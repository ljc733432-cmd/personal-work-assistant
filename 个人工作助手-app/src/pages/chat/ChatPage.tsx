import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card } from '@/components/ui/card'
import { useProvidersStore } from '@/stores/providers'
import { invoke, on, send } from '@/lib/ipc'
import type { ChatMessage } from '@/types'

let _seq = 0
const genId = () => `m${Date.now()}_${_seq++}`

export function ChatPage() {
  const { providers, refresh } = useProvidersStore()
  const [providerId, setProviderId] = useState<string>('')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [enableTools, setEnableTools] = useState(true) // 默认开 FC，验证 TV-1
  const [error, setError] = useState<string | null>(null)
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  // 默认选中第一个启用的 provider
  useEffect(() => {
    if (!providerId && providers.length) {
      const first = providers.find((p) => p.enabled) ?? providers[0]
      if (first) setProviderId(first.id)
    }
  }, [providers, providerId])

  // 滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const currentReqId = useRef<string | null>(null)

  const handleSend = async () => {
    if (!input.trim() || !providerId || streaming) return
    setError(null)

    const userMsg: ChatMessage = { id: genId(), role: 'user', content: input.trim() }
    const aiMsg: ChatMessage = { id: genId(), role: 'assistant', content: '', streaming: true }
    const history = [...messages, userMsg]
    setMessages([...history, aiMsg])
    setInput('')
    setStreaming(true)

    // ★ 关键：渲染层先生成 reqId，先订阅，再带 reqId 发起。
    // 旧版 reqId 在 invoke 返回后才知，会丢首字且无法取消。
    const reqId = `r${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    currentReqId.current = reqId

    const offToken = on('chat:token', (...args) => {
      const ev = args[0] as { reqId: string; text: string }
      if (ev.reqId !== reqId) return
      setMessages((cur) =>
        cur.map((m) => (m.id === aiMsg.id ? { ...m, content: m.content + ev.text } : m)),
      )
    })
    const offFirstToken = on('chat:first_token', (...args) => {
      const ev = args[0] as { reqId: string; elapsedMs: number }
      if (ev.reqId !== reqId) return
      setFirstTokenMs(ev.elapsedMs)
    })
    const offToolCall = on('chat:tool_call', (...args) => {
      const ev = args[0] as { reqId: string; name: string; args: string }
      if (ev.reqId !== reqId) return
      setMessages((cur) =>
        cur.map((m) =>
          m.id === aiMsg.id
            ? { ...m, content: m.content + `\n\n⚙️ 调用工具 ${ev.name}(${ev.args})\n\n` }
            : m,
        ),
      )
    })
    const offDone = on('chat:done', (...args) => {
      const ev = args[0] as { reqId: string }
      if (ev.reqId !== reqId) return
      cleanup()
    })
    const offError = on('chat:error', (...args) => {
      const ev = args[0] as { reqId: string; message: string }
      if (ev.reqId !== reqId) return
      setError(ev.message)
      setMessages((cur) => cur.filter((m) => m.id !== aiMsg.id))
      cleanup()
    })

    const cleanup = () => {
      offToken()
      offFirstToken()
      offToolCall()
      offDone()
      offError()
      currentReqId.current = null
      setStreaming(false)
      setFirstTokenMs(null)
    }

    try {
      await invoke<string>('chat:send', {
        reqId,
        providerId,
        enableTools,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      })
    } catch (e) {
      setError(String(e))
      setMessages((cur) => cur.map((m) => (m.id === aiMsg.id ? { ...m, streaming: false } : m)))
      cleanup()
    }
  }

  const handleCancel = () => {
    const rid = currentReqId.current
    if (!rid) return
    // AbortController 在主进程，通过 send 触发取消
    send('chat:cancel', rid)
  }

  const enabledProviders = providers.filter((p) => p.enabled)

  return (
    <div className="flex h-screen flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b bg-card px-4 py-2.5">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          {enabledProviders.length === 0 && <option value="">未配置模型</option>}
          {enabledProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={enableTools}
            onChange={(e) => setEnableTools(e.target.checked)}
          />
          启用工具（FC）
        </label>
        {firstTokenMs !== null && (
          <span className="text-xs text-muted-foreground">
            首字 {(firstTokenMs / 1000).toFixed(1)}s
          </span>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
        {streaming && (
          <span className="ml-auto animate-pulse text-xs text-muted-foreground">
            {firstTokenMs === null ? '思考中…' : '回复中…'}
          </span>
        )}
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && (
            <div className="rounded-lg border border-dashed bg-card/50 p-8 text-center text-sm text-muted-foreground">
              <p className="mb-2 font-medium text-foreground">M1 骨架验证</p>
              <p>试试问"现在几点？"来验证 Function Calling 链路。</p>
              <p className="mt-1">需先在「设置」页配置一个模型 Provider。</p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} />
          ))}
        </div>
      </div>

      {/* 输入区 */}
      <div className="border-t bg-card p-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={providerId ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先在设置页配置模型'}
            disabled={!providerId || streaming}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            className="min-h-[44px] max-h-[160px] resize-none"
            rows={1}
          />
          <Button onClick={handleSend} disabled={!input.trim() || !providerId || streaming}>
            {streaming ? '回复中…' : '发送'}
          </Button>
          {streaming && (
            <Button variant="ghost" onClick={handleCancel}>
              取消
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <Card
        className={`max-w-[85%] px-4 py-2.5 ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-card'
        } ${msg.streaming ? 'animate-pulse' : ''}`}
      >
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {msg.content || (msg.streaming ? '…' : '')}
          {msg.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
        </div>
      </Card>
    </div>
  )
}
