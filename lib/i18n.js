/**
 * Tick（定时任务）— 多语言（仅 zh / en）。
 *
 * ★★ 设计依据（全部来自官方源码实读）：
 *
 *   1. **客户端**有官方 locale 服务（`@deepseek-ai/dsh-client-locale`）：
 *      `inject: ['locale']` + `ctx.locale.register(NS, {zh, en})` +
 *      注册 slot 时传 `locale: NS` + 组件从 props 取 `t`。
 *      （官方 `dsh-client-ui-goal` 即此范式。）
 *
 *   2. **Host 侧没有任何 locale 服务**（全树搜 host 半部注册 locale：0 命中）。
 *      因此 host 侧的文案（命令回执、工具描述、注入 framing、错误消息）
 *      必须另找探测途径。
 *
 *   3. **官方把用户的显式语言选择持久化到 Host settings**：
 *      `LocaleRuntime.setLocale(id)` 结尾是
 *        `this.host?.set(LOCALE_PREFERENCE_FIELD, match.id)`
 *      命名空间 `locale`、字段 `preference`。Host 侧可用
 *      官方 `ctx.settings.get('locale')` 读回（`dsh-settings` 公开 API）。
 *
 *   4. **缺省回退为中文（不是官方客户端的 en）** ——刻意的选择：
 *      - 本插件的**主要模式是中文**（用户定案）；
 *      - Host 侧看不到 `navigator.language`，无法复刻"浏览器探测"；
 *      - 若缺省回退英文，则现有中文用户在**从未显式选过语言**时会突然变英文，
 *        属于"英文挤占中文"——正是用户明确禁止的。
 *      因此：**只有用户显式选择过英文（preference === 'en'）才用英文**，
 *      其余一律中文 → 保证中文模式**逐字节零回归**。
 *
 *   5. 未注册语言（如 fr）按官方 `FALLBACK_LOCALE` 语义回退：非 zh 即 en。
 *      本插件只支持 zh/en，不做其它语言。
 *
 * @module dsh-tick/i18n
 */

/** 支持的两种语言（与官方 `LOCALE_IDS` 一致）。 */
export const LOCALES = Object.freeze(['zh', 'en'])

/** 官方 locale 设置的命名空间与字段名（实读 `dsh-client-locale`）。 */
export const LOCALE_NS = 'locale'
export const LOCALE_FIELD = 'preference'

/**
 * Host 侧是否可用英文——即客户端是否注册过本插件的 locale 命名空间。
 *
 * 客户端翻译文案由客户端自己处理；这里只用于 host 侧文案。
 */

/**
 * 中文（**key 集的 source of truth**，对齐官方 zh 为权威的约定）。
 *
 * 注意：这里的键名是**语义化**的，不直接复用中文原文——否则改动文案会牵连键名。
 */
