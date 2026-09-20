/**
 * Tick（定时任务）— 注入动作的**唯一**实现。
 *
 * ★ 为什么单独抽一个模块：
 *   注入是"把一个任务变成一条模型可见消息"的动作，runtime（到点触发）与
 *   service（立即执行 / 恢复已超时任务）都需要它。两处各写一份会导致
 *   **framing 与 source 漂移**——而 source 漂移会污染"是否真实用户发言"
 *   的权威判据（工作区最高优先级纪律）。故收敛到这一个函数。
 *
 * @module dsh-tick/inject
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { renderFraming } from './framing.js'

/**
 * 向指定 agent 注入一条任务触发消息。
 *
 * @param agent - 目标 agent（必须 live）。
 * @param task - 任务记录。
 * @returns 构造出的消息（便于调用方断言/记录）。
 */
export function injectTask(agent, task) {
  const message = createUserMessage({
    content: [{ type: 'text', text: renderFraming({ task }) }],
    // ★ 绝不写成 { kind: 'user' }：见 framing.js 顶部的纪律说明。
    source: { kind: 'plugin', plugin: 'tick' },
  })
  agent.followup(message)
  return message
}
