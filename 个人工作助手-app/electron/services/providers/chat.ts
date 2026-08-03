import OpenAI from 'openai'
import type { ChatRequest, OnToken, ToolRegistration } from './types'
import type { ChatMessage } from '../../types'

/**
 * 统一的流式对话 + Function Calling 循环。
 *
 * 流程（见 AGENTS.md §4）：
 *  1. client.chat.completions.create({ stream:true, tools })
 *  2. 逐 chunk 把文本 delta 通过 onToken 推回（流式 IPC）
 *  3. 若模型发起 tool_calls → 本地执行 handler → 结果作为 role:'tool' 回灌
 *     → 再发起一次请求让模型生成最终答（最多循环 N 次，防失控）
 *
 * 用 chat.completions（非 responses）——见 ADR-003，国产兼容端点只支持前者。
 */
// 工具调用轮次上限。设大值兼顾"复杂任务够用"与"防模型死循环烧 token"。
// 如总结整个项目文件夹需要多次 read_file，4 轮远不够，提到 25。
const MAX_TOOL_ROUNDS = 25

interface RunOptions extends ChatRequest {
  client: OpenAI
  model: string
  onToken: OnToken
  /** 模型发起 FC 时回调（用于二次确认等场景，M6 用）。 */
  onToolCall?: (name: string, args: string) => void
  /** 首字到达回调，传首字延迟毫秒数（诊断"回复慢"用）。 */
  onFirstToken?: (elapsedMs: number) => void
  /** 工具需要用户确认时（如 write_file 覆盖）的回调，返回用户是否同意。 */
  onConfirm?: (prompt: string) => Promise<boolean>
}

/** 把内部 ChatMessage[] 转成 OpenAI SDK 期望的格式。 */
function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    const base: OpenAI.Chat.ChatCompletionMessageParam = {
      role: m.role,
      content: m.content,
    } as OpenAI.Chat.ChatCompletionMessageParam
    return base
  })
}

function toOpenAITools(tools?: ToolRegistration[]) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => t.def)
}

/** 找一个工具注册项，按名字。 */
function findTool(tools: ToolRegistration[] | undefined, name: string) {
  return tools?.find((t) => t.def.function.name === name)
}

export async function chatWithProvider(opts: RunOptions): Promise<void> {
  const { client, model, messages, tools, onToken, onToolCall, onFirstToken, onConfirm, signal } = opts

  // 累积 messages，工具结果会追加进去
  const working: OpenAI.Chat.ChatCompletionMessageParam[] = toOpenAIMessages(messages)
  const openaiTools = toOpenAITools(tools)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const roundStart = Date.now()
    let firstTokenReported = false
    const stream = await client.chat.completions.create(
      {
        model,
        messages: working,
        tools: openaiTools,
        stream: true,
      },
      { signal },
    )

    // 边收边累积本轮 assistant 消息（含可能的 tool_calls）
    let textBuf = ''
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue

      // 首字计时（任一 delta 到达即记），用于诊断回复慢
      if (!firstTokenReported) {
        firstTokenReported = true
        onFirstToken?.(Date.now() - roundStart)
      }

      if (delta.content) {
        textBuf += delta.content
        onToken(delta.content)
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const entry = toolCallAccumulator.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) entry.id = tc.id
          if (tc.function?.name) entry.name += tc.function.name
          if (tc.function?.arguments) entry.args += tc.function.arguments
          toolCallAccumulator.set(idx, entry)
        }
      }
    }

    // 把本轮 assistant 消息入历史
    const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: textBuf || null,
    }
    if (toolCallAccumulator.size > 0) {
      assistantMsg.tool_calls = [...toolCallAccumulator.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, e]) => ({
          id: e.id,
          type: 'function' as const,
          function: { name: e.name, arguments: e.args },
        }))
    }
    working.push(assistantMsg)

    // 没有工具调用 → 本轮就是最终答，结束
    if (toolCallAccumulator.size === 0) return

    // 执行每个工具调用，结果作为 role:'tool' 回灌
    for (const [, entry] of toolCallAccumulator) {
      onToolCall?.(entry.name, entry.args)
      const tool = findTool(tools, entry.name)
      let resultStr: string
      if (!tool) {
        resultStr = JSON.stringify({ error: `未知工具: ${entry.name}` })
      } else {
        let parsed: Record<string, unknown> = {}
        try {
          parsed = entry.args ? JSON.parse(entry.args) : {}
        } catch {
          parsed = {}
        }
        try {
          const r = await tool.handler(parsed, onConfirm)
          // 规范化：handler 可返回 string 或 ToolHandlerResult
          if (typeof r === 'string') {
            resultStr = r
          } else if (r.kind === 'result') {
            resultStr = r.value
          } else {
            // confirm 类型：挂起等用户确认
            if (!onConfirm) {
              resultStr = JSON.stringify({ error: '该操作需要确认，但当前不支持确认流程，已取消' })
            } else {
              const approved = await onConfirm(r.prompt)
              if (approved) {
                resultStr = await r.action()
              } else {
                resultStr = JSON.stringify({ cancelled: true, message: '用户取消了该操作' })
              }
            }
          }
        } catch (e) {
          resultStr = JSON.stringify({ error: String(e) })
        }
      }
      working.push({
        role: 'tool',
        tool_call_id: entry.id,
        content: resultStr,
      })
    }
    // 循环回到顶部，再发一次请求让模型基于工具结果生成最终答
  }

  // 达到上限仍没结束：补一句收尾，引导模型基于已有结果给答复
  onToken('\n\n_（已达到本轮工具调用上限，请基于已获取的信息继续回答）_')
}
