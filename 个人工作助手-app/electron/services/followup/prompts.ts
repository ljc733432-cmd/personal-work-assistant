import type { Task } from '../../types'

/**
 * 跟进会话提示词（M6）。
 * 见 CONTEXT.md「跟进会话」「到点流程」。
 */

/** 跟进会话系统提示：AI 主动问候 + 询问候选任务进展。 */
export const FOLLOWUP_SYSTEM_PROMPT = `你是用户的个人工作助手，正在做定时跟进。根据下面的待办任务列表，主动发起一段跟进对话：

要求：
1. 语气友好、简短（不要长篇大论，3-5 句话）。
2. 提到最紧急的 1-2 个任务（今天到期/逾期/高优先级），询问进展。
3. 如果有逾期任务，温和提醒（不要指责）。
4. 不要罗列全部任务，挑重点。
5. 直接输出对话内容（这是要展示给用户的第一条消息），不要有任何前置说明。`

/** 把候选任务列表构造成给模型的摘要文本。 */
export function buildCandidatesContext(candidates: Task[]): string {
  if (candidates.length === 0) return '（无候选任务）'

  const now = Math.floor(Date.now() / 1000)
  const lines = candidates.map((t, i) => {
    const parts = [`${i + 1}. ${t.title}`]
    if (t.priority === 'high') parts.push('【高优先级】')
    if (t.dueDate) {
      const diff = t.dueDate - now
      const dayDiff = Math.floor(diff / 86400)
      const dueLabel =
        dayDiff < 0
          ? `【已逾期 ${Math.abs(dayDiff)} 天】`
          : dayDiff === 0
            ? '【今天到期】'
            : `【${dayDiff} 天后到期】`
      parts.push(dueLabel)
    }
    if (t.description) parts.push(`（${t.description}）`)
    return parts.join(' ')
  })
  return `当前时间：${new Date().toLocaleString('zh-CN')}\n\n待跟进任务：\n${lines.join('\n')}`
}
