/**
 * Tick（定时任务）— 客户端半部（Web UI 可写管理面板）。
 *
 * ⚠ 构建产物格式约束（不可协商）：
 *   必须是 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，
 *   **裸 ESM 会被 Web 端丢弃**（表现为 client bundle not found）；
 *   React 用 `React.createElement`（无 JSX）。
 *
 * ★ 与官方 goal / todo 的布局兼容（实读确认）：
 *   `conversation.input.dock` 的声明是 `kind:'list'` + `scope:'session'`，
 *   渲染处是纵向 flex 堆叠，靠**唯一 id + order** 并列：
 *     todo(order 0) · goal(order 10) · 本插件(order 15) · queue(order 20)
 *   因此三方同时存在时自动一上一下、互不覆盖。**绝不可复用别人的 id**
 *   （复用即"遮蔽"）。无任务时返回 null，不占位。
 *
 * ★ 图标复用官方 primitives（与 goal 面板同一套，含 Tooltip + aria-label）。
 *
 * ★ 时区纪律：`at` 模式提交时**必须显式**把浏览器时区偏移写进 RFC3339——
 *   宿主与模型都不会去猜本地时区（对齐官方 schedule 的显式时区边界）。
 *
 * @module dsh-tick/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-tick',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /** 管理 RPC 的端点名（`connection.rpc.call('/api', <ENDPOINT>, …)` 的第二参）。 */
    const ENDPOINT = 'tick'
    /** 展开时轮询间隔（有倒计时要看，快一点）。 */
    const POLL_EXPANDED_MS = 2000
    /** 折叠时轮询间隔（只要个摘要，慢一点省资源）。 */
    const POLL_COLLAPSED_MS = 15000

    // ────────────────────────────── 样式 ──────────────────────────────

    const STYLES = `
.dim-tk-dock { box-sizing: border-box; width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)); margin: 0 auto; }
.dim-tk-bar { box-sizing: border-box; width: 100%; max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset)); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-specific-tip); border-radius: 12px; align-items: center; gap: 4px; min-height: 36px; margin: 0 auto; padding: 4px 5px 4px 12px; display: flex; }
.dim-tk-header { box-sizing: border-box; min-width: 0; flex: 1; align-items: center; gap: 10px; display: flex; cursor: pointer; background: 0 0; border: none; border-radius: 8px; padding: 2px 4px 2px 0; text-align: left; font: inherit; color: inherit; }
.dim-tk-header:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dim-tk-chevron { flex: none; color: var(--dsw-alias-label-tertiary); margin-left: auto; display: inline-flex; align-items: center; }
.dim-tk-glyph { color: var(--dsw-alias-label-tertiary); flex: none; display: inline-flex; }
.dim-tk-label { color: var(--dsw-alias-label-primary); flex: none; font-size: 13px; font-weight: 500; line-height: 24px; }
.dim-tk-summary { min-width: 0; color: var(--dsw-alias-label-primary-dimmed); text-overflow: ellipsis; white-space: nowrap; flex: 1; font-size: 13px; line-height: 20px; overflow: hidden; }
.dim-tk-badge { flex: none; font-size: 12px; line-height: 18px; padding: 0 6px; border-radius: 9px; white-space: nowrap; }
.dim-tk-badge-overdue { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dim-tk-badge-paused { color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-interactive-bg-hover); }
/* 「待执行」徽章：中性/偏正向，与「已超时」的红色区分开 */
.dim-tk-badge-pending { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.dim-tk-actions { flex: none; align-items: center; gap: 6px; display: flex; }
.dim-tk-iconBtn { width: 28px; height: 28px; color: var(--dsw-alias-label-tertiary); cursor: pointer; background: 0 0; border: none; border-radius: 999px; justify-content: center; align-items: center; padding: 0; display: inline-flex; flex-shrink: 0; }
.dim-tk-iconBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dim-tk-iconBtn:disabled { opacity: .4; cursor: default; }
/* 展开面板：★ 必须与折叠行同一套宽度体系，否则会横向拉满整个右侧宽度。
   官方 todo 面板（.lXshSW_root）的范式是：
     width: calc(100% - side-clearance*2 - dock-inset*4)
     max-width: calc(--dsh-composer-card-max-width - dock-inset*4)   ← 与输入框同宽
     margin: 0 auto                                                  ← 居中
   本插件原先只有 .dim-tk-bar（折叠行）带了这套约束，而 .dim-tk-panel
   （展开面板）**没带** → 折叠态正常、一展开就占满宽度（用户实测发现）。 */
.dim-tk-panel { box-sizing: border-box; width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)); max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset)); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-specific-tip); border-radius: 12px; margin: 6px auto 0; padding: 8px; display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
.dim-tk-row { align-items: center; gap: 8px; padding: 6px 4px; border-radius: 8px; display: flex; }
.dim-tk-row + .dim-tk-row { border-top: .5px solid var(--dsw-alias-border-l1); }
.dim-tk-rowMain { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.dim-tk-rowTop { align-items: center; gap: 6px; min-width: 0; display: flex; }
.dim-tk-prompt { min-width: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.dim-tk-meta { color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-tk-form { border-top: .5px solid var(--dsw-alias-border-l1); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.dim-tk-tabs { gap: 4px; display: flex; }
.dim-tk-tab { font-size: 12px; line-height: 20px; padding: 2px 10px; border-radius: 999px; cursor: pointer; border: .5px solid var(--dsw-alias-border-l1); background: 0 0; color: var(--dsw-alias-label-secondary); white-space: nowrap; flex-shrink: 0; }
.dim-tk-tabOn { background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); color: #fff; }
.dim-tk-input, .dim-tk-textarea { box-sizing: border-box; border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 6px; outline: none; padding: 4px 8px; font-size: 13px; line-height: 20px; width: 100%; font-family: inherit; }
.dim-tk-input:focus, .dim-tk-textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
.dim-tk-textarea { resize: vertical; min-height: 44px; }
.dim-tk-timeRow { align-items: center; gap: 6px; display: flex; flex-wrap: wrap; }
.dim-tk-num { width: 62px; flex: none; }
.dim-tk-unit { color: var(--dsw-alias-label-caption); font-size: 12px; flex: none; }
.dim-tk-formActions { align-items: center; gap: 8px; display: flex; }
.dim-tk-btn { font-size: 13px; line-height: 24px; padding: 0 12px; border-radius: 6px; cursor: pointer; border: .5px solid var(--dsw-alias-border-l1); background: 0 0; color: var(--dsw-alias-label-primary); white-space: nowrap; flex-shrink: 0; }
.dim-tk-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dim-tk-btn:disabled { opacity: .4; cursor: default; }
.dim-tk-btnPrimary { background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); color: #fff; }
.dim-tk-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dim-tk-empty { color: var(--dsw-alias-label-caption); font-size: 13px; padding: 6px 4px; }
.dim-tk-note { color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
/* 侧栏底部的全局汇总入口（对齐官方 occupant 的宽栏/窄栏双形态） */
/* ★ 布局要点（均为实测结论，改动前先读）：
   本组件的宿主是侧栏底部的 flex 行容器（hHd-Xa_footerActions），官方设置按钮
   在其中是 flex:1 1 0%（实测宽 260px）。
   若本组件不声明伸展（默认 flex:0 1 auto），它就只按内容宽度收缩（实测 139px），
   后果：① 比设置行窄、视觉不齐；② 徽章靠右对齐的基准随之漂移，内容变化时左右跳动。
   所以必须用 flex:1 1 auto 让它与设置行同宽。
   注意：max-width / width:100% 在这种 flex 行里不可靠，不要用它们代替 flex 伸展。
   ⚠ 本 CSS 块位于 JS 模板字符串内部：说明文字里**不要出现反引号**，
     否则会提前结束字符串导致语法错误（本项目已踩三次，另有 tools/check-css-backticks.mjs 守卫）。 */
.dim-tk-sideWrap { flex: 1 1 auto; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; }
/* 按钮撑满 wrap（wrap 已与设置行同宽），徽章组因此恒定贴在右端 */
.dim-tk-side { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; align-items: center; gap: 8px; display: flex; cursor: pointer; background: 0 0; border: none; border-radius: 8px; padding: 6px 8px; color: var(--dsw-alias-label-secondary); font: inherit; text-align: left; }
.dim-tk-side:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dim-tk-sideRail { justify-content: center; padding: 6px 0; }
.dim-tk-sideGlyph { flex: none; display: inline-flex; }
/* 标签占据剩余空间并可省略；徽章组靠右（margin-left:auto）——
   这样"只有一种徽章"时它仍在右端同一位置，不会随文字长度左右跳。 */
.dim-tk-sideLabel { min-width: 0; flex: 1 1 auto; font-size: 13px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dim-tk-sideBadges { flex: none; align-items: center; gap: 4px; display: inline-flex; margin-left: auto; }
.dim-tk-sideList { display: flex; flex-direction: column; gap: 2px; padding: 2px 4px 4px; box-sizing: border-box; max-width: 100%; min-width: 0; }
/* ★ 每条**竖排**：任务文本一行、徽章下一行。侧栏宽栏只有约 280px，
   横排会迫使文本与徽章都退化成省略号（实测）。 */
.dim-tk-sideItem { flex-direction: column; align-items: stretch; gap: 3px; display: flex; padding: 4px; border-radius: 6px; box-sizing: border-box; max-width: 100%; min-width: 0; }
.dim-tk-sideItem:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* 文本可收缩（flex 且 min-width:0）—— 空间不足时省略文本而不是裁切徽章 */
.dim-tk-sideItemText { min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 徽章行：可换行（徽章数量不定），左对齐 */
.dim-tk-sideItemMeta { align-items: center; gap: 4px; display: flex; flex-wrap: wrap; min-width: 0; }
/* 树形分支连接符（|___>）：表示这一行是从上方标题展开的内容。
   颜色取 label-tertiary —— 比 border 更可见，又不抢徽章的视觉重心。 */
.dim-tk-sideBranch { flex: none; color: var(--dsw-alias-label-tertiary); margin-right: 2px; }
/* 侧栏内的徽章：绝不溢出容器 */
.dim-tk-sideItem .dim-tk-badge, .dim-tk-side .dim-tk-badge { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
`

    let stylesInstalled = false
    /** 安装样式（幂等；随 effect 释放移除）。 */
    function installStyles() {
      if (stylesInstalled) return () => {}
      const tagId = 'dsh-tick/styles'
      if (document.querySelector(`style[data-plugin-style="${tagId}"]`) !== null) {
        stylesInstalled = true
        return () => {}
      }
      const style = document.createElement('style')
      style.dataset.pluginStyle = tagId
      style.textContent = STYLES
      document.head.appendChild(style)
      stylesInstalled = true
      return () => {
        style.remove()
        stylesInstalled = false
      }
    }

    // ──────────────────────── 官方图标（可降级） ────────────────────────

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    /** 取一个官方图标组件（取不到返回 undefined）。 */
    function icon(name) {
      return primitives !== null ? primitives[name] : undefined
    }

    /**
     * 图标按钮（Tooltip + aria-label；图标缺失时降级为文字，**绝不因缺图标而崩**）。
     *
     * ★ 刻意**不设 `title`**：`title` 会触发浏览器**原生**提示，
     *   与下面的 `Tooltip` 组件**同时弹出**，出现两个重叠的提示框
     *   （用户实测截图发现）。官方 goal 的图标按钮同样只用
     *   `Tooltip` + `aria-label`，不设 `title`。
     *   无障碍语义由 `aria-label` 承担，不依赖 `title`。
     *
     * @param props - 属性。
     * @returns React 元素。
     */
    function IconButton(props) {
      const { iconName, label, onClick, disabled, fallbackText } = props
      const Icon = icon(iconName)
      const button = React.createElement(
        'button',
        {
          type: 'button',
          className: 'dim-tk-iconBtn',
          onClick,
          disabled: disabled === true,
          'aria-label': label,
        },
        Icon !== undefined && Icon !== null
          ? React.createElement(Icon, { size: 14 })
          : React.createElement('span', { style: { fontSize: 12 } }, fallbackText ?? label),
      )
      if (primitives !== null && typeof primitives.Tooltip === 'function') {
        return React.createElement(primitives.Tooltip, { label, side: 'bottom', delayMs: 500 }, button)
      }
      return button
    }

    // ────────────────────────────── 工具函数 ──────────────────────────────

    /** 把管理 RPC 的 `{ok,value}` 信封解包成值或抛错。 */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && result.ok === true) return result.value
      if (result !== null && typeof result === 'object' && result.ok === false) {
        const error = new Error(result.error?.message ?? t('ui.requestFailed'))
        error.code = result.error?.code
        throw error
      }
      return result
    }

    /** 两位补零。 */
    const pad = (n) => String(n).padStart(2, '0')

    /**
     * 相对时间文本（如"2 分钟后"）。
     * @param iso - 目标时刻（RFC3339）。
     * @param now - 当前毫秒。
     * @returns 文本。
     */
    function relativeText(iso, now) {
      const target = Date.parse(iso)
      if (!Number.isFinite(target)) return '—'
      const diff = Math.round((target - now) / 1000)
      const past = diff < 0
      const abs = Math.abs(diff)
      let text
      if (abs < 60) text = t('rel.seconds', { n: abs })
      else if (abs < 3600) text = t('rel.minutes', { n: Math.floor(abs / 60) })
      else if (abs < 86400) text = t('rel.hours', { n: Math.floor(abs / 3600) })
      else text = t('rel.days', { n: Math.floor(abs / 86400) })
      return past ? t('rel.ago', { text }) : t('rel.later', { text })
    }

    /** 绝对时间文本（浏览器本地）。 */
    function localText(iso) {
      const d = new Date(iso)
      if (!Number.isFinite(d.getTime())) return '—'
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    /** 模式文本。 */
    function modeText(task) {
      if (task.kind === 'after') {
        const s = task.afterSeconds ?? 0
        return s >= 3600 ? t('sum.delayHours', { n: Math.round(s / 3600) }) : s >= 60 ? t('sum.delayMinutes', { n: Math.round(s / 60) }) : t('sum.delaySeconds', { n: s })
      }
      if (task.kind === 'periodic') {
        const s = task.intervalSeconds ?? 0
        return s >= 3600 ? t('sum.everyHours', { n: Math.round(s / 3600) }) : s >= 60 ? t('sum.everyMinutes', { n: Math.round(s / 60) }) : t('sum.everySeconds', { n: s })
      }
      return t('mode.at')
    }

    /** 状态文本。 */
    function statusText(status) {
      return t(`status.${status}`)
    }

    /** 把"时/分/秒"折成总秒。 */
    function toSeconds(h, m, s) {
      return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)
    }

    /** 由总秒拆成 [时, 分, 秒]。 */
    function fromSeconds(total) {
      // ⚠ 变量名刻意用 `sec` 而不是 `t`：模块里 `t` 是**翻译函数**，
      //   用 `t` 做局部变量会遮蔽它（本函数当前不调用 t()，但属隐患）。
      const sec = Math.max(0, Number(total) || 0)
      return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
    }

    /**
     * 把 datetime-local 的值转成**带显式时区偏移**的 RFC3339。
     *
     * ★ 为什么必须显式带偏移：宿主与模型都不会去猜本地时区
     *   （对齐官方 schedule 的显式时区边界）。
     * @param value - `YYYY-MM-DDTHH:mm` 形式的值。
     * @returns RFC3339 字符串（带 ±HH:MM）；非法输入返回 null。
     */
    function localInputToRfc3339(value) {
      if (typeof value !== 'string' || value.length === 0) return null
      const d = new Date(value)
      if (!Number.isFinite(d.getTime())) return null
      const offsetMin = -d.getTimezoneOffset()
      const sign = offsetMin >= 0 ? '+' : '-'
      const absMin = Math.abs(offsetMin)
      return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
        `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`
      )
    }

    /** 把 RFC3339 转回 datetime-local 的输入值（本地）。 */
    function rfc3339ToLocalInput(iso) {
      const d = new Date(iso)
      if (!Number.isFinite(d.getTime())) return ''
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** ISO → `YYYY-MM-DDTHH:mm`（供 datetime-local 的 min 属性）。 */
    function nowLocalInput() {
      return rfc3339ToLocalInput(new Date().toISOString())
    }

    // ────────────────────────────── 任务行 ──────────────────────────────

    /**
     * 一行任务（含图标操作）。
     * @param props - 属性。
     * @returns React 元素。
     */
    function TaskRow(props) {
      const { task, now, busy, onPause, onResume, onEdit, onRemove } = props
      const overdue = task.status === 'overdue'
      const paused = task.status === 'paused'
      const finished = task.status === 'done'

      const metaParts = [statusText(task.status), modeText(task)]
      if (task.status === 'pending') metaParts.push(`${localText(task.scheduledAt)} · ${relativeText(task.scheduledAt, now)}`)
      else if (paused && task.remainingMs !== null) metaParts.push(t('sum.remainingSeconds', { n: Math.max(0, Math.round(task.remainingMs / 1000)) }))
      else metaParts.push(localText(task.scheduledAt))
      if (task.createdBy === 'ai') metaParts.push(t('sum.createdByAi'))
      if (task.kind === 'periodic' && task.firedCount > 0) metaParts.push(t('sum.firedCount', { n: task.firedCount }))

      const badges = []
      if (overdue) badges.push(React.createElement('span', { key: 'od', className: 'dim-tk-badge dim-tk-badge-overdue' }, t('status.overdue')))
      if (paused) badges.push(React.createElement('span', { key: 'pa', className: 'dim-tk-badge dim-tk-badge-paused' }, t('status.paused')))

      return React.createElement(
        'div',
        { className: 'dim-tk-row', 'data-tick-task': task.id },
        React.createElement(
          'div',
          { className: 'dim-tk-rowMain' },
          React.createElement(
            'div',
            { className: 'dim-tk-rowTop' },
            React.createElement('span', { className: 'dim-tk-prompt', title: task.prompt }, task.prompt),
            ...badges,
          ),
          React.createElement('span', { className: 'dim-tk-meta', title: metaParts.join(' · ') }, metaParts.join(' · ')),
        ),
        React.createElement(
          'div',
          { className: 'dim-tk-actions' },
          // ★ 已超时任务**只保留一个**播放按钮（用户定案）：
          //   原先「立即执行」与「恢复」是两个按钮、都用 IconPlayOutline16，
          //   视觉完全相同 → 用户无法分辨（实测反馈）。
          //   实际上二者本就等价：`service.resume()` 对 overdue 任务
          //   会走 `if (wasOverdue) await this.runNow(...)`，即"恢复 = 立即执行"。
          //   因此删掉冗余的那个，label 说明这是立即执行。
          paused || overdue
            ? IconButton({
                iconName: 'IconPlayOutline16',
                label: overdue ? t('action.runNowOverdue') : t('action.resumeFromLeft'),
                onClick: () => onResume(task.id),
                disabled: busy,
                fallbackText: overdue ? t('action.run') : t('action.resume'),
              })
            : IconButton({
                iconName: 'IconPauseOutline16',
                label: t('action.pauseHint'),
                onClick: () => onPause(task.id),
                disabled: busy || finished,
                fallbackText: t('action.pause'),
              }),
          IconButton({
            iconName: 'IconEditOutline16',
            label: t('action.editHint'),
            onClick: () => onEdit(task),
            disabled: busy || finished,
            fallbackText: t('action.edit'),
          }),
          IconButton({
            iconName: 'IconTrashOutline16',
            label: t('action.removeHint'),
            onClick: () => onRemove(task.id),
            disabled: busy,
            fallbackText: t('action.remove'),
          }),
        ),
      )
    }

    // ────────────────────────────── 新建/编辑表单 ──────────────────────────────

    /**
     * 新建或编辑任务的表单。
     * @param props - 属性。
     * @returns React 元素。
     */
    function TaskForm(props) {
      const { editing, busy, onCancel, onSubmit } = props
      const [mode, setMode] = React.useState(editing === null ? 'after' : editing.kind)
      const [prompt, setPrompt] = React.useState(editing === null ? '' : editing.prompt)
      // ★ 新建时默认全 0（用户定案）：原先延迟默认 10 分、重复默认 30 分，
      //   导致"只想设 30 秒"的用户只改秒框时会得到 10 分 30 秒（实测混淆）。
      //   编辑时仍保留原有值。
      const [h, setH] = React.useState(() => String(fromSeconds(editing?.afterSeconds ?? 0)[0]))
      const [m, setM] = React.useState(() => String(fromSeconds(editing?.afterSeconds ?? 0)[1]))
      const [s, setS] = React.useState(() => String(fromSeconds(editing?.afterSeconds ?? 0)[2]))
      const [ih, setIh] = React.useState(() => String(fromSeconds(editing?.intervalSeconds ?? 0)[0]))
      const [im, setIm] = React.useState(() => String(fromSeconds(editing?.intervalSeconds ?? 0)[1]))
      const [is, setIs] = React.useState(() => String(fromSeconds(editing?.intervalSeconds ?? 0)[2]))
      const [atValue, setAtValue] = React.useState(() =>
        editing?.kind === 'at' ? rfc3339ToLocalInput(editing.scheduledAt) : nowLocalInput(),
      )

      /**
       * 当前模式下的时长（秒）。
       * 用于「时长为 0 时禁用提交」——用户定案：防误操作。
       */
      const durationSeconds =
        mode === 'after' ? toSeconds(h, m, s) : mode === 'periodic' ? toSeconds(ih, im, is) : null

      /**
       * 提交是否可用。
       *
       * ★ 规则（用户定案）：内容非空 **且** 时长不为 0。
       *   延迟与重复两种模式都适用；固定时刻模式无时长概念，只校验内容与时刻。
       *   这样"时长为 0"不会被提交成一条**立刻触发**的任务（那几乎必然是误操作）。
       */
      const canSubmit = (() => {
        if (prompt.trim().length === 0) return false
        if (mode === 'at') return localInputToRfc3339(atValue) !== null
        return durationSeconds !== null && durationSeconds > 0
      })()

      /** 提交。 */
      const submit = () => {
        const trimmed = prompt.trim()
        if (trimmed.length === 0) return
        const selector = {}
        if (mode === 'after') {
          if (durationSeconds === null || durationSeconds <= 0) return
          selector.afterSeconds = durationSeconds
        } else if (mode === 'periodic') {
          if (durationSeconds === null || durationSeconds <= 0) return
          selector.intervalSeconds = durationSeconds
        } else {
          const rfc = localInputToRfc3339(atValue)
          if (rfc === null) return
          selector.scheduledAt = rfc
        }
        onSubmit({ prompt: trimmed, ...selector })
      }

      const numRow = (label, hh, mm, ss, setH, setM, setS) =>
        React.createElement(
          'div',
          { className: 'dim-tk-timeRow' },
          React.createElement('span', { className: 'dim-tk-label' }, label),
          React.createElement('input', {
            className: 'dim-tk-input dim-tk-num',
            type: 'number',
            min: 0,
            value: hh,
            onChange: (e) => setH(e.target.value),
            'aria-label': t('ui.hoursAria', { label }),
          }),
          React.createElement('span', { className: 'dim-tk-unit' }, t('ui.hour')),
          React.createElement('input', {
            className: 'dim-tk-input dim-tk-num',
            type: 'number',
            min: 0,
            max: 59,
            value: mm,
            onChange: (e) => setM(e.target.value),
            'aria-label': t('ui.minutesAria', { label }),
          }),
          React.createElement('span', { className: 'dim-tk-unit' }, t('ui.minute')),
          React.createElement('input', {
            className: 'dim-tk-input dim-tk-num',
            type: 'number',
            min: 0,
            max: 59,
            value: ss,
            onChange: (e) => setS(e.target.value),
            'aria-label': t('ui.secondsAria', { label }),
          }),
          React.createElement('span', { className: 'dim-tk-unit' }, t('ui.second')),
        )

      const tab = (key, label) =>
        React.createElement(
          'button',
          {
            key,
            type: 'button',
            className: `dim-tk-tab${mode === key ? ' dim-tk-tabOn' : ''}`,
            onClick: () => setMode(key),
          },
          label,
        )

      return React.createElement(
        'div',
        { className: 'dim-tk-form' },
        React.createElement('div', { className: 'dim-tk-tabs' }, tab('after', t('ui.delay')), tab('at', t('ui.at')), tab('periodic', t('ui.periodic'))),
        React.createElement('textarea', {
          className: 'dim-tk-textarea',
          placeholder: t('ui.promptPlaceholder'),
          value: prompt,
          onChange: (e) => setPrompt(e.target.value),
          'aria-label': t('ui.taskContent'),
        }),
        mode === 'after' ? numRow(t('ui.delay'), h, m, s, setH, setM, setS) : null,
        mode === 'periodic' ? numRow(t('ui.interval'), ih, im, is, setIh, setIm, setIs) : null,
        mode === 'at'
          ? React.createElement(
              'div',
              { className: 'dim-tk-timeRow' },
              React.createElement('input', {
                className: 'dim-tk-input',
                type: 'datetime-local',
                value: atValue,
                min: nowLocalInput(),
                onChange: (e) => setAtValue(e.target.value),
                'aria-label': t('ui.execTime'),
              }),
            )
          : null,
        mode === 'periodic'
          ? React.createElement('div', { className: 'dim-tk-note' }, t('ui.intervalNote'))
          : null,
        React.createElement(
          'div',
          { className: 'dim-tk-formActions' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dim-tk-btn dim-tk-btnPrimary',
              onClick: submit,
              // ★ 内容为空 **或** 时长为 0 时禁用（用户定案：防误操作）。
              //   时长为 0 会立刻触发，几乎必然是误操作；延迟与重复两种模式都适用。
              disabled: busy || !canSubmit,
              title: canSubmit ? undefined : t('ui.cannotSubmit'),
            },
            editing === null ? t('ui.add') : t('ui.save'),
          ),
          React.createElement('button', { type: 'button', className: 'dim-tk-btn', onClick: onCancel, disabled: busy }, t('ui.cancel')),
        ),
      )
    }

    // ────────────────────────────── 主面板 ──────────────────────────────

    /**
     * 已提示过的"模板复原"序号（模块级，整页共享）。
     *
     * ★ 为什么需要它：`list` 是**每个会话各自轮询**的，同一个复原事件会在
     *   多轮、多个面板上被观察到。按序号去重，保证**只提示一次**。
     */
    let lastResetSeqSeen = 0

    /**
     * 是否已经建立过序号基线。
     *
     * ★ 为什么不能只看 `seq > lastResetSeqSeen`：
     *   若页面打开时 seq=0、随后变成 1，用"上次是 0"判断首轮会**误吞**
     *   这次真实事件。故用独立标志区分"建立基线"与"检测到新事件"。
     */
    let resetBaselineReady = false

    /**
     * 经**官方 notices 通道**弹一条 error 级提示（顶部 toast）。
     *
     * ★ 完全照官方 `dsh-client-ui-commands` 的 `noticeFor` 路径，
     *   **不做任何 DOM 注入**（不改 DOM、不挂 MutationObserver、
     *   不依赖哈希类名）：
     *
     *     sessions.scope(sessionId)          // ISessions 公开方法
     *       → actx.get('conversation')
     *       → conversation.input.for(actx)   // hub.d.ts 公开面
     *       → .notify('error', text)         // facade.d.ts 公开契约
     *
     * ★ 用 `'error'` 而**不是** `'info'`：
     *   实测 `info` 渲染成**常驻**的灰条、**没有关闭按钮**（只能刷新页面清掉），
     *   而 `error` 走官方 `showToast`，约 4~5 秒自动消失、无需用户操作。
     *   对"模板已自动复原"这种**事后告知**，toast 更合适；且其目标是
     *   资深用户——即使没看到，也能从自动还原与 `.bad-<时间戳>` 副本察觉。
     *
     * @param sessionId - 当前会话 id（notify 需要 session scope）。
     * @param text - 已本地化的提示文案。
     */
    function notifyTemplateReset(sessionId, text) {
      try {
        const sessions = ctxRef?.get?.('sessions')
        if (sessions === undefined || sessions === null) return
        if (typeof sessions.scope !== 'function') return
        const actx = sessions.scope(sessionId)
        if (actx === undefined) return
        const conversation = actx.get('conversation')
        if (conversation === undefined) return
        const shell = conversation.input?.for?.(actx)
        if (typeof shell?.notify !== 'function') return
        shell.notify('error', text)
      } catch {
        // ★ 提示失败**绝不能**影响面板本身（这也是为什么整段包在 try 里）。
      }
    }

    /** 客户端根 ctx（供非组件代码路径读服务）；在 apply 时赋值。 */
    let ctxRef = null

    /**
     * dock 主组件：折叠摘要 + 展开面板。
     *
     * 需要 `useProjection` 之外的数据，因此走 RPC 轮询（本插件不注册 projection，
     * 因为任务状态存在插件自有 sidecar 而非会话日志）。
     *
     * @param props - 客户端 slot 提供的标准属性。
     * @returns React 元素或 null。
     */
    function TickDock(props) {
      const { sessionId } = props
      const { t } = props
      const [tasks, setTasks] = React.useState([])
      const [summary, setSummary] = React.useState(null)
      const [expanded, setExpanded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [formOpen, setFormOpen] = React.useState(false)
      const [editing, setEditing] = React.useState(null)
      const [now, setNow] = React.useState(() => Date.now())
      /** UI 配置（由宿主下发；`null` 表示还没拿到）。 */
      const [uiConfig, setUiConfig] = React.useState(null)

      // ★ 用 ref 持有最新 rpc 引用：把它放进依赖数组会导致 effect 反复重跑
      //   （曾遇到：每次渲染新函数引用 → 无限重跑 → 冲掉用户正在编辑的表单）。
      const rpcRef = React.useRef(props.rpc)
      rpcRef.current = props.rpc
      /** UI 配置缓存（避免每轮轮询都重复请求）。 */
      const uiConfigRef = React.useRef(null)

      /**
       * 拉取一次任务列表。
       *
       * 首次成功时顺带读回 UI 配置（`showDock` 等）—— 配置由宿主下发，
       * 客户端不自己读宿主文件。（"声明了配置却不生效"是典型静默失效。）
       */
      const refresh = React.useCallback(async () => {
        const rpc = rpcRef.current
        if (typeof rpc !== 'function' || sessionId === undefined) return
        try {
          const value = unwrap(await rpc('list', { sessionId }))
          setTasks(Array.isArray(value?.tasks) ? value.tasks : [])
          setSummary(value?.summary ?? null)

          // ★ 自定义注入模板"复原"提示：
          //   宿主只下发 {seq, reason}，**文案在这里按 UI 语言渲染** ——
          //   因此中文界面显示中文、其余语言显示英文，而宿主无需知道 UI 语言。
          //   按序号去重：只对**比上次见过更大**的序号提示一次。
          const reset = value?.templateReset
          const seq = Number.isInteger(reset?.seq) ? reset.seq : 0
          if (!resetBaselineReady) {
            // 首轮只建立基线：页面刚打开时 seq 可能已 > 0（历史复原事件），
            // 不该在每次刷新时把旧事件重播一遍。
            resetBaselineReady = true
            lastResetSeqSeen = seq
          } else if (seq > lastResetSeqSeen) {
            lastResetSeqSeen = seq
            notifyTemplateReset(sessionId, t('notice.customTemplateReset'))
          }

          setError(null)
          if (uiConfigRef.current === null) {
            try {
              const ui = unwrap(await rpc('ui', { sessionId }))
              uiConfigRef.current = ui
              setUiConfig(ui)
            } catch {
              /* 读不到 UI 配置时按默认显示，不影响主功能 */
            }
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [sessionId])

      // 轮询：展开时快、折叠时慢（间隔与被观测过程的时长匹配）。
      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        void refresh()
        const interval = expanded ? POLL_EXPANDED_MS : POLL_COLLAPSED_MS
        const timer = setInterval(() => {
          void refresh()
        }, interval)
        return () => clearInterval(timer)
      }, [refresh, expanded, sessionId])

      // 倒计时文本要跟着走：展开时每秒推一次 now（只影响渲染，不触发请求）。
      React.useEffect(() => {
        if (!expanded) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [expanded])

      /** 包一层：置忙、清错、拉取。 */
      const run = React.useCallback(
        async (fn) => {
          setBusy(true)
          setError(null)
          try {
            await fn()
            await refresh()
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [refresh],
      )

      const rpcCall = (method, payload) => rpcRef.current(method, { sessionId, ...payload })

      const onCreate = (input) =>
        run(async () => {
          await rpcCall('create', { task: input })
          setFormOpen(false)
        })
      const onUpdate = (id, patch) =>
        run(async () => {
          await rpcCall('update', { id, patch })
          setEditing(null)
          setFormOpen(false)
        })
      const onPause = (id) => run(() => rpcCall('pause', { id }))
      const onResume = (id) => run(() => rpcCall('resume', { id }))
      // 注意：不再有 onRun。已超时任务的"立即执行"由 onResume 承担
      //（service.resume 对 overdue 会走 runNow），避免两个同形按钮造成混淆。
      const onRemove = (id) => run(() => rpcCall('remove', { id }))

      // ★ 若管理员在 data/config.json 里关掉了 dock（`showDock: false`），
      //   这里就**真的不渲染**——不是"声明了却不生效"。
      if (uiConfig !== null && uiConfig.showDock === false) return null

      // ★ 无任务且没在编辑 → 返回 null，不占位（官方 todo/goal 的惯例，
      //   也让四项并列时不给输入区增加固定高度）。
      if (tasks.length === 0 && !formOpen && !expanded) return null

      const attention = summary?.attention ?? 0
      const overdueCount = summary?.overdue ?? 0
      const nextAt = summary?.nextAt ?? null
      const summaryText =
        tasks.length === 0
          ? t('sum.emptyList')
          : nextAt !== null
            ? t('sum.countAndNext', { n: tasks.length, when: relativeText(nextAt, now) })
            : t('sum.countOnly', { n: tasks.length })

      const Clock = icon('IconClockOutline16')
      // ★ 展开控件对齐官方 todo 面板（`TodoPanel`）的格式：
      //   - 用官方 `IconChevronUp/DownOutline14` 图标**放在最右侧**（不是文字 ▸/▾ 放左侧）；
      //   - 标题行整体是一个 `button`（带 `aria-expanded`），点哪儿都能展开/收起。
      //   官方范式见 dsh-client-ui-conversation 的 TodoPanel：lead 图标 → title → progress → chevron。
      const ChevronCollapsed = icon('IconChevronUpOutline14')
      const ChevronExpanded = icon('IconChevronDownOutline14')

      return React.createElement(
        'div',
        { className: 'dim-tk-dock', 'data-tick-dock': 'true' },
        React.createElement(
          'div',
          { className: 'dim-tk-bar' },
          // ── 左侧：主按钮（图标 + 标题 + 汇总 + chevron），整行可点 ──
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dim-tk-header',
              'aria-expanded': expanded,
              'aria-label': expanded ? t('ui.collapsePanel') : t('ui.expandPanel'),
              title: expanded ? t('ui.collapse') : t('ui.expand'),
              onClick: () => setExpanded((v) => !v),
            },
            React.createElement(
              'span',
              { className: 'dim-tk-glyph', 'aria-hidden': true },
              Clock !== undefined && Clock !== null ? React.createElement(Clock, { size: 14 }) : '⏱',
            ),
            React.createElement('span', { className: 'dim-tk-label' }, t('ui.title')),
            // 顶部汇总：有超时才显示（用户要求"旁边有明显的已超时提示"）
            overdueCount > 0
              ? React.createElement('span', { className: 'dim-tk-badge dim-tk-badge-overdue' }, t('sum.overdueCount', { n: overdueCount }))
              : null,
            React.createElement('span', { className: 'dim-tk-summary', title: summaryText }, summaryText),
            React.createElement(
              'span',
              { className: 'dim-tk-chevron', 'aria-hidden': true },
              expanded
                ? ChevronExpanded !== undefined && ChevronExpanded !== null
                  ? React.createElement(ChevronExpanded, {})
                  : '▾'
                : ChevronCollapsed !== undefined && ChevronCollapsed !== null
                  ? React.createElement(ChevronCollapsed, {})
                  : '▸',
            ),
          ),
          // ── 右侧：新建按钮（与主按钮分开，避免误触发展开） ──
          React.createElement(
            'div',
            { className: 'dim-tk-actions' },
            IconButton({
              iconName: 'IconPlusOutline16',
              label: t('ui.newTask'),
              onClick: () => {
                setEditing(null)
                setFormOpen(true)
                setExpanded(true)
              },
              disabled: busy || sessionId === undefined,
              fallbackText: '＋',
            }),
          ),
        ),
        error !== null ? React.createElement('div', { className: 'dim-tk-error', role: 'alert' }, error) : null,
        expanded
          ? React.createElement(
              'div',
              { className: 'dim-tk-panel' },
              tasks.length === 0
                ? React.createElement('div', { className: 'dim-tk-empty' }, t('ui.noTasks'))
                : tasks.map((task) =>
                    React.createElement(TaskRow, {
                      key: task.id,
                      task,
                      now,
                      busy,
                      onPause,
                      onResume,
                      onEdit: (t) => {
                        setEditing(t)
                        setFormOpen(true)
                      },
                      onRemove,
                    }),
                  ),
              formOpen
                ? React.createElement(TaskForm, {
                    key: editing === null ? 'new' : editing.id,
                    editing,
                    busy,
                    onCancel: () => {
                      setFormOpen(false)
                      setEditing(null)
                    },
                    onSubmit: (input) => (editing === null ? onCreate(input) : onUpdate(editing.id, input)),
                  })
                : null,
            )
          : null,
      )
    }

    // ─────────────────────── 侧栏底部：全局汇总入口 ───────────────────────

    /**
     * 侧栏底部的「定时任务」汇总入口（相对「设置」的位置）。
     *
     * 形态对齐官方 occupant（如 `dsh-client-ui-cordis` 的 CordisPanel）：
     *   - 收到官方给的 `wide`（宽栏/56px 窄栏）；
     *   - `wide` 时渲染"图标 + 文字 + 计数"，窄栏只渲染图标（靠 `title` 说明）；
     *   - **无待执行/已超时任务时返回 null**，不占位（与 dock 的惯例一致）。
     *
     * 默认关闭（`showSidebarSummary: false`）；开启后才真正请求数据。
     *
     * @param props - 客户端 slot 提供的标准属性（含 `wide` 与注入的 `rpc`）。
     * @returns React 元素或 null。
     */
    function TickSidebarSummary(props) {
      const { wide } = props
      const [enabled, setEnabled] = React.useState(null)
      const [data, setData] = React.useState(null)
      const [open, setOpen] = React.useState(false)

      const rpcRef = React.useRef(props.rpc)
      rpcRef.current = props.rpc

      /** 读一次 UI 配置（决定该入口是否启用）。 */
      React.useEffect(() => {
        let alive = true
        void (async () => {
          const rpc = rpcRef.current
          if (typeof rpc !== 'function') return
          try {
            const ui = unwrap(await rpc('ui', {}))
            if (alive) setEnabled(ui?.showSidebarSummary === true)
          } catch {
            // 读不到配置 → 按"关闭"处理（默认关闭是安全侧）
            if (alive) setEnabled(false)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      /** 轮询全局汇总（只在启用后）。 */
      React.useEffect(() => {
        if (enabled !== true) return undefined
        let alive = true
        const load = async () => {
          const rpc = rpcRef.current
          if (typeof rpc !== 'function') return
          try {
            const value = unwrap(await rpc('global', {}))
            if (alive) setData(value)
          } catch {
            /* 单次失败保持上次数据，不闪 */
          }
        }
        void load()
        const timer = setInterval(() => {
          void load()
        }, 20_000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [enabled])

      // 配置未启用 → 不占位（默认关闭，见 config.js）
      if (enabled !== true) return null
      // 没有待执行/已超时任务 → 不占位（与 dock 的惯例一致）
      if (data === null || data.attention === 0) return null

      const overdue = data.overdue ?? 0
      const attention = data.attention ?? 0
      // attention = 待执行 + 已超时 → 待执行数需减去超时数
      const pending = Math.max(0, attention - overdue)
      const labelParts = [
        overdue > 0 ? t('sum.overdueCount', { n: overdue }) : '',
        pending > 0 ? t('sum.pendingCount', { n: pending }) : '',
      ].filter(Boolean)
      const label = `${t('ui.title')} · ${labelParts.join(t('common.listSep'))}`
      const Clock = icon('IconClockOutline16')

      const glyph =
        Clock !== undefined && Clock !== null
          ? React.createElement(Clock, { size: 14 })
          : React.createElement('span', null, '⏱')

      // ★ 表头徽章：与展开列表**同一顺序**（超时在左、待执行在右），
      //   且整组**靠右对齐**（`.dim-tk-sideBadges` 用 margin-left:auto）——
      //   这样"只有一种"时它仍出现在同一个位置（右端），不会左右跳。
      //   数量只显示裸数字（表头空间窄），具体含义由 title/aria-label 说明。
      const headerBadges = []
      if (overdue > 0) {
        headerBadges.push(
          React.createElement(
            'span',
            { key: 'od', className: 'dim-tk-badge dim-tk-badge-overdue' },
            String(overdue),
          ),
        )
      }
      if (pending > 0) {
        headerBadges.push(
          React.createElement(
            'span',
            { key: 'pd', className: 'dim-tk-badge dim-tk-badge-pending' },
            String(pending),
          ),
        )
      }

      const head = React.createElement(
        'button',
        {
          type: 'button',
          className: `dim-tk-side${wide === true ? '' : ' dim-tk-sideRail'}`,
          onClick: () => setOpen((v) => !v),
          'aria-expanded': open,
          'aria-label': label,
          title: label,
        },
        React.createElement('span', { className: 'dim-tk-sideGlyph', 'aria-hidden': true }, glyph),
        wide === true ? React.createElement('span', { className: 'dim-tk-sideLabel' }, t('ui.title')) : null,
        wide === true && headerBadges.length > 0
          ? React.createElement('span', { className: 'dim-tk-sideBadges' }, ...headerBadges)
          : null,
      )

      // 展开的跨会话列表（点击条目在侧栏外无法直接跳转会话，
      // 因此这里只做"提示哪些会话有待办"，并给出提示语，不做伪跳转）。
      const list =
        open && Array.isArray(data.sessions)
          ? React.createElement(
              'div',
              { className: 'dim-tk-sideList' },
              data.sessions.slice(0, 8).map((s) => {
                // ★ 一个会话可能**同时**有超时与待执行任务，因此两种徽章各自独立显示，
                //   而不是 `if/else` 二选一（那样会隐藏待执行的数量）。
                //   attention = 待执行 + 已超时，所以待执行数 = attention - overdue。
                const overdueCount = s.overdue ?? 0
                const pendingCount = Math.max(0, (s.attention ?? 0) - overdueCount)
                const badges = []
                if (overdueCount > 0) {
                  badges.push(
                    React.createElement(
                      'span',
                      { key: 'od', className: 'dim-tk-badge dim-tk-badge-overdue' },
                      t('side.overdueItems', { n: overdueCount }),
                    ),
                  )
                }
                if (pendingCount > 0) {
                  badges.push(
                    React.createElement(
                      'span',
                      { key: 'pd', className: 'dim-tk-badge dim-tk-badge-pending' },
                      t('side.pendingItems', { n: pendingCount }),
                    ),
                  )
                }
                const detail = [
                  overdueCount > 0 ? t('side.overdueDetail', { n: overdueCount }) : '',
                  pendingCount > 0 ? t('side.pendingDetail', { n: pendingCount }) : '',
                ]
                  .filter(Boolean)
                  .join('，')
                return React.createElement(
                  'div',
                  {
                    key: s.sessionId,
                    className: 'dim-tk-sideItem',
                    title: detail.length > 0 ? `${detail}｜${s.samplePrompt}` : s.samplePrompt,
                  },
                  // ★ 布局：任务文本一行，徽章**另起一行**。
                  //   侧栏宽栏只有约 280px，把「文本 + 两个徽章」挤在同一行会让
                  //   三者都被省略号截断（实测："2 项..." "1 项..."）。
                  //   竖排后文本能用满整行宽度，徽章也不会被裁切。
                  React.createElement(
                    'span',
                    { className: 'dim-tk-sideItemText' },
                    s.samplePrompt.length > 0 ? s.samplePrompt : s.sessionId.slice(0, 18),
                  ),
                  badges.length > 0
                    ? React.createElement(
                        'span',
                        { className: 'dim-tk-sideItemMeta' },
                        // ★ 树形分支连接符 |___>：表示这行是从上方标题展开的内容。
                        //   用 SVG 画（而非文字字符），这样线宽/圆角可控、颜色跟随主题。
                        //   竖线从行顶开始，向下折成横线，末端一个小箭头指向胶囊。
                        React.createElement(
                          'svg',
                          {
                            className: 'dim-tk-sideBranch',
                            width: 12,
                            height: 14,
                            viewBox: '0 0 12 14',
                            fill: 'none',
                            'aria-hidden': true,
                          },
                          // 竖线从上方（贴近标题行）下垂到中线，再折成横线；末端小箭头。
                          React.createElement('path', {
                            d: 'M1.5 0 V8',
                            stroke: 'currentColor',
                            strokeWidth: 1.3,
                            strokeLinecap: 'round',
                          }),
                          React.createElement('path', {
                            d: 'M1.5 8 H8',
                            stroke: 'currentColor',
                            strokeWidth: 1.3,
                            strokeLinecap: 'round',
                          }),
                          React.createElement('path', {
                            d: 'M6.6 5.6 L9 8 L6.6 10.4',
                            stroke: 'currentColor',
                            strokeWidth: 1.3,
                            strokeLinecap: 'round',
                            strokeLinejoin: 'round',
                          }),
                        ),
                        ...badges,
                      )
                    : null,
                )
              }),
            )
          : null

      return React.createElement('div', { className: 'dim-tk-sideWrap' }, head, list)
    }

    // ────────────────────────────── 插件主体 ──────────────────────────────

    /**
     * 本插件的文案字典（**由 tools/gen-client-dicts.mjs 从 lib/i18n.js 生成**）。
     *
     * ★ 必须内联：客户端是浏览器 bundle，官方 client.js 全树**没有**
     *   `require('./…')` 的用法（只 require react 等 seed 模块），
     *   因此拿不到 host 侧的 i18n.js。
     * ★ 不要手改这里的文案 —— 改 lib/i18n.js 后重跑生成脚本。
     */
    const NS_DICTS = {
      zh: {
      "action.edit": "编辑",
      "action.editHint": "修改内容或定时",
      "action.pause": "暂停",
      "action.pauseHint": "暂停（延迟与重复模式会冻结剩余时间）",
      "action.remove": "删除",
      "action.removeHint": "删除该任务",
      "action.resume": "恢复",
      "action.resumeFromLeft": "恢复（从剩余时间继续）",
      "action.run": "执行",
      "action.runNowOverdue": "立即执行（该任务已超时，不会自动执行）",
      "cmd.badInterval": "无法识别间隔「{spec}」；支持 30s / 5m / 2h / 1h30m。",
      "cmd.badTime": "无法识别「{head}」。",
      "cmd.created": "已创建定时任务 {id}\n  模式：{kind}\n  目标：{when}\n  内容：{prompt}",
      "cmd.deleted": "已删除任务 {id}。",
      "cmd.description": "创建与管理本会话的定时任务（延迟 / 固定时刻 / 重复）",
      "cmd.failed": "定时任务操作失败：{message}",
      "cmd.help": "时间写法：+30s / +5m / +2h / +1h30m（延迟）；every 30m（重复）；@2026-09-20T15:00:00+08:00（固定时刻）",
      "cmd.listHeader": "当前会话共 {n} 个定时任务：",
      "cmd.needContentAfter": "延迟任务需要内容。",
      "cmd.needContentAt": "绝对时刻任务需要内容。",
      "cmd.needContentPeriodic": "重复任务需要内容，例如：/schedule every 30m 检查队列",
      "cmd.noSession": "该命令必须由某个会话发起。",
      "cmd.noTasks": "当前会话没有定时任务。",
      "cmd.paused": "已暂停任务 {id}。",
      "cmd.ran": "已立即执行任务 {id}。",
      "cmd.resumed": "已恢复任务 {id}。",
      "cmd.usage": "用法：/schedule <时间> <内容> | /schedule list | /schedule remove <id> | /schedule pause <id> | /schedule resume <id> | /schedule run <id>",
      "common.failed": "失败",
      "common.listSep": "，",
      "common.needId": "请给出任务 id。",
      "common.unknownReason": "未知原因",
      "desc.after": "延迟 {n} 秒",
      "desc.periodic": "每 {n} 秒重复",
      "err.afterMustBePositive": "after_seconds 必须是正整数。",
      "err.afterRange": "after_seconds 必须是 1~{max} 的整数。",
      "err.afterTooLarge": "after_seconds 超过上限 {max}（30 天）；更长的等待请改用固定时刻模式。",
      "err.badCreatedBy": "createdBy 必须为 user 或 ai。",
      "err.badInstant": "{label} 不是合法时刻。",
      "err.cannotPauseDone": "已完成的任务不能暂停。",
      "err.cannotResumeDone": "已完成的任务不能恢复。",
      "err.cannotUpdateDone": "已完成的任务不能修改时间。",
      "err.idInvalid": "任务 id 必须是非空且无首尾空白的字符串。",
      "err.intervalRange": "interval_seconds 必须在 {min}~{max} 之间。",
      "err.intervalTooLarge": "interval_seconds 超过上限 {max} 秒。",
      "err.intervalTooSmall": "interval_seconds 不能小于 {min} 秒。",
      "err.multipleSelectors": "一次只能给出一种时间设定，收到 {got}；请只保留一种。",
      "err.mustBeFuture": "目标时刻必须晚于当前时刻。",
      "err.mustBeInt": "{label} 必须是整数。",
      "err.mustBeRfc3339": "{label} 必须是 RFC3339 字符串。",
      "err.needOneSelector": "必须给出恰好一种时间设定：after_seconds（多少秒后）、interval_seconds（每多少秒重复）或 scheduled_at/scheduledAt（RFC3339 时刻）。",
      "err.nowNotSafeInt": "now 必须是安全整数毫秒。",
      "err.onlyOneSelector": "每次只能给出一种时间设定。",
      "err.periodicNoInterval": "重复任务 {id} 缺少合法的 intervalSeconds。",
      "err.promptEmpty": "prompt 不能为空。",
      "err.promptNotString": "prompt 必须是字符串。",
      "err.promptTooLong": "prompt 过长（上限 {max} 字符）。",
      "err.recordNotObject": "任务记录必须是对象。",
      "err.taskBadKind": "任务 {id} 的模式非法：{kind}。",
      "err.taskBadScheduledAt": "任务 {id} 的 scheduledAt 非法。",
      "err.taskEmptyPrompt": "任务 {id} 的 prompt 为空。",
      "err.unknownKind": "未知模式：{kind}。",
      "err.yearRange": "{label} 超出可表达的年份范围。",
      "framing.periodic": "本会话中一个「周期性任务」按固定间隔自动触发。本次触发与上一条回复无关，只需执行下方任务内容一次。",
      "framing.periodicHint": "提示：若你注意到本周期性任务的触发频率或内容出现明显异常（例如远超设定的 interval_seconds、内容与设定不符、或在你不期望时反复触发），请如实向用户指出，不要默认它正常；必要时可用定时任务工具自行暂停或删除该任务。",
      "framing.task": "本会话中一个一次性定时任务触发。本次触发与上一条回复无关，只需执行下方任务内容一次。",
      "mode.after": "延迟",
      "mode.at": "固定时刻",
      "mode.atShort": "指定时刻",
      "mode.periodic": "重复",
      "notice.customTemplateReset": "自定义注入模板读取失败，配置文件已复原为初始值（原文件已改名为 .bad-<时间戳> 保留）。",
      "param.afterSeconds": "延迟多少秒后执行一次（与另两个互斥）。",
      "param.id": "任务 id（来自 tick_list）。",
      "param.intervalSeconds": "每隔多少秒重复执行（最小 10，与另两个互斥）。",
      "param.newAfterSeconds": "改成\"多少秒后执行一次\"。",
      "param.newIntervalSeconds": "改成\"每多少秒重复\"。",
      "param.newPrompt": "新的任务内容；不改则不传。",
      "param.newScheduledAt": "改成某个绝对时刻（RFC3339 带时区）。",
      "param.prompt": "到点时要执行的任务内容（会作为提示词注入本会话）。",
      "param.scheduledAt": "绝对时刻，RFC3339 且带时区偏移（与另两个互斥）。",
      "rel.ago": "{text}前",
      "rel.days": "{n} 天",
      "rel.hours": "{n} 小时",
      "rel.later": "{text}后",
      "rel.minutes": "{n} 分钟",
      "rel.seconds": "{n} 秒",
      "rel.then": "之后",
      "render.created": "已创建定时任务：{task}",
      "render.fail": "失败（{code}）：{message}",
      "render.listHeader": "当前会话共 {n} 个定时任务：",
      "render.noAgent": "定时任务工具必须由某个会话中的模型调用（当前调用没有归属会话）。",
      "render.noTasks": "当前会话没有定时任务。",
      "render.paused": "已暂停：{task}",
      "render.ran": "已立即执行：{task}",
      "render.removed": "已删除该定时任务。",
      "render.resumed": "已恢复：{task}",
      "render.updated": "已修改定时任务：{task}",
      "side.overdueDetail": "{n} 项已超时",
      "side.overdueItems": "{n} 项超时",
      "side.pendingDetail": "{n} 项待执行",
      "side.pendingItems": "{n} 项待执行",
      "status.done": "已完成",
      "status.overdue": "已超时",
      "status.paused": "已暂停",
      "status.pending": "等待中",
      "sum.countAndNext": "共 {n} 个 · 最近 {when}",
      "sum.countOnly": "共 {n} 个",
      "sum.createdByAi": "AI 创建",
      "sum.delayHours": "延迟 {n} 小时",
      "sum.delayMinutes": "延迟 {n} 分钟",
      "sum.delaySeconds": "延迟 {n} 秒",
      "sum.emptyList": "暂无任务",
      "sum.everyHours": "每 {n} 小时重复",
      "sum.everyMinutes": "每 {n} 分钟重复",
      "sum.everySeconds": "每 {n} 秒重复",
      "sum.firedCount": "已触发 {n} 次",
      "sum.overdueCount": "{n} 个已超时",
      "sum.pendingCount": "{n} 个待执行",
      "sum.remainingSeconds": "剩余 {n} 秒",
      "svc.aiDisabled": "配置已禁用 AI 创建定时任务。",
      "svc.limitActive": "本会话同时启用的任务数已达上限 {max}；请先暂停或删除一些任务。",
      "svc.limitTasks": "本会话任务数已达上限 {max}；请先删除一些任务。",
      "svc.noAgent": "该会话当前没有活跃 Agent，无法立即执行；请先打开该会话。",
      "svc.notFound": "未找到任务 {id}。",
      "tool.create.desc": "在当前会话创建一个定时任务：到点后向本会话注入设定好的提示词，唤醒你执行它。必须给出 prompt，并**恰好一种**时间设定：afterSeconds（多少秒后执行一次）、intervalSeconds（每多少秒自动重复，最小 10）、scheduledAt（RFC3339 绝对时刻，如 \"2026-09-20T15:00:00+08:00\"）。示例：用户说\"10 分钟后提醒我检查构建\" → {prompt:\"检查构建队列\", afterSeconds:600}；用户说\"每隔半小时看一眼队列\" → {prompt:\"检查构建队列\", intervalSeconds:1800}；用户说\"今天下午三点提醒我\" → 先把本地时间换算成带时区偏移的 RFC3339 再传 scheduledAt。三种时间字段不要同时传，一次只能一种。",
      "tool.list.desc": "列出当前会话的全部定时任务（含 id、模式、状态、目标时间）。修改、暂停、恢复、删除、立即执行之前都先用它拿到准确的 id。",
      "tool.pause.desc": "暂停当前会话中的一个定时任务。延迟与重复模式会**冻结剩余时间**（恢复后从剩余时间继续，不重新计时）；固定时刻模式在暂停期间即使时刻已过也不会执行。",
      "tool.remove.desc": "删除当前会话中的一个定时任务。先用 tick_list 确认 id。",
      "tool.resume.desc": "恢复当前会话中一个已暂停的定时任务。若该任务已超时，恢复即**立即执行**（与「立即执行」等价）。",
      "tool.runNow.desc": "立即执行当前会话中的一个定时任务（不等它的定时到点）。典型用法：任务已超时，用户希望马上补跑一次。执行后一次性任务会标记完成，重复任务会继续按周期运行。",
      "tool.update.desc": "修改当前会话中某个定时任务的内容或时间。先用 tick_list 拿 id。可改 prompt（任务内容），或改时间（afterSeconds / intervalSeconds / scheduledAt 三选一，规则与 tick_create 相同）。不传的字段保持不变。注意：改时间会让模式随之切换（传 afterSeconds 就变成\"延迟\"模式）。",
      "ui.add": "添加",
      "ui.at": "固定时刻",
      "ui.cancel": "取消",
      "ui.cannotSubmit": "请填写任务内容，并把时长设为大于 0",
      "ui.collapse": "收起定时任务面板",
      "ui.delay": "延迟",
      "ui.execTime": "执行时刻（浏览器本地时间）",
      "ui.expand": "展开定时任务面板",
      "ui.hour": "时",
      "ui.hoursAria": "{label} 小时",
      "ui.interval": "间隔",
      "ui.intervalNote": "间隔最小 10 秒。任务按下一次设定严格周期触发。",
      "ui.minute": "分",
      "ui.minutesAria": "{label} 分钟",
      "ui.newTask": "新建定时任务",
      "ui.noTasks": "当前会话没有定时任务。",
      "ui.periodic": "重复",
      "ui.promptPlaceholder": "到点要执行的内容（会作为提示词注入本会话）",
      "ui.requestFailed": "定时任务请求失败",
      "ui.save": "保存",
      "ui.second": "秒",
      "ui.secondsAria": "{label} 秒",
      "ui.taskContent": "任务内容",
      "ui.title": "定时任务",
    },
      en: {
      "action.edit": "Edit",
      "action.editHint": "Edit content or schedule",
      "action.pause": "Pause",
      "action.pauseHint": "Pause (delay and repeating modes freeze the remaining time)",
      "action.remove": "Delete",
      "action.removeHint": "Delete this task",
      "action.resume": "Resume",
      "action.resumeFromLeft": "Resume (continue from the remaining time)",
      "action.run": "Run",
      "action.runNowOverdue": "Run now (this task is overdue and will not run automatically)",
      "cmd.badInterval": "Unrecognized interval \"{spec}\"; supported: 30s / 5m / 2h / 1h30m.",
      "cmd.badTime": "Unrecognized \"{head}\".",
      "cmd.created": "Created scheduled task {id}\n  mode: {kind}\n  target: {when}\n  content: {prompt}",
      "cmd.deleted": "Deleted task {id}.",
      "cmd.description": "Create and manage scheduled tasks for this session (delay / fixed time / repeating)",
      "cmd.failed": "Scheduled task operation failed: {message}",
      "cmd.help": "Time formats: +30s / +5m / +2h / +1h30m (delay); every 30m (repeating); @2026-09-20T15:00:00+08:00 (fixed time)",
      "cmd.listHeader": "This session has {n} scheduled task(s):",
      "cmd.needContentAfter": "A delayed task needs content.",
      "cmd.needContentAt": "A fixed-time task needs content.",
      "cmd.needContentPeriodic": "A repeating task needs content, e.g. /schedule every 30m check the queue",
      "cmd.noSession": "This command must be issued from a session.",
      "cmd.noTasks": "This session has no scheduled tasks.",
      "cmd.paused": "Paused task {id}.",
      "cmd.ran": "Ran task {id} now.",
      "cmd.resumed": "Resumed task {id}.",
      "cmd.usage": "Usage: /schedule <when> <content> | /schedule list | /schedule remove <id> | /schedule pause <id> | /schedule resume <id> | /schedule run <id>",
      "common.failed": "Failed",
      "common.listSep": ", ",
      "common.needId": "Please provide a task id.",
      "common.unknownReason": "unknown reason",
      "desc.after": "delay {n}s",
      "desc.periodic": "every {n}s",
      "err.afterMustBePositive": "after_seconds must be a positive integer.",
      "err.afterRange": "after_seconds must be an integer between 1 and {max}.",
      "err.afterTooLarge": "after_seconds exceeds the limit {max} (30 days); use fixed-time mode for longer waits.",
      "err.badCreatedBy": "createdBy must be user or ai.",
      "err.badInstant": "{label} is not a valid instant.",
      "err.cannotPauseDone": "A completed task cannot be paused.",
      "err.cannotResumeDone": "A completed task cannot be resumed.",
      "err.cannotUpdateDone": "A completed task cannot have its time changed.",
      "err.idInvalid": "A task id must be a non-empty string without surrounding whitespace.",
      "err.intervalRange": "interval_seconds must be between {min} and {max}.",
      "err.intervalTooLarge": "interval_seconds exceeds the limit {max} seconds.",
      "err.intervalTooSmall": "interval_seconds must not be smaller than {min} seconds.",
      "err.multipleSelectors": "Only one time setting may be given, but got {got}; keep just one.",
      "err.mustBeFuture": "The target time must be later than now.",
      "err.mustBeInt": "{label} must be an integer.",
      "err.mustBeRfc3339": "{label} must be an RFC3339 string.",
      "err.needOneSelector": "Exactly one time setting is required: after_seconds, interval_seconds, or scheduled_at/scheduledAt (an RFC3339 instant).",
      "err.nowNotSafeInt": "now must be a safe integer of milliseconds.",
      "err.onlyOneSelector": "Only one time setting may be given at a time.",
      "err.periodicNoInterval": "Repeating task {id} is missing a valid intervalSeconds.",
      "err.promptEmpty": "prompt must not be empty.",
      "err.promptNotString": "prompt must be a string.",
      "err.promptTooLong": "prompt is too long (limit {max} characters).",
      "err.recordNotObject": "A task record must be an object.",
      "err.taskBadKind": "Task {id} has an invalid mode: {kind}.",
      "err.taskBadScheduledAt": "Task {id} has an invalid scheduledAt.",
      "err.taskEmptyPrompt": "Task {id} has an empty prompt.",
      "err.unknownKind": "Unknown mode: {kind}.",
      "err.yearRange": "{label} is outside the representable year range.",
      "framing.periodic": "A periodic task in this session fired automatically at its fixed interval. This firing is unrelated to your previous reply; just perform the task content below once.",
      "framing.periodicHint": "Note: if you notice the firing rate or content of this periodic task is clearly abnormal (e.g. far more frequent than interval_seconds, content not matching the setting, or firing when you did not expect it), tell the user honestly rather than assuming it is fine; you may use the scheduled-task tools to pause or delete the task yourself if needed.",
      "framing.task": "A one-shot scheduled task in this session has fired. This firing is unrelated to your previous reply; just perform the task content below once.",
      "mode.after": "Delay",
      "mode.at": "Fixed time",
      "mode.atShort": "specific time",
      "mode.periodic": "Repeating",
      "notice.customTemplateReset": "Failed to read the custom injection templates. The file has been reset to its initial value (the previous file was kept as .bad-<timestamp>).",
      "param.afterSeconds": "Run once after how many seconds (mutually exclusive with the other two).",
      "param.id": "Task id (from tick_list).",
      "param.intervalSeconds": "Repeat every how many seconds (minimum 10, mutually exclusive with the other two).",
      "param.newAfterSeconds": "Change to \"run once after N seconds\".",
      "param.newIntervalSeconds": "Change to \"repeat every N seconds\".",
      "param.newPrompt": "New task content; omit to keep unchanged.",
      "param.newScheduledAt": "Change to an absolute time (RFC3339 with timezone).",
      "param.prompt": "Content to run when the task fires (injected into this session as a prompt).",
      "param.scheduledAt": "Absolute time, RFC3339 with an explicit timezone offset (mutually exclusive with the other two).",
      "rel.ago": "{text} ago",
      "rel.days": "{n} d",
      "rel.hours": "{n} h",
      "rel.later": "in {text}",
      "rel.minutes": "{n} min",
      "rel.seconds": "{n}s",
      "rel.then": "later",
      "render.created": "Created scheduled task: {task}",
      "render.fail": "Failed ({code}): {message}",
      "render.listHeader": "This session has {n} scheduled task(s):",
      "render.noAgent": "Scheduled-task tools must be called by a model inside a session (this call has no owning session).",
      "render.noTasks": "This session has no scheduled tasks.",
      "render.paused": "Paused: {task}",
      "render.ran": "Ran now: {task}",
      "render.removed": "Deleted the scheduled task.",
      "render.resumed": "Resumed: {task}",
      "render.updated": "Updated scheduled task: {task}",
      "side.overdueDetail": "{n} overdue",
      "side.overdueItems": "{n} overdue",
      "side.pendingDetail": "{n} pending",
      "side.pendingItems": "{n} pending",
      "status.done": "Completed",
      "status.overdue": "Overdue",
      "status.paused": "Paused",
      "status.pending": "Waiting",
      "sum.countAndNext": "{n} total · next {when}",
      "sum.countOnly": "{n} total",
      "sum.createdByAi": "created by AI",
      "sum.delayHours": "delay {n} h",
      "sum.delayMinutes": "delay {n} min",
      "sum.delaySeconds": "delay {n}s",
      "sum.emptyList": "No tasks",
      "sum.everyHours": "every {n} h",
      "sum.everyMinutes": "every {n} min",
      "sum.everySeconds": "every {n}s",
      "sum.firedCount": "fired {n} time(s)",
      "sum.overdueCount": "{n} overdue",
      "sum.pendingCount": "{n} pending",
      "sum.remainingSeconds": "{n}s left",
      "svc.aiDisabled": "AI creation of scheduled tasks is disabled in this configuration.",
      "svc.limitActive": "This session has reached the active-task limit ({max}); pause or delete some tasks first.",
      "svc.limitTasks": "This session has reached the task limit ({max}); delete some tasks first.",
      "svc.noAgent": "This session has no live agent, so it cannot run now; open the session first.",
      "svc.notFound": "Task {id} not found.",
      "tool.create.desc": "Create a scheduled task in the current session: when it fires, a preset prompt is injected into this session to wake you up and run it. You must provide prompt and **exactly one** time setting: afterSeconds (run once after N seconds), intervalSeconds (repeat every N seconds, minimum 10), scheduledAt (absolute RFC3339 time, e.g. \"2026-09-20T15:00:00+08:00\"). Example: user says \"remind me to check the build in 10 minutes\" -> {prompt:\"check the build queue\", afterSeconds:600}; user says \"check the queue every half hour\" -> {prompt:\"check the queue\", intervalSeconds:1800}; user says \"remind me at 3pm today\" -> convert local time to RFC3339 with an explicit offset first. Never pass more than one of the three time fields.",
      "tool.list.desc": "List all scheduled tasks of the current session (id, mode, status, target time). Always call it first to get the exact id before updating, pausing, resuming, removing, or running a task.",
      "tool.pause.desc": "Pause a scheduled task in the current session. Delay and repeating modes **freeze the remaining time** (resuming continues from the leftover time, not a restart); a fixed-time task will not run while paused even if its moment has passed.",
      "tool.remove.desc": "Delete a scheduled task in the current session. Call tick_list first to confirm the id.",
      "tool.resume.desc": "Resume a paused scheduled task in the current session. If the task is overdue, resuming means **running it immediately** (equivalent to \"run now\").",
      "tool.runNow.desc": "Run a scheduled task in the current session immediately (without waiting for its time). Typical use: the task is overdue and the user wants it run right away. A one-shot task is marked completed afterwards; a repeating task keeps its cycle.",
      "tool.update.desc": "Update the content or time of a scheduled task in the current session. Call tick_list first to get the id. You may change prompt (task content), or the time (exactly one of afterSeconds / intervalSeconds / scheduledAt, same rules as tick_create). Omitted fields stay unchanged. Note: changing the time also switches the mode (passing afterSeconds makes it a \"delay\" task).",
      "ui.add": "Add",
      "ui.at": "Fixed time",
      "ui.cancel": "Cancel",
      "ui.cannotSubmit": "Enter task content and set a duration greater than 0",
      "ui.collapse": "Collapse scheduled tasks panel",
      "ui.delay": "Delay",
      "ui.execTime": "Run at (browser local time)",
      "ui.expand": "Expand scheduled tasks panel",
      "ui.hour": "h",
      "ui.hoursAria": "{label} hours",
      "ui.interval": "Interval",
      "ui.intervalNote": "Minimum interval 10 seconds. The task fires on a strict period from the previous setting.",
      "ui.minute": "m",
      "ui.minutesAria": "{label} minutes",
      "ui.newTask": "New scheduled task",
      "ui.noTasks": "This session has no scheduled tasks.",
      "ui.periodic": "Repeating",
      "ui.promptPlaceholder": "Content to run when it fires (injected into this session as a prompt)",
      "ui.requestFailed": "Scheduled task request failed",
      "ui.save": "Save",
      "ui.second": "s",
      "ui.secondsAria": "{label} seconds",
      "ui.taskContent": "Task content",
      "ui.title": "Scheduled tasks",
    },
    }

    /**
     * 本插件在官方 locale 注册表里的命名空间。
     * 与官方 `dsh-client-ui-goal` 的 `NS = "goal"` 同一范式。
     */
    const NS = 'tick'

    /**
     * 官方 locale 服务的语言快照订阅（由 `installLocale` 提供的 face）。
     * 未取得时为 `null`，此时一律按**中文**渲染（主要模式，保证零回归）。
     */
    let localeFace = null

    /** 当前语言（`'zh'` | `'en'`），默认中文。 */
    let currentLocale = 'zh'

    /**
     * 取当前语言下的文案。
     *
     * ★ 字典由 `ctx.locale.register(NS, {zh, en})` 注册进官方服务后，
     *   `t` 由 slot 的 `locale: NS` 自动注入到组件 props；
     *   但**非组件的调用点**（如 setInterval 里的轮询错误处理）拿不到 props，
     *   因此这里再提供一个模块级 `t`，直接从 localeFace 读 active。
     *
     * @param key - 文案键。
     * @param params - 插值参数（`{name}` 风格）。
     * @returns 文案。
     */
    function t(key, params) {
      const dict = NS_DICTS[currentLocale] ?? NS_DICTS.zh
      const raw = dict[key] ?? NS_DICTS.zh[key]
      if (typeof raw !== 'string') return String(key)
      if (params === undefined || params === null) return raw
      return raw.replace(/\{(\w+)\}/gu, (whole, k) =>
        Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : whole,
      )
    }

    const inject = ['slots', 'connection', 'locale']

    /**
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'tick: install styles')
      // 供 notifyTemplateReset 在组件外读服务（如 sessions / conversation）。
      ctxRef = ctx

      // ── 官方 locale 接入（照官方 dsh-client-ui-goal 的范式） ──
      //   `register(ns, {zh, en})` 要求两种内置语言**成对**提供；
      //   注册后 slot 传 `locale: NS` 即可让组件从 props 拿到 `t`。
      ctx.effect(() => ctx.locale.register(NS, { zh: NS_DICTS.zh, en: NS_DICTS.en }), 'tick: dictionaries')

      // 跟踪当前语言：用官方 face 的订阅接口，语言切换会即时反映到渲染。
      try {
        localeFace = ctx.locale.getSnapshot !== undefined ? ctx.locale : null
        if (localeFace !== null) {
          const sync = () => {
            const snap = localeFace.getSnapshot()
            const active = typeof snap?.active === 'string' ? snap.active : 'zh'
            // 只支持 zh/en：非 zh 一律按 en（对齐官方 FALLBACK_LOCALE = en）
            currentLocale = active === 'zh' || active.startsWith('zh-') ? 'zh' : 'en'
          }
          sync()
          ctx.effect(() => {
            const off = localeFace.subscribe(sync)
            return () => {
              try {
                off()
              } catch {
                /* 退订失败不影响卸载 */
              }
            }
          }, 'tick: locale tracking')
        }
      } catch {
        // 拿不到 locale 服务 → 保持中文（主要模式），不影响其余功能。
      }

      /**
       * 管理调用：走 DSH 自身的 RPC 信封协议。
       *
       * `ctx.connection.rpc.call('/api', <endpoint>, msg)` 会发出
       * `{type:'client-request', rpcId, method, payload}` 信封，只有宿主侧
       * 用 `connection.fetch.register({path:'/api/tick'})` 注册的通道会认领它。
       * @param method - 管理方法。
       * @param payload - 参数。
       * @returns 解包后的值。
       */
      const rpc = async (method, payload) => {
        const raw = await ctx.connection.rpc.call('/api', ENDPOINT, { method, payload })
        return unwrap(raw)
      }

      // ★ 与 goal / todo 共用 conversation.input.dock（kind:'list' + 唯一 id + order）。
      //   现有占用者：todo(0) · goal(10) · queue(20) → 本插件取 15。
      //   绝不复用别人的 id（复用即遮蔽）。
      //
      // ★ `inject` 工厂在 session scope 下会收到 `sessionId` —— 必须把它显式传给
      //   组件。官方 goal 同样用这个闭包值去调 RPC，而不是只依赖组件 props。
      //   （踩过的坑：把 inject 写成 `() => ({rpc})` 会拿不到 sessionId，
      //    组件因 `sessionId === undefined` 直接 return null → dock 永远空白，
      //    且**没有任何报错**，属最难查的静默失效。）
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'tick',
            order: 15,
            // ★ 官方范式（照 dsh-client-ui-goal）：声明 locale 命名空间后，
            //   框架会把该命名空间的 `t` 注入组件 props，语言切换会自动重渲染。
            locale: NS,
            inject: (sessionId) => ({ rpc, sessionId }),
          },
          TickDock,
        ),
      )

      // ── 侧栏底部：全局定时任务汇总入口（默认关闭） ──────────────────────
      //
      // ★ 为什么用 `sidebar.footer.action` 而**不是**"会话行内图标"：
      //   官方把整个会话列表区声明为 **single** 插槽并由 ui-workspace 独占
      //   （`sidebar.workspaces`），会话行内部**没有** slot 渲染点，
      //   用官方机制做不到；唯一可行路径是 DOM 注入（依赖哈希类名、改版即碎、
      //   失效时还静默无提示），代价大于收益。
      //   这里改用官方 `list` 插槽，**零 DOM 依赖**，且会收到 `wide` 列状态
      //   （宽栏显示文字、窄栏只显示图标），与官方 occupant 同一范式。
      //
      // ★ 默认关闭（`showSidebarSummary: false`）：它是全局汇总，
      //   对多数用户，会话内 dock 已经够用。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'tick-summary',
            order: 20,
            locale: NS,
            inject: () => ({ rpc }),
          },
          TickSidebarSummary,
        ),
      )
    }

    module.exports = { apply, inject, name: 'tick-client' }
    return module.exports
  },
})
