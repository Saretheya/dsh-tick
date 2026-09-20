/**
 * Tick（定时任务）— 注入模板源（Host 半部内部模块）。
 *
 * ★ 本模块解决一个具体问题：**注入给模型的提示词用什么语言/什么文本**。
 *
 * ── 设计依据（全部来自官方源码实读）────────────────────────────────
 *
 * 官方 goal / todo / schedule 的做法是「**UI 本地化，注入硬编码英文**」
 *   - `dsh-goal-round-driver` 的 `renderGoalRoundPrompt(goal, round)` —— 函数签名
 *     **没有 locale 参数**，`<goal_round>` 正文是硬编码英文；
 *   - `dsh-tool-todo` / `dsh-tool-goal` / `dsh-schedule` —— 全树不含中文、
 *     不引用 `ctx.locale`（实读 0 命中）。
 * 也就是说官方**只把 UI 文案本地化**，模型可见的提示词一律英文。
 *
 * 本插件提供三档（用户定案）
 *   - `'en'`（**默认**）：与官方 goal/todo 一致 —— 注入固定英文；
 *   - `'zh'`：注入中文（本插件以中文为主模式，给偏好中文的用户）；
 *   - `'custom'`：从 `data/inject-templates.json` 读取**整段模板**。
 *
 * ── custom 档的纪律（用户定案）────────────────────────────────────
 *
 * 「选择 custom 的默认是资深用户，应当掌握配置文件的格式要求，
 *   因此我们**不做专门的复杂兜底逻辑，只要任意时刻出错均直接初始化**。」
 *
 * 因此本模块的错误处理**极简且有决断**
 *   - 任何读取/解析/结构错误 → **立即把文件重建为 en 初始模板**，
 *     并把坏文件改名保留（`.bad-<时间戳>`，用户手改的内容不凭空消失）；
 *   - 重建时**递增一个全局序号** `resetSeq`，供客户端识别"发生过复原"；
 *   - **不做**占位符完整性校验 —— 那是"复杂兜底"，与定案相悖。
 *
 * ★ 切到 custom 时文件不存在 = **静默创建**（不算失败，不提示）——
 *   否则用户一选中就看到"读取失败"，体验很差（用户定案）。
 *
 * ── 为什么单开一个文件 ────────────────────────────────────────
 *
 * `config.json` 承载三道闸等**重要配置**；把动辄几十行的模板塞进去会
 * 稀释重要区。故模板放 `data/inject-templates.json`，只在 custom 档被读取
 * （用户定案：「以防污染重要区」）。
 *
 * @module dsh-tick/templates
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { PATHS } from './storage.js'
import { en as EN_DICT, zh as ZH_DICT } from './i18n.js'

/**
 * 可自定义的模板键（顺序即文件里的书写顺序）。
 *
 * ★ 只有两项，因为采用**整段模板**（用户定案 决策 1 = 甲）
 *   `periodic` 已把末尾的异常自省提示包含在内，不必再单列一项。
 *   项数越少，用户改错的概率越低。
 */
export const TEMPLATE_KEYS = Object.freeze(['task', 'periodic'])

// ─────────────────────────────────────────────────────────────────────────────
// 一、内置模板（en / zh）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 占位符说明（★ 结构契约，两种语言完全一致）
 *
 *   {task_id_json}         任务 id（JSON 字符串，含引号）
 *   {kind}                 任务类型（JSON 字符串）
 *   {occurrence_at}        本次触发时刻（JSON 字符串）
 *   {interval_seconds}     周期秒数（JSON 数字，仅 periodic）
 *   {created_by}           创建者（JSON 字符串）
 *   {task_prompt_json}     任务正文（JSON 字符串）
 *
 * ★ 标签 `[SCHEDULER TASK]` / `[SCHEDULER PERIODIC]` 与字段名
 *   （`task_id_json` 等）**两种语言下完全相同** —— 它们是模型识别
 *   "这是定时任务"的结构契约，
 *   **绝不翻译**。模板化后这一点仍然保持：内置模板的标签与字段名一致，
 *   只有说明句不同。
 */

/**
 * 由字典里的说明句拼出内置模板。
 *
 * @param dict - 语言字典（zh / en）。
 * @returns 三个模板键到模板文本的映射。
 */
