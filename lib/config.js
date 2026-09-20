/**
 * Tick（定时任务）— 插件自有配置。
 *
 * ★ 为什么不用 `ctx.settings.installSection` / 共享 `settings.yaml`：
 *   DSH 卸载插件时**不清理** settings.yaml 中的命名空间段，会**永久残留**
 *   （实测结论：见
 *   本插件因此走**自有配置文件** `data/config.json`，卸载即随目录消失。
 *
 * 三道闸（刻意如此）：
 *   maxTasksPerSession      每会话任务总数上限（限"总量"）
 *   maxActivePerSession     同时处于启用态的任务数上限（限"并发启用"，防 AI 批量误建）
 *   maxInjectionsPerMinute  注入频率上限（防自我循环）
 *
 * @module dsh-tick/config
 */

import { LIMITS } from './domain.js'

/** 默认配置。数值刻意保守——两道"上限"闸是为了兜住 AI 误操作，不是性能调优。 */
export const DEFAULT_CONFIG = Object.freeze({
  /**
   * ★★ 注入给模型的提示词语言（**与 UI 语言相互独立**）。
   *
   * `'en'`（默认）| `'zh'` | `'custom'`
   *
   * ── 为什么默认英文 ─────────────────────────────────────────
   * 官方 goal / todo / schedule 的注入文本**都是硬编码英文**，不随 UI
   * 语言变化（实读：`dsh-goal-round-driver` 的 render 函数没有 locale 参数，
   * 三个包全树不含中文、不引用 ctx.locale）。默认 en 即**与官方一致**。
   *
   * ── 为什么独立于 UI 语言 ───────────────────────────────────
   * Host 侧看不到 `navigator.language`，无法复刻浏览器的语言探测；
   * 若这里跟随 UI，则"从未显式选过语言"的用户会被误判。故给一个
   * **显式档位**，让用户自己决定模型看到什么语言。
   *
   * ── custom 档 ──────────────────────────────────────────────
   * 从 `data/inject-templates.json` 读取**整段模板**（单独成文件，
   * 以免污染本文件的重要配置区）。任何读取/结构错误 → 立即复原为
   * en 初始模板并保留 `.bad-<时间戳>` 副本；见 templates.js。
   */
  serverPromptLanguage: 'en',
  /** 每会话任务总数上限。 */
  maxTasksPerSession: 50,
  /** 同时启用（enabled）的任务数上限。 */
  maxActivePerSession: 10,
  /** 同一会话每分钟最多注入次数。 */
  maxInjectionsPerMinute: 1,
  /** 心跳间隔（毫秒）：DSH 关闭期间"冻结计时"的精度来源。 */
  heartbeatMs: 15_000,
  /**
   * 到期判定的容错宽限（毫秒）：避免把"刚触发"误判成"错过"。
   *
   * ★ 生效路径：`store.load()` → `recoverOnLoad(task, now, config.graceMs)`。
   *   改动本项**立即生效**（每次加载任务时读取），无需重启 DSH。
   *   （此前该值未被读取，改它无效——已修，并有回归测试锁死。）
   */
  graceMs: LIMITS.graceMs,
  /** 是否在输入框上方显示 dock 面板。 */
  showDock: true,
  /**
   * 是否在侧栏底部显示「定时任务」汇总入口（默认**关闭**）。
   *
   * ★ 为什么默认关闭：它是**全局**汇总（所有会话的待执行/已超时总数），
   *   出现在侧栏"设置"旁边，属于锦上添花；对多数用户，会话内的 dock 面板
   *   已经够用。开启后点它可展开跨会话列表并跳转到对应会话。
   *
   * ★ 为什么不做"会话行内图标"：官方把整个会话列表区声明为 **single** 插槽
   *   并由 ui-workspace 独占（`sidebar.workspaces`），会话行内部**没有** slot
   *   渲染点，用官方机制**做不到**。唯一可行路径是 DOM 注入（依赖哈希类名、
   *   改版即碎、失效时还静默无提示），代价大于收益，故不做。
   *   详见 README「为什么没有会话行内的图标」一节。
   */
  showSidebarSummary: false,
  /** 是否允许 AI（而非仅用户）创建任务。 */
  allowAiCreate: true,
})

/** 各字段的校验规则（用于把磁盘值收敛回合法区间，非法值回退默认）。 */
const RULES = Object.freeze({
  serverPromptLanguage: { oneOf: ['en', 'zh', 'custom'] },
  maxTasksPerSession: { min: 1, max: 1000, int: true },
  maxActivePerSession: { min: 1, max: 200, int: true },
  maxInjectionsPerMinute: { min: 1, max: 60, int: true },
  heartbeatMs: { min: 1000, max: 300_000, int: true },
  graceMs: { min: 0, max: 600_000, int: true },
  showDock: { bool: true },
  showSidebarSummary: { bool: true },
  allowAiCreate: { bool: true },
})

/**
 * 把磁盘上的配置收敛成一个合法配置。
 *
 * 设计取舍：**非法值回退默认而不是抛错**——配置坏了不该让插件加载失败，
 * 但必须让它可见（调用方会记录被修正的字段）。
 *
 * @param stored - 磁盘读到的原始值（可能是 undefined / 非对象 / 部分字段）。
 * @returns 冻结的合法配置。
 */
export function readConfig(stored) {
  const source = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  const result = {}
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const rule = RULES[key]
    const raw = source[key]
    if (rule?.bool === true) {
      result[key] = typeof raw === 'boolean' ? raw : fallback
      continue
    }
    if (Array.isArray(rule?.oneOf)) {
      // 枚举档位：只接受清单内的值（大小写与首尾空白已归一）。
      const norm = typeof raw === 'string' ? raw.trim().toLowerCase() : raw
      result[key] = rule.oneOf.includes(norm) ? norm : fallback
      continue
    }
    if (Number.isSafeInteger(raw) && raw >= rule.min && raw <= rule.max) {
      result[key] = raw
    } else {
      result[key] = fallback
    }
  }

  // 交叉约束：同时启用的上限不应超过总数上限，否则"并发闸"形同虚设。
  if (result.maxActivePerSession > result.maxTasksPerSession) {
    result.maxActivePerSession = Math.max(1, Math.min(result.maxActivePerSession, result.maxTasksPerSession))
  }

  return Object.freeze(result)
}

/**
 * 列出被修正（或缺失）的字段，供 UI/日志如实展示"配置与生效值的差异"。
 * @param stored - 磁盘原始值。
 * @param effective - 收敛后的生效值。
 * @returns 被修正的字段名数组。
 */
export function correctedFields(stored, effective) {
  const source = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  const changed = []
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (source[key] !== effective[key]) changed.push(key)
  }
  return changed
}
