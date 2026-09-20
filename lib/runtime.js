/**
 * Tick（定时任务）— 运行时调度器（每会话一个）。
 *
 * 职责：
 *   1. 为每个"有活跃任务"的会话维护一个定时器；
 *   2. 到点后通过 `agent.followup()` 注入 framing（source 标识为插件）；
 *   3. 靠**心跳**推进 `lastSeenAt`，从而让"DSH 关闭期间冻结计时"成立
 *      （不依赖关闭钩子——强杀也成立，代价是精度等于心跳间隔）；
 *   4. 遵守注入频率闸与并发闸。
 *
 * ★ 为什么用心跳而不是"关闭时保存剩余时间"：
 *   DSH 的关闭钩子有 5 秒超时，而且**被强杀时根本不会执行**。
 *   心跳把"最后一次活着的时刻"持续写到盘上，重启时用
 *   `剩余 = scheduledAt - lastSeenAt` 反推关闭前的剩余时间，天然免疫强杀。
 *
 * ★ 定时器分段：单个 setTimeout 的最大延迟约 24.8 天
 *   （`MAX_TIMER_DELAY_MS`），超过会立即触发。因此长延迟必须分段等待。
 *
 * @module dsh-tick/runtime
 */
import { advanceAfterFire, isDue, parseInstant, taskView } from './domain.js'
import { injectTask } from './inject.js'

/** 单个 setTimeout 的安全上限（对齐官方 schedule 的取值）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * 注入失败后的退避窗口。
 *
 * 为什么需要它：注入失败时任务仍是 pending 且已过期，若立刻重排定时器，
 * 会在毫秒级反复重试同一个必然失败的任务，形成紧密死循环。
 * 单元测试"followup 抛错时不影响其它任务"实测发现：过这个问题。
 */
const INJECT_FAILURE_BACKOFF_MS = 30_000

/** 注入类操作的出错前缀（便于日志检索）。 */
const LOG_TAG = '[tick]'

/**
 * 一个会话的调度器。
 */
export class SessionRuntime {
  /** 注入失败退避：taskId → 可重试的时刻（毫秒）。私有不暴露。 */
  #backoff = new Map()

  /**
   * @param options - 构造参数。
   * @param options.ctx - 宿主上下文。
   * @param options.store - TaskStore 实例。
   * @param options.config - 已收敛的配置。
   * @param options.sessionId - 本调度器负责的会话 id。
   * @param options.getAgent - 返回该会话当前的 live agent（没有则 undefined）。
   * @param options.onInject - 注入前/后的回调（用于刷新 UI、记日志）。
   */
  constructor(options) {
    this.ctx = options.ctx
    this.store = options.store
    this.config = options.config
    this.sessionId = options.sessionId
    this.getAgent = options.getAgent
    this.onInject = options.onInject
    /**
     * 可选：注入**前**的异步钩子（用于按需刷新注入模板源）。
     *
     * ★ 为什么需要它：custom 档的模板要"实时读取"（用户改完即生效）。
     *   刷新是异步（读盘），而注入本身是同步调用，故拆成两步。
     */
    this.onBeforeInject = options.onBeforeInject

    /** 当前定时器。 */
    this.timer = undefined
    /** 心跳定时器。 */
    this.heartbeatTimer = undefined
    /** 是否已停止（释放后不再排新工作）。 */
    this.stopped = false
    /** 是否正在执行注入（防重入）。 */
    this.busy = false
    /** 最近的注入时刻（毫秒）数组，用于频率闸。 */
    this.recentInjections = []
  }

  /** 启动：立即排一次调度与心跳。 */
  start() {
    if (this.stopped) return
    void this.#schedule()
    this.#startHeartbeat()
  }

  /** 停止并清理全部定时器。 */
  dispose() {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  /**
   * 心跳：把活跃任务的 `lastSeenAt` 推到当前时刻。
   * 只在确有活跃任务时才写盘（TaskStore.heartbeat 内部判断）。
   */
  #startHeartbeat() {
    if (this.heartbeatTimer !== undefined) return
    const interval = this.config.heartbeatMs
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped) return
      void this.store.heartbeat(this.sessionId, Date.now()).catch((error) => {
        this.ctx.logger.warn(`${LOG_TAG} 心跳写入失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, interval)
    // 心跳不该阻止进程退出。
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  /**
   * 计算"下一个需要唤醒的时刻"，并据此排一个（必要时分段的）定时器。
   */
  async #schedule() {
    if (this.stopped) return
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    const now = Date.now()
    let tasks
    try {
      tasks = await this.store.load(this.sessionId, now)
    } catch (error) {
      this.ctx.logger.warn(`${LOG_TAG} 读取任务表失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (this.stopped) return

    const pending = tasks.filter((task) => task.enabled && task.status === 'pending')
    if (pending.length === 0) return

    // 最近的目标时刻决定唤醒点。
    // ★ 处于退避窗口内的任务不能按其（已过去的）目标时刻唤醒，否则会算出
    //   delay=0 而立刻重新触发，形成忙循环；改用它的"可重试时刻"作为唤醒点。
    let earliest = Number.POSITIVE_INFINITY
    for (const task of pending) {
      const target = parseInstant(task.scheduledAt)
      const until = this.#backoff.get(task.id)
      const wakeAt = until !== undefined ? Math.max(target, until) : target
      if (wakeAt < earliest) earliest = wakeAt
    }
    // 全都被退避挡住时，最早唤醒点仍可能远在未来；下限兜底避免 0 延迟空转。
    if (!Number.isFinite(earliest)) return

    const delay = Math.max(50, Math.min(earliest - now, MAX_TIMER_DELAY_MS))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.#tick()
    }, delay)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * 判断频率闸是否放行。不允许时返回 false（并跳过本轮注入）。
   * @param now - 当前时刻。
   * @returns 是否放行。
   */
  #admitByRate(now) {
    const windowMs = 60_000
    const limit = this.config.maxInjectionsPerMinute
    this.recentInjections = this.recentInjections.filter((t) => now - t < windowMs)
    if (this.recentInjections.length >= limit) {
      this.ctx.logger.warn(
        `${LOG_TAG} 会话 ${this.sessionId} 触发注入频率闸（${limit}/分钟），本轮跳过；` +
          `这通常是任务设定过于频繁，请检查或暂停相关任务。`,
      )
      return false
    }
    return true
  }

