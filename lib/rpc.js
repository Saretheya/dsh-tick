/**
 * Tick（定时任务）— 管理 RPC 通道（Host 侧）。
 *
 * ⚠ 本模块采用**已验证可用**的 RPC 范式，
 *   两个约束都是踩坑换来的，不可改：
 *
 *   1. **必须用 `connection.fetch.register`**，不能用 `webServer.register`。
 *      前端 `ctx.connection.rpc.call('/api', endpoint, …)` 走的是 DSH 自身的
 *      RPC 信封协议 `{type:'client-request', rpcId, method, payload}`，
 *      只有 `connection.fetch.register` 认领它；用 webServer 注册会拿不到信封，
 *      界面表现为**「面板点不动 / 无反应」**。
 *
 *   2. **响应必须含 `type: 'server-response'`**（且错误分支补 `details: {}`）。
 *      缺了它，client 侧抛 `connection: invalid server-response envelope`，
 *      界面表现为**永远卡在"读取中…"**，且浏览器控制台无报错——极难排查。
 *
 * @module dsh-tick/rpc
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { TickInputError } from './domain.js'
import { PACKAGE_ROOT } from './storage.js'

/** RPC 端点路径（必须以 /api 开头，由 connection 闸门认领）。 */
export const RPC_PATH = '/api/tick'

/** RPC 方法名（前端与宿主必须一致）。 */
export const RPC_METHOD = 'tick'

/**
 * 健康检查路径。
 *
 * ★ 为什么**不放在 `/api` 下**：`/api` 是 `dsh-client-connection` 的保留前缀，
 *   它先做 Host/Origin + 浏览器鉴权闸门，**未带浏览器凭据的请求一律 401**
 *   （实测：curl 打任何 `/api/*` 都是 401，哪怕路由存在）。
 *   若健康端点放在 `/api` 下，启动自检探针拿到的是 401，**无法区分
 *   "插件正常工作" 与 "被闸门拦下"**，探针就失去意义。
 *   因此它挂在 `webServer` 的独立路径上，可被探针/curl 直接访问。
 *
 * ★ 为什么必须有健康端点：—**纯通用层的启动自检看不到
 *   `apply()` 故障**（`import` 成功、端口在听、HTTP 有响应，但插件毫无功能）。
 *   只有插件自己暴露的可观测端点才能证明它真的在工作。
 *
 * 安全：只回最少的存活信息（不含路径、配置、会话 id），
 * 且**不依赖任何开关**（否则"未启用"时 404 会被误判成"加载失败"）。
 */
export const HEALTH_PATH = '/dsh-tick/health'

/**
 * 从 `package.json` 读取的真实版本号（**不再硬编码**）。
 *
 * ★ 为什么必须动态读：此前这里写死 `'0.1.0'`，而发布版早已推进到 1.0.1 ——
 *   健康端点于是**永远报一个过期版本号**，属"配置值 ≠ 生效值"同类问题：
 *   HTTP 200、结构合法、字段齐全，**只有那个数字在撒谎**，会误导启动自检与人工排查。
 *
 * ★ 读取失败时的兜底：返回 `'unknown'` 而**不抛错**——
 *   健康端点的第一职责是"证明插件活着"，绝不能因为读不到版本号而让自己挂掉。
 *   （`'unknown'` 是显式的"未知"，比编造一个数字诚实。）
 *
 * @returns 版本字符串。
 */
