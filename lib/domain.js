/**
 * Tick（定时任务）— 领域模型（纯函数，无 IO）。
 *
 * 三种模式
 *   after     延迟      —— 输入具体时长，倒计时到点触发一次
 *   at        固定时刻  —— 输入绝对时刻，系统时间到达后触发一次
 *   periodic  重复      —— 输入具体时长，倒计时到点触发后按**严格周期**续排
 *
 * 状态机
 *   pending  等待中
 *   paused   已暂停（after/periodic 冻结剩余时间；at 冻结"是否已过"）
 *   overdue  已超时（不自动执行，等用户点「立即执行」或重新开启）
 *   done     已执行（一次性任务终态）
 *
 * 关闭语义（，用户定案）
 *   - after / periodic：DSH 关闭期间**冻结计时**（靠心跳 lastSeenAt 回推），
 *     重载后一律置为 paused，**绝不自动恢复**；
 *   - at：时间照常流逝，重载后若已过则转 overdue。
 *
 * @module dsh-tick/domain
 */

import { createTranslator } from './i18n.js'

/** 三种定时模式的稳定枚举值（★ 用 periodic 而非 repeat，）。 */
export const KINDS = Object.freeze(['after', 'at', 'periodic'])

/** 任务状态。 */
export const STATUSES = Object.freeze(['pending', 'paused', 'overdue', 'done'])

/** 硬性边界（.2 用户定案）。 */
export const LIMITS = Object.freeze({
  /** 延迟模式单次上限：30 天（更长的延迟应改用 at 模式）。 */
  maxAfterSeconds: 30 * 24 * 60 * 60,
  /** 重复模式间隔下限：10 秒。 */
  minIntervalSeconds: 10,
  /** 重复模式间隔上限：一年（"不设天数上限"的工程化取值，防误输入溢出）。 */
  maxIntervalSeconds: 365 * 24 * 60 * 60,
  /** prompt 长度上限（字符）。 */
  maxPromptChars: 4000,
  /** 领域层容错宽限窗口：判定"错过"时允许的毫秒容差。 */
  graceMs: 60_000,
})

/** 四位数年份可表达的时间范围（对齐官方 schedule 的边界）。 */
const MIN_INSTANT_MS = Date.parse('0001-01-01T00:00:00.000Z')
const MAX_INSTANT_MS = Date.parse('9999-12-31T23:59:59.999Z')

/**
 * 当前语言的翻译函数（**默认中文**）。
 *
 * ★ 为什么用模块级状态而不是逐层传参：本模块是**纯函数**层（无 ctx），
 *   而错误消息散落在十几个校验函数深处。逐层加 `t` 参数会污染所有签名、
 *   并让现有调用方与测试全部需要改动。
 *   module 级 + **默认中文** 的好处是：**不设置时行为与改造前逐字节相同**，
 *   现有测试与中文模式因此天然零回归。
 *
 * 切换入口：`setDomainLocale(locale)`，由 index.js 在各入口处按当前语言刷新。
 */
let t = createTranslator('zh')

/**
 * 切换本模块的文案语言。
 * @param locale - `'zh'` 或 `'en'`。
 */
export function setDomainLocale(locale) {
  t = createTranslator(locale)
}

/** 读取当前文案语言（供诊断/测试）。 */
export function currentDomainLocale() {
  return t === createTranslator('en') ? 'en' : 'zh'
}

/**
 * 领域输入错误（可安全回给模型/UI 的稳定错误）。
 */
export class TickInputError extends Error {
  /**
   * @param code - 稳定的机器可读错误码。
   * @param message - 人类可读说明。
   */
  constructor(code, message) {
    super(message)
    this.name = 'TickInputError'
    this.code = code
  }
}

/** 是否是非数组对象。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 清洗并校验 prompt。 */
function normalizePrompt(prompt) {
  if (typeof prompt !== 'string') throw new TickInputError('invalid_prompt', t('err.promptNotString'))
  const trimmed = prompt.trim()
  if (trimmed.length === 0) throw new TickInputError('invalid_prompt', t('err.promptEmpty'))
  if (trimmed.length > LIMITS.maxPromptChars) {
    throw new TickInputError('invalid_prompt', t('err.promptTooLong', { max: LIMITS.maxPromptChars }))
  }
  return trimmed
}

