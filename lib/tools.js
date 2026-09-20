/**
 * Tick（定时任务）— 面向模型的工具。
 *
 * 设计要点：
 *   1. **全局注册**（host 平面），不在 agent 作用域注册——官方 dsh-schedule 只给
 *      "加载后创建的 root agent"装工具，因此**加载前已存在的会话拿不到工具**。
 *      我们在插件根 ctx 上注册，对所有会话可见，不受加载顺序影响。
 *   2. **用 `exec.agent` 定位调用者会话**（`exec.agent.session.id`），
 *      实现"在哪个会话里建，就在哪个会话里触发"。
 *   3. **无 agent 的调用直接拒绝**（程序化 `ctx.tools.execute()` 没有会话，
 *      没有会话就没有可注入的目标，必须显式失败而不是静默）。
 *   4. description 内嵌**自然语言→结构化参数的转换指引**，提升模型正确调用率。
 *   5. 返回值是**规范 JSON 值**，人话交给 `output.render`——不让调用方从散文里抠 id。
 *
 * ⚠ schema DSL 约束（踩过的坑）：这是**作者侧 DSL**，不是裸 JSON Schema。
 *   - 必填是**逐属性的 `required: true`**，**不是** `required: [...]` 数组
 *     （写成数组会抛 `JsonSchemaError: schema.required is not supported by the
 *     value schema DSL`，导致整批工具注册失败）；
 *   - 对象节点必须显式给 `additionalProperties`。
 *
 * @module dsh-tick/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { TickInputError } from './domain.js'
import { createTranslator, detectLocale } from './i18n.js'

/** 三种模式的 selector 字段名（用于 update 的互斥校验与错误提示）。 */
const SELECTORS = ['afterSeconds', 'intervalSeconds', 'scheduledAt']

/**
 * 可空的数字字段（DSL 无 `nullable`，用 `oneOf` 表达）。
 *
 * ★ 存在的理由：「某个模式不适用时该字段为 `null`」是领域层的既定表示
 *   （见 `domain.js` 的 `taskView`）。若 schema 只写 `number`，
 *   宿主校验**返回值**时会拒绝整个工具调用，而插件内部完全察觉不到。
 */
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }

/** 可空的字符串字段（同上）。 */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** 复用的任务视图 output schema（对象，逐属性 required）。 */
const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    status: { type: 'string', required: true },
    scheduledAt: { type: 'string', required: true },
    // ★★ 这两个字段必须**可空**：`taskView` 里非该模式时它们是 `null`
    //   （如 after 任务的 intervalSeconds === null）。
    //   写成裸 `type:'number'` 会让宿主在**校验返回值时**拒绝整个工具调用：
    //       tool "tick_create" returned invalid output:
    //       "value.task.intervalSeconds" must be a number
    //   ——而插件内部测试与 `execute` 都察觉不到（宿主才做这一步校验）。
    //   DSL 无 `nullable`，正确写法是 `oneOf`（已实测：接受数字、接受 null、
    //   字段缺失也通过）。
    intervalSeconds: NULLABLE_NUMBER,
    afterSeconds: NULLABLE_NUMBER,
    remainingMs: NULLABLE_NUMBER,
    doneAt: NULLABLE_STRING,
    lastFiredAt: NULLABLE_STRING,
  },
}

/**
 * 把领域错误转成**模型可读**的稳定 JSON 值（不抛异常，让模型能自我纠正）。
 * @param error - 捕获到的错误。
 * @param t - 翻译函数（默认中文）。
 * @returns `{ok:false, code, message}`。
 */
