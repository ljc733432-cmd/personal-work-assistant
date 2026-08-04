import { createClientForProvider } from './providers/factory'
import { logInfo } from './logger'

/**
 * AI 思维导图生成（v1.12，PRD §15.3 AI 产出组）。
 *
 * 照搬 reportGenerator 的「独立非流式调用」范式（ADR-010）：
 *  - 非流式一次性调用（stream:false），思维导图可等 10~20s，前端有 working 动画
 *  - 复用 settings KV report.providerId（零新配置，与报告/笔记助手共用）
 *  - 输出是 Markdown 层级标题（# / ## / ###），markmap 原生支持渲染
 *
 * 两种输入模式：
 *  - topic：用户输主题（如「Q4 产品规划」），AI 自由展开
 *  - material：基于笔记/任务内容生成（信息更丰富）
 *
 * 容错策略：
 *  - 模型返回空 content → 返回兜底 Markdown（不抛错）+ 记 finish_reason 诊断日志
 *  - 剥可能的代码块包裹
 *  - prompt 用「指示性」措辞（DeepSeek 在「不要前置说明/不要代码块」等禁止性措辞下会吞输出
 *    返回空 content，见 v1.10 摘要 bug + noteAssistant 注释）。给明确输出模板 + 起始锚点。
 */

const SYSTEM_PROMPT = `你是一个思维导图生成助手。根据用户的主题或素材，生成一份结构清晰的 Markdown 思维导图。

请按以下格式输出（直接从「# 」一级标题开始，给出完整的标题层级）：

# 主题名称

## 一级分支 A
### 细分要点 1
### 细分要点 2

## 一级分支 B
### 细分要点 1

## 一级分支 C

要求：
1. 用中文输出。
2. 用 Markdown 标题层级表达思维导图：「# 」是根节点（1 个），「## 」是主要方面（3-6 个），「### 」是细分要点（每个一级分支下 2-5 个）。需要更细时用「#### 」，尽量控制在 3 层以内。
3. 每个分支节点用简洁的短语（5-15 字），保持精炼。
4. 分支之间逻辑独立不重叠（MECE 原则）。`

/**
 * 生成思维导图（Markdown 字符串）。
 *
 * @param providerId 模型 Provider（复用 report.providerId）
 * @param input 输入：topic 主题字符串 或 material 素材文本（笔记/任务内容）
 * @param options.signal 可选 AbortSignal（mindmap:cancel 用）
 * @returns Markdown 字符串（标题层级，markmap 渲染用）
 */
export async function generateMindmap(
  providerId: string,
  input: { topic?: string; material?: string },
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const { client, model } = createClientForProvider(providerId)

  const userContent =
    input.material && input.material.trim()
      ? `请基于以下素材生成思维导图，提炼出核心主题和分支结构：\n\n${input.material}`
      : `请为以下主题生成一份思维导图：\n\n${input.topic ?? '（未提供主题）'}`

  const res = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      stream: false,
      temperature: 0.4, // 思维导图要发散但要结构，0.4 略高于报告
      max_tokens: 3000,
    },
    { timeout: 30000, signal: options.signal },
  )

  const choice = res.choices?.[0]
  const content = choice?.message?.content ?? ''
  // 空内容诊断日志（照搬 noteAssistant：记 finish_reason 定位是 length/content_filter/stop）
  if (!content.trim()) {
    const finishReason = choice?.finish_reason ?? 'unknown'
    logInfo(`[mindmap] 空内容：finish_reason=${finishReason} model=${model}`)
    return '# 思维导图\n\n（模型未返回内容。可能原因：内容过滤/长度限制。请稍后重试，或换一个主题）'
  }

  return content
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}