function builtinFrom(dict) {
  return Object.freeze({
    task: [
      '[SCHEDULER TASK]',
      dict['framing.task'],
      'task_id_json: {task_id_json}',
      'kind: {kind}',
      'occurrence_at: {occurrence_at}',
      'created_by: {created_by}',
      'task_prompt_json: {task_prompt_json}',
    ].join('\n'),
    periodic: [
      '[SCHEDULER PERIODIC]',
      dict['framing.periodic'],
      'task_id_json: {task_id_json}',
      'kind: "periodic"',
      'occurrence_at: {occurrence_at}',
      'interval_seconds: {interval_seconds}',
      'created_by: {created_by}',
      'task_prompt_json: {task_prompt_json}',
      '',
      dict['framing.periodicHint'],
    ].join('\n'),
  })
}

/** 内置英文模板（★ 默认档位）。 */
export const BUILTIN_EN = builtinFrom(EN_DICT)

/** 内置中文模板。 */
export const BUILTIN_ZH = builtinFrom(ZH_DICT)

/**
 * 取某一档位/语言的内置模板。
 * @param language - `'zh'` | `'en'`。
 * @returns 模板映射（未知语言回落 en）。
 */
export function builtinTemplates(language) {
  return language === 'zh' ? BUILTIN_ZH : BUILTIN_EN
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、JSONC 支持（去注释）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 剥掉 JSON 文本里的 `//` 行注释与 `/* *\/` 块注释。
 *
 * ★ 为什么要自己写：依赖树里**没有** strip-json-comments / json5 /
 *   jsonc-parser（实读确认），所以只能自实现。核心约 30 行。
 *
 * ★ 必须正确处理的状态（否则会破坏合法内容）
 *   - 字符串里的 `//`（如 URL `http://x`）**不能**当注释；
 *   - 字符串里的 `/*` **不能**当注释；
 *   - 注释里的引号**不能**影响状态机；
 *   - 字符串里的转义引号 `\"` **不能**提前结束字符串。
 *   以上四类已用受控用例逐一验证通过。
 *
 * @param text - 原始文本。
 * @returns 去掉注释后的文本（可被 JSON.parse 解析）。
 */
export function stripJsonComments(text) {
  let out = ''
  let mode = 'code'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line'
        i++
        continue
      }
      if (c === '/' && n === '*') {
        mode = 'block'
        i++
        continue
      }
      if (c === '"') {
        mode = 'str'
        out += c
        continue
      }
      out += c
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      }
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        i++
      }
      continue
    }
    // mode === 'str'
    if (c === '\\') {
      out += c + (n ?? '')
      i++
      continue
    }
    if (c === '"') mode = 'code'
    out += c
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、模板文件的内容（头部注释 + 数据）
// ─────────────────────────────────────────────────────────────────────────────

/** 模板文件名（放在插件自有 data/ 目录内）。 */
export const TEMPLATE_FILE = 'inject-templates.json'

/**
 * 生成模板文件的**头部注释**。
 *
 * ★ 这是给人读的部分：把"用途 / 怎么改 / 风险 / 出错会怎样"写在一处
 *   （用户定案：注释正好放在写明风险的位置）。
 *
 * ⚠ 实现注意：`JSON.stringify` **会丢掉这段注释**，所以重建文件时必须
 *   用 `renderTemplateFile()` 把头部与数据一起写，**不能**裸用
 *   `writeFile(JSON.stringify(...))` —— 否则第二次重建后说明就没了。
 *
 * @returns 头部注释文本（含首尾换行，尚未包进 `{}`）。
 */