/** 校验一个正安全整数。 */
function requireSafeInt(value, label) {
  if (!Number.isSafeInteger(value)) throw new TickInputError('invalid_rule', t('err.mustBeInt', { label }))
  return value
}

/** 把 epoch 毫秒转成规范 RFC3339 UTC 字符串。 */
export function toIso(ms) {
  return new Date(ms).toISOString()
}

/** 校验一个可表达的 UTC 时刻字符串，返回 epoch 毫秒。 */
export function parseInstant(value, label = 'scheduledAt') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TickInputError('invalid_time', t('err.mustBeRfc3339', { label }))
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new TickInputError('invalid_time', t('err.badInstant', { label }))
  if (ms < MIN_INSTANT_MS || ms > MAX_INSTANT_MS) {
    throw new TickInputError('invalid_time', t('err.yearRange', { label }))
  }
  return ms
}

/**
 * 从已有任务表分配一个新的、永不复用的任务 id。
 *
 * ★★ 必须取「已有最大编号 + 1」，**不能**取「任务数量 + 1」。
 *   原实现用 `used.size + 1`，于是**删除任意一条后新 id 就会与用过的 id 碰撞**
 *   实测场景 —— 有 tick-1..tick-5，删掉 tick-5，再新建 → `size` 从 5 变 4，
 *   新 id 又算成 `tick-5`，**复用了刚删掉那条的 id**。
 *   后果：按 id 追踪历史的行为会错乱（同一 id 先后指向两条不同任务），
 *   实测被本会话里的模型主动发现并报告。
 *
 *   虽然状态存在插件自有文件、不涉及会话日志的 seq 复用风险，
 *   但「id 永不复用」是任务系统的基本契约，必须成立。
 *
 * @param tasks - 现有任务数组。
 * @returns 形如 `tick-3` 的新 id。
 */
export function allocateId(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  let max = 0
  for (const task of list) {
    const id = task === null || task === undefined ? '' : String(task.id)
    const m = /^tick-(\d+)$/u.exec(id)
    if (m !== null) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isSafeInteger(n) && n > max) max = n
    }
  }
  // 直接从 max+1 开始；若历史数据里存在非 tick-N 形式或有空洞，
  // 下面的 while 仍能保证不碰撞。
  let n = max + 1
  const used = new Set(list.map((t) => (t === null || t === undefined ? '' : String(t.id))))
  while (used.has(`tick-${n}`)) n += 1
  return `tick-${n}`
}

/**
 * 从一组可能的 selector 字段中解析出**恰好一种**时间设定。
 *
 * ★ 为什么放在领域层（而不是每个入口各写一份）
 *
 *   判据必须收敛到同一个函数"。本项目有四个入口（RPC/UI、模型工具、
 *   /schedule 命令、未来的其它通道），若各写一份校验，就会出现
 *   "UI 拦住了、工具没拦住"这类不一致——**本函数就是那个唯一判据**。
 *   实测发现：过：RPC 路径漏了这个校验，导致同时传两个 selector 被静默接受、
 *   只生效其中一个（用户以为另一个也生效了）。
 *
 * @param source - 含 selector 字段的对象。
 * @returns `{ kind, afterSeconds }` | `{ kind, intervalSeconds }` | `{ kind, scheduledAt }`。
 */
export function resolveSelector(source) {
  const input = isRecord(source) ? source : {}
  const present = []
  if (input.afterSeconds !== undefined && input.afterSeconds !== null) present.push('afterSeconds')
  if (input.intervalSeconds !== undefined && input.intervalSeconds !== null) present.push('intervalSeconds')
  if (input.scheduledAt !== undefined && input.scheduledAt !== null) present.push('scheduledAt')

  if (present.length === 0) {
    throw new TickInputError(
      'invalid_selector',
      t('err.needOneSelector'),
    )
  }
  if (present.length > 1) {
    throw new TickInputError(
      'invalid_selector',
      t('err.multipleSelectors', { got: present.join(' + ') }),
    )
  }
  const key = present[0]
  if (key === 'afterSeconds') return { kind: 'after', afterSeconds: input.afterSeconds }
  if (key === 'intervalSeconds') return { kind: 'periodic', intervalSeconds: input.intervalSeconds }
  return { kind: 'at', scheduledAt: input.scheduledAt }
}