function toFailure(error, t = createTranslator('zh')) {
  if (error instanceof TickInputError) {
    return { ok: false, code: error.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'internal_error', message: t('cmd.failed', { message }) }
}

/**
 * 渲染一条任务的单行人话。
 * @param task - 任务视图。
 * @param t - 翻译函数（默认中文）。
 * @returns 文本。
 */
function describeTask(task, t = createTranslator('zh')) {
  const when = new Date(task.scheduledAt).toLocaleString()
  const mode =
    task.kind === 'after'
      ? t('desc.after', { n: task.afterSeconds })
      : task.kind === 'periodic'
        ? t('desc.periodic', { n: task.intervalSeconds })
        : t('mode.atShort')
  const statusText = t(`status.${task.status}`)
  return `[${task.id}] ${statusText} · ${mode} · ${when} · ${task.prompt}`
}

/**
 * 注册全部定时任务工具。
 *
 * @param options - 注册参数。
 * @param options.ctx - 宿主上下文（须已注入 tools）。
 * @param options.service - TickService 实例。
 * @returns 释放函数（注销全部工具）。
 */
export function registerTickTools(options) {
  const { ctx, service } = options
  /** 逐个登记，任一失败要整体回滚（避免留下半个工具集）。 */
  const disposers = []

  /**
   * 翻译函数。
   *
   * ★ 两段式设计（因为工具的两类文案时机不同）：
   *   - **工具描述 / 参数说明**在 `register` 时求值一次并固定 → 用注册时的语言
   *     （官方插件的工具描述同样是静态的）。
   *   - **`render` 与错误消息**在**每次调用时**执行 → 这里动态探测语言，
   *     所以用户中途切换语言后，后续调用的回执会立刻跟随新语言。
   *
   * 实现：`t` 本身是"查当前语言再翻译"的函数；注册时立即求值的描述
   * 会捕获当时的结果，而 render 里的 `t(...)` 每次调用都重新解析。
   */
  let cached = createTranslator(detectLocale(ctx))
  ctx.on?.('locale/change', () => {
    cached = createTranslator(detectLocale(ctx))
  })
  const t = (key, params) => cached(key, params)

  /**
   * 取调用者会话 id；无 agent 直接抛错（工具必须给出明确失败）。
   * @param exec - 工具执行上下文。
   * @returns 会话 id 字符串。
   */
  const requireSession = (exec) => {
    const agent = exec.agent
    if (agent === undefined) {
      throw new TickInputError('no_agent', t('render.noAgent'))
    }
    return String(agent.session.id)
  }

  /** 统一的"成功/失败"输出 schema（逐属性 required）。 */
  const resultSchema = (extra) => ({
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      code: { type: 'string' },
      message: { type: 'string' },
      ...extra,
    },
  })

  /** 统一的渲染：成功说人话，失败给出码与原因。 */
  const renderResult = (okText) => (_args, value) =>
    value.ok === true
      ? [{ type: 'text', text: okText(value) }]
      : [{ type: 'text', text: t('render.fail', { code: value.code ?? 'unknown', message: value.message ?? t('common.unknownReason') }) }]

  try {
    // ───────────────────────── create ─────────────────────────
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'tick_create',
          description:
            t('tool.create.desc'),
          parameters: {
            prompt: { type: 'string', required: true, description: t('param.prompt') },
            afterSeconds: { type: 'number', description: t('param.afterSeconds') },
            intervalSeconds: { type: 'number', description: t('param.intervalSeconds') },
            scheduledAt: { type: 'string', description: t('param.scheduledAt') },
          },
          output: {
            schema: resultSchema({ task: TASK_SCHEMA }),
            render: renderResult((value) => t('render.created', { task: describeTask(value.task, t) })),
          },
          async execute(args, exec) {
            try {
              const sessionId = requireSession(exec)
              // ★ 不在此处自建校验：service.create 内部用领域层唯一的
              //   resolveSelector 做"恰好一种 selector"判定，保证与 RPC/UI 一致。
              const task = await service.create(sessionId, args, 'ai')
              return { ok: true, task }
            } catch (error) {
              return toFailure(error, t)
            }
          },
          presentCall: (args) => ({
            card: 'generic',
            title: 'Create scheduled task',
            kind: 'other',
            rawInput: args.prompt,
          }),
        }),
      ),
    )

    // ───────────────────────── list ─────────────────────────
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'tick_list',
          description:
            t('tool.list.desc'),
          parameters: {},
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                code: { type: 'string' },
                message: { type: 'string' },
                tasks: { type: 'array', required: true, items: { type: 'json' } },
                summary: { type: 'json', required: true },
              },
            },
            render: (_args, value) => {
              if (value.ok !== true) {
                return [{ type: 'text', text: t('render.fail', { code: value.code ?? 'unknown', message: value.message ?? t('common.unknownReason') }) }]
              }
              if (value.tasks.length === 0) return [{ type: 'text', text: t('render.noTasks') }]
              const lines = value.tasks.map((task) => describeTask(task, t))
              return [{ type: 'text', text: `${t('render.listHeader', { n: value.tasks.length })}\n${lines.join('\n')}` }]
            },
          },
          async execute(_args, exec) {
            try {
              const sessionId = requireSession(exec)
              const tasks = await service.list(sessionId)
              const summary = await service.summary(sessionId)
              return { ok: true, tasks, summary }
            } catch (error) {
              const failure = toFailure(error, t)
              return { ok: false, tasks: [], summary: {}, code: failure.code, message: failure.message }
            }
          },
          presentCall: () => ({ card: 'generic', title: 'List scheduled tasks', kind: 'read' }),
        }),
      ),
    )

    // ───────────────────────── update ─────────────────────────
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'tick_update',
          description:
            t('tool.update.desc'),
          parameters: {
            id: { type: 'string', required: true, description: t('param.id') },
            prompt: { type: 'string', description: t('param.newPrompt') },
            afterSeconds: { type: 'number', description: t('param.newAfterSeconds') },
            intervalSeconds: { type: 'number', description: t('param.newIntervalSeconds') },
            scheduledAt: { type: 'string', description: t('param.newScheduledAt') },
          },
          output: {
            schema: resultSchema({ task: TASK_SCHEMA }),
            render: renderResult((value) => t('render.updated', { task: describeTask(value.task, t) })),
          },
          async execute(args, exec) {
            try {
              const sessionId = requireSession(exec)
              const patch = {}
              if (args.prompt !== undefined) patch.prompt = args.prompt
              // ★ 时间字段的互斥由 service.update 内的领域层判据统一负责。
              for (const key of SELECTORS) {
                if (args[key] !== undefined && args[key] !== null) patch[key] = args[key]
              }
              const task = await service.update(sessionId, String(args.id), patch)
              return { ok: true, task }
            } catch (error) {
              return toFailure(error, t)
            }
          },
          presentCall: (args) => ({
            card: 'generic',
            title: 'Update scheduled task',
            kind: 'other',
            rawInput: args.id,
          }),
        }),
      ),
    )

    // ───────────────────────── pause ─────────────────────────
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'tick_pause',
          description:
            t('tool.pause.desc'),
          parameters: {
            id: { type: 'string', required: true, description: t('param.id') },
          },
          output: {
            schema: resultSchema({ task: TASK_SCHEMA }),
            render: renderResult((value) => t('render.paused', { task: describeTask(value.task, t) })),
          },
          async execute(args, exec) {
            try {
              const sessionId = requireSession(exec)
              return { ok: true, task: await service.pause(sessionId, String(args.id)) }
            } catch (error) {
              return toFailure(error, t)
            }
          },
          presentCall: (args) => ({ card: 'generic', title: 'Pause scheduled task', kind: 'other', rawInput: args.id }),
        }),
      ),
    )

    // ───────────────────────── resume ─────────────────────────
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'tick_resume',
          description:
            t('tool.resume.desc'),
          parameters: {
            id: { type: 'string', required: true, description: t('param.id') },
          },
          output: {
            schema: resultSchema({ task: TASK_SCHEMA }),
            render: renderResult((value) => t('render.resumed', { task: describeTask(value.task, t) })),
          },
          async execute(args, exec) {
            try {
              const sessionId = requireSession(exec)
              return { ok: true, task: await service.resume(sessionId, String(args.id)) }
            } catch (error) {
              return toFailure(error, t)
            }
          },
          presentCall: (args) => ({ card: 'generic', title: 'Resume scheduled task', kind: 'other', rawInput: args.id }),
        }),
      ),
    )

    // ───────────────────────── run now ─────────────────────────
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'tick_run_now',
          description:
            t('tool.runNow.desc'),
          parameters: {
            id: { type: 'string', required: true, description: t('param.id') },
          },
          output: {
            schema: resultSchema({ task: TASK_SCHEMA }),
            render: renderResult((value) => t('render.ran', { task: describeTask(value.task, t) })),
          },
          async execute(args, exec) {
            try {
              const sessionId = requireSession(exec)
              return { ok: true, task: await service.runNow(sessionId, String(args.id)) }
            } catch (error) {
              return toFailure(error, t)
            }
          },
          presentCall: (args) => ({
            card: 'generic',
            title: 'Run scheduled task now',
            kind: 'other',
            rawInput: args.id,
          }),
        }),
      ),
    )

    // ───────────────────────── remove ─────────────────────────
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'tick_remove',
          description: t('tool.remove.desc'),
          parameters: {
            id: { type: 'string', required: true, description: t('param.id') },
          },
          output: {
            schema: resultSchema({ removed: { type: 'boolean' } }),
            render: renderResult(() => t('render.removed')),
          },
          async execute(args, exec) {
            try {
              const sessionId = requireSession(exec)
              await service.remove(sessionId, String(args.id))
              return { ok: true, removed: true }
            } catch (error) {
              return toFailure(error, t)
            }
          },
          presentCall: (args) => ({ card: 'generic', title: 'Remove scheduled task', kind: 'other', rawInput: args.id }),
        }),
      ),
    )
  } catch (error) {
    // 任一注册失败 → 整体回滚，避免留下半个工具集（静默失效最难查）。
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* 回滚失败不掩盖原始错误 */
      }
    }
    throw error
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* 注销失败不影响插件卸载 */
      }
    }
  }
}