function headerComment() {
  return `  /* ==========================================================================
   * Tick · 自定义注入模板 / Custom injection templates
   * --------------------------------------------------------------------------
   * 本文件仅在 config.json 的 "serverPromptLanguage" 设为 "custom" 时被读取。
   *
   * 【改哪里】只改每项的 "value"。它是**整段模板**，会原样注入给模型。
   *          "comment" 只是给人看的说明，改它不影响行为。
   *
   * 【可用占位符】保持这些花括号原样，程序会在注入前替换为实际值
   *     {task_id_json}       任务 id（JSON 字符串，含引号）
   *     {kind}               任务类型（JSON 字符串）
   *     {occurrence_at}      本次触发时刻（JSON 字符串）
   *     {interval_seconds}   周期秒数（JSON 数字，仅 periodic 有）
   *     {created_by}         创建者（JSON 字符串）
   *     {task_prompt_json}   任务正文（JSON 字符串）
   *
   * 【不要删】[SCHEDULER TASK] / [SCHEDULER PERIODIC] 这两个标签，以及
   *          task_id_json 等字段名。它们是模型识别"这是定时任务"的结构
   *          契约；删掉可能导致模型**不执行任务却也不报错**，极难排查。
   *
   * 【出错会怎样】本文件损坏或结构不合法时，Tick 会
   *     1. 把它改名保留为 inject-templates.json.bad-<时间戳>，不丢你的内容；
   *     2. 立即重新生成为英文初始模板；
   *     3. 在对话窗口用一条 toast 提示（约 4 秒后自动消失，无需手动关闭）。
   *   此后一律按重新生成后的内容读取。
   *
   * 【风险自担】选择 custom 意味着你自行负责模板格式；本插件不做
   *   占位符完整性校验（这是刻意的设计取舍，避免过度兜底）。
   * ========================================================================== */
`
}

/**
 * 渲染完整的模板文件文本（头部注释 + 数据）。
 *
 * @param templates - 模板映射（如 BUILTIN_EN）。
 * @returns 可直接写盘的文件内容。
 */
export function renderTemplateFile(templates) {
  const body = {}
  for (const key of TEMPLATE_KEYS) {
    body[key] = {
      comment: commentFor(key),
      value: typeof templates[key] === 'string' ? templates[key] : '',
    }
  }
  // 数据部分用 JSON.stringify 生成，再把头部注释插到第一个 '{' 之后。
  const json = JSON.stringify(body, null, 2)
  const withHeader = `{${headerComment()}${json.slice(1)}`
  return `${withHeader}\n`
}

/**
 * 给每个模板键配一句中文说明（写进文件的 `comment` 字段）。
 * @param key - 模板键。
 * @returns 说明文本。
 */
function commentFor(key) {
  switch (key) {
    case 'task':
      return '一次性任务（延迟 / 固定时刻）触发时注入的整段文本'
    case 'periodic':
      return '周期性任务触发时注入的整段文本（含末尾的异常自省提示）'
    default:
      return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、读取 / 校验 / 重建
// ─────────────────────────────────────────────────────────────────────────────

/** 复原序号：每次"出错→重建"递增，客户端据此识别新事件（模块级，进程内唯一）。 */
let resetSeq = 0

/** 最近一次复原的原因（给日志与提示用）。 */
let lastReset = null

/** 是否已经"认识"这个文件（用于区分「首次切到 custom」与「此前的文件坏了」）。 */
let fileKnown = false

/**
 * 读当前的复原序号。
 * @returns 序号（0 表示从未发生过复原）。
 */
export function getResetSeq() {
  return resetSeq
}

/**
 * 读最近一次复原的信息。
 * @returns `{seq, reason}` 或 null。
 */
export function getLastReset() {
  return lastReset === null ? null : { ...lastReset }
}

/** 仅供测试：复位模块级状态。 */
export function _resetTemplateState() {
  resetSeq = 0
  lastReset = null
  fileKnown = false
}

/**
 * 校验解析出来的对象是否是可用的模板集合。
 *
 * 规则（刻意简单）：每个键必须存在，且是 `{comment: string, value: string}`，
 * `value` 非空。**不校验占位符**（用户定案：不做复杂兜底）。
 *
 * @param parsed - JSON.parse 的结果。
 * @returns `{ok:true, templates}` 或 `{ok:false, reason}`。
 */
export function validateTemplates(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'root-not-object' }
  }
  const out = {}
  for (const key of TEMPLATE_KEYS) {
    const item = parsed[key]
    if (item === undefined) return { ok: false, reason: `missing-key:${key}` }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: `bad-item:${key}` }
    }
    if (typeof item.value !== 'string' || item.value.trim().length === 0) {
      return { ok: false, reason: `bad-value:${key}` }
    }
    if (item.comment !== undefined && typeof item.comment !== 'string') {
      return { ok: false, reason: `bad-comment:${key}` }
    }
    out[key] = item.value
  }
  return { ok: true, templates: Object.freeze(out) }
}

