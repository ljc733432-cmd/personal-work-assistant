import { createClientForProvider } from './providers/factory'
import type { ReportPayload } from '../types'

/**
 * AI 日报/周报生成（v1.8 M17，PRD §15.3④）。
 *
 * 见 CONTEXT.md「Report」、ADR-025（复用笔记库不建 ReportRecord 表）。
 *
 * 设计（照搬 taskExtractor.ts 的「独立非流式调用」范式，ADR-010）：
 *  - 非流式一次性调用（stream:false），报告可等 10~20s，前端有 working 动画
 *  - 用「报告模型」（设置页配 report.providerId），建议选便宜模型（报告不需强推理）
 *  - 输出是 Markdown（不是 JSON），所以不做 JSON 容错，但仍剥可能的代码块包裹
 *
 * 容错策略：
 *  - 模型返回空 content → 返回兜底 Markdown（不抛错，让用户看到「无内容」而非崩溃）
 *  - 数据全空（没完成任务/对话/番茄/提醒）→ IPC 层提前拦截提示，不走模型调用
 */

const SYSTEM_PROMPT = `你是一个工作总结助手。根据用户提供的当日/当周工作数据，生成一份结构清晰的 Markdown 报告。

要求：
1. 用中文输出，语气简洁客观（不要夸张形容词）。
2. 报告结构：先一句概述，再分小节（完成任务 / 对话摘要 / 专注时长 / 待办提醒）。
3. 完成的任务按优先级排序（high > medium > low），每条用「- [x]」格式。
4. 对话摘要提炼关键话题（不要逐条复述），如果对话内容很少就省略这节。
5. 专注时长统计总分钟数 + 番茄钟次数；如果没有番茄数据就省略。
6. 如果某类数据为空，对应小节写「无」或直接省略，不要编造。
7. 结尾加一节「明日/下周计划建议」，基于未完成的待办和提醒给出 1-3 条建议。
8. 直接输出 Markdown 正文（从「## 报告」一级标题开始），不要用代码块包裹，不要任何前置说明。`

/**
 * 生成工作报告（Markdown 字符串）。
 *
 * @param providerId 报告用的 Provider（设置页配的「报告模型」）
 * @param payload 聚合后的数据载荷（时间范围内已过滤 + 截断）
 * @returns Markdown 字符串（不会抛错，空内容返回兜底）
 */
export async function generateReport(
  providerId: string,
  payload: ReportPayload,
): Promise<string> {
  const { client, model } = createClientForProvider(providerId)

  const userContent = buildUserPrompt(payload)

  const res = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      stream: false,
      temperature: 0.3, // 报告要通顺但不要胡编，0.3 比抽取的 0 略高
      max_tokens: 4000, // 报告比草稿长，给足空间但防 timeout
    },
    { timeout: 30000 }, // 30s 超时（ms，SDK request options）
  )

  const content = res.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) {
    return payload.range === 'daily' ? '## 今日报告\n\n（模型未返回内容，请稍后重试）' : '## 本周报告\n\n（模型未返回内容，请稍后重试）'
  }

  // 剥可能的 markdown 代码块包裹（与 taskExtractor 同款容错，虽然要求不裹但模型偶尔会裹）
  return content
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

/** 把 payload 拼成喂给模型的 user 消息（紧凑格式，省 token）。 */
function buildUserPrompt(payload: ReportPayload): string {
  const rangeLabel = payload.range === 'daily' ? '今日' : '本周'
  const lines: string[] = []
  lines.push(`以下是${rangeLabel}的工作数据，请生成报告。`)
  lines.push('')

  // 任务
  lines.push(`【完成的任务】（共 ${payload.tasks.length} 个）`)
  if (payload.tasks.length === 0) {
    lines.push('无')
  } else {
    for (const t of payload.tasks) {
      lines.push(`- [优先级:${t.priority}] ${t.title}`)
    }
  }
  lines.push('')

  // 对话
  lines.push(`【对话记录】（共 ${payload.conversations.length} 条，已截断）`)
  if (payload.conversations.length === 0) {
    lines.push('无')
  } else {
    for (const m of payload.conversations) {
      lines.push(`[${m.role}] ${m.content}`)
    }
  }
  lines.push('')

  // 番茄钟
  const totalMin = payload.pomodoros.reduce((sum, p) => sum + p.durationMin, 0)
  lines.push(`【番茄钟】（共 ${payload.pomodoros.length} 次，合计 ${totalMin} 分钟）`)
  if (payload.pomodoros.length === 0) {
    lines.push('无')
  } else {
    lines.push(`完成 ${payload.pomodoros.filter((p) => p.completed).length} 次，中断 ${payload.pomodoros.filter((p) => !p.completed).length} 次`)
  }
  lines.push('')

  // 提醒
  lines.push(`【待办提醒】（共 ${payload.reminders.length} 条）`)
  if (payload.reminders.length === 0) {
    lines.push('无')
  } else {
    for (const r of payload.reminders) {
      lines.push(`- ${r.content}${r.done ? '（已处理）' : '（未处理）'}`)
    }
  }

  return lines.join('\n')
}
