import type { ChatMessage } from '../../types'

/**
 * 上下文截断（M2-Step7）。
 *
 * 见 CONTEXT.md「上下文预算 / 上下文截断」、AGENTS.md §6 禁忌「不要静默丢历史消息」。
 *
 * 策略（按 token 预算，非消息条数）：
 *  - 永远保留 system 消息（如果有）
 *  - 从最近的消息往前累加，直到接近预算
 *  - 超预算时从最旧的 user 消息丢起
 *  - 返回 { messages, dropped } —— dropped>0 时调用方要 UI 提示「已省略较早的 X 条」
 *
 * token 估算（无 tokenizer 依赖，避免 tiktoken wasm 在 Electron 打包踩坑）：
 *  - 国产模型（智谱/DeepSeek）中文优化，1 汉字 ≈ 0.6~1 token
 *  - 取保守上界：token ≈ 字符数 × 1（多截比少截安全，绝不超模型上限）
 *  - 估算偏差只会多丢几条旧消息，不影响正确性
 */

/** 默认 token 预算（CONTEXT.md：每模型设上限，默认 32k）。 */
export const DEFAULT_CONTEXT_BUDGET = 32000

/** 粗估单条消息的 token 数（字符数作为保守上界 + 少量开销）。 */
function estimateTokens(msg: ChatMessage): number {
  const text = msg.content ?? ''
  // tool_calls 的 args（JSON 字符串）也算进去
  const toolArgs =
    msg.toolCalls && Array.isArray(msg.toolCalls)
      ? (msg.toolCalls as Array<{ args?: string }>).reduce((sum, tc) => sum + (tc.args?.length ?? 0), 0)
      : 0
  // 每条消息固定开销（role 标记等），约 4 token
  return Math.ceil((text.length + toolArgs) * 1) + 4
}

export interface TruncateResult {
  /** 截断后的消息（可直接传给模型）。 */
  messages: ChatMessage[]
  /** 被丢弃的消息条数（>0 时调用方要 UI 提示）。 */
  dropped: number
}

/**
 * 按预算截断历史。
 *
 * @param messages 完整历史（含可能的 system + 多轮 user/assistant/tool）
 * @param budget token 预算上限
 */
export function truncateByTokenBudget(
  messages: ChatMessage[],
  budget: number = DEFAULT_CONTEXT_BUDGET,
): TruncateResult {
  if (messages.length === 0) return { messages, dropped: 0 }

  // 1) 分离 system 消息（永远保留）+ 其余按时间正序
  const systemMsgs = messages.filter((m) => m.role === 'system')
  const nonSystem = messages.filter((m) => m.role !== 'system')

  // 2) system 占用的预算
  let usedTokens = systemMsgs.reduce((sum, m) => sum + estimateTokens(m), 0)

  // 3) 从最近往前累加 nonSystem，直到接近预算
  //    （nonSystem 数组是时间正序，从末尾=最近往前取）
  const kept: ChatMessage[] = []
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const cost = estimateTokens(nonSystem[i])
    if (usedTokens + cost > budget) break
    usedTokens += cost
    kept.unshift(nonSystem[i]) // unshift 保持正序
  }

  const dropped = nonSystem.length - kept.length
  // system 在最前 + 保留的非系统消息
  return { messages: [...systemMsgs, ...kept], dropped }
}