export const zh = Object.freeze({
  // ── 通用 ──
  'common.failed': '失败',
  'common.unknownReason': '未知原因',
  'common.needId': '请给出任务 id。',
  /** 列表项之间的分隔符（中文用全角顿号式逗号，英文用半角逗号 + 空格）。 */
  'common.listSep': '，',

  // ── 模式与状态 ──
  'mode.after': '延迟',
  'mode.periodic': '重复',
  'mode.at': '固定时刻',
  'mode.atShort': '指定时刻',
  'status.pending': '等待中',
  'status.paused': '已暂停',
  'status.overdue': '已超时',
  'status.done': '已完成',

  // ── /schedule 命令 ──
  'cmd.description': '创建与管理本会话的定时任务（延迟 / 固定时刻 / 重复）',
  'cmd.usage':
    '用法：/schedule <时间> <内容> | /schedule list | /schedule remove <id> | ' +
    '/schedule pause <id> | /schedule resume <id> | /schedule run <id>',
  'cmd.help':
    '时间写法：+30s / +5m / +2h / +1h30m（延迟）；every 30m（重复）；@2026-09-20T15:00:00+08:00（固定时刻）',
  'cmd.needContentPeriodic': '重复任务需要内容，例如：/schedule every 30m 检查队列',
  'cmd.needContentAt': '绝对时刻任务需要内容。',
  'cmd.needContentAfter': '延迟任务需要内容。',
  'cmd.badInterval': '无法识别间隔「{spec}」；支持 30s / 5m / 2h / 1h30m。',
  'cmd.badTime': '无法识别「{head}」。',
  'cmd.noTasks': '当前会话没有定时任务。',
  'cmd.created':
    '已创建定时任务 {id}\n  模式：{kind}\n  目标：{when}\n  内容：{prompt}',
  'cmd.deleted': '已删除任务 {id}。',
  'cmd.paused': '已暂停任务 {id}。',
  'cmd.resumed': '已恢复任务 {id}。',
  'cmd.ran': '已立即执行任务 {id}。',
  'cmd.noSession': '该命令必须由某个会话发起。',
  'cmd.failed': '定时任务操作失败：{message}',
  'cmd.listHeader': '当前会话共 {n} 个定时任务：',

  // ── 注入 framing ──
  'framing.task': '本会话中一个一次性定时任务触发。本次触发与上一条回复无关，只需执行下方任务内容一次。',
  'framing.periodic': '本会话中一个「周期性任务」按固定间隔自动触发。本次触发与上一条回复无关，只需执行下方任务内容一次。',
  'framing.periodicHint':
    '提示：若你注意到本周期性任务的触发频率或内容出现明显异常（例如远超设定的 interval_seconds、' +
    '内容与设定不符、或在你不期望时反复触发），请如实向用户指出，不要默认它正常；' +
    '必要时可用定时任务工具自行暂停或删除该任务。',

  // ── 客户端提示（toast / 面板内的运行期告知）──
  //   ★ 语言取 **UI 语言**（客户端渲染），与注入语言（serverPromptLanguage）无关：
  //     这条是给"人"看的，不是给模型看的。
  'notice.customTemplateReset':
    '自定义注入模板读取失败，配置文件已复原为初始值（原文件已改名为 .bad-<时间戳> 保留）。',

  // ── 工具描述 ──
  'tool.create.desc':
    '在当前会话创建一个定时任务：到点后向本会话注入设定好的提示词，唤醒你执行它。' +
    '必须给出 prompt，并**恰好一种**时间设定：' +
    'afterSeconds（多少秒后执行一次）、' +
    'intervalSeconds（每多少秒自动重复，最小 10）、' +
    'scheduledAt（RFC3339 绝对时刻，如 "2026-09-20T15:00:00+08:00"）。' +
    '示例：用户说"10 分钟后提醒我检查构建" → {prompt:"检查构建队列", afterSeconds:600}；' +
    '用户说"每隔半小时看一眼队列" → {prompt:"检查构建队列", intervalSeconds:1800}；' +
    '用户说"今天下午三点提醒我" → 先把本地时间换算成带时区偏移的 RFC3339 再传 scheduledAt。' +
    '三种时间字段不要同时传，一次只能一种。',
  'tool.list.desc':
    '列出当前会话的全部定时任务（含 id、模式、状态、目标时间）。' +
    '修改、暂停、恢复、删除、立即执行之前都先用它拿到准确的 id。',
  'tool.update.desc':
    '修改当前会话中某个定时任务的内容或时间。先用 tick_list 拿 id。' +
    '可改 prompt（任务内容），或改时间（afterSeconds / intervalSeconds / scheduledAt 三选一，' +
    '规则与 tick_create 相同）。不传的字段保持不变。' +
    '注意：改时间会让模式随之切换（传 afterSeconds 就变成"延迟"模式）。',
  'tool.pause.desc':
    '暂停当前会话中的一个定时任务。' +
    '延迟与重复模式会**冻结剩余时间**（恢复后从剩余时间继续，不重新计时）；' +
    '固定时刻模式在暂停期间即使时刻已过也不会执行。',
  'tool.resume.desc':
    '恢复当前会话中一个已暂停的定时任务。' +
    '若该任务已超时，恢复即**立即执行**（与「立即执行」等价）。',
  'tool.runNow.desc':
    '立即执行当前会话中的一个定时任务（不等它的定时到点）。' +
    '典型用法：任务已超时，用户希望马上补跑一次。' +
    '执行后一次性任务会标记完成，重复任务会继续按周期运行。',
  'tool.remove.desc': '删除当前会话中的一个定时任务。先用 tick_list 确认 id。',
  // 参数说明
  'param.prompt': '到点时要执行的任务内容（会作为提示词注入本会话）。',
  'param.afterSeconds': '延迟多少秒后执行一次（与另两个互斥）。',
  'param.intervalSeconds': '每隔多少秒重复执行（最小 10，与另两个互斥）。',
  'param.scheduledAt': '绝对时刻，RFC3339 且带时区偏移（与另两个互斥）。',
  'param.id': '任务 id（来自 tick_list）。',
  'param.newPrompt': '新的任务内容；不改则不传。',
  'param.newAfterSeconds': '改成"多少秒后执行一次"。',
  'param.newIntervalSeconds': '改成"每多少秒重复"。',
  'param.newScheduledAt': '改成某个绝对时刻（RFC3339 带时区）。',
  // 渲染
  'render.created': '已创建定时任务：{task}',
  'render.updated': '已修改定时任务：{task}',
  'render.paused': '已暂停：{task}',
  'render.resumed': '已恢复：{task}',
  'render.ran': '已立即执行：{task}',
  'render.removed': '已删除该定时任务。',
  'render.noTasks': '当前会话没有定时任务。',
  'render.listHeader': '当前会话共 {n} 个定时任务：',
  'render.fail': '失败（{code}）：{message}',
  'render.noAgent': '定时任务工具必须由某个会话中的模型调用（当前调用没有归属会话）。',

  // ── 描述任务（describeTask） ──
  'desc.after': '延迟 {n} 秒',
  'desc.periodic': '每 {n} 秒重复',

  // ── 错误消息 ──
  'err.promptNotString': 'prompt 必须是字符串。',
  'err.promptEmpty': 'prompt 不能为空。',
  'err.promptTooLong': 'prompt 过长（上限 {max} 字符）。',
  'err.mustBeInt': '{label} 必须是整数。',
  'err.mustBeRfc3339': '{label} 必须是 RFC3339 字符串。',
  'err.badInstant': '{label} 不是合法时刻。',
  'err.yearRange': '{label} 超出可表达的年份范围。',
  'err.needOneSelector':
    '必须给出恰好一种时间设定：after_seconds（多少秒后）、interval_seconds（每多少秒重复）' +
    '或 scheduled_at/scheduledAt（RFC3339 时刻）。',
  'err.unknownKind': '未知模式：{kind}。',
  'err.nowNotSafeInt': 'now 必须是安全整数毫秒。',
  'err.badCreatedBy': 'createdBy 必须为 user 或 ai。',
  'err.afterMustBePositive': 'after_seconds 必须是正整数。',
  'err.afterTooLarge': 'after_seconds 超过上限 {max}（30 天）；更长的等待请改用固定时刻模式。',
  'err.intervalTooSmall': 'interval_seconds 不能小于 {min} 秒。',
  'err.intervalTooLarge': 'interval_seconds 超过上限 {max} 秒。',
  'err.mustBeFuture': '目标时刻必须晚于当前时刻。',
  'err.recordNotObject': '任务记录必须是对象。',
  'err.idInvalid': '任务 id 必须是非空且无首尾空白的字符串。',
  'err.taskBadKind': '任务 {id} 的模式非法：{kind}。',
  'err.taskEmptyPrompt': '任务 {id} 的 prompt 为空。',
  'err.taskBadScheduledAt': '任务 {id} 的 scheduledAt 非法。',
  'err.periodicNoInterval': '重复任务 {id} 缺少合法的 intervalSeconds。',
  'err.cannotPauseDone': '已完成的任务不能暂停。',
  'err.cannotResumeDone': '已完成的任务不能恢复。',
  'err.cannotUpdateDone': '已完成的任务不能修改时间。',
  'err.onlyOneSelector': '每次只能给出一种时间设定。',
  'err.multipleSelectors': '一次只能给出一种时间设定，收到 {got}；请只保留一种。',
  'err.afterRange': 'after_seconds 必须是 1~{max} 的整数。',
  'err.intervalRange': 'interval_seconds 必须在 {min}~{max} 之间。',

  // ── service 错误 ──
  'svc.aiDisabled': '配置已禁用 AI 创建定时任务。',
  'svc.limitTasks': '本会话任务数已达上限 {max}；请先删除一些任务。',
  'svc.limitActive': '本会话同时启用的任务数已达上限 {max}；请先暂停或删除一些任务。',
  'svc.notFound': '未找到任务 {id}。',
  'svc.noAgent': '该会话当前没有活跃 Agent，无法立即执行；请先打开该会话。',

  // ── UI（客户端也会用到部分同名键，保持同一套 key） ──
  'ui.title': '定时任务',
  'ui.newTask': '新建定时任务',
  'ui.add': '添加',
  'ui.save': '保存',
  'ui.cancel': '取消',
  'ui.expand': '展开定时任务面板',
  'ui.collapse': '收起定时任务面板',
  'ui.noTasks': '当前会话没有定时任务。',
  'ui.promptPlaceholder': '到点要执行的内容（会作为提示词注入本会话）',
  'ui.taskContent': '任务内容',
  'ui.hour': '时',
  'ui.minute': '分',
  'ui.second': '秒',
  'ui.delay': '延迟',
  'ui.at': '固定时刻',
  'ui.periodic': '重复',
  'ui.interval': '间隔',
  'ui.execTime': '执行时刻（浏览器本地时间）',
  'ui.intervalNote': '间隔最小 10 秒。任务按下一次设定严格周期触发。',

  // ── 相对时间与摘要（客户端计数/单位词） ──
  'rel.seconds': '{n} 秒',
  'rel.minutes': '{n} 分钟',
  'rel.hours': '{n} 小时',
  'rel.days': '{n} 天',
  'rel.ago': '{text}前',
  'rel.later': '{text}后',
  'rel.then': '之后',
  'sum.delayHours': '延迟 {n} 小时',
  'sum.delayMinutes': '延迟 {n} 分钟',
  'sum.delaySeconds': '延迟 {n} 秒',
  'sum.everyHours': '每 {n} 小时重复',
  'sum.everyMinutes': '每 {n} 分钟重复',
  'sum.everySeconds': '每 {n} 秒重复',
  'sum.remainingSeconds': '剩余 {n} 秒',
  'sum.createdByAi': 'AI 创建',
  'sum.firedCount': '已触发 {n} 次',
  'sum.countAndNext': '共 {n} 个 · 最近 {when}',
  'sum.countOnly': '共 {n} 个',
  'sum.emptyList': '暂无任务',
  'sum.overdueCount': '{n} 个已超时',
  'sum.pendingCount': '{n} 个待执行',
  'side.overdueItems': '{n} 项超时',
  'side.pendingItems': '{n} 项待执行',
  'side.overdueDetail': '{n} 项已超时',
  'side.pendingDetail': '{n} 项待执行',
  'ui.cannotSubmit': '请填写任务内容，并把时长设为大于 0',
  'ui.requestFailed': '定时任务请求失败',
  'ui.hoursAria': '{label} 小时',
  'ui.minutesAria': '{label} 分钟',
  'ui.secondsAria': '{label} 秒',
  // ⚠ 不要在此再定义 ui.expand / ui.collapse —— 上面 UI 段已有一对
  //   （`ui.expand` = 展开面板的 aria-label）。重复键会让**后者静默覆盖前者**。
  'action.runNowOverdue': '立即执行（该任务已超时，不会自动执行）',
  'action.resumeFromLeft': '恢复（从剩余时间继续）',
  'action.run': '执行',
  'action.resume': '恢复',
  'action.pauseHint': '暂停（延迟与重复模式会冻结剩余时间）',
  'action.pause': '暂停',
  'action.editHint': '修改内容或定时',
  'action.edit': '编辑',
  'action.removeHint': '删除该任务',
  'action.remove': '删除',
})

