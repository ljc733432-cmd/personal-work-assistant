import { createClientForProvider } from './providers/factory'
import type { ChatMessage, TaskDraft, TaskPriority } from '../types'

/**
 * 任务抽取（M4）。
 *
 * 见 CONTEXT.md「任务抽取草稿」、AGENTS.md §6 红线「不要静默建任务」。
 *
 * 设计（ADR-010：抽取走独立 IPC，不走 FC）：
 *  - 非流式一次性调用（照搬 provider:test 范式，stream:false）
 *  - 用「最便宜的模型」（设置页配 extract.providerId）
 *  - 只产草稿，不直接入库（红线：必须人工点"加入任务"）
 *
 * 容错策略：
 *  - 模型返回非法 JSON / 格式不符 → 返回空数组（不抛错，前端提示"未识别到任务"）
 *  - 单条草稿字段缺失/非法 → 跳过该条，不整批失败
 */

const SYSTEM_PROMPT = `你是一个任务识别助手。从下面的对话中，识别出用户明确提到「需要去做的事」「待办」「计划要做」的任务。

要求：
1. 只抽取用户自己要做的事（不是 AI 要做的、不是已完成的、不是纯闲聊）。
2. 每个任务给出：title（简短动作，如"交季度报告"）、description（补充细节，可空）、priority（low/medium/high）、dueDate（截止日期，ISO 格式如"2026-08-10"或"2026-08-10T14:00"，无截止则 null）。
3. 如果对话里没有明确可执行的任务，返回 {"tasks": []}。
4. 不要臆测任务——只在用户确实表达了要做某事时才抽取。
5. 严格返回 JSON，格式：{"tasks": [{"title": "...", "description": "..."或null, "priority": "medium", "dueDate": "2026-08-10"或null}]}
6. 只返回 JSON 对象，不要有任何其他文字、不要用 markdown 代码块包裹。`

/** 把模型返回的原始对象归一化成 TaskDraft（容错：字段非法则跳过）。 */
function normalizeDraft(raw: unknown): TaskDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title) return null // 无标题的草稿无意义

  const description =
    typeof r.description === 'string' && r.description.trim() ? r.description.trim() : null

  const priorityRaw = r.priority
  const priority: TaskPriority =
    priorityRaw === 'low' || priorityRaw === 'high' ? priorityRaw : 'medium' // 默认 medium

  // dueDate：模型可能返回 ISO 字符串或 null，转 Unix 秒
  let dueDate: number | null = null
  if (typeof r.dueDate === 'string' && r.dueDate.trim()) {
    const ts = Date.parse(r.dueDate)
    if (!Number.isNaN(ts)) dueDate = Math.floor(ts / 1000)
  }

  return { title, description, priority, dueDate }
}

/**
 * 从对话历史抽取任务草稿。
 *
 * @param providerId 抽取用的 Provider（设置页配的「最便宜模型」）
 * @param messages 对话历史（role/content，与 chat:send 同结构）
 * @returns 草稿数组（可能为空）。不直接入库。
 */
export async function extractTasks(
  providerId: string,
  messages: ChatMessage[],
): Promise<TaskDraft[]> {
  if (messages.length === 0) return []

  const { client, model } = createClientForProvider(providerId)

  // 转成 OpenAI messages 格式。过滤掉 tool 消息（中间态，抽取不需要，
  // 且 OpenAI 类型要求 tool 消息带 tool_call_id）。只保留 system/user/assistant。
  const openaiMessages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    ...messages
      .filter((m) => m.role !== 'tool')
      .map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
  ]

  // 注：不用 response_format:{type:'json_object'}——虽 DeepSeek/智谱支持，
  // 但实测在 Electron + OpenAI SDK 4.x 下偶发 "Request was aborted"（连接抖动，
  // 见项目总结 bug #14）。改用提示词约束 JSON 输出，更稳兼容。
  // max_tokens 限制：草稿不需要长输出，限 2000 防 timeout。
  const res = await client.chat.completions.create(
    {
      model,
      messages: openaiMessages,
      stream: false,
      temperature: 0, // 抽取要稳定，不要发挥
      max_tokens: 2000,
    },
    { timeout: 30000 }, // 30s 超时（ms，SDK request options），防默认超时过长卡死
  )

  const content = res.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) return []

  // 容错解析：剥离可能的 markdown 代码块包裹（```json ... ```），再 JSON.parse
  const jsonStr = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return []
  }

  // 期望 { tasks: [...] }，但也容忍直接是数组
  const arr: unknown =
    Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown })?.tasks
  if (!Array.isArray(arr)) return []

  return arr.map(normalizeDraft).filter((d): d is TaskDraft => d !== null)
}