/**
 * 构造一条新任务。
 *
 * @param options - 构造参数。
 * @param options.id - 已分配的任务 id。
 * @param options.kind - `after` | `at` | `periodic`。
 * @param options.prompt - 到点注入的提示词。
 * @param options.afterSeconds - after 模式的时长（秒）。
 * @param options.intervalSeconds - periodic 模式的间隔（秒）。
 * @param options.scheduledAt - at 模式的目标时刻（epoch 毫秒）。
 * @param options.createdBy - `user` | `ai`。
 * @param options.now - 当前时刻（epoch 毫秒，注入以便测试）。
 * @returns 冻结的新任务记录。
 */
export function createTask(options) {
  const { id, kind, createdBy = 'user', now } = options
  if (!KINDS.includes(kind)) throw new TickInputError('invalid_kind', t('err.unknownKind', { kind: String(kind) }))
  if (!Number.isSafeInteger(now)) throw new TickInputError('internal', t('err.nowNotSafeInt'))
  if (createdBy !== 'user' && createdBy !== 'ai') {
    throw new TickInputError('internal', t('err.badCreatedBy'))
  }
  const prompt = normalizePrompt(options.prompt)

  let scheduledAt
  let afterSeconds = null
  let intervalSeconds = null

  if (kind === 'after') {
    const secs = requireSafeInt(options.afterSeconds, 'after_seconds')
    if (secs <= 0) throw new TickInputError('invalid_rule', t('err.afterMustBePositive'))
    if (secs > LIMITS.maxAfterSeconds) {
      throw new TickInputError(
        'invalid_rule',
        t('err.afterTooLarge', { max: LIMITS.maxAfterSeconds }),
      )
    }
    afterSeconds = secs
    scheduledAt = now + secs * 1000
  } else if (kind === 'periodic') {
    const secs = requireSafeInt(options.intervalSeconds, 'interval_seconds')
    if (secs < LIMITS.minIntervalSeconds) {
      throw new TickInputError('invalid_rule', t('err.intervalTooSmall', { min: LIMITS.minIntervalSeconds }))
    }
    if (secs > LIMITS.maxIntervalSeconds) {
      throw new TickInputError('invalid_rule', t('err.intervalTooLarge', { max: LIMITS.maxIntervalSeconds }))
    }
    intervalSeconds = secs
    scheduledAt = now + secs * 1000
  } else {
    const ms = typeof options.scheduledAt === 'number' ? options.scheduledAt : parseInstant(options.scheduledAt)
    if (ms <= now) throw new TickInputError('not_future', t('err.mustBeFuture'))
    scheduledAt = ms
  }

  if (scheduledAt < MIN_INSTANT_MS || scheduledAt > MAX_INSTANT_MS) {
    throw new TickInputError('invalid_time', t('err.yearRange', { label: 'scheduledAt' }))
  }

  return Object.freeze({
    id,
    kind,
    prompt,
    status: 'pending',
    enabled: true,
    scheduledAt: toIso(scheduledAt),
    remainingMs: null,
    afterSeconds,
    intervalSeconds,
    lastSeenAt: toIso(now),
    createdBy,
    createdAt: toIso(now),
    firedCount: 0,
    lastFiredAt: null,
  })
}

/**
 * 校验并规范化一条从磁盘读回的任务记录。
 *
 * 磁盘数据可能来自旧版本或被手工编辑，因此这里**严格校验**
 * 任何不合规的记录都抛错，由调用方决定丢弃还是报错（不静默放行）。
 *
 * @param value - 未信任的原始值。
 * @returns 冻结的规范任务记录。
 */
