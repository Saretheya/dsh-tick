/**
 * Tick（定时任务）— `/schedule` 聊天框命令。
 *
 * 照官方 `/goal` 的实现范式（`dsh-command-goal/lib/index.js`）：
 *   - `ctx.commands.register({ name, description, input:{hint}, handler })`
 *   - handler 拿到的 `invocation` 提供 `agent`（精确的接收 agent）、`rawInput`、
 *     `attachments`、`signal`；
 *   - 返回 `{ kind:'success'|'error', text }` 作为**直接 UI 输出**（不发给模型）。
 *
 * ⚠ 命令名必须匹配 `^[a-z][a-z0-9_-]*$`——**不能含冒号**。生态实测：
 *   `user-schedule:create` 因无法通过 `parseCommand` 而**静默不执行**（命令敲了没反应）。
 *
 * @module dsh-tick/command
 */
import { TickInputError } from './domain.js'
import { createTranslator, detectLocale } from './i18n.js'

/** 用法提示（按语言生成）。 */
function usage(t) {
  return t('cmd.usage')
}

/**
 * 解析 `/schedule` 的输入。
 *
 * 支持的语法（面向人类，尽量宽容）：
 *   list                        列出任务
 *   remove|pause|resume|run <id>  对指定任务操作
 *   <时间> <内容>                新建任务
 *
 * 时间写法：
 *   +30s / +5m / +2h / +1h30m   延迟（相对时长）
 *   every 30m <内容>            重复
 *   @2026-09-20T15:00:00+08:00 <内容>  绝对时刻
 *
 * @param rawInput - 命令名之后的原始文本。
 * @param t - 翻译函数（默认中文，保证未传时行为同改造前）。
 * @returns 解析结果。
 */
export function parseScheduleInput(rawInput, t = createTranslator('zh')) {
  const input = String(rawInput ?? '').trim()
  if (input.length === 0) return { kind: 'help' }

  // ★ 用"首个空白的位置"切分，而不是 split(/\s+/) + join(' ')——
  //   后者会把内容里的连续空格与换行压成单个空格，
  //   而任务内容可能是代码片段或保留缩进的文本，必须原样保留。
  const firstSpace = input.search(/\s/u)
  const head = firstSpace < 0 ? input : input.slice(0, firstSpace)
  const remainderRaw = firstSpace < 0 ? '' : input.slice(firstSpace + 1).trim()
  const toks = remainderRaw.length === 0 ? [] : remainderRaw.split(/\s+/u)
  const lower = head.toLowerCase()

  if (lower === 'list' || lower === 'ls') return { kind: 'list' }
  if (lower === 'remove' || lower === 'rm' || lower === 'delete' || lower === 'del') {
    const id = toks[0]
    return id === undefined ? { kind: 'invalid', message: t('common.needId') } : { kind: 'remove', id }
  }
  if (lower === 'pause') {
    const id = toks[0]
    return id === undefined ? { kind: 'invalid', message: t('common.needId') } : { kind: 'pause', id }
  }
  if (lower === 'resume') {
    const id = toks[0]
    return id === undefined ? { kind: 'invalid', message: t('common.needId') } : { kind: 'resume', id }
  }
  if (lower === 'run' || lower === 'now') {
    const id = toks[0]
    return id === undefined ? { kind: 'invalid', message: t('common.needId') } : { kind: 'run', id }
  }
  if (lower === 'every') {
    // every 的间隔是第二个 token，其余全部是内容（保留原文空白）。
    const spec = toks[0]
    if (spec === undefined) {
      return { kind: 'invalid', message: `${t('cmd.needContentPeriodic')}\n${usage(t)}` }
    }
    const afterSpec = remainderRaw.slice(remainderRaw.indexOf(spec) + spec.length).trim()
    if (afterSpec.length === 0) {
      return { kind: 'invalid', message: `${t('cmd.needContentPeriodic')}\n${usage(t)}` }
    }
    const seconds = parseDuration(spec)
    if (seconds === null) return { kind: 'invalid', message: t('cmd.badInterval', { spec }) }
    return { kind: 'create', selector: { intervalSeconds: seconds }, prompt: afterSpec }
  }

  // 绝对时刻：@RFC3339
  if (head.startsWith('@')) {
    if (remainderRaw.length === 0) return { kind: 'invalid', message: `${t('cmd.needContentAt')}\n${usage(t)}` }
    return { kind: 'create', selector: { scheduledAt: head.slice(1) }, prompt: remainderRaw }
  }

  // 相对时长：+30m
  const seconds = parseDuration(head)
  if (seconds !== null) {
    if (remainderRaw.length === 0) return { kind: 'invalid', message: `${t('cmd.needContentAfter')}\n${usage(t)}` }
    return { kind: 'create', selector: { afterSeconds: seconds }, prompt: remainderRaw }
  }

  return { kind: 'invalid', message: `${t('cmd.badTime', { head })}\n${usage(t)}` }
}

/**
 * 解析一个时长串（如 `+1h30m`、`30s`、`5m`、`2h`）为秒。
 * @param spec - 时长串。
 * @returns 秒数；无法识别时返回 null。
 */