/**
 * 英文（**必须与 zh 键集完全一致**，对齐官方"bilingual balance"约定）。
 */
export const en = Object.freeze({
  'common.failed': 'Failed',
  'common.unknownReason': 'unknown reason',
  'common.needId': 'Please provide a task id.',
  /** Separator between list items (full-width comma in Chinese, comma+space in English). */
  'common.listSep': ', ',

  'mode.after': 'Delay',
  'mode.periodic': 'Repeating',
  'mode.at': 'Fixed time',
  'mode.atShort': 'specific time',
  'status.pending': 'Waiting',
  'status.paused': 'Paused',
  'status.overdue': 'Overdue',
  'status.done': 'Completed',

  'cmd.description': 'Create and manage scheduled tasks for this session (delay / fixed time / repeating)',
  'cmd.usage':
    'Usage: /schedule <when> <content> | /schedule list | /schedule remove <id> | ' +
    '/schedule pause <id> | /schedule resume <id> | /schedule run <id>',
  'cmd.help':
    'Time formats: +30s / +5m / +2h / +1h30m (delay); every 30m (repeating); @2026-09-20T15:00:00+08:00 (fixed time)',
  'cmd.needContentPeriodic': 'A repeating task needs content, e.g. /schedule every 30m check the queue',
  'cmd.needContentAt': 'A fixed-time task needs content.',
  'cmd.needContentAfter': 'A delayed task needs content.',
  'cmd.badInterval': 'Unrecognized interval "{spec}"; supported: 30s / 5m / 2h / 1h30m.',
  'cmd.badTime': 'Unrecognized "{head}".',
  'cmd.noTasks': 'This session has no scheduled tasks.',
  'cmd.created': 'Created scheduled task {id}\n  mode: {kind}\n  target: {when}\n  content: {prompt}',
  'cmd.deleted': 'Deleted task {id}.',
  'cmd.paused': 'Paused task {id}.',
  'cmd.resumed': 'Resumed task {id}.',
  'cmd.ran': 'Ran task {id} now.',
  'cmd.noSession': 'This command must be issued from a session.',
  'cmd.failed': 'Scheduled task operation failed: {message}',
  'cmd.listHeader': 'This session has {n} scheduled task(s):',

  'framing.task':
    'A one-shot scheduled task in this session has fired. This firing is unrelated to your previous reply; just perform the task content below once.',
  'framing.periodic':
    'A periodic task in this session fired automatically at its fixed interval. This firing is unrelated to your previous reply; just perform the task content below once.',
  'framing.periodicHint':
    'Note: if you notice the firing rate or content of this periodic task is clearly abnormal (e.g. far more frequent than interval_seconds, ' +
    'content not matching the setting, or firing when you did not expect it), tell the user honestly rather than assuming it is fine; ' +
    'you may use the scheduled-task tools to pause or delete the task yourself if needed.',

  // ── Client-facing notices (toast / in-panel runtime messages) ──
  //   ★ These follow the **UI locale** (rendered client-side), independent of the
  //     injection language (serverPromptLanguage): they are addressed to the
  //     human, not to the model.
  'notice.customTemplateReset':
    'Failed to read the custom injection templates. The file has been reset to its initial value (the previous file was kept as .bad-<timestamp>).',

  'tool.create.desc':
    'Create a scheduled task in the current session: when it fires, a preset prompt is injected into this session to wake you up and run it. ' +
    'You must provide prompt and **exactly one** time setting: ' +
    'afterSeconds (run once after N seconds), ' +
    'intervalSeconds (repeat every N seconds, minimum 10), ' +
    'scheduledAt (absolute RFC3339 time, e.g. "2026-09-20T15:00:00+08:00"). ' +
    'Example: user says "remind me to check the build in 10 minutes" -> {prompt:"check the build queue", afterSeconds:600}; ' +
    'user says "check the queue every half hour" -> {prompt:"check the queue", intervalSeconds:1800}; ' +
    'user says "remind me at 3pm today" -> convert local time to RFC3339 with an explicit offset first. ' +
    'Never pass more than one of the three time fields.',
  'tool.list.desc':
    'List all scheduled tasks of the current session (id, mode, status, target time). ' +
    'Always call it first to get the exact id before updating, pausing, resuming, removing, or running a task.',
  'tool.update.desc':
    'Update the content or time of a scheduled task in the current session. Call tick_list first to get the id. ' +
    'You may change prompt (task content), or the time (exactly one of afterSeconds / intervalSeconds / scheduledAt, ' +
    'same rules as tick_create). Omitted fields stay unchanged. ' +
    'Note: changing the time also switches the mode (passing afterSeconds makes it a "delay" task).',
  'tool.pause.desc':
    'Pause a scheduled task in the current session. ' +
    'Delay and repeating modes **freeze the remaining time** (resuming continues from the leftover time, not a restart); ' +
    'a fixed-time task will not run while paused even if its moment has passed.',
  'tool.resume.desc':
    'Resume a paused scheduled task in the current session. ' +
    'If the task is overdue, resuming means **running it immediately** (equivalent to "run now").',
  'tool.runNow.desc':
    'Run a scheduled task in the current session immediately (without waiting for its time). ' +
    'Typical use: the task is overdue and the user wants it run right away. ' +
    'A one-shot task is marked completed afterwards; a repeating task keeps its cycle.',
  'tool.remove.desc': 'Delete a scheduled task in the current session. Call tick_list first to confirm the id.',
  'param.prompt': 'Content to run when the task fires (injected into this session as a prompt).',
  'param.afterSeconds': 'Run once after how many seconds (mutually exclusive with the other two).',
  'param.intervalSeconds': 'Repeat every how many seconds (minimum 10, mutually exclusive with the other two).',
  'param.scheduledAt': 'Absolute time, RFC3339 with an explicit timezone offset (mutually exclusive with the other two).',
  'param.id': 'Task id (from tick_list).',
  'param.newPrompt': 'New task content; omit to keep unchanged.',
  'param.newAfterSeconds': 'Change to "run once after N seconds".',
  'param.newIntervalSeconds': 'Change to "repeat every N seconds".',
  'param.newScheduledAt': 'Change to an absolute time (RFC3339 with timezone).',
  'render.created': 'Created scheduled task: {task}',
  'render.updated': 'Updated scheduled task: {task}',
  'render.paused': 'Paused: {task}',
  'render.resumed': 'Resumed: {task}',
  'render.ran': 'Ran now: {task}',
  'render.removed': 'Deleted the scheduled task.',
  'render.noTasks': 'This session has no scheduled tasks.',
  'render.listHeader': 'This session has {n} scheduled task(s):',
  'render.fail': 'Failed ({code}): {message}',
  'render.noAgent': 'Scheduled-task tools must be called by a model inside a session (this call has no owning session).',

  'desc.after': 'delay {n}s',
  'desc.periodic': 'every {n}s',

  'err.promptNotString': 'prompt must be a string.',
  'err.promptEmpty': 'prompt must not be empty.',
  'err.promptTooLong': 'prompt is too long (limit {max} characters).',
  'err.mustBeInt': '{label} must be an integer.',
  'err.mustBeRfc3339': '{label} must be an RFC3339 string.',
  'err.badInstant': '{label} is not a valid instant.',
  'err.yearRange': '{label} is outside the representable year range.',
  'err.needOneSelector':
    'Exactly one time setting is required: after_seconds, interval_seconds, ' +
    'or scheduled_at/scheduledAt (an RFC3339 instant).',
  'err.unknownKind': 'Unknown mode: {kind}.',
  'err.nowNotSafeInt': 'now must be a safe integer of milliseconds.',
  'err.badCreatedBy': 'createdBy must be user or ai.',
  'err.afterMustBePositive': 'after_seconds must be a positive integer.',
  'err.afterTooLarge': 'after_seconds exceeds the limit {max} (30 days); use fixed-time mode for longer waits.',
  'err.intervalTooSmall': 'interval_seconds must not be smaller than {min} seconds.',
  'err.intervalTooLarge': 'interval_seconds exceeds the limit {max} seconds.',
  'err.mustBeFuture': 'The target time must be later than now.',
  'err.recordNotObject': 'A task record must be an object.',
  'err.idInvalid': 'A task id must be a non-empty string without surrounding whitespace.',
  'err.taskBadKind': 'Task {id} has an invalid mode: {kind}.',
  'err.taskEmptyPrompt': 'Task {id} has an empty prompt.',
  'err.taskBadScheduledAt': 'Task {id} has an invalid scheduledAt.',
  'err.periodicNoInterval': 'Repeating task {id} is missing a valid intervalSeconds.',
  'err.cannotPauseDone': 'A completed task cannot be paused.',
  'err.cannotResumeDone': 'A completed task cannot be resumed.',
  'err.cannotUpdateDone': 'A completed task cannot have its time changed.',
  'err.onlyOneSelector': 'Only one time setting may be given at a time.',
  'err.multipleSelectors': 'Only one time setting may be given, but got {got}; keep just one.',
  'err.afterRange': 'after_seconds must be an integer between 1 and {max}.',
  'err.intervalRange': 'interval_seconds must be between {min} and {max}.',

  'svc.aiDisabled': 'AI creation of scheduled tasks is disabled in this configuration.',
  'svc.limitTasks': 'This session has reached the task limit ({max}); delete some tasks first.',
  'svc.limitActive': 'This session has reached the active-task limit ({max}); pause or delete some tasks first.',
  'svc.notFound': 'Task {id} not found.',
  'svc.noAgent': 'This session has no live agent, so it cannot run now; open the session first.',

  'ui.title': 'Scheduled tasks',
  'ui.newTask': 'New scheduled task',
  'ui.add': 'Add',
  'ui.save': 'Save',
  'ui.cancel': 'Cancel',
  'ui.expand': 'Expand scheduled tasks panel',
  'ui.collapse': 'Collapse scheduled tasks panel',
  'ui.noTasks': 'This session has no scheduled tasks.',
  'ui.promptPlaceholder': 'Content to run when it fires (injected into this session as a prompt)',
  'ui.taskContent': 'Task content',
  'ui.hour': 'h',
  'ui.minute': 'm',
  'ui.second': 's',
  'ui.delay': 'Delay',
  'ui.at': 'Fixed time',
  'ui.periodic': 'Repeating',
  'ui.interval': 'Interval',
  'ui.execTime': 'Run at (browser local time)',
  'ui.intervalNote': 'Minimum interval 10 seconds. The task fires on a strict period from the previous setting.',

  // ── relative time & summaries ──
  'rel.seconds': '{n}s',
  'rel.minutes': '{n} min',
  'rel.hours': '{n} h',
  'rel.days': '{n} d',
  'rel.ago': '{text} ago',
  'rel.later': 'in {text}',
  'rel.then': 'later',
  'sum.delayHours': 'delay {n} h',
  'sum.delayMinutes': 'delay {n} min',
  'sum.delaySeconds': 'delay {n}s',
  'sum.everyHours': 'every {n} h',
  'sum.everyMinutes': 'every {n} min',
  'sum.everySeconds': 'every {n}s',
  'sum.remainingSeconds': '{n}s left',
  'sum.createdByAi': 'created by AI',
  'sum.firedCount': 'fired {n} time(s)',
  'sum.countAndNext': '{n} total · next {when}',
  'sum.countOnly': '{n} total',
  'sum.emptyList': 'No tasks',
  'sum.overdueCount': '{n} overdue',
  'sum.pendingCount': '{n} pending',
  'side.overdueItems': '{n} overdue',
  'side.pendingItems': '{n} pending',
  'side.overdueDetail': '{n} overdue',
  'side.pendingDetail': '{n} pending',
  'ui.cannotSubmit': 'Enter task content and set a duration greater than 0',
  'ui.requestFailed': 'Scheduled task request failed',
  'ui.hoursAria': '{label} hours',
  'ui.minutesAria': '{label} minutes',
  'ui.secondsAria': '{label} seconds',
  'action.runNowOverdue': 'Run now (this task is overdue and will not run automatically)',
  'action.resumeFromLeft': 'Resume (continue from the remaining time)',
  'action.run': 'Run',
  'action.resume': 'Resume',
  'action.pauseHint': 'Pause (delay and repeating modes freeze the remaining time)',
  'action.pause': 'Pause',
  'action.editHint': 'Edit content or schedule',
  'action.edit': 'Edit',
  'action.removeHint': 'Delete this task',
  'action.remove': 'Delete',
})

