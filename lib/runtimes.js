/**
 * Tick（定时任务）— 运行时管理器（Host 侧）。
 *
 * 为**每个有任务的会话**维护一个 SessionRuntime，并在下列时机重建/释放
 *   - 插件加载后：为已知会话按需惰性建立（不扫描全量会话）；
 *   - 会话被加载/创建时（`session/created`）：建立该会话的 runtime；
 *   - 任务被增删改时（由 store 的调用方通知）：`ensure()` 重建；
 *   - 插件释放时：全部 dispose。
 *
 * ★ 为什么不在启动时扫描全部会话
 *    `dsh-workspace` 启动路径（listStoredHeaders）因为"任何
 *   异常直接 throw"导致整个 profile 加载失败、Web UI 起不来。本插件不往启动
 *   路径再加扫描逻辑，改为**跟随官方"选中哪个加载哪个"的会话流程**。
 *
 * @module dsh-tick/runtimes
 */
import { SessionRuntime } from './runtime.js'

/**
 * 管理全部会话的调度器。
 */
export class RuntimeManager {
  /**
   * @param options - 构造参数。
   * @param options.ctx - 宿主上下文。
   * @param options.store - TaskStore 实例。
   * @param options.config - 已收敛的配置。
   * @param options.getAgent - `(sessionId) => agent | undefined`。
   * @param options.onInject - 注入后的回调。
   * @param options.onBeforeInject - 注入**前**的异步钩子（刷新注入模板源）。
   */
  constructor(options) {
    this.ctx = options.ctx
    this.store = options.store
    this.config = options.config
    this.getAgent = options.getAgent
    this.onInject = options.onInject
    this.onBeforeInject = options.onBeforeInject
    /** sessionId → SessionRuntime */
    this.runtimes = new Map()
    /** 是否已整体释放。 */
    this.stopped = false
  }

  /**
   * 为一个会话确保存在调度器（已存在则重启它以读取最新任务）。
   * @param sessionId - 会话 id。
   * @returns 该会话的调度器。
   */
  ensure(sessionId) {
    if (this.stopped) return undefined
    const existing = this.runtimes.get(sessionId)
    if (existing !== undefined) {
      // 任务可能刚变过：让调度器重新读盘并排期。
      existing.dispose()
    }
    const runtime = new SessionRuntime({
      ctx: this.ctx,
      store: this.store,
      config: this.config,
      sessionId,
      getAgent: () => this.getAgent(sessionId),
      onInject: this.onInject,
      onBeforeInject: this.onBeforeInject,
    })
    this.runtimes.set(sessionId, runtime)
    runtime.start()
    return runtime
  }

  /**
   * 释放一个会话的调度器（例如该会话已无任务）。
   * @param sessionId - 会话 id。
   */
  release(sessionId) {
    const runtime = this.runtimes.get(sessionId)
    if (runtime !== undefined) {
      runtime.dispose()
      this.runtimes.delete(sessionId)
    }
  }

  /**
   * 当前已建立调度器的会话数（供诊断）。
   * @returns 会话数。
   */
  get size() {
    return this.runtimes.size
  }

  /** 释放全部调度器。 */
  dispose() {
    this.stopped = true
    for (const runtime of this.runtimes.values()) runtime.dispose()
    this.runtimes.clear()
  }
}
