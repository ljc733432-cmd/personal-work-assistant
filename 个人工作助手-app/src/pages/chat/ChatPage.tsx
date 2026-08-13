import { useEffect, useRef, useState, type ClipboardEvent, type ChangeEvent } from 'react'
import { Sparkles, MessageSquare, User, Bot, Wrench, Loader2, ImageSquare, X } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/Markdown'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useProvidersStore } from '@/stores/providers'
import { useChatStore } from '@/stores/chat'
import { useTasksStore } from '@/stores/tasks'
import { useTiersStore } from '@/stores/tiers'
import { useScreenshotStore } from '@/stores/screenshot'
import { ConversationList } from './ConversationList'
import { DraftCard } from './DraftCard'
import { invoke, on, send } from '@/lib/ipc'
import type { ChatMessage, ConfirmRequest, TaskDraft } from '@/types'

let _seq = 0
const genId = () => `m${Date.now()}_${_seq++}`

// 模块级空数组常量：selector 返回它时引用稳定，避免 useSyncExternalStore 无限循环。
// （zustand 在 React 18 strict 下要求 getSnapshot 返回值引用不变。）
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_DRAFTS: TaskDraft[] = []

export function ChatPage() {
  const { providers, refresh, initialized } = useProvidersStore()
  const [providerId, setProviderId] = useState<string>('')
  const [input, setInput] = useState('')
  const [enableTools, setEnableTools] = useState(true) // 默认开 FC，验证 TV-1
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // v1.17 对话发图：待发送的图片附件（粘贴/上传），发送时带进 user 消息
  const [pendingImages, setPendingImages] = useState<{ name: string; dataUrl: string }[]>([])
  const chatImgInputRef = useRef<HTMLInputElement>(null)

  // M4-Step7：自动抽取配置（ref，不触发重渲染，供 offDone 闭包读）。
  // 设置页改了需重开生效（MVP，不做实时同步——避免每次 done 都 IPC 读）。
  const extractConfig = useRef<{ enabled: boolean; providerId: string }>({
    enabled: false,
    providerId: '',
  })

  // M2-Step4/6：会话、消息、流式元状态都从 store 读（per-conversation）。
  // 注意：selector 不能返回内联新对象/数组（如 `?? []`），否则 useSyncExternalStore 无限循环。
  const activeId = useChatStore((s) => s.activeId)
  const convMessages = useChatStore((s) =>
    s.activeId ? s.messagesByConv[s.activeId] : EMPTY_MESSAGES,
  )
  const messages = convMessages ?? EMPTY_MESSAGES
  // active 会话的流式元状态（per-conversation，Step6：切到 B 时 B 不被 A 的流式锁住）
  const meta = useChatStore((s) => (s.activeId ? s.metaByConv[s.activeId] : undefined))
  const streaming = meta?.streaming ?? false

  // M15：当前会话对象（读 defaultProviderId 做会话级记忆）+ 档位列表
  const currentConv = useChatStore((s) =>
    s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined,
  )
  const { tiers, refresh: refreshTiers } = useTiersStore()
  const firstTokenMs = meta?.firstTokenMs ?? null
  const error = meta?.error ?? null
  const truncatedNotice = meta?.truncatedNotice ?? null
  const extracting = meta?.extracting ?? false
  const drafts = useChatStore((s) => (s.activeId ? s.draftsByConv[s.activeId] : undefined)) ?? EMPTY_DRAFTS
  const loadConversations = useChatStore((s) => s.loadConversations)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const updateMessage = useChatStore((s) => s.updateMessage)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const setMeta = useChatStore((s) => s.setMeta)
  const setDrafts = useChatStore((s) => s.setDrafts)
  const updateDraft = useChatStore((s) => s.updateDraft)
  const removeDraft = useChatStore((s) => s.removeDraft)
  const createFromDraft = useTasksStore((s) => s.createFromDraft)

  useEffect(() => {
    refresh()
  }, [refresh])

  // v1.19：订阅截图标注 store。截图页「插入当前对话」push 后，这里 merge 进 pendingImages
  // 并 consume 清空。ChatPage 常驻挂载（v1.17.1），订阅式保证切回对话页能看到图。
  const pendingFromScreenshot = useScreenshotStore((s) => s.pendingForChat)
  const consumeForChat = useScreenshotStore((s) => s.consumeForChat)
  useEffect(() => {
    if (pendingFromScreenshot.length > 0) {
      setPendingImages((prev) => [...prev, ...pendingFromScreenshot])
      consumeForChat()
    }
  }, [pendingFromScreenshot, consumeForChat])

  // M4-Step7：读自动抽取配置（mount 时读一次，设置页改了重开生效）
  useEffect(() => {
    ;(async () => {
      try {
        const enabled = await invoke<string | null>('settings:get', 'extract.enabled')
        const providerId = await invoke<string | null>('settings:get', 'extract.providerId')
        extractConfig.current = {
          enabled: enabled === 'true',
          providerId: providerId ?? '',
        }
      } catch {
        /* 读配置失败不影响对话 */
      }
    })()
  }, [])

  // 会话初始化（单会话兜底）+ 历史 hydrate —— 委托给 store。
  useEffect(() => {
    ;(async () => {
      try {
        await loadConversations()
      } catch (e) {
        // 会话初始化失败不阻塞对话（主进程会兜底：conversationId 为空时落库跳过）
        console.error('[chat] 会话初始化失败', e)
      }
    })()
  }, [loadConversations])

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

  // M15：providerId 初始化优先级：会话 defaultProviderId（会话级记忆）> 第一个启用 provider
  useEffect(() => {
    refreshTiers()
  }, [refreshTiers])

  // 仅在切会话（activeId 变化）时 hydrate providerId，不依赖 providerId 自身
  // （否则用户切 provider 会触发此 effect 把 providerId 覆盖回会话旧值）
  useEffect(() => {
    if (currentConv?.defaultProviderId) {
      setProviderId(currentConv.defaultProviderId)
      return
    }
    // 无会话记忆时，默认第一个启用 provider
    if (providers.length) {
      const first = providers.find((p) => p.enabled) ?? providers[0]
      if (first) setProviderId(first.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // 滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const currentReqId = useRef<string | null>(null)
  // 持有当前活跃流的 cleanup 函数（handleSend 设置，卸载时调用，防 listener 泄漏）
  const activeCleanup = useRef<(() => void) | null>(null)

  // M2-Step3：组件卸载时若仍在流式，取消请求 + 退订监听，防 IPC listener 泄漏 + setState 到已卸载组件。
  // （ChatPage 在 App.tsx 是条件渲染，切 tab 即卸载。）
  useEffect(() => {
    return () => {
      if (currentReqId.current) {
        send('chat:cancel', currentReqId.current)
      }
      activeCleanup.current?.()
      activeCleanup.current = null
    }
  }, [])

  // M15：切换 provider 时同步持久化到会话（会话级记忆，复用闲置字段 defaultProviderId）
  // 关键：DB 和 chat store 的 conversations 都要更新，否则下次切回该会话 hydrate 到旧值
  const handleProviderChange = async (nextProviderId: string) => {
    setProviderId(nextProviderId)
    if (activeId) {
      // 同步更新 store 的 conversations（让 currentConv.defaultProviderId 立即准确）
      useChatStore.setState((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === activeId ? { ...c, defaultProviderId: nextProviderId } : c,
        ),
      }))
      try {
        await invoke<true>('conversation:setProvider', activeId, nextProviderId)
      } catch {
        // 持久化失败不影响本次切换（内存 state 已更新）
      }
    }
  }

  const handleSend = async () => {
    if (!input.trim() || streaming) return
    // v1.16.1：provider 未就绪时给明确提示（而非静默 return，避免用户按 Enter 无反应）
    if (!providerId) {
      setMeta(activeId ?? '', {
        error: initialized
          ? '尚未配置模型，请先到设置页添加模型'
          : '模型配置加载中，请稍候片刻再发送',
      })
      return
    }
    if (!activeId) {
      setMeta(activeId ?? '', { error: '会话未就绪，请稍候' })
      return
    }
    const convId = activeId // 捕获到局部，避免闭包内 activeId 变化影响
    // 清该会话的 error + truncatedNotice + 置 streaming（per-conversation，Step6）
    setMeta(convId, { error: null, streaming: true, firstTokenMs: null, truncatedNotice: null })

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: input.trim(),
      // v1.17 对话发图：带上待发送的图片附件
      ...(pendingImages.length > 0 ? { attachments: pendingImages } : {}),
    }
    const aiMsg: ChatMessage = { id: genId(), role: 'assistant', content: '', streaming: true }
    const history = [...messages, userMsg]
    // 乐观插入：user + 空 aiMsg（store 追加）
    appendMessage(convId, userMsg)
    appendMessage(convId, aiMsg)
    setInput('')
    setPendingImages([]) // v1.17：发送后清空待发图片

    // ★ 关键：渲染层先生成 reqId，先订阅，再带 reqId 发起。
    // 旧版 reqId 在 invoke 返回后才知，会丢首字且无法取消。
    const reqId = `r${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    currentReqId.current = reqId

    const offToken = on('chat:token', (...args) => {
      const ev = args[0] as { reqId: string; text: string }
      if (ev.reqId !== reqId) return
      // content 拼接：读当前值 + 追加（store 不支持函数式 patch，手动读）
      const cur = useChatStore.getState().getMessages(convId).find((m) => m.id === aiMsg.id)
      if (cur) updateMessage(convId, aiMsg.id, { content: cur.content + ev.text })
    })
    const offFirstToken = on('chat:first_token', (...args) => {
      const ev = args[0] as { reqId: string; elapsedMs: number }
      if (ev.reqId !== reqId) return
      setMeta(convId, { firstTokenMs: ev.elapsedMs })
    })
    const offToolCall = on('chat:tool_call', (...args) => {
      const ev = args[0] as { reqId: string; name: string; args: string }
      if (ev.reqId !== reqId) return
      // 工具调用独立展示，不污染正文 content
      const cur = useChatStore.getState().getMessages(convId).find((m) => m.id === aiMsg.id)
      if (cur) {
        updateMessage(convId, aiMsg.id, {
          toolCalls: [...(cur.toolCalls ?? []), { name: ev.name, args: ev.args }],
        })
      }
    })
    const offDone = on('chat:done', (...args) => {
      const ev = args[0] as { reqId: string; cancelled?: boolean }
      if (ev.reqId !== reqId) return
      // 修现存 bug：done 时必须清掉 aiMsg.streaming，否则光标动画一直闪。
      // cancelled=true（用户点取消）也走这里，content 保留已生成的部分。
      updateMessage(convId, aiMsg.id, { streaming: false })
      cleanup()
      // M4-Step7：自动抽取（设置开了 + 配了抽取模型 + 无未确认草稿 + 非取消）
      if (
        !ev.cancelled &&
        extractConfig.current.enabled &&
        extractConfig.current.providerId &&
        useChatStore.getState().getDrafts(convId).length === 0
      ) {
        // 不 await：自动抽取后台跑，不阻塞 done 流程
        runExtract(convId).catch(() => {})
      }
    })
    const offError = on('chat:error', (...args) => {
      const ev = args[0] as { reqId: string; message: string }
      if (ev.reqId !== reqId) return
      setMeta(convId, { error: ev.message })
      removeMessage(convId, aiMsg.id)
      cleanup()
    })
    // M2-Step7：截断提示（主进程丢弃了较早消息时推来，UI 要提示，禁忌静默丢）
    const offTruncated = on('chat:truncated', (...args) => {
      const ev = args[0] as { reqId: string; dropped: number }
      if (ev.reqId !== reqId) return
      setMeta(convId, { truncatedNotice: `已省略较早的 ${ev.dropped} 条消息（超出上下文预算）` })
    })

    const cleanup = () => {
      offToken()
      offFirstToken()
      offToolCall()
      offDone()
      offError()
      offTruncated()
      currentReqId.current = null
      activeCleanup.current = null
      // 只清 streaming + firstTokenMs（保留 error + truncatedNotice，让用户切回还能看到）
      setMeta(convId, { streaming: false, firstTokenMs: null })
    }
    activeCleanup.current = cleanup

    try {
      await invoke<string>('chat:send', {
        reqId,
        providerId,
        enableTools,
        conversationId: convId,
        messages: history.map((m) => ({
          role: m.role,
          content: m.content,
          // v1.17 对话发图：带图片附件给主进程分流（视觉/OCR）
          ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        })),
      })
    } catch (e) {
      setMeta(convId, { error: String(e) })
      updateMessage(convId, aiMsg.id, { streaming: false })
      cleanup()
    }
  }

  const handleCancel = () => {
    const rid = currentReqId.current
    if (!rid) return
    // AbortController 在主进程，通过 send 触发取消
    send('chat:cancel', rid)
  }

  // v1.21 快捷键：Ctrl+Enter 发送 + Esc 取消流式。ChatPage 常驻挂载，window 监听全局生效。
  // 裸 Enter 发送已在 textarea onKeyDown 处理，Ctrl+Enter 是额外方式（习惯用户）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Esc 取消流式（仅 streaming 时）
      if (e.key === 'Escape' && streaming) {
        e.preventDefault()
        handleCancel()
        return
      }
      // Ctrl+Enter 发送（非 streaming、有输入时）
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (!streaming && input.trim()) {
          e.preventDefault()
          void handleSend()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [streaming, input, handleSend, handleCancel])

  // v1.17 对话发图：粘贴/上传图片到待发送列表（不在正文插文本，单独预览）。
  // 粘贴：拦截 clipboardData 里的图片项，转 dataUrl 加入 pendingImages。
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile()
        if (file) {
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = reader.result
            if (typeof dataUrl === 'string') {
              setPendingImages((prev) => [
                ...prev,
                { name: file.name || `图片${prev.length + 1}`, dataUrl },
              ])
            }
          }
          reader.readAsDataURL(file)
        }
      }
    }
  }

  // 上传按钮：选文件加入 pendingImages
  const handlePickChatImage = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result
        if (typeof dataUrl === 'string') {
          setPendingImages((prev) => [...prev, { name: file.name, dataUrl }])
        }
      }
      reader.readAsDataURL(file)
    })
    e.target.value = ''
  }

  const removePendingImage = (idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx))
  }

  // M4：抽取任务草稿核心逻辑（手动 ✨ 和自动都用）。
  const runExtract = async (convId: string) => {
    setMeta(convId, { extracting: true, error: null })
    try {
      const result = await invoke<TaskDraft[]>('task:extract', convId)
      if (result.length > 0) {
        setDrafts(convId, result)
      } else if (convId === activeId) {
        // 手动抽取时给"未识别到"提示；自动抽取静默（不打扰）
        setMeta(convId, { error: '未识别到可执行的任务' })
      }
    } catch (e) {
      if (convId === activeId) setMeta(convId, { error: String(e) })
    } finally {
      setMeta(convId, { extracting: false })
    }
  }

  // M4：手动抽取（✨ 按钮）
  const handleExtract = async () => {
    if (!activeId || extracting) return
    await runExtract(activeId)
  }

  // 草稿确认入库（source 服务端强制 from_chat + 溯源 conversationId）
  const handleAcceptDraft = async (index: number) => {
    if (!activeId) return
    const draft = drafts[index]
    if (!draft || !draft.title.trim()) return
    try {
      await createFromDraft({
        title: draft.title.trim(),
        description: draft.description,
        priority: draft.priority,
        dueDate: draft.dueDate,
        conversationId: activeId,
      })
      removeDraft(activeId, index)
    } catch (e) {
      setMeta(activeId, { error: `加入任务失败：${String(e)}` })
    }
  }

  const handleDismissDraft = (index: number) => {
    if (!activeId) return
    removeDraft(activeId, index)
  }

  const enabledProviders = providers.filter((p) => p.enabled)

  return (
    <div className="flex h-full">
      {/* 会话列表侧栏 */}
      <ConversationList />

      {/* 对话区 */}
      <div className="flex flex-1 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b bg-card px-4 py-2.5">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={providerId}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          {enabledProviders.length === 0 && (
            <option value="">{initialized ? '未配置模型' : '加载中…'}</option>
          )}
          {/* M15：档位快捷入口（绑定的 providerId 作 value，选了等于直接选那个 provider）*/}
          {tiers.length > 0 && enabledProviders.length > 0 && (
            <optgroup label="⚡ 档位">
              {tiers.map((t) => {
                const p = providers.find((x) => x.id === t.providerId)
                if (!p) return null
                return (
                  <option key={t.id} value={t.providerId}>
                    {t.name} · {p.model}
                  </option>
                )
              })}
            </optgroup>
          )}
          {/* 具体模型（始终可用，档位只是快捷别名）*/}
          <optgroup label="具体模型">
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.model}
              </option>
            ))}
          </optgroup>
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
        {truncatedNotice && (
          <span className="text-xs text-warning">{truncatedNotice}</span>
        )}
        {/* M4：手动抽取任务草稿（✨ 按钮） */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleExtract}
          disabled={!activeId || extracting || streaming}
          className="ml-auto h-8 gap-1 text-xs"
          title="从对话中识别任务草稿"
        >
          {extracting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              抽取中…
            </>
          ) : (
            <>
              <Sparkles size={14} />
              抽取任务
            </>
          )}
        </Button>
        {streaming && (
          <span className="animate-pulse text-xs text-muted-foreground">
            {firstTokenMs === null ? '思考中…' : '回复中…'}
          </span>
        )}
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 && (
            <div className="mt-12 space-y-3 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary/60">
                <MessageSquare size={28} />
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

      {/* M4：任务草稿区（有草稿才显示，在消息区和输入区之间） */}
      {drafts.length > 0 && (
        <div className="border-t bg-warning/5 px-4 py-3">
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="text-xs font-medium text-warning">
              AI 识别到 {drafts.length} 条任务草稿，确认后加入任务
            </div>
            <div className="space-y-2">
              {drafts.map((d, i) => (
                <DraftCard
                  key={i}
                  draft={d}
                  index={i}
                  onUpdate={(patch) => activeId && updateDraft(activeId, i, patch)}
                  onAccept={() => handleAcceptDraft(i)}
                  onDismiss={() => handleDismissDraft(i)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="border-t bg-card p-4">
        {/* v1.17 对话发图：待发送图片预览区 */}
        {pendingImages.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="group relative">
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="h-16 w-16 rounded-md border object-cover"
                />
                <button
                  onClick={() => removePendingImage(i)}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground shadow"
                  title="移除"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          {/* v1.17 对话发图：上传图片按钮 */}
          <input
            ref={chatImgInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handlePickChatImage}
            className="hidden"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => chatImgInputRef.current?.click()}
            disabled={streaming}
            title="上传图片（也可直接粘贴）"
            className="h-[44px] w-[44px] shrink-0"
          >
            <ImageSquare size={16} />
          </Button>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            placeholder={
              !initialized
                ? '正在加载模型配置…'
                : providerId
                  ? '输入消息，Enter 发送，Shift+Enter 换行（可粘贴/上传图片）'
                  : '请先在设置页配置模型'
            }
            // v1.16.1：只在发送中禁用，不再因 providerId 未加载完误伤输入。
            // 没 provider 时仍允许打字（发送时兜底提示），避免启动期输入框点不动。
            disabled={streaming}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            className="min-h-[44px] max-h-[160px] resize-none"
            rows={1}
          />
          <Button
            onClick={handleSend}
            // v1.17：有图片也能发（不强制必须有文字）
            disabled={(!input.trim() && pendingImages.length === 0) || !providerId || streaming}
          >
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
    </div>
  )
}

// v1.2 签名元素（PRD §12.2.4）：无圆角消息块 + 左侧 2px role 色条。
// 抛弃默认圆角气泡，每条消息是左对齐矩形块，色条编码角色：
//   user=accent 蓝 / assistant=muted-foreground 灰 / tool=success 绿
// 视觉上像精装卷宗的条目，区别于所有圆角气泡的 AI 应用。
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const role = msg.role // user / assistant / tool / system
  const hasContent = msg.content.trim().length > 0
  const hasTools = (msg.toolCalls?.length ?? 0) > 0

  // role → 色条颜色 + 头像 + 标签
  const isUser = role === 'user'
  const isTool = role === 'tool'
  const barColor = isUser ? 'border-accent' : isTool ? 'border-success' : 'border-muted-foreground/50'
  const label = isUser ? '我' : isTool ? '工具' : 'AI'

  return (
    <div className={`flex gap-3 animate-fade-up ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* 头像（v1.3：用户用 accent 渐变 + 阴影，AI 用 surface-3 + border）*/}
      <div
        className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full shadow-sm ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'border border-border bg-surface-3 text-muted-foreground'
        }`}
      >
        {isUser ? <User size={16} weight="fill" /> : isTool ? <Wrench size={15} weight="fill" /> : <Bot size={16} weight="fill" />}
      </div>

      {/* 签名消息块 v2（v1.3 Soft UI）：无圆角 + 左侧 2px role 色条 + shadow 浮起 */}
      <div className={`flex max-w-[80%] flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
        {/* 工具调用 chips（v1.3：加 Wrench 图标 + 精致样式）*/}
        {hasTools && (
          <div className="flex flex-wrap gap-1">
            {msg.toolCalls!.map((tc, i) => (
              <div
                key={i}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-3 px-2 py-0.5 text-[11px] text-muted-foreground shadow-xs"
              >
                <Wrench size={11} weight="fill" className="text-accent" />
                <span className="font-medium text-foreground/80">{tc.name}</span>
                {tc.args && tc.args !== '{}' && (
                  <span className="max-w-[320px] truncate font-mono text-[10px] opacity-70" title={tc.args}>
                    {tc.args}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 消息块主体（v1.3：bg-surface-2 + shadow-sm 浮起 + hover 加深）*/}
        {(hasContent || msg.streaming) && (
          <div
            className={`min-w-0 rounded-r-md border-l-2 bg-surface-2 px-3.5 py-2.5 shadow-sm transition-shadow duration-200 hover:shadow-md ${barColor}`}
          >
            {/* 角色标签行（极小，灰）*/}
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </div>
            {hasContent ? (
              <Markdown content={msg.content} />
            ) : (
              // 流式中空内容：三圆点 typing 指示器（skill 推荐，替代省略号）
              <span className="typing-dots">
                <span />
                <span />
                <span />
              </span>
            )}
            {/* 有内容时的流式光标：三圆点（紧贴文末）*/}
            {msg.streaming && hasContent && (
              <span className="ml-1 inline-flex items-center align-middle">
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
            )}
          </div>
        )}

        {/* v1.17 对话发图：user 消息的图片附件展示（消息块下方，点击放大可选，MVP 先小图） */}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
            {msg.attachments.map((att, i) => (
              <img
                key={i}
                src={att.dataUrl}
                alt={att.name}
                className="h-24 rounded-md border border-border object-cover shadow-sm"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