/** 所有支持语言的字典（键集必须一致）。 */
export const DICTS = Object.freeze({ zh, en })

/**
 * 把任意输入归一到 `'zh'` 或 `'en'`（**只支持这两种**）。
 *
 * 规则：
 *   - 空/未知 → `'zh'`（本插件主要模式，保证中文零回归）；
 *   - `en*` → `'en'`；`zh*` → `'zh'`（容忍 `zh-CN` 这类 BCP 47 写法）。
 *
 * @param raw - 原始语言标识。
 * @returns `'zh'` 或 `'en'`。
 */
export function normalizeLocale(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'zh'
  const lower = raw.toLowerCase()
  if (lower === 'en' || lower.startsWith('en-')) return 'en'
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh'
  // 非中英：按官方 FALLBACK_LOCALE 语义落到 en（官方兜底是英文）
  return 'en'
}

/**
 * 已捕获的 settings 服务引用（由 index.js 通过 `ctx.inject(['settings'], …)` 设置）。
 *
 * ★ 为什么不在 detectLocale 里直接 `ctx.get('settings')`：
 *   cordis 的 `ctx.get` **必须在 inject 作用域内**，否则抛
 *   `cannot get property "settings" without inject`。
 *   在插件根 ctx 上直接调它会**每次都抛**（虽然已捕获，
 *   但会刷 warn 噪音，且永远拿不到真实值）。
 *   正确做法：在注入回调里取一次服务引用，之后复用。
 *
 * @type {object | null}
 */
