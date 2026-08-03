import { create } from 'zustand'
import type { ChatMessage, Conversation, ConversationMessage } from '@/types'
import { invoke } from '@/lib/ipc'

/**
 * 对话 store（M2）。
 *
 * 数据模型（为多会话设计的 Record 结构）：
 *  - conversations: 会话列表（侧栏用，按 pinned + updatedAt 倒序，由主进程排好）
 *  - messagesByConv: { [conversationId]: ChatMessage[] } 每会话的消息（内存，已 hydrate 过的才在）
 *  - metaByConv: { [conversationId]: ConvMeta } 每会话的流式状态（streaming/首字延迟/错误）
 *  - activeId: 当前展示的会话 id
 *
 * Step6 关键：streaming 改成 per-conversation，让会话 A 流式中时切到 B，
 * B 的输入框仍可用（不被 A 的流式锁住）。
 */

/** 单个会话的流式元状态（per-conversation，替代原 ChatPage 全局 streaming state）。 */
export interface ConvMeta {
  streaming: boolean
  firstTokenMs: number | null
  error: string | null
  truncatedNotice: string | null // M2-Step7：上下文截断提示（如「已省略较早的 3 条」），下次发消息清
}

/** 默认 meta（空闲态）。模块级常量，避免每次新建。 */
const IDLE_META: ConvMeta = { streaming: false, firstTokenMs: null, error: null, truncatedNotice: null }

interface ChatState {
  conversations: Conversation[]
  messagesByConv: Record<string, ChatMessage[]>
  metaByConv: Record<string, ConvMeta>
  activeId: string | null

  // ---- 会话级 ----
  /** 拉会话列表。无会话则创建首个。返回 active 会话（供调用方 hydrate 消息）。 */
  loadConversations: () => Promise<Conversation | null>
  /** 新建会话并切过去。 */
  createConversation: () => Promise<Conversation | null>
  /** 切换 active 会话，并按需 hydrate 它的消息（未 hydrate 过才拉）。 */
  switchConversation: (id: string) => Promise<void>
  /** 重命名。 */
  renameConversation: (id: string, title: string) => Promise<void>
  /** 删除会话（含消息）。删 active 时自动切到剩余的第一个（或 null）。 */
  deleteConversation: (id: string) => Promise<void>

  // ---- 消息级（ChatPage 流式过程用，纯内存操作，不调 IPC） ----
  /** 设置某会话的全部消息（hydrate 用）。 */
  setMessages: (conversationId: string, msgs: ChatMessage[]) => void
  /** 取某会话当前消息（快捷读）。 */
  getMessages: (conversationId: string) => ChatMessage[]
  /** 追加一条消息到某会话末尾。 */
  appendMessage: (conversationId: string, msg: ChatMessage) => void
  /** 按 id 更新某会话里的某条消息（流式 token 拼接 / streaming 标志用）。 */
  updateMessage: (conversationId: string, msgId: string, patch: Partial<ChatMessage>) => void
  /** 按 id 删除某会话里的某条消息（error 分支删 aiMsg 用）。 */
  removeMessage: (conversationId: string, msgId: string) => void

  // ---- 流式元状态（per-conversation，Step6） ----
  /** 取某会话的 meta（无记录返回空闲默认）。 */
  getMeta: (conversationId: string) => ConvMeta
  /** 更新某会话的 meta（patch 合并）。 */
  setMeta: (conversationId: string, patch: Partial<ConvMeta>) => void
}

/** ConversationMessage（DB） → ChatMessage（内存）。与 ChatPage 原转换函数一致。 */
function dbMsgToChatMessage(m: ConversationMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ?? undefined,
  }
}

/** 拉某会话的历史消息并 hydrate 进 store。 */
async function hydrateMessages(conversationId: string): Promise<ChatMessage[]> {
  const msgs = await invoke<ConversationMessage[]>('message:list', conversationId)
  return msgs.map(dbMsgToChatMessage)
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  messagesByConv: {},
  metaByConv: {},
  activeId: null,

  loadConversations: async () => {
    const list = await invoke<Conversation[]>('conversation:list')
    let active: Conversation | null = list[0] ?? null
    if (!active) {
      active = await invoke<Conversation>('conversation:create', {})
      set({ conversations: [active], activeId: active.id })
    } else {
      set({ conversations: list, activeId: active.id })
    }
    // hydrate active 会话的消息
    const msgs = await hydrateMessages(active.id)
    set((s) => ({
      messagesByConv: { ...s.messagesByConv, [active!.id]: msgs },
    }))
    return active
  },

  createConversation: async () => {
    const conv = await invoke<Conversation>('conversation:create', {})
    set((s) => ({
      conversations: [conv, ...s.conversations],
      messagesByConv: { ...s.messagesByConv, [conv.id]: [] },
      metaByConv: { ...s.metaByConv, [conv.id]: { ...IDLE_META } },
      activeId: conv.id,
    }))
    return conv
  },

  switchConversation: async (id) => {
    set({ activeId: id })
    // 未 hydrate 过才拉（避免重复 IPC）
    if (!get().messagesByConv[id]) {
      const msgs = await hydrateMessages(id)
      set((s) => ({ messagesByConv: { ...s.messagesByConv, [id]: msgs } }))
    }
  },

  renameConversation: async (id, title) => {
    const updated = await invoke<Conversation>('conversation:rename', id, title)
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
    }))
  },

  deleteConversation: async (id) => {
    await invoke<true>('conversation:delete', id)
    set((s) => {
      const remaining = s.conversations.filter((c) => c.id !== id)
      const { [id]: _m, ...restMsgs } = s.messagesByConv
      const { [id]: _meta, ...restMeta } = s.metaByConv
      const newActive = s.activeId === id ? (remaining[0]?.id ?? null) : s.activeId
      return { conversations: remaining, messagesByConv: restMsgs, metaByConv: restMeta, activeId: newActive }
    })
    // 删的是 active 且有剩余 → hydrate 新 active（若未 hydrate）
    const st = get()
    if (st.activeId && !st.messagesByConv[st.activeId]) {
      const msgs = await hydrateMessages(st.activeId)
      set((s) => ({ messagesByConv: { ...s.messagesByConv, [st.activeId!]: msgs } }))
    }
  },

  setMessages: (conversationId, msgs) =>
    set((s) => ({ messagesByConv: { ...s.messagesByConv, [conversationId]: msgs } })),

  getMessages: (conversationId) => get().messagesByConv[conversationId] ?? [],

  appendMessage: (conversationId, msg) =>
    set((s) => {
      const cur = s.messagesByConv[conversationId] ?? []
      return { messagesByConv: { ...s.messagesByConv, [conversationId]: [...cur, msg] } }
    }),

  updateMessage: (conversationId, msgId, patch) =>
    set((s) => {
      const cur = s.messagesByConv[conversationId] ?? []
      return {
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: cur.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
        },
      }
    }),

  removeMessage: (conversationId, msgId) =>
    set((s) => {
      const cur = s.messagesByConv[conversationId] ?? []
      return {
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: cur.filter((m) => m.id !== msgId),
        },
      }
    }),

  getMeta: (conversationId) => get().metaByConv[conversationId] ?? IDLE_META,

  setMeta: (conversationId, patch) =>
    set((s) => {
      const cur = s.metaByConv[conversationId] ?? IDLE_META
      return { metaByConv: { ...s.metaByConv, [conversationId]: { ...cur, ...patch } } }
    }),
}))