export function pluginVersion() {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const v = parsed?.version
    return typeof v === 'string' && v.length > 0 ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 健康端点的响应体（刻意最小化，避免不必要的暴露）。 */
export function healthPayload(describe) {
  const body = { ok: true, plugin: 'tick', version: pluginVersion() }
  if (typeof describe === 'function') {
    try {
      const extra = describe()
      if (extra !== null && typeof extra === 'object') body.state = extra
    } catch {
      /* 描述函数失败不影响"存活"这一事实 */
    }
  }
  return body
}

/**
 * 安装管理通道。
 *
 * @param options - 安装参数。
 * @param options.ctx - Host 插件上下文。
 * @param options.connection - **已注入**的 connection 服务（不可在未 inject 时 ctx.get）。
 * @param options.service - TickService 实例。
 * @returns `{ installed, dispose }`。
 */
export function installManagementRpc(options) {
  const { ctx, connection, service } = options

  /**
   * 读"自定义模板复原"事件。
   *
   * ★ 走 service 暴露的读取器（而不是直接 import templates.js）：
   *   service 是唯一持有运行期状态的地方，且未来若把模板源换成别的实现，
   *   这里不必改。拿不到时返回安全的零值。
   * @returns `{seq, reason}`。
   */
  const templateResetState = () => {
    try {
      if (typeof service?.templateResetState === 'function') return service.templateResetState()
    } catch {
      /* 读不到就当作"从未复原"，不影响其余 RPC */
    }
    return { seq: 0, reason: null }
  }

  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[tick] connection.fetch 不可用，管理通道未注册（dock 面板将无法读写）')
    return { installed: false, dispose: () => {} }
  }

  /**
   * 构造规范响应（★ 必须含 type: 'server-response'）。
   * @param rpcId - 对应请求 id。
   * @param result - `{ok:true,value}` 或 `{ok:false,error}`。
   * @returns Response。
   */
  const reply = (rpcId, result) => {
    const value =
      result !== null && typeof result === 'object' && result.ok === false
        ? { ...result, error: { ...result.error, details: {} } }
        : result
    return new Response(JSON.stringify({ type: 'server-response', rpcId, result: value }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 分发一个管理方法。
   *
   * ★ 所有写操作都在这里统一做参数校验，且都调用 TickService 的同一批方法，
   *   避免出现"UI 拦住了、别处没拦住"的越权缺口。
   *
   * @param method - 方法名。
   * @param payload - 参数。
   * @returns `{ok:true,value}` 或 `{ok:false,error}`。
   */
  const dispatch = async (method, payload) => {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''

    // ★ 全局方法**不需要 sessionId**，必须在校验之前分流。
    //   `global`：跨会话汇总（侧栏入口）
    //   `ui`    ：UI 配置（侧栏入口与 dock 都可能在没有会话时读取）
    //   实测发现：`ui` 原来放在 sessionId 校验之后，于是侧栏组件以空 payload
    //   调它时被拒 → 客户端只能按"功能关闭"处理 → 侧栏入口永远不显示，
    //   而且**没有任何报错**（静默失效）。
    if (method === 'global' || method === 'ui') {
      try {
        if (method === 'global') return { ok: true, value: await service.globalSummary() }
        return {
          ok: true,
          value: {
            showDock: service.config?.showDock !== false,
            // 侧栏底部汇总入口（默认关闭，见 config.js 的说明）
            showSidebarSummary: service.config?.showSidebarSummary === true,
            allowAiCreate: service.config?.allowAiCreate !== false,
            /**
             * ★ 自定义模板"复原"事件（供客户端弹 toast）。
             *
             * 设计：Host 只知道**发生了什么**（一个单调递增的序号 + 错误码），
             * 不知道该怎么措辞 —— 文案由客户端用自己的 UI 语言渲染。
             * 这样提示文案天然跟随 UI 语言（中文用户中文、其余英文），
             * 而 Host 侧无需知道 UI 语言（Host 侧拿不到 navigator.language）。
             *
             * 客户端按序号去重：只对"比上次见过的大"的序号提示一次。
             */
            templateReset: templateResetState(),
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[tick] RPC ${method} 失败：${message}`)
        return { ok: false, error: { code: 'handler-failed', message } }
      }
    }

    if (sessionId.length === 0) {
      return { ok: false, error: { code: 'bad-request', message: '缺少 sessionId。' } }
    }

    try {
      switch (method) {
        case 'list': {
          const tasks = await service.list(sessionId)
          const summary = await service.summary(sessionId)
          /**
           * `list` 是被**定期轮询**的方法（展开 2s / 折叠 15s），
           * 因此把"模板复原事件"挂在这里下发 —— 客户端每轮比对序号即可，
           * 不需要任何新的推送通道。
           */
          return { ok: true, value: { tasks, summary, templateReset: templateResetState() } }
        }
        case 'summary':
          return { ok: true, value: await service.summary(sessionId) }
        case 'create':
          return { ok: true, value: await service.create(sessionId, input.task ?? {}, 'user') }
        case 'update':
          return {
            ok: true,
            value: await service.update(sessionId, String(input.id ?? ''), input.patch ?? {}),
          }
        case 'pause':
          return { ok: true, value: await service.pause(sessionId, String(input.id ?? '')) }
        case 'resume':
          return { ok: true, value: await service.resume(sessionId, String(input.id ?? '')) }
        case 'run':
          return { ok: true, value: await service.runNow(sessionId, String(input.id ?? '')) }
        case 'remove':
          return { ok: true, value: { removed: await service.remove(sessionId, String(input.id ?? '')) } }
        default:
          return { ok: false, error: { code: 'unknown_method', message: `未知方法：${String(method)}` } }
      }
    } catch (error) {
      if (error instanceof TickInputError) {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[tick] RPC ${String(method)} 失败：${message}`)
      // 必须返回规范 RPC 错误响应（不是裸 500），否则前端表现为"点击无反应"。
      return { ok: false, error: { code: 'handler-failed', message } }
    }
  }

  const registration = connection.fetch.register({
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload
      if (
        message.type !== 'client-request' ||
        typeof message.rpcId !== 'string' ||
        message.method !== RPC_METHOD ||
        !call ||
        typeof call.method !== 'string' ||
        !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, {
          ok: false,
          error: { code: 'bad-request', message: 'Invalid tick management request.' },
        })
      }
      const result = await dispatch(call.method, call.payload)
      return reply(rpcId, result)
    },
  })

  return {
    installed: true,
    dispose: () => {
      try {
        registration?.()
      } catch {
        /* 释放失败不影响卸载 */
      }
    },
  }
}

/**
 * 单独安装健康端点（与 `connection` 无关，只依赖 `webServer`）。
 *
 * ★ 为什么是独立函数：健康端点走的是 `webServer`，与管理 RPC 的 `connection`
 *   是**两条不同的注入链**。若把它塞进 `connection` 的注入回调里，
 *   就要求那一条链上已经能取到 `webServer` —— 实测拿不到（返回 404）。
 *   拆开后各自 `ctx.inject` 自己的服务，互不依赖。
 *
 * @param options - 安装参数。
 * @param options.ctx - Host 插件上下文（仅用于日志）。
 * @param options.webServer - 宿主的 webServer 服务。
 * @param options.describe - 可选，返回可观测事实。
 * @returns 释放函数（注册失败时返回 no-op）。
 */
export function installHealth(options) {
  const { ctx, webServer, describe } = options
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger.warn('[tick] webServer 不可用，健康端点未注册（不影响面板与工具）')
    return () => {}
  }
  try {
    return webServer.register({
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const body = JSON.stringify(healthPayload(describe))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    })
  } catch (error) {
    ctx.logger.warn(`[tick] 健康端点注册失败：${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
}
