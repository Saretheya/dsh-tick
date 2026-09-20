/**
 * Tick（定时任务）— 任务表存储（sidecar，每会话一份）。
 *
 * ★ 为什么不用会话日志：见 storage.js 顶部说明与
 *
 * 本模块负责
 *   1. 每会话一个文件的读写（原子写、损坏容错、写链串行化）；
 *   2. 加载时的**恢复决策**（recoverOnLoad：冻结计时 / 转 overdue）；
 *   3. 内存缓存 + 显式持久化，避免热路径反复读盘。
 *
 * 并发纪律：同一会话的写操作经 `writeChain` 串行化，避免"读旧写新"覆盖
 * （竞品踩过"启动期未读到旧任务就覆盖写盘"的数据丢失）。
 *
 * @module dsh-tick/store
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PATHS, readJsonStrict, tasksFileFor, writeJson } from './storage.js'
import { normalizeStoredTask, recoverOnLoad } from './domain.js'

/** 磁盘上任务表文件的版本号（便于将来迁移）。 */
const STORE_VERSION = 1

/**
 * 一条会话的任务表。
 */
export class TaskStore {
  /**
   * @param ctx - 宿主上下文（用于 logger）。
   * @param config - 已收敛的插件配置。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** sessionId → 任务数组（内存缓存）。 */
    this.cache = new Map()
    /** sessionId → 写链尾（串行化同一会话的写）。 */
    this.writeChain = new Map()
    /** sessionId → 该表是否已从磁盘加载过。 */
    this.loaded = new Set()
  }

  /**
   * 把同一会话的写操作串起来，避免并发覆盖。
   * @param sessionId - 会话 id。
   * @param operation - 实际操作。
   * @returns 操作结果。
   */
  #serialize(sessionId, operation) {
    const previous = this.writeChain.get(sessionId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    // 链尾只用于排序，失败不应阻断后续操作，因此吞掉拒绝。
    this.writeChain.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /**
   * 读一个会话的任务表（首次访问时从磁盘加载并做恢复决策）。
   *
   * 损坏处理：文件不可解析 → **改名保留**（`.corrupt-<ts>`）→ 按空表继续，
   * 并**明确告警**（不静默——静默会让用户以为任务凭空消失）。
   *
   * @param sessionId - 会话 id。
   * @param now - 当前时刻（epoch 毫秒）。
   * @returns 任务数组（已规范化、已恢复）。
   */
  async load(sessionId, now) {
    if (this.loaded.has(sessionId)) return this.cache.get(sessionId) ?? []

    const file = tasksFileFor(sessionId)
    // ★ 用严格读：必须区分"首次运行"与"文件损坏"，否则损坏会被当成空表，
    //   下一次写入直接覆盖用户数据且毫无痕迹（单元测试实测发现：过）。
    const read = await readJsonStrict(file)

    let tasks = []
    if (read.kind === 'corrupt') {
      this.ctx.logger.warn(
        `[tick] 任务表损坏，已改名保留并按空表继续：${file}` +
          `（${read.error instanceof Error ? read.error.message : String(read.error)}）`,
      )
      await this.#quarantine(file)
    } else if (read.kind === 'ok') {
      const raw = read.value
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : null
      if (list === null) {
        this.ctx.logger.warn(`[tick] 任务表结构非法（缺少 tasks 数组），已改名保留：${file}`)
        await this.#quarantine(file)
      } else {
        const good = []
        for (const item of list) {
          try {
            good.push(normalizeStoredTask(item))
          } catch (error) {
            this.ctx.logger.warn(
              `[tick] 丢弃一条无法解析的任务（${file}）：${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        tasks = good
        if (good.length !== list.length) {
          // 有丢弃 → 立即落盘，避免每次加载都重复告警。
          this.cache.set(sessionId, good)
          this.loaded.add(sessionId)
          await this.#persist(sessionId)
        }
      }
    }

    // ★ 恢复决策：延迟/重复冻结计时并置 paused；固定时刻已过则 overdue。
    //   `graceMs` 从配置取（此前误用 domain 里的内置常量，导致该配置项**改了不生效**）。
    const recovered = tasks.map((task) => recoverOnLoad(task, now, this.config?.graceMs))
    const changed = recovered.some((task, index) => task !== tasks[index])
    this.cache.set(sessionId, recovered)
    this.loaded.add(sessionId)
    // 注意：若上面已因"丢弃损坏条目"落盘过，这里仍需在恢复决策改变状态时再落一次。
    if (changed) await this.#persist(sessionId)

    return recovered
  }

  /**
   * 把损坏文件改名保留，避免被下一次写入直接覆盖。
   * @param file - 任务表路径。
   */
  async #quarantine(file) {
    try {
      const { rename } = await import('node:fs/promises')
      await rename(file, `${file}.corrupt-${Date.now()}`)
      this.ctx.logger.warn(`[tick] 已把损坏的任务表改名保留：${file}.corrupt-*`)
    } catch {
      /* 改名失败不致命：后续写入会覆盖它 */
    }
  }

  /**
   * 落盘一个会话的任务表（调用方需保证已在串行区内）。
   *
   * ★ 文件里**同时写入 `sessionId`**：文件名经过净化（非法字符换成 `_`），
   *   无法由文件名可靠反推原始 id；而跨会话汇总需要真实 id 才能跳转/加载。
   *   写入 id 后，`listStoredSessions()` 就能拿到权威值。
   * @param sessionId - 会话 id。
   */
  async #persist(sessionId) {
    const tasks = this.cache.get(sessionId) ?? []
    await writeJson(tasksFileFor(sessionId), { version: STORE_VERSION, sessionId, tasks })
    return tasks
  }

  /**
   * 写一个会话的任务表（串行化 + 原子写）。
   * @param sessionId - 会话 id。
   * @param tasks - 新任务数组。
   * @returns 落盘后的任务数组。
   */
  async save(sessionId, tasks) {
    return this.#serialize(sessionId, async () => {
      this.cache.set(sessionId, tasks)
      this.loaded.add(sessionId)
      return this.#persist(sessionId)
    })
  }

  /**
   * 在一个串行区内执行"读—改—写"，避免并发覆盖。
   *
   * @param sessionId - 会话 id。
   * @param now - 当前时刻。
   * @param mutate - 接收当前任务数组，返回新数组（或抛错取消）。
   * @returns 落盘后的任务数组。
   */
  async update(sessionId, now, mutate) {
    return this.#serialize(sessionId, async () => {
      const current = await this.load(sessionId, now)
      const next = await mutate(current)
      if (!Array.isArray(next)) throw new TypeError('tick: mutate 必须返回任务数组')
      this.cache.set(sessionId, next)
      this.loaded.add(sessionId)
      return this.#persist(sessionId)
    })
  }

  /**
   * 心跳：把 `lastSeenAt` 推进到当前时刻（冻结计时的精度来源）。
   *
   * 只在**确有活跃任务**时才写盘，避免无任务时也周期性写文件。
   * @param sessionId - 会话 id。
   * @param now - 当前时刻。
   * @returns 是否发生了写入。
   */
  async heartbeat(sessionId, now) {
    const tasks = this.cache.get(sessionId)
    if (tasks === undefined || tasks.length === 0) return false
    const active = tasks.some((task) => task.enabled && task.status === 'pending')
    if (!active) return false
    const iso = new Date(now).toISOString()
    const next = tasks.map((task) =>
      task.enabled && task.status === 'pending' ? Object.freeze({ ...task, lastSeenAt: iso }) : task,
    )
    await this.save(sessionId, next)
    return true
  }

  /**
   * 列出本插件 `data/tasks/` 目录里**存有任务表**的会话 id。
   *
   * 用途：跨会话汇总（侧栏全局入口）。
   *
   * ★ 为什么读**文件内容**而不是文件名：文件名经过净化（非法字符换成 `_`），
   *   无法可靠反推原始 sessionId。所以落盘时把权威的 `sessionId` 写进文件，
   *   这里以它为准；旧文件（没有该字段）回退用文件名，仅作尽力而为。
   *
   * 容错：单文件失败只跳过并继续（**绝不外抛**），保证侧栏入口不会因
   * 一个坏文件而整个不可用。
   *
   * @returns 会话 id 数组（已去重）。
   */
  async listStoredSessions() {
    let entries = []
    try {
      entries = await readdir(PATHS.tasks)
    } catch (error) {
      // ★ 只把"目录不存在"当作"没有任务"；其它错误（权限等）要**如实抛出**。
      //   教训：这里原来写的是无条件 `catch { return [] }`，于是把
      //   "PATHS 未定义"这类**编程错误**也吞成了"没有任务"，
      //   表现为侧栏汇总恒为空、且没有任何报错——是最难查的静默失效。
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
      throw error
    }
    const ids = new Set()
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue // 跳过 .corrupt-* 等
      const read = await readJsonStrict(join(PATHS.tasks, entry))
      if (read.kind !== 'ok') continue
      const raw = read.value
      const explicit = raw !== null && typeof raw === 'object' ? raw.sessionId : undefined
      if (typeof explicit === 'string' && explicit.length > 0) {
        ids.add(explicit)
      } else {
        // 旧版本文件没有 sessionId 字段：用净化前的文件名尽力而为。
        ids.add(entry.slice(0, -'.json'.length))
      }
    }
    return [...ids]
  }

  /**
   * 列出所有已加载会话的任务（供本进程内的诊断使用）。
   * @returns `{ sessionId, tasks }` 数组。
   */
  loadedSessions() {
    return [...this.cache.entries()].map(([sessionId, tasks]) => ({ sessionId, tasks }))
  }

  /**
   * 统计某会话的"应当显示提醒"的任务数。
   *
   * 按用户定案（.0）：只有**待执行**或**已超时**才算；
   * 全暂停 / 全完成 / 无任务都**不显示**标记。
   * @param tasks - 任务数组。
   * @returns 需要提醒的任务数。
   */
  static attentionCount(tasks) {
    return tasks.filter((task) => task.status === 'pending' || task.status === 'overdue').length
  }
}