export function normalizeStoredTask(value) {
  if (!isRecord(value)) throw new TickInputError('corrupt', t('err.recordNotObject'))
  const id = value.id
  if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
    throw new TickInputError('corrupt', t('err.idInvalid'))
  }
  const kind = value.kind
  if (!KINDS.includes(kind)) throw new TickInputError('corrupt', t('err.taskBadKind', { id, kind: String(kind) }))
  const prompt = typeof value.prompt === 'string' ? value.prompt : ''
  if (prompt.trim().length === 0) throw new TickInputError('corrupt', t('err.taskEmptyPrompt', { id }))

  const status = STATUSES.includes(value.status) ? value.status : 'pending'
  const enabled = value.enabled === true

  const scheduledAtMs = parseInstant(value.scheduledAt, t('err.taskBadScheduledAt', { id }))
  const lastSeenMs = Number.isFinite(Date.parse(value.lastSeenAt)) ? Date.parse(value.lastSeenAt) : scheduledAtMs

  const remainingMs =
    Number.isSafeInteger(value.remainingMs) && value.remainingMs >= 0 ? value.remainingMs : null

  const afterSeconds =
    kind === 'after' && Number.isSafeInteger(value.afterSeconds) && value.afterSeconds > 0
      ? value.afterSeconds
      : null

  const intervalSeconds =
    kind === 'periodic' && Number.isSafeInteger(value.intervalSeconds) && value.intervalSeconds > 0
      ? value.intervalSeconds
      : null

  if (kind === 'periodic' && intervalSeconds === null) {
    throw new TickInputError('corrupt', t('err.periodicNoInterval', { id }))
  }

  const firedCount = Number.isSafeInteger(value.firedCount) && value.firedCount >= 0 ? value.firedCount : 0
  const lastFiredAt = Number.isFinite(Date.parse(value.lastFiredAt)) ? value.lastFiredAt : null

  return Object.freeze({
    id,
    kind,
    prompt,
    status,
    enabled,
    scheduledAt: toIso(scheduledAtMs),
    remainingMs,
    afterSeconds,
    intervalSeconds,
    lastSeenAt: toIso(lastSeenMs),
    createdBy: value.createdBy === 'ai' ? 'ai' : 'user',
    createdAt: Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : toIso(scheduledAtMs),
    firedCount,
    lastFiredAt,
  })
}

/**
 * 重启后的恢复决策（★ 本项目最关键的一段语义，）。
 *
 * 用户定案
 *   - after / periodic：关闭期间冻结计时 → 重载后**一律置为 paused**，绝不自动恢复；
 *   - at：时间照常流逝 → 若目标时刻已过（超出宽限），置为 overdue，等用户决定。
 *
 * 冻结计时的原理：磁盘上的 `lastSeenAt` 是"进程最后一次活着"的心跳时刻，
 * 因此关闭前的剩余时间 = `scheduledAt - lastSeenAt`。这不需要依赖关闭钩子，
 * **强杀也成立**（代价是精度等于心跳间隔）。
 *
 * @param task - 已规范化的任务。
 * @param now - 当前时刻（epoch 毫秒）。
 * @param graceMs - 到期宽限（毫秒）。**由调用方传 `config.graceMs`**，
 *   使该配置项真正生效；省略时回落内置常量（便于领域层单测）。
 * @returns 恢复后的新任务（可能未变）。
 */
export function recoverOnLoad(task, now, graceMs = LIMITS.graceMs) {
  if (task.status === 'done') return task
  if (!task.enabled && task.status !== 'overdue') return task

  const scheduledMs = parseInstant(task.scheduledAt)
  // ★ 宽限必须是有限非负数；配置层已收敛，这里再兜一层，避免 NaN 让比较恒为 false
  //   （那会让"已过期的固定时刻任务"永远不被判为 overdue）。
  const grace =
    typeof graceMs === 'number' && Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : LIMITS.graceMs

  if (task.kind === 'at') {
    // 绝对时刻语义：时间照常流逝，过了就是 overdue。
    if (scheduledMs <= now - grace) {
      return Object.freeze({ ...task, status: 'overdue', enabled: false, lastSeenAt: toIso(now) })
    }
    return Object.freeze({ ...task, lastSeenAt: toIso(now) })
  }

  // after / periodic：冻结计时。
  // 关闭前的剩余 = scheduledAt - lastSeenAt；若它已经 <= 0，说明关闭前就该触发
  // （可能是触发后被强杀），保守地交给用户决定 → overdue。
  const remaining = scheduledMs - parseInstant(task.lastSeenAt)
  if (remaining <= 0) {
    return Object.freeze({ ...task, status: 'overdue', enabled: false, lastSeenAt: toIso(now) })
  }
  // 冻结：把目标时刻推到"重启后 + 剩余时间"，并置为暂停等用户恢复。
  return Object.freeze({
    ...task,
    status: 'paused',
    enabled: false,
    scheduledAt: toIso(now + remaining),
    remainingMs: remaining,
    lastSeenAt: toIso(now),
  })
}