/**
 * 把模板文件重置为内置英文模板，并保留坏文件副本。
 *
 * ★ **保留副本**是刻意的（用户定案）：一次误编辑不该让用户的自定义永久消失。
 *   提示语里会说明"已复原"，同时用 `.bad-<时间戳>` 留现场。
 *
 * @param reason - 复原原因（记入日志与事件）。
 * @returns 复原后的模板（= 内置英文模板）。
 */
async function rebuildToEnglish(reason) {
  const file = PATHS.templates
  try {
    await rename(file, `${file}.bad-${Date.now()}`)
  } catch {
    // 文件不存在（首次）或改名失败：都不该阻止重建。
  }
  try {
    await writeFile(file, renderTemplateFile(BUILTIN_EN), 'utf8')
  } catch {
    // 写失败（磁盘满/无权限）也不能让插件挂掉：本次用内存里的 en 模板即可。
  }
  resetSeq += 1
  lastReset = { seq: resetSeq, reason }
  fileKnown = true
  return BUILTIN_EN
}

/**
 * 确保模板文件存在（切到 custom 时的**静默**创建，不算失败）。
 *
 * @returns true 表示本次创建了文件。
 */
export async function ensureTemplateFile() {
  const file = PATHS.templates
  try {
    // ★ 注意 writeFile 的签名是 (file, data, options) —— **没有第四个参数**。
    //   写成 writeFile(file, data, {flag:'wx'}, 'utf8') 会让 options 对象被忽略
    //   （实测：既覆盖了已有文件，又谎报"创建成功"）。编码要放进 options。
    await writeFile(file, renderTemplateFile(BUILTIN_EN), { encoding: 'utf8', flag: 'wx' })
    fileKnown = true
    return true
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
      fileKnown = true
      return false
    }
    // 其它错误（无权限等）留给 loadCustomTemplates 走"重建 → 提示"路径。
    return false
  }
}

/**
 * 读取自定义模板。
 *
 * ★ 语义（用户定案）：**只要任意时刻出错，就直接初始化**。
 *   因此任何失败都 → 重建为 en 模板 + 递增 resetSeq，并返回 en 模板。
 *   调用方（framing）拿到的**永远**是一份可用的模板，不会因为配置坏了
 *   而拒绝注入任务 —— 这是"配置坏了不该让功能失效"的一致取舍。
 *
 * ★ 首次切到 custom（文件尚不存在且此前没见过）→ 静默创建，**不算失败**。
 *
 * @param onLog - 可选日志回调 `(message) => void`。
 * @returns 冻结的模板映射（失败时为内置英文模板）。
 */
export async function loadCustomTemplates(onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {}

  // 首次：静默创建，不提示。
  if (!fileKnown) {
    const created = await ensureTemplateFile()
    if (created) {
      log('已创建 data/inject-templates.json（英文初始模板）')
      return BUILTIN_EN
    }
  }

  let text
  try {
    text = await readFile(PATHS.templates, 'utf8')
  } catch (error) {
    const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT'
    log(`自定义模板读取失败（${missing ? 'ENOENT' : 'io-error'}），已复原为英文初始模板`)
    return rebuildToEnglish(missing ? 'file-missing' : 'file-unreadable')
  }

  let parsed
  try {
    parsed = JSON.parse(stripJsonComments(text))
  } catch {
    log('自定义模板 JSON 解析失败，已复原为英文初始模板')
    return rebuildToEnglish('parse-error')
  }

  const checked = validateTemplates(parsed)
  if (!checked.ok) {
    log(`自定义模板结构不合法（${checked.reason}），已复原为英文初始模板`)
    return rebuildToEnglish(checked.reason)
  }

  fileKnown = true
  return checked.templates
}

/**
 * 同步版：由已加载的模板映射渲染模板文本。
 *
 * @param templates - 模板映射。
 * @param key - 模板键。
 * @param vars - 占位符取值。
 * @returns 渲染后的文本。
 */
export function applyTemplate(templates, key, vars) {
  const raw = typeof templates?.[key] === 'string' ? templates[key] : BUILTIN_EN[key] ?? ''
  // ★ 单趟替换：避免替换结果里再含 `{...}` 时被二次解释（注入防护）。
  return raw.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}
