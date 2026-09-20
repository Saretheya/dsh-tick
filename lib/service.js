/**
 * Tick（定时任务）— 管理服务（RPC 与 AI 工具共用的**唯一**实现）。
 *
 * ★ 为什么要收敛成一份实现
 *
 *   不能只看不见"——同一件事在多处判断时，判据必须收敛到同一个函数，
 *   否则会出现"UI 拦住了、工具没拦住"这类越权缺口。
 *   因此 RPC 与模型工具都调用这里的同一批方法。
 *
 * 三道闸在这里统一执行
 *   - maxTasksPerSession     总量
 *   - maxActivePerSession    同时启用数
 *   - maxInjectionsPerMinute 注入频率（由 runtime 执行）
 *
 * @module dsh-tick/service
 */
import {
  TickInputError,
  advanceAfterFire,
  allocateId,
  createTask,
  parseInstant,
  pauseTask,
  resolveSelector,
  resumeTask,
  taskView,
  updateTaskSchedule,
} from './domain.js'
import { injectTask } from './inject.js'
import { TaskStore } from './store.js'
import { createTranslator, detectLocale } from './i18n.js'

/** 管理操作返回的稳定错误码（供 UI / 模型识别）。 */
export const CODES = Object.freeze({
  notFound: 'task_not_found',
  limitTasks: 'limit_tasks_per_session',
  limitActive: 'limit_active_per_session',
  invalid: 'invalid_input',
  noAgent: 'no_live_agent',
  aiDisabled: 'ai_create_disabled',
})

/**
 * 管理服务。
 */
export class TickService {
  /** 注入前的异步刷新钩子（custom 档下实时读取模板）；未注入时为 undefined。 */
  #beforeInject

  /**
   * @param options - 构造参数。
   * @param options.ctx - 宿主上下文。
   * @param options.store - TaskStore 实例。
   * @param options.config - 已收敛的配置。
   * @param options.getAgent - `(sessionId) => agent | undefined`。
   * @param options.onChanged - 任务变更后的回调（用于重建调度器/刷新 UI）。
   * @param options.templateReset - `() => {seq, reason}`，读模板复原事件。
   * @param options.beforeInject - 注入前刷新模板源（异步）。
   */
  constructor(options) {
    this.ctx = options.ctx
    this.store = options.store
    this.config = options.config
    this.getAgent = options.getAgent
    this.onChanged = options.onChanged
    /** 可选：读自定义模板复原事件的函数（由 index.js 注入，见 templates.js）。 */
    this.templateReset = options.templateReset
    /** 可选：注入前的异步刷新钩子（custom 档下实时读取模板）。 */
    this.#beforeInject = options.beforeInject
  }

  /**
   * 读"自定义注入模板复原"事件（供 RPC 下发给客户端弹提示）。
   *
   * ★ 只暴露**发生了什么**（序号 + 错误码），不含文案 ——
   *   文案由客户端按 **UI 语言** 渲染，因此中文用户看到中文、
   *   其余用户看到英文，而 Host 侧无需知道 UI 语言。
   *
   * @returns `{seq, reason}`；未装配模板源时返回零值。
   */
  templateResetState() {
    try {
      if (typeof this.templateReset === 'function') return this.templateReset()
    } catch {
      /* 读不到即视为"从未复原" */
    }
    return { seq: 0, reason: null }
  }

