import { createClientForProvider } from './providers/factory'
import { logInfo } from './logger'
import type { NoteAiOp } from '../types'

/**
 * AI 笔记助手（v1.9 M18，PRD §15.2①）。
 *
 * 见 CONTEXT.md「NoteAiAssist」、ADR-010（非流式独立调用范式，照搬 reportGenerator）。
 *
 * 4 个操作：
 *  - summary：提炼核心要点（3-5 条）
 *  - todos：从笔记抽 - [ ] 待办项
 *  - questions：基于笔记提 2-3 个相关问题（启发思考）；用户可传 question 追问
 *  - continue：顺延笔记内容续写一段
 *
 * 复用 report.providerId（与报告模型共用，零新配置项，语义相近都是非流式文本处理）。
 * 结果以「可插入块」形式返回（Markdown），用户点插入才写进笔记（不静默改）。
 *
 * 容错策略：
 *  - 空内容：日志记录 finish_reason 便于排查，返回带原因的兜底文案
 *  - 剥可能的 ```markdown 代码块包裹
 *
 * 踩坑（v1.9.1 修复）：原 prompt 措辞「不要前置说明，不要用代码块包裹」过严，
 * DeepSeek 在此指令下偶发返回空 content（过度遵守导致吞输出）。改为给明确起始锚点
 * （如「## 摘要」），弱化"不要"的绝对性。reportGenerator 同款措辞工作正常，照搬。
 */

const SYSTEM_PROMPTS: Record<NoteAiOp, string> = {
  summary: `你是一个笔记摘要助手。对用户提供的笔记内容生成简洁摘要。

请按以下格式输出（直接从「## 摘要」标题开始）：

## 摘要

- 要点一
- 要点二
- 要点三

要求：
1. 用中文，提炼 3-5 条核心要点，每条一句话。
2. 客观陈述笔记中的信息，不要编造。
3. 用 Markdown 无序列表（- 开头）。`,

  todos: `你是一个待办提取助手。从用户提供的笔记内容中识别可执行的待办事项。

请按以下格式输出（直接从「## 待办」标题开始）：

## 待办

- [ ] 待办事项一
- [ ] 待办事项二

要求：
1. 用中文，用 GitHub Flavored Markdown 任务列表格式（- [ ] 开头）。
2. 只提取「需要去做的事」（动作型），不提取陈述句或已完成的。
3. 如果笔记中没有明确待办，在「## 待办」标题下写「未识别到待办事项」。`,

  questions: `你是一个思考启发助手。基于用户提供的笔记内容，提出 2-3 个相关的问题，帮助用户深入思考。

请按以下格式输出（直接从「## 思考」标题开始）：

## 思考

1. 问题一
2. 问题二
3. 问题三

要求：
1. 用中文，问题要有启发性（不是事实确认题），引导用户反思或扩展。
2. 问题紧扣笔记主题，不要泛泛而谈。
3. 用 Markdown 有序列表。

如果用户提供了具体问题，则围绕该问题结合笔记内容作答，用 Markdown 正文输出（仍以「## 回答」标题开头）。`,

  continue: `你是一个写作续写助手。顺延用户提供的笔记内容，续写一段（150-300 字）。

直接输出续写的正文内容（Markdown 格式，与笔记风格一致），从第一个段落就开始写正文。

要求：
1. 用中文，保持笔记的语气和风格。
2. 顺延主题展开，不要重复已有内容，不要编造与笔记无关的情节。`,
}

/**
 * 对笔记执行 AI 操作。
 *
 * @param providerId 模型 Provider（复用 report.providerId）
 * @param op 操作类型（summary/todos/questions/continue）
 * @param content 笔记正文（Markdown）
 * @param options.question op='questions' 时的可选用户追问（空则 AI 自行提问）
 * @param options.signal 可选 AbortSignal（note:ai_cancel 用）
 * @returns Markdown 字符串（空内容返回带原因的兜底，不抛错；被 cancel 时抛 AbortError 由调用方处理）
 */
export async function assistNote(
  providerId: string,
  op: NoteAiOp,
  content: string,
  options: { question?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const { client, model } = createClientForProvider(providerId)

  const systemPrompt = SYSTEM_PROMPTS[op]
  // questions 模式：有追问就把问题拼进 user 消息；其他模式直接传笔记内容
  const userContent =
    op === 'questions' && options.question?.trim()
      ? `笔记内容：\n\n${content}\n\n我的问题：${options.question.trim()}`
      : content

  const res = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      stream: false,
      temperature: 0.3, // 与 reportGenerator 一致，通顺但不胡编
      max_tokens: 2000, // 笔记操作输出比报告短
    },
    { timeout: 30000, signal: options.signal },
  )

  const choice = res.choices?.[0]
  const result = choice?.message?.content ?? ''
  const finishReason = choice?.finish_reason ?? 'unknown'

  // 诊断日志：空 content 时记录 finish_reason，便于排查（length=被截断/content_filter=审核/stop=正常结束却空）
  if (!result.trim()) {
    logInfo(`[noteAssistant] 空内容：op=${op} finish_reason=${finishReason} model=${model}`)
    return `（模型未返回内容。原因：${finishReason}。请稍后重试，或换一个操作）`
  }

  // 剥可能的 markdown 代码块包裹（与 reportGenerator 同款容错）
  return result
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

