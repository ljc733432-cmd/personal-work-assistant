import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card } from '@/components/ui/card'
import { Markdown } from '@/components/Markdown'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useProvidersStore } from '@/stores/providers'
import { invoke, on, send } from '@/lib/ipc'
import type { ChatMessage, ConfirmRequest, ToolCallInfo } from '@/types'

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
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  // 监听工具确认请求（write_file 覆盖等）—— 全局，整个组件生命周期
  useEffect(() => {
    return on('chat:confirm_request', (...args) => {
      const ev = args[0] as ConfirmRequest
      setConfirmReq(ev)
    })
  }, [])

  const respondConfirm = (approved: boolean) => {
    if (confirmReq) {
      send('chat:confirm_response', { reqId: confirmReq.reqId, approved })
      setConfirmReq(null)
    }
  }

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
      // 工具调用独立展示，不污染正文 content
      setMessages((cur) =>
        cur.map((m) =>
          m.id === aiMsg.id
            ? { ...m, toolCalls: [...(m.toolCalls ?? []), { name: ev.name, args: ev.args }] }
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
    <div className="flex h-full flex-col">
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
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 && (
            <div className="mt-12 space-y-3 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-2xl">
                💬
              </div>
              <div>
                <p className="text-base font-medium text-foreground">开始对话</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {providerId
                    ? '问点什么吧。试试「现在几点？」来体验工具调用。'
                    : '请先到「设置」页配置一个模型 Provider。'}
                </p>
              </div>
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

      {/* 工具确认弹窗（write_file 覆盖等） */}
      <ConfirmDialog
        open={confirmReq !== null}
        title="AI 请求确认"
        prompt={confirmReq?.prompt ?? ''}
        confirmText="允许"
        cancelText="拒绝"
        onConfirm={() => respondConfirm(true)}
        onCancel={() => respondConfirm(false)}
      />
    </div>
  )
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  const hasContent = msg.content.trim().length > 0
  const hasTools = (msg.toolCalls?.length ?? 0) > 0

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* 头像 */}
      <div
        className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        }`}
      >
        {isUser ? '我' : 'AI'}
      </div>

      {/* 内容区 */}
      <div className={`flex max-w-[80%] flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
        {/* 工具调用：默认折叠成一个细标签，点开看详情 */}
        {hasTools && <ToolCallsCollapse toolCalls={msg.toolCalls!} align={isUser ? 'end' : 'start'} />}

        {/* 消息气泡 */}
        {(hasContent || msg.streaming) && (
          <Card
            className={`px-3.5 py-2.5 ${
              isUser
                ? 'rounded-br-sm bg-primary text-primary-foreground'
                : 'rounded-bl-sm bg-card'
            }`}
          >
            {hasContent ? (
              isUser ? (
                // 用户消息也用 Markdown（支持它发代码/列表）
                <Markdown content={msg.content} />
              ) : (
                <Markdown content={msg.content} />
              )
            ) : (
              <span className="text-sm text-muted-foreground">…</span>
            )}
            {msg.streaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-text-bottom" />
            )}
          </Card>
        )}
      </div>
    </div>
  )
}

/** 工具调用折叠组件：默认收起成一个细标签，点开看每个调用的详情。 */
function ToolCallsCollapse({
  toolCalls,
  align,
}: {
  toolCalls: ToolCallInfo[]
  align: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const count = toolCalls.length
  // 名字汇总（去重），如 "list_files · read_file"
  const names = [...new Set(toolCalls.map((t) => t.name))].join(' · ')

  return (
    <div className={`flex flex-col gap-1 ${align === 'end' ? 'items-end' : 'items-start'}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        title={open ? '收起' : '展开详情'}
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        <span>
          🔧 {count} 个工具调用
          <span className="ml-1 opacity-70">({names})</span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1">
          {toolCalls.map((tc, i) => (
            <div
              key={i}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              <span className="font-medium text-foreground/80">{tc.name}</span>
              {tc.args && tc.args !== '{}' && (
                <span className="max-w-[280px] truncate font-mono text-[10px] opacity-70" title={tc.args}>
                  {tc.args}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