/**
 * 暂停一条任务。
 * @param task - 任务。
 * @param now - 当前时刻。
 * @returns 暂停后的任务。
 */
export function pauseTask(task, now) {
  if (task.status === 'done') throw new TickInputError('invalid_state', t('err.cannotPauseDone'))
  if (task.status === 'paused') return task
  const scheduledMs = parseInstant(task.scheduledAt)
  // 冻结剩余时间（at 模式不冻结时间本身，但保留剩余仅为显示）。
  const remaining = Math.max(0, scheduledMs - now)
  return Object.freeze({
    ...task,
    status: 'paused',
    enabled: false,
    remainingMs: remaining,
    lastSeenAt: toIso(now),
  })
}

/**
 * 恢复一条任务。
 *
 * 用户定案
 *   - after / periodic：从冻结的剩余时间继续；
 *   - at：若目标时刻已过 → 保持/转 overdue，由用户点「立即执行」；
 *         未过 → 正常等待。
 *
 * @param task - 任务。
 * @param now - 当前时刻。
 * @returns 恢复后的任务。
 */
export function resumeTask(task, now) {
  if (task.status === 'done') throw new TickInputError('invalid_state', t('err.cannotResumeDone'))
  if (task.status === 'overdue') {
    // 「重新开启」已超时任务 = 按用户定案**立即执行**（由调用方触发投递）。
    return Object.freeze({ ...task, status: 'pending', enabled: true, remainingMs: null, lastSeenAt: toIso(now) })
  }
  if (task.kind === 'at') {
    const scheduledMs = parseInstant(task.scheduledAt)
    if (scheduledMs <= now) {
      return Object.freeze({ ...task, status: 'overdue', enabled: false, lastSeenAt: toIso(now) })
    }
    return Object.freeze({ ...task, status: 'pending', enabled: true, remainingMs: null, lastSeenAt: toIso(now) })
  }
  const remaining = Number.isSafeInteger(task.remainingMs) && task.remainingMs > 0 ? task.remainingMs : 0
  return Object.freeze({
    ...task,
    status: 'pending',
    enabled: true,
    scheduledAt: toIso(now + remaining),
    remainingMs: null,
    lastSeenAt: toIso(now),
  })
}

/**
 * 修改任务的时间设定。
 *
 * ★ 用户定案：若用户把时间改到**当前时刻之后**，必须**立即清除**
 * overdue 状态与「立即执行」入口，但**仍保持暂停**（不自动开始跑）。
 *
 * @param task - 任务。
 * @param patch - 变更字段。
 * @param now - 当前时刻。
 * @returns 修改后的任务。
 */