  /**
   * 当前语言的翻译函数（**每次调用时重新探测**）。
   *
   * ★ 为什么每次探测而不是构造函数里缓存一次：服务实例的生命周期
   *   贯穿整个进程，而用户可能中途切换语言；每次读一次 settings 的成本
   *   极低（内存读取），换来的是错误消息语言始终与用户当前选择一致。
   *
   * @returns `(key, params?) => string`。
   */
  #t() {
    return createTranslator(detectLocale(this.ctx))
  }

  /**
   * 便捷取词（绑定当前语言）。
   * @param key - 文案键。
   * @param params - 插值参数。
   * @returns 文本。
   */
  #text(key, params) {
    return this.#t()(key, params)
  }

  /**
   * 列出某会话的全部任务视图。
   * @param sessionId - 会话 id。
   * @returns 任务视图数组。
   */
  async list(sessionId) {
    const now = Date.now()
    const tasks = await this.store.load(sessionId, now)
    return tasks.map((task) => taskView(task, now))
  }

  /**
   * 创建一条任务。
   *
   * @param sessionId - 会话 id。
   * @param input - 输入参数。
   * @param actor - `user` | `ai`（决定 createdBy 与是否受 AI 开关限制）。
   * @returns 新任务的视图。
   */
  async create(sessionId, input, actor = 'user') {
    if (actor === 'ai' && this.config.allowAiCreate !== true) {
      throw new TickInputError(CODES.aiDisabled, this.#text('svc.aiDisabled'))
    }
    const now = Date.now()

    // ★ 唯一判据：selector 的唯一性在这里统一校验（RPC/UI 与模型工具共用）。
    //   实测发现：过"工具拦了、RPC 没拦"的不一致。
    const selector = resolveSelector(input)

    const current = await this.store.load(sessionId, now)

    if (current.length >= this.config.maxTasksPerSession) {
      throw new TickInputError(
        CODES.limitTasks,
        this.#text('svc.limitTasks', { max: this.config.maxTasksPerSession }),
      )
    }
    const activeCount = current.filter((task) => task.enabled && task.status === 'pending').length
    if (activeCount >= this.config.maxActivePerSession) {
      throw new TickInputError(
        CODES.limitActive,
        this.#text('svc.limitActive', { max: this.config.maxActivePerSession }),
      )
    }

    const task = createTask({
      id: allocateId(current),
      kind: selector.kind,
      prompt: input.prompt,
      afterSeconds: selector.afterSeconds,
      intervalSeconds: selector.intervalSeconds,
      scheduledAt: selector.scheduledAt,
      createdBy: actor,
      now,
    })

    await this.store.update(sessionId, now, (tasks) => [...tasks, task])
    this.#changed(sessionId)
    return taskView(task, now)
  }

  /**
   * 修改一条任务（内容或时间）。
   * @param sessionId - 会话 id。
   * @param id - 任务 id。
   * @param patch - 变更字段。
   * @returns 修改后的视图。
   */
  async update(sessionId, id, patch) {
    const now = Date.now()
    // ★ 时间设定的互斥校验同样走领域层唯一判据（只在真的给了时间字段时校验）。
    const hasTimeField =
      (patch.afterSeconds !== undefined && patch.afterSeconds !== null) ||
      (patch.intervalSeconds !== undefined && patch.intervalSeconds !== null) ||
      (patch.scheduledAt !== undefined && patch.scheduledAt !== null)
    if (hasTimeField) resolveSelector(patch)

    let updated
    await this.store.update(sessionId, now, (tasks) => {
      const index = tasks.findIndex((task) => task.id === id)
      if (index < 0) throw new TickInputError(CODES.notFound, this.#text('svc.notFound', { id }))
      updated = updateTaskSchedule(tasks[index], patch, now)
      const next = [...tasks]
      next[index] = updated
      return next
    })
    this.#changed(sessionId)
    return taskView(updated, now)
  }

  /**
   * 暂停一条任务（冻结剩余时间）。
   * @param sessionId - 会话 id。
   * @param id - 任务 id。
   * @returns 暂停后的视图。
   */
  async pause(sessionId, id) {
    const now = Date.now()
    let updated
    await this.store.update(sessionId, now, (tasks) => {
      const index = tasks.findIndex((task) => task.id === id)
      if (index < 0) throw new TickInputError(CODES.notFound, this.#text('svc.notFound', { id }))
      updated = pauseTask(tasks[index], now)
      const next = [...tasks]
      next[index] = updated
      return next
    })
    this.#changed(sessionId)
    return taskView(updated, now)
  }

  /**
   * 恢复一条任务。
   *
   * ★ 对已超时（overdue）任务，"恢复"= 按用户定案**立即执行**，
   *   因此这里在恢复后主动触发一次投递。
   * @param sessionId - 会话 id。
   * @param id - 任务 id。
   * @returns 恢复后的视图。
   */
  async resume(sessionId, id) {
    const now = Date.now()
    let updated
    let wasOverdue = false
    await this.store.update(sessionId, now, (tasks) => {
      const index = tasks.findIndex((task) => task.id === id)
      if (index < 0) throw new TickInputError(CODES.notFound, this.#text('svc.notFound', { id }))
      wasOverdue = tasks[index].status === 'overdue'
      updated = resumeTask(tasks[index], now)
      const next = [...tasks]
      next[index] = updated
      return next
    })
    this.#changed(sessionId)
    if (wasOverdue) await this.runNow(sessionId, id)
    return taskView(updated, now)
  }

  /**
   * 立即执行一条任务（不等定时）。
   *
   * 语义：把该任务视为"此刻到期"，注入一次并按模式推进状态。
   * @param sessionId - 会话 id。
   * @param id - 任务 id。
   * @returns 执行结果视图。
   */
  async runNow(sessionId, id) {
    const now = Date.now()
    const tasks = await this.store.load(sessionId, now)
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) throw new TickInputError(CODES.notFound, this.#text('svc.notFound', { id }))

    const agent = this.getAgent(sessionId)
    if (agent === undefined) {
      throw new TickInputError(CODES.noAgent, this.#text('svc.noAgent'))
    }

    // ★ 复用 inject.js 的唯一注入实现，保证 framing 与 source 不会在这里漂移。
    //   ⚠ 也走与 runtime 相同的"注入前刷新模板"钩子，否则 custom 档下
    //     "立即执行"会用上一次的模板（与到点注入不一致）。
    await this.#beforeInject?.()
    injectTask(agent, task)

    let advanced
    await this.store.update(sessionId, now, (current) =>
      current.map((item) => {
        if (item.id !== id) return item
        advanced = advanceAfterFire(item, now)
        return advanced
      }),
    )
    this.#changed(sessionId)
    this.ctx.logger.info(`[tick] 已立即执行任务 ${id}（会话 ${sessionId}）`)
    return taskView(advanced, now)
  }

  /**
   * 删除一条任务。
   * @param sessionId - 会话 id。
   * @param id - 任务 id。
   * @returns 是否删除成功。
   */
  async remove(sessionId, id) {
    const now = Date.now()
    let removed = false
    await this.store.update(sessionId, now, (tasks) => {
      const next = tasks.filter((task) => task.id !== id)
      removed = next.length !== tasks.length
      return next
    })
    if (!removed) throw new TickInputError(CODES.notFound, this.#text('svc.notFound', { id }))
    this.#changed(sessionId)
    return true
  }

  /**
   * 跨会话汇总（供侧栏底部的全局入口使用）。
   *
   * ★ 数据来源：**按需枚举本插件自己的 `data/tasks/` 目录**，而不是只数内存里
   *   已加载的会话。理由：只数内存会让"DSH 重启后侧栏汇总为空、必须逐个打开
   *   会话才看得见"，那基本等于没有这个功能。
   *
   * ★ 为什么枚举自己的目录是安全的
   *   - 那次事故的根源是 `dsh-workspace` 读 **DSH 自己的会话文件**
   *     （`sessions` 目录下的 `session.v3.jsonl.zstd`），且**任何异常都向上抛**
   *     导致整个 profile 加载失败；
   *   - 这里读的是本插件自己在 `data/tasks/` 写的几十字节小 JSON**，
   *     且**每个文件独立 try/catch**（坏文件跳过并告警，绝不外抛）；
   *   - 而且它是**按需调用**（用户点开侧栏入口时），**不在启动路径上**。
   *
   * @returns `{ total, attention, overdue, sessions: [...] }`。
   */
  async globalSummary() {
    const now = Date.now()
    let total = 0
    let attention = 0
    let overdue = 0
    const sessions = []

    let sessionIds = []
    try {
      sessionIds = await this.store.listStoredSessions()
    } catch (error) {
      this.ctx.logger.warn(
        `[tick] 枚举任务目录失败，跨会话汇总将为空：${error instanceof Error ? error.message : String(error)}`,
      )
      return { total, attention, overdue, sessions, generatedAt: new Date(now).toISOString() }
    }

    for (const sessionId of sessionIds) {
      let tasks
      try {
        // load() 内部已做规范化、损坏隔离与恢复决策，且每个文件独立容错。
        tasks = await this.store.load(sessionId, now)
      } catch (error) {
        this.ctx.logger.warn(
          `[tick] 读取会话 ${sessionId} 的任务失败（已跳过）：${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      if (tasks.length === 0) continue
      const sessionAttention = TaskStore.attentionCount(tasks)
      const sessionOverdue = tasks.filter((task) => task.status === 'overdue').length
      total += tasks.length
      attention += sessionAttention
      overdue += sessionOverdue
      if (sessionAttention === 0) continue // 只要"需要关注"的会话
      let nextAt = null
      for (const task of tasks) {
        if (task.status !== 'pending' || !task.enabled) continue
        const ms = parseInstant(task.scheduledAt)
        if (nextAt === null || ms < nextAt) nextAt = ms
      }
      const sample = tasks.find((task) => task.status === 'overdue' || task.status === 'pending')
      sessions.push({
        sessionId,
        attention: sessionAttention,
        overdue: sessionOverdue,
        total: tasks.length,
        nextAt: nextAt === null ? null : new Date(nextAt).toISOString(),
        samplePrompt: sample === undefined ? '' : sample.prompt.slice(0, 60),
      })
    }

    sessions.sort((a, b) => b.overdue - a.overdue || b.attention - a.attention)
    return { total, attention, overdue, sessions, generatedAt: new Date(now).toISOString() }
  }

  /**
   * 该会话的展示摘要（供 dock 折叠行与侧栏图标）。
   * @param sessionId - 会话 id。
   * @returns 摘要对象。
   */
  async summary(sessionId) {
    const now = Date.now()
    const tasks = await this.store.load(sessionId, now)
    const attention = TaskStore.attentionCount(tasks)
    const pending = tasks.filter((task) => task.status === 'pending' && task.enabled)
    let nextAt = null
    for (const task of pending) {
      const ms = parseInstant(task.scheduledAt)
      if (nextAt === null || ms < nextAt) nextAt = ms
    }
    return {
      total: tasks.length,
      attention,
      pending: pending.length,
      paused: tasks.filter((task) => task.status === 'paused').length,
      overdue: tasks.filter((task) => task.status === 'overdue').length,
      done: tasks.filter((task) => task.status === 'done').length,
      nextAt: nextAt === null ? null : new Date(nextAt).toISOString(),
    }
  }

  /**
   * 通知外部"该会话的任务变了"（重建调度器 + 刷新 UI）。
   * @param sessionId - 会话 id。
   */
  #changed(sessionId) {
    if (typeof this.onChanged === 'function') {
      try {
        this.onChanged(sessionId)
      } catch (error) {
        this.ctx.logger.warn(`[tick] onChanged 回调失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