  /**
   * 到点处理：找出到期任务，注入 framing，并推进任务状态。
   */
  async #tick() {
    if (this.stopped || this.busy) return
    this.busy = true
    try {
      const now = Date.now()
      const agent = this.getAgent()

      const tasks = await this.store.load(this.sessionId, now)
      const due = tasks.filter((task) => isDue(task, now))
      if (due.length === 0) {
        await this.#schedule()
        return
      }

      if (agent === undefined) {
        // 会话当前没有 live agent（冷会话）→ 不投递，保持原状等下次加载。
        this.ctx.logger.info(`${LOG_TAG} 会话 ${this.sessionId} 当前无 live agent，暂不投递`)
        return
      }

      for (const task of due) {
        if (this.stopped) return

        // ★ 逐次判闸（**不能**放在循环外只判一次）：一轮里可能同时有多个任务
        //   到期，若只在循环外判，多任务就会整批绕过闸门（单元测试实测发现：）。
        if (!this.#admitByRate(Date.now())) return

        // ★ 处于退避窗口内的任务跳过（防"注入持续失败 → 立即重排 → 死循环"）。
        const until = this.#backoff.get(task.id)
        if (until !== undefined) {
          if (Date.now() < until) continue
          this.#backoff.delete(task.id)
        }

        try {
          /**
           * ★ 注入前刷新一次模板源（**实时读取**要求）。
           *
           * 自定义模板刻意**不做缓存**：用户改完 `inject-templates.json`
           * 应当下次注入即生效，不必重启 DSH。读盘的代价发生在"确实要注入"
           * 这一刻（低频），可以接受。
           *
           * ⚠ 这里 await 的是"刷新"，**不是**注入本身 —— 注入必须同步调用
           *   （`agent.followup` 非异步），否则会把下面 catch 的语义搞乱。
           *   刷新失败也不能阻止注入：templates.js 内部已保证失败即回退 en。
           */
          if (typeof this.onBeforeInject === 'function') {
            await this.onBeforeInject()
          }
          this.#inject(agent, task, now)
        } catch (error) {
          // ★ 注入失败**不能立即重试**：任务仍是 pending 且已过期，直接重排定时器
          //   会形成紧密重试死循环（单元测试实测发现：）。这里记一个退避窗口。
          this.#backoff.set(task.id, Date.now() + INJECT_FAILURE_BACKOFF_MS)
          this.ctx.logger.warn(
            `${LOG_TAG} 注入失败（任务 ${task.id}），${Math.round(INJECT_FAILURE_BACKOFF_MS / 1000)} 秒内不再重试：` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        this.recentInjections.push(Date.now())
        // ★ 注入成功后才推进状态并落盘（先投递、后落盘；
        //   若落盘失败，下次加载会重放，宁可重复也不丢）。
        await this.store.update(this.sessionId, now, (current) =>
          current.map((item) => (item.id === task.id ? advanceAfterFire(item, now) : item)),
        )
        if (typeof this.onInject === 'function') {
          this.onInject({ sessionId: this.sessionId, task: taskView(task, now) })
        }
      }
    } catch (error) {
      this.ctx.logger.warn(`${LOG_TAG} 调度循环出错：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
      if (!this.stopped) await this.#schedule()
    }
  }

  /**
   * 构造并投递一条注入消息。
   *
   * ★ source 标识为插件（绝不伪装 user）；构造失败要抛错由调用方记录。
   * @param agent - 目标 agent。
   * @param task - 任务记录。
   * @param now - 当前时刻。
   */
  #inject(agent, task, now) {
    // ★ 注入实现收敛在 inject.js（保证 framing 与 source 不与 service 漂移）。
    injectTask(agent, task)
    this.ctx.logger.info(`${LOG_TAG} 已注入任务 ${task.id}（${task.kind}）到会话 ${this.sessionId}`)
  }
}
