import { createClientForProvider } from './providers/factory'
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
 * 容错策略（与 reportGenerator 一致）：
 *  - 空内容返回兜底 Markdown（不抛错）
 *  - 剥可能的 ```markdown 代码块包裹
 */

const SYSTEM_PROMPTS: Record<NoteAiOp, string> = {
  summary: `你是一个笔记摘要助手。对用户提供的笔记内容生成简洁摘要。
要求：
1. 用中文输出，提炼 3-5 条核心要点，每条一句话。
2. 用 Markdown 无序列表（- ）格式。
3. 客观陈述，不要添加笔记中没有的信息。
4. 直接输出列表，不要前置说明，不要用代码块包裹。`,

  todos: `你是一个待办提取助手。从用户提供的笔记内容中识别可执行的待办事项。
要求：
1. 用中文输出，用 GitHub Flavored Markdown 任务列表格式：- [ ] 待办内容
2. 只提取「需要去做的事」（动作型），不提取陈述句或已完成的。
3. 如果笔记中没有明确待办，返回「未识别到待办事项」。
4. 直接输出列表，不要前置说明，不要用代码块包裹。`,

  questions: `你是一个思考启发助手。基于用户提供的笔记内容，提出 2-3 个相关的问题，帮助用户深入思考。
要求：
1. 用中文输出，问题要有启发性（不是事实确认题），引导用户反思或扩展。
2. 用 Markdown 有序列表（1. 2. 3.）格式。
3. 问题应紧扣笔记主题，不要泛泛而谈。
4. 如果用户提供了具体问题，围绕该问题 + 笔记内容回答，用 Markdown 正文输出。
5. 直接输出，不要前置说明，不要用代码块包裹。`,

  continue: `你是一个写作续写助手。顺延用户提供的笔记内容，续写一段（150-300 字）。
要求：
1. 用中文输出，保持笔记的语气和风格。
2. 顺延主题展开，不要重复已有内容，不要编造与笔记无关的情节。
3. 用 Markdown 正文输出（与笔记风格一致）。
4. 直接输出续写内容，不要前置「以下是续写」之类的说明，不要用代码块包裹。`,
}

/**
 * 对笔记执行 AI 操作。
 *
 * @param providerId 模型 Provider（复用 report.providerId）
 * @param op 操作类型（summary/todos/questions/continue）
 * @param content 笔记正文（Markdown）
 * @param options.question op='questions' 时的可选用户追问（空则 AI 自行提问）
 * @param options.signal 可选 AbortSignal（note:ai_cancel 用）
 * @returns Markdown 字符串（空内容返回兜底，不抛错；被 cancel 时抛 AbortError 由调用方处理）
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

  const result = res.choices?.[0]?.message?.content ?? ''
  if (!result.trim()) {
    return '（模型未返回内容，请稍后重试）'
  }

  // 剥可能的 markdown 代码块包裹（与 reportGenerator 同款容错）
  return result
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}