export function parseDuration(spec) {
  const text = String(spec ?? '').replace(/^\+/u, '').trim()
  if (text.length === 0) return null
  // 纯数字视为分钟（对人类最自然）。
  if (/^\d+$/u.test(text)) {
    const minutes = Number.parseInt(text, 10)
    return minutes > 0 ? minutes * 60 : null
  }
  // ★ 这里的中文单位（小时/分钟/秒）是**输入语法**，不是输出文案 —— 刻意不翻译。
  //   它们是"用户可以直接敲的中文写法"，两种语言下都应被接受
  //   （英文用户敲 `1h30m` 即可，中文用户也可敲 `1小时30分钟`）。
  const pattern = /(\d+)\s*(h|m|s|小时|分钟|秒)/gu
  let total = 0
  let matched = false
  let consumed = 0
  for (const match of text.matchAll(pattern)) {
    matched = true
    consumed += match[0].length
    const n = Number.parseInt(match[1], 10)
    const unit = match[2]
    if (unit === 'h' || unit === '小时') total += n * 3600
    else if (unit === 'm' || unit === '分钟') total += n * 60
    else total += n
  }
  // 允许单位之间有空格，但不允许有未识别的残留字符（否则是拼错了）。
  const residue = text.replace(pattern, '').trim()
  if (!matched || residue.length > 0) return null
  void consumed
  return total > 0 ? total : null
}

/**
 * 渲染列表文本。
 * @param tasks - 任务视图数组。
 * @param t - 翻译函数（默认中文）。
 * @returns 文本。
 */
function renderTasks(tasks, t = createTranslator('zh')) {
  if (tasks.length === 0) return t('cmd.noTasks')
  const lines = tasks.map((task) => {
    const when = new Date(task.scheduledAt).toLocaleString()
    const mode =
      task.kind === 'after'
        ? `${t('mode.after')} ${task.afterSeconds}s`
        : task.kind === 'periodic'
          ? `${t('desc.periodic', { n: task.intervalSeconds })}`
          : t('mode.atShort')
    const status = t(`status.${task.status}`)
    return `${task.id}  [${status}] ${mode} → ${when}\n    ${task.prompt}`
  })
  return `${t('cmd.listHeader', { n: tasks.length })}\n${lines.join('\n')}`
}

/**
 * 注册 `/schedule` 命令。
 *
 * @param options - 注册参数。
 * @param options.ctx - **已注入 commands** 的上下文。
 * @param options.service - TickService 实例。
 * @returns 释放函数。
 */
export function registerScheduleCommand(options) {
  const { ctx, service } = options

  // 命令的 description / hint 在注册时确定，而语言可能之后才变。
  // 注册时按当前语言取一次即可——命令列表是"发现 UI"，不要求实时跟随。
  const initialT = createTranslator(detectLocale(ctx))

  const registration = ctx.commands.register({
    name: 'schedule',
    description: initialT('cmd.description'),
    input: {
      hint: '[<+duration>|<@instant>|every <interval>|list|remove|pause|resume|run <id>] [content]',
    },
    handler: async (invocation) => {
      // ★ 每次调用都重新探测语言：用户可能在两次调用之间切换了语言。
      const t = createTranslator(detectLocale(ctx))
      const agent = invocation.agent
      if (agent === undefined) {
        return { kind: 'error', text: t('cmd.noSession') }
      }
      const sessionId = String(agent.session.id)
      const parsed = parseScheduleInput(invocation.rawInput, t)

      try {
        switch (parsed.kind) {
          case 'help':
            return { kind: 'success', text: `${usage(t)}\n\n${t('cmd.help')}` }
          case 'invalid':
            return { kind: 'error', text: parsed.message }
          case 'list':
            return { kind: 'success', text: renderTasks(await service.list(sessionId), t) }
          case 'create': {
            const task = await service.create(sessionId, { prompt: parsed.prompt, ...parsed.selector }, 'user')
            return {
              kind: 'success',
              text: t('cmd.created', {
                id: task.id,
                kind: task.kind,
                when: new Date(task.scheduledAt).toLocaleString(),
                prompt: task.prompt,
              }),
            }
          }
          case 'remove':
            await service.remove(sessionId, parsed.id)
            return { kind: 'success', text: t('cmd.deleted', { id: parsed.id }) }
          case 'pause':
            await service.pause(sessionId, parsed.id)
            return { kind: 'success', text: t('cmd.paused', { id: parsed.id }) }
          case 'resume':
            await service.resume(sessionId, parsed.id)
            return { kind: 'success', text: t('cmd.resumed', { id: parsed.id }) }
          case 'run':
            await service.runNow(sessionId, parsed.id)
            return { kind: 'success', text: t('cmd.ran', { id: parsed.id }) }
          default:
            return { kind: 'error', text: usage(t) }
        }
      } catch (error) {
        if (error instanceof TickInputError) return { kind: 'error', text: `${error.message}` }
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[tick] /schedule failed: ${message}`)
        return { kind: 'error', text: t('cmd.failed', { message }) }
      }
    },
  })

  return () => {
    try {
      if (typeof registration === 'function') registration()
    } catch {
      /* 注销失败不影响卸载 */
    }
  }
}