let settingsService = null

/**
 * 注入 settings 服务引用（由 index.js 调用）。
 *
 * ★ **接受两种形态**（DSH 0.1.5 与 0.2.0 的 settings API 完全不同）：
 *   - **0.1.5**：有 `get(ns)` → 直接读命名空间对象；
 *   - **0.2.0**：无 `get`，改为 `describe()` 返回描述符数组。
 * 因此这里**不再要求 `get`**，只要求"是个对象"；真正的能力判别放到
 * `readLocalePreference()` 里按需进行（**能力检测**，不依赖版本号）。
 *
 * @param service - settings 服务，或 null。
 */
export function installLocaleSettings(service) {
  settingsService =
    service !== null &&
    typeof service === 'object' &&
    (typeof service.get === 'function' || typeof service.describe === 'function')
      ? service
      : null
}

/**
 * 从 0.1.5 形态的 settings 服务读命名空间（`get(ns)`）。
 *
 * @returns 命名空间对象，或 undefined。
 */
function readViaGet() {
  const value = settingsService.get(LOCALE_NS)
  return value !== null && typeof value === 'object' ? value : undefined
}

/**
 * 从 0.2.0 形态的 settings 服务读命名空间（`describe()`）。
 *
 * ★ 0.2.0 的 `describe()` 返回 `SettingsDescriptor[]`，每项形如
 *   `{ ns, schema, value, revision, ... }`；`value` 是**经 schema 投影后的表单值**。
 *   官方 locale 把 `preference` 声明为 `volatile()`，因此它会出现在 `value` 里。
 *
 * ★ 为什么按 `ns` 字段匹配而不是按下标：`describe()` 返回的是**当前 profile 的
 *   全部**条目，顺序不保证；locale 也可能根本未被启用。
 *
 * @returns 命名空间对象，或 undefined。
 */
