/**
 * Tick（定时任务）— Host 入口。
 *
 * 目标：在 DSH 会话内按「延迟 / 固定时刻 / 重复」三种模式注入提示词唤醒模型，
 * 并提供可写管理面板、`/schedule` 命令与面向模型的完整管理工具。
 *
 * ★ 三条贯穿全项目的纪律（改代码前先读）：
 *
 *   1. **绝不写自定义会话事件类型**。dsh-session 有 `KNOWN_SESSION_EVENT_TYPES`
 *      白名单，持久化读路径对"不在白名单且未标 ignorable"的类型 fail-closed，
 *      会让**整份会话日志被拒读**（GUI 报"历史加载失败"）；而 `Session.append()`
 *      只提取 surfaceOp/sourceEventSeqs，插件无法为自己的事件打 ignorable 标记，
 *      官方也明确拒绝了"事件名注册"。故任务状态一律存插件自有 data/。
 *      （对应曾出现过的"启动路径任何异常直接 throw → Web UI 起不来"同类事故。）
 *
 *   2. **注入消息的 source 必须是 plugin，绝不伪装 user**。工作区最高优先级纪律
 *      规定"是否真实用户发言"的唯一权威判据是
 *      `event.type==='user/message' && event.data.source.kind==='user'`；
 *      污染它会让将来的会话分析无法区分"用户真说了"与"定时器注入的"。
 *
 *   3. **每个功能块各自 try/catch**。注入回调里一处抛错会中断其后所有注册
 *      （曾遇到：连带 health 端点 404，让"是否加载成功"无法判断）。
 *
 * @module dsh-tick
 */
import { readConfig } from './config.js'
import { ensureDirs, readJsonStrict, sweepTmp, writeJson, PATHS } from './storage.js'
import { RuntimeManager } from './runtimes.js'
import { TaskStore } from './store.js'
import { TickService } from './service.js'
import { builtinTemplates, getLastReset, getResetSeq, loadCustomTemplates } from './templates.js'
import { setFramingLocale, setFramingTemplates } from './framing.js'
import { installHealth, installManagementRpc } from './rpc.js'
import { registerTickTools } from './tools.js'
import { registerScheduleCommand } from './command.js'
import { detectLocale, installLocaleSettings } from './i18n.js'
import { setDomainLocale } from './domain.js'

/** 插件显示名（仅用于诊断）。 */
export const name = 'dsh-tick'

/**
 * 必需服务。
 *
 * 只声明真正必需的：`sessions`（定位会话/flush）与 `tools`（注册模型工具）。
 * 其余（`agents`、`connection`、`commands`）用可选注入，缺失时降级而不是
 * 让整机加载失败（headless 组合没有 connection，插件仍应可用）。
 */
export const inject = ['sessions', 'tools']

/** 部署期配置由插件自有 data/config.json 承担，故不声明 schema。 */
export const Config = undefined

/**
 * 当前进程的语言同步函数（模块级，**不挂在 ctx 上**）。
 *
 * ★ 为什么用模块级而不是 `ctx.tickSyncLocale`：cordis 的 ctx 受保护，
 *   挂未 `provide` 的属性会抛 `cannot set property … without provide`
 *   并让**整个 DSH 起不来**。
 *
 * @type {(() => 'zh'|'en') | null}
 */
let currentSyncLocale = null

/**
 * 刷新 domain / framing 的文案语言（供其它模块按需调用）。
 * 未装配时是 no-op。
 * @returns 当前语言。
 */
export function syncTickLocale() {
  return currentSyncLocale === null ? 'zh' : currentSyncLocale()
}