export function updateTaskSchedule(task, patch, now) {
  if (task.status === 'done') throw new TickInputError('invalid_state', t('err.cannotUpdateDone'))
  const next = { ...task }

  if (patch.prompt !== undefined) next.prompt = normalizePrompt(patch.prompt)

  const wantsAfter = patch.afterSeconds !== undefined
  const wantsAt = patch.scheduledAt !== undefined
  const wantsInterval = patch.intervalSeconds !== undefined
  const selectorCount = Number(wantsAfter) + Number(wantsAt) + Number(wantsInterval)
  if (selectorCount > 1) {
    throw new TickInputError('invalid_selector', t('err.onlyOneSelector'))
  }

  if (wantsAfter || wantsAt || wantsInterval) {
    if (wantsAfter) {
      const secs = requireSafeInt(patch.afterSeconds, 'after_seconds')
      if (secs <= 0 || secs > LIMITS.maxAfterSeconds) {
        throw new TickInputError('invalid_rule', t('err.afterRange', { max: LIMITS.maxAfterSeconds }))
      }
      next.kind = 'after'
      next.afterSeconds = secs
      next.intervalSeconds = null
      next.scheduledAt = toIso(now + secs * 1000)
    } else if (wantsInterval) {
      const secs = requireSafeInt(patch.intervalSeconds, 'interval_seconds')
      if (secs < LIMITS.minIntervalSeconds || secs > LIMITS.maxIntervalSeconds) {
        throw new TickInputError(
          'invalid_rule',
          t('err.intervalRange', { min: LIMITS.minIntervalSeconds, max: LIMITS.maxIntervalSeconds }),
        )
      }
      next.kind = 'periodic'
      next.intervalSeconds = secs
      next.afterSeconds = null
      next.scheduledAt = toIso(now + secs * 1000)
    } else {
      const ms = typeof patch.scheduledAt === 'number' ? patch.scheduledAt : parseInstant(patch.scheduledAt)
      if (ms <= now) throw new TickInputError('not_future', t('err.mustBeFuture'))
      next.kind = 'at'
      next.afterSeconds = null
      next.intervalSeconds = null
      next.scheduledAt = toIso(ms)
    }
    next.remainingMs = null
  }

  // 时间已在未来 → 清 overdue；但保持暂停（用户定案）。
  if (next.status === 'overdue' && parseInstant(next.scheduledAt) > now) {
    next.status = 'paused'
    next.enabled = false
  }
  next.lastSeenAt = toIso(now)
  return Object.freeze(next)
}

/**
 * 判定任务是否到期。
 * @param task - 任务。
 * @param now - 当前时刻。
 * @returns 是否应当触发。
 */
export function isDue(task, now) {
  if (!task.enabled || task.status !== 'pending') return false
  const scheduledMs = parseInstant(task.scheduledAt)
  if (task.kind === 'at') return scheduledMs <= now
  // after / periodic：到点即触发；负的过大偏差说明错过，由 recoverOnLoad 处理。
  return now >= scheduledMs
}

/**
 * 触发后推进任务状态。
 *
 * ★ 重复模式采用**严格周期**（用户定案，.1）
 *   `nextAt = 上一轮目标时刻 + interval`，不因执行耗时漂移。
 *   追赶保护：若推进后仍落后于"现在"，直接跳到第一个未来时刻
 *   （对齐官方 schedule"只追赶最新一次、绝不枚举错过的间隔"的做法，
 *   避免补跑历史积压造成的连续触发风暴）。
 *
 * @param task - 任务。
 * @param now - 触发时刻。
 * @returns 触发后的任务。
 */
export function advanceAfterFire(task, now) {
  const firedAt = toIso(now)
  const base = {
    ...task,
    lastFiredAt: firedAt,
    firedCount: task.firedCount + 1,
    lastSeenAt: firedAt,
  }
  if (task.kind !== 'periodic') {
    return Object.freeze({ ...base, status: 'done', enabled: false, remainingMs: null })
  }
  const intervalMs = task.intervalSeconds * 1000
  let nextMs = parseInstant(task.scheduledAt) + intervalMs
  if (nextMs <= now) {
    // 追赶保护：跳到第一个严格未来的锚点对齐时刻，绝不逐轮补跑。
    const missed = Math.floor((now - nextMs) / intervalMs) + 1
    nextMs += missed * intervalMs
  }
  if (nextMs > MAX_INSTANT_MS) {
    return Object.freeze({ ...base, status: 'done', enabled: false, remainingMs: null })
  }
  return Object.freeze({ ...base, status: 'pending', enabled: true, scheduledAt: toIso(nextMs) })
}

/**
 * 派生一条任务的展示视图（供 UI / 工具返回）。
 * @param task - 任务。
 * @param now - 当前时刻。
 * @returns 可 JSON 序列化的视图。
 */
export function taskView(task, now) {
  const scheduledMs = parseInstant(task.scheduledAt)
  return {
    id: task.id,
    kind: task.kind,
    prompt: task.prompt,
    status: task.status,
    enabled: task.enabled,
    scheduledAt: task.scheduledAt,
    remainingMs: task.status === 'paused' ? Math.max(0, scheduledMs - now) : null,
    intervalSeconds: task.intervalSeconds,
    afterSeconds: task.afterSeconds,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    firedCount: task.firedCount,
    lastFiredAt: task.lastFiredAt,
  }
}