function readViaDescribe() {
  const list = settingsService.describe({ redactSecrets: false })
  if (!Array.isArray(list)) return undefined
  for (const d of list) {
    if (d !== null && typeof d === 'object' && d.ns === LOCALE_NS) {
      const v = d.value
      return v !== null && typeof v === 'object' ? v : undefined
    }
  }
  return undefined
}

/**
 * 读 locale 命名空间（**自动适配 0.1.5 / 0.2.0**）。
 *
 * ★ 判别顺序很重要：`describe` **两版都有**（语义不同），而 `get` 只有 0.1.5 有。
 *   所以**必须先查 `get`**，否则 0.1.5 会被误判成 0.2.0 而读到错误的形状。
 *
 * @returns 命名空间对象，或 undefined（读不到）。
 */
function readLocaleNamespace() {
  if (settingsService === null) return undefined
  try {
    if (typeof settingsService.get === 'function') return readViaGet()
    if (typeof settingsService.describe === 'function') return readViaDescribe()
  } catch {
    /* 读失败一律当作"读不到"，由调用方回退默认值 */
  }
  return undefined
}

/**
 * 探测当前语言（Host 侧）。
 *
 * ★ 途径：读官方 locale 客户端写入的 settings 命名空间。
 *   `LocaleRuntime.setLocale()` 会 `host.set('preference', id)`；
 *   这里用官方 `settings.get('locale')` 读回。
 *
 * ★ 缺省（从未显式选择过，或 settings 尚不可用）→ **中文**。
 *   理由见模块头注释第 4 条：主要模式是中文，且 host 侧无法复刻
 *   浏览器的 `navigator.language` 探测；若缺省回退英文会"挤占中文"。
 *
 * ★ 本函数**不抛错、不打日志** —— 它被高频调用（每次工具/命令/注入），
 *   噪音会淹没真正的问题。读不到就是中文，这是安全侧。
 *
 * @param ctx - 宿主上下文（仅用于兼容旧调用点；实际用 `installLocaleSettings` 注入的引用）。
 * @returns `'zh'` 或 `'en'`。
 */