/**
 * 插件主体。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  ctx.logger.info('[tick] 初始化中')

  /**
   * 共享状态（在配置就绪后填充）。
   *
   * ★ 必须**声明在使用它的函数之前**：`syncLocale()` / `syncFramingTemplates()`
   *   会读 `shared.config`，而它们在本函数早期就被调用。若把它声明在下面，
   *   会命中 `const` 的暂时性死区（TDZ），抛
   *   `ReferenceError: Cannot access 'shared' before initialization`
   *   —— 后果是 **apply 整体失败、插件完全不工作**。
   */
  const shared = {
    store: undefined,
    service: undefined,
    runtimes: undefined,
    config: undefined,
  }

  /**
   * ★ 语言同步：把当前语言刷进 domain / framing 的 module 级 translator。
   *
   * 为什么需要：这两个模块是**纯函数层**（不持有 ctx），文案用 module 级
   * translator（默认中文）。这里在装配时、以及语言可能变化的每个入口
   * （工具调用、命令调用、注入前）刷新一次，保证输出语言跟随用户选择。
   *
   * 探测途径：官方 locale 客户端会把用户选择写进 settings 的 `locale.preference`
   * （实读 `LocaleRuntime.setLocale()` 结尾 `host.set('preference', id)`），
   * 宿主用官方 `ctx.settings.get('locale')` 读回。
   *
   * @returns 当前语言 `'zh'` | `'en'`。
   */
  const syncLocale = () => {
    const locale = detectLocale(ctx)
    setDomainLocale(locale)
    /**
     * ★★ 注意：**framing 不再跟随 UI 语言**。
     *
     * 注入给模型的提示词语言现在由配置项 `serverPromptLanguage` 决定
     * （默认 `'en'`，与官方 goal / todo / schedule 的硬编码英文一致）。
     * 这里只在"非 custom"档时把内置模板刷成选定语言；
     * custom 档由下面的 `syncFramingTemplates()` 负责。
     */
    if (shared.config?.serverPromptLanguage !== 'custom') {
      setFramingLocale(shared.config?.serverPromptLanguage === 'zh' ? 'zh' : 'en')
    }
    return locale
  }

  /**
   * ★ 按配置把注入模板源切到正确的档位。
   *
   * - `'zh'` / `'en'` → 取内置模板（同步，无需读盘）；
   * - `'custom'`       → 实时读 `data/inject-templates.json`（**每次注入前**读，
   *                      这样用户改完模板无需重启 DSH 即生效）；
   *                      任何错误都由 templates.js 内部复原为 en 并记录序号。
   *
   * @returns 生效的档位。
   */
  const syncFramingTemplates = async () => {
    const mode = shared.config?.serverPromptLanguage
    if (mode !== 'custom') {
      setFramingTemplates(builtinTemplates(mode === 'zh' ? 'zh' : 'en'))
      return mode === 'zh' ? 'zh' : 'en'
    }
    const templates = await loadCustomTemplates((message) => ctx.logger.warn(`[tick] ${message}`))
    setFramingTemplates(templates)
    return 'custom'
  }
  // 装配时先同步一次（此后各入口会再刷）。
  syncLocale()

  /**
   * ★ 捕获 settings 服务引用（**必须在 inject 作用域内取**）。
   *
   * `ctx.get('settings')` 在插件根 ctx 上会抛
   * `cannot get property "settings" without inject`（cordis 的注入纪律）。
   * 因此这里用官方的 `ctx.inject(['settings'], …)` 拿一次引用交给 i18n 模块，
   * 之后 `detectLocale()` 就能安全读取 `locale.preference`。
   *
   * 用可选注入（不是静态 inject）：headless 等组合可能没有 settings，
   * 那时保持中文即可，**不能因此让插件加载失败**。
   */
  ctx.inject(['settings'], (sctx) => {
    try {
      installLocaleSettings(sctx.get('settings'))
      // 拿到服务后立刻按真实语言刷新一次（装配早期可能是英文用户）。
      syncLocale()
      // 语言切换会写 settings → 监听其变化即时跟随。
      const settings = sctx.get('settings')
      if (typeof settings?.watch === 'function') {
        const dispose = settings.watch(() => {
          syncLocale()
        })
        if (typeof dispose === 'function') ctx.effect(() => dispose, 'tick: locale watch')
      }
    } catch (error) {
      ctx.logger.warn(
        `[tick] 装配 locale 读取失败，按中文继续：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })

  // ⚠ **绝不能**在 cordis ctx 上挂自定义属性：
  //   `ctx.tickSyncLocale = …` 会抛
  //     `cannot set property "tickSyncLocale" without provide`
  //   并导致**整个 DSH 启动失败**（plugin tree failed to load）。
  //   实测被真实启动自检抓到（RESULT: FAIL-probe-tick）。
  //   改用模块级引用即可（同一进程内全局唯一，无需挂在 ctx 上）。
  currentSyncLocale = syncLocale

  /** ★ 配置就绪屏障：读盘与用配置之间必须有显式同步，避免与同步 inject 回调竞态。 */
  const configReady = (async () => {
    try {
      await ensureDirs()
      const swept = await sweepTmp()
      if (swept > 0) ctx.logger.info(`[tick] 清理了 ${swept} 个残留临时文件`)
      const read = await readJsonStrict(PATHS.config)
      if (read.kind === 'corrupt') {
        ctx.logger.warn('[tick] data/config.json 损坏，已按默认值继续（原文件改名保留）')
        const { rename } = await import('node:fs/promises')
        await rename(PATHS.config, `${PATHS.config}.corrupt-${Date.now()}`).catch(() => {})
      }
      const stored = read.kind === 'ok' ? read.value : undefined
      const config = readConfig(stored)
      if (read.kind === 'missing' || read.kind === 'corrupt') {
        await writeJson(PATHS.config, config)
        ctx.logger.info('[tick] 已写入默认配置 data/config.json（三道闸等可在此调整）')
      }
      return config
    } catch (error) {
      ctx.logger.warn(`[tick] 配置初始化失败，回退默认值：${error instanceof Error ? error.message : String(error)}`)
      return readConfig(undefined)
    }
  })()
  configReady.catch(() => {})

  /**
   * 取某会话当前 live 的 agent。
   *
   * 用 `ctx.get('agents')` 而不是静态 inject：agents 服务在 web 组合里存在，
   * 但 headless 场景可能没有；拿不到就返回 undefined，让上层按"冷会话"处理。
   * @param sessionId - 会话 id。
   * @returns live agent 或 undefined。
   */
  const getAgent = (sessionId) => {
    try {
      const agents = ctx.get('agents')
      if (agents === undefined || typeof agents.get !== 'function') return undefined
      return agents.get(sessionId)
    } catch {
      // ctx.get 在未注入时会抛 "cannot get property ... without inject"。
      return undefined
    }
  }

  /**
   * 任务变更后的处理：重建该会话的调度器，让新设定立刻生效。
   * @param sessionId - 会话 id。
   */ const onChanged = (sessionId) => {
    try {
      shared.runtimes?.ensure(sessionId)
    } catch (error) {
      ctx.logger.warn(`[tick] 重建调度器失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 主装配：在配置就绪后建立各部件（各自 try/catch，互不拖累） ──────────
  ctx.effect(() => {
    let disposed = false
    let disposeRpc = () => {}
    let disposeHealth = () => {}
    let disposeTools = () => {}
    let disposeCommand = () => {}

    void (async () => {
      const config = await configReady
      if (disposed) return
      shared.config = config

      const store = new TaskStore(ctx, config)
      shared.store = store
      const service = new TickService({
        ctx,
        store,
        config,
        getAgent,
        onChanged,
        /**
         * 注入模板的"复原事件"读取器 —— 见 templates.js 与 rpc.js。
         * 只回 `{seq, reason}`（**不含文案**）：文案由客户端按 UI 语言渲染。
         */
        templateReset: () => ({ seq: getResetSeq(), reason: getLastReset()?.reason ?? null }),
        /** 注入前刷新模板（custom 档实时读取）。 */
        beforeInject: () => syncFramingTemplates(),
      })
      shared.service = service
      const runtimes = new RuntimeManager({
        ctx,
        store,
        config,
        getAgent,
        onChanged,
        /** 到点注入前同样刷新模板 —— 保证"改完模板即生效、无需重启"。 */
        onBeforeInject: () => syncFramingTemplates(),
      })
      shared.runtimes = runtimes

      // ⓪ 注入模板源（必须早于任何可能触发注入的部件）
      try {
        const mode = await syncFramingTemplates()
        ctx.logger.info(
          `[tick] 注入语言档位：${mode}` +
            (mode === 'custom' ? `（自定义模板，复原次数 ${getResetSeq()}）` : ''),
        )
      } catch (error) {
        // 兜底：绝不让模板装配失败拖垮整个插件。
        setFramingTemplates(builtinTemplates('en'))
        ctx.logger.warn(`[tick] 注入模板装配失败，回退英文内置模板：${error instanceof Error ? error.message : String(error)}`)
      }

      // ① 模型工具（全局注册：不受"加载后才创建 root agent"的限制）
      try {
        disposeTools = registerTickTools({ ctx, service })
        ctx.logger.info('[tick] 已注册 7 个模型工具')
      } catch (error) {
        ctx.logger.warn(`[tick] 工具注册失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // ② 管理 RPC（connection 通道：只负责面板与工具的读写）
      /** 供健康端点与诊断使用的可观测事实。 */
      const describe = () => ({
        ready: shared.store !== undefined,
        runtimes: shared.runtimes?.size ?? 0,
        guards: {
          maxTasksPerSession: config.maxTasksPerSession,
          maxActivePerSession: config.maxActivePerSession,
          maxInjectionsPerMinute: config.maxInjectionsPerMinute,
        },
      })

      try {
        ctx.inject(['connection'], (cctx) => {
          const connection = cctx.get('connection')
          disposeRpc = installManagementRpc({ ctx, connection, service, describe }).dispose
        })
      } catch (error) {
        ctx.logger.warn(`[tick] RPC 注册失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // ②b 健康端点（webServer 通道：独立注入链，且必须在 /api 之外，
      //     探针/curl 才能直接访问；详见 rpc.js 的 HEALTH_PATH 注释）
      try {
        ctx.inject(['webServer'], (wctx) => {
          disposeHealth = installHealth({ ctx, webServer: wctx.get('webServer'), describe })
        })
      } catch (error) {
        ctx.logger.warn(`[tick] 健康端点装配失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // ③ /schedule 命令
      try {
        ctx.inject(['commands'], (cctx) => {
          disposeCommand = registerScheduleCommand({ ctx: cctx, service })
          ctx.logger.info('[tick] 已注册 /schedule 命令')
        })
      } catch (error) {
        ctx.logger.warn(`[tick] 命令注册失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // ④ 会话生命周期：会话被创建/加载时按需建立调度器（不扫描全量会话）
      try {
        ctx.inject(['sessions'], (sctx) => {
          const sessions = sctx.get('sessions')
          // 已有会话：只在**确实有任务**时才建调度器（惰性，避免无谓读盘）。
          for (const session of sessions.list()) {
            const sessionId = String(session.id)
            void store
              .load(sessionId, Date.now())
              .then((tasks) => {
                if (!disposed && tasks.length > 0) runtimes.ensure(sessionId)
              })
              .catch(() => {
                /* 单会话失败不影响其它 */
              })
          }
          // 新会话：挂监听，出现任务后由 onChanged 建立调度器。
          ctx.on('session/created', (session) => {
            if (disposed) return
            const sessionId = String(session.id)
            void store
              .load(sessionId, Date.now())
              .then((tasks) => {
                if (!disposed && tasks.length > 0) runtimes.ensure(sessionId)
              })
              .catch(() => {})
          })
        })
      } catch (error) {
        ctx.logger.warn(`[tick] 会话监听注册失败：${error instanceof Error ? error.message : String(error)}`)
      }

      ctx.logger.info(
        `[tick] 就绪：闸位 上限${config.maxTasksPerSession}/会话 · ` +
          `同时启用${config.maxActivePerSession} · 注入${config.maxInjectionsPerMinute}/分钟`,
      )
    })().catch((error) => {
      ctx.logger.warn(`[tick] 装配失败：${error instanceof Error ? error.message : String(error)}`)
    })

    return () => {
      disposed = true
      try {
        disposeCommand()
      } catch {
        /* 释放失败不影响卸载 */
      }
      try {
        disposeTools()
      } catch {
        /* 同上 */
      }
      try {
        disposeRpc()
      } catch {
        /* 同上 */
      }
      try {
        disposeHealth()
      } catch {
        /* 同上 */
      }
      try {
        shared.runtimes?.dispose()
      } catch {
        /* 同上 */
      }
    }
  }, 'tick: wiring')
}