export function detectLocale(ctx) {
  void ctx
  try {
    const value = readLocaleNamespace()
    if (value === undefined) return 'zh'
    const pref = value[LOCALE_FIELD]
    if (pref === undefined) return 'zh'
    return normalizeLocale(pref)
  } catch {
    return 'zh'
  }
}

/**
 * 用 `{name}` 占位符做插值（对齐官方字典的占位风格）。
 *
 * @param template - 含 `{key}` 的模板。
 * @param params - 替换值。
 * @returns 替换后的文本。
 */
function interpolate(template, params) {
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/gu, (whole, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  )
}

/**
 * 造一个翻译函数。
 *
 * ★ 回退链：目标语言 → **中文** → 键名本身。
 *   中文是 key 集的权威，所以英文缺键时回落中文**不会显示键名**；
 *   这保证英文模式永远不会露出 `some.key` 这种内部标识。
 *   （反过来中文缺键会露出键名 —— 但中文是权威，测试会锁住键集一致。）
 *
 * @param locale - `'zh'` 或 `'en'`。
 * @returns `(key, params?) => string`。
 */
export function createTranslator(locale) {
  const primary = DICTS[locale] ?? zh
  return function t(key, params) {
    const raw = primary[key] ?? zh[key]
    if (typeof raw !== 'string') return String(key)
    return interpolate(raw, params)
  }
}

/**
 * 校验 zh / en 键集完全一致（供测试与自检调用）。
 *
 * @returns `{ ok: boolean, missingInEn: string[], missingInZh: string[] }`。
 */
export function checkDictionaries() {
  const zhKeys = new Set(Object.keys(zh))
  const enKeys = new Set(Object.keys(en))
  const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k))
  const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k))
  return { ok: missingInEn.length === 0 && missingInZh.length === 0, missingInEn, missingInZh }
}
