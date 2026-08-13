import { eq, asc, desc, and, gte, lte, like, not, inArray } from 'drizzle-orm'
import { getDb } from '../db'
import { conversations, messages } from '../db/schema'
import type { Conversation, ConversationMessage } from '../../types'

/**
 * Conversation / Message 只读查询（M2）。
 *
 * 分工（与 Task 一致）：只读放这里，写操作在 ipc。
 * 写时机：chat:send 的 handler 在 done 前把本轮 user/assistant/tool 消息落库。
 */

/** 列出全部会话（侧栏用）。按置顶 + 更新时间倒序（最近活动的在前）。 */
export function listConversations(): Conversation[] {
  return getDb()
    .select()
    .from(conversations)
    .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
    .all()
    .map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      scenarioId: r.scenarioId,
      defaultProviderId: r.defaultProviderId,
      pinned: r.pinned,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
}

/** 按 id 取单个会话。不存在返回 null。 */
export function getConversation(id: string): Conversation | null {
  const r = getDb().select().from(conversations).where(eq(conversations.id, id)).get()
  if (!r) return null
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    scenarioId: r.scenarioId,
    defaultProviderId: r.defaultProviderId,
    pinned: r.pinned,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** 列出某会话的全部消息（按时间正序，渲染层直接渲染）。 */
export function listMessages(conversationId: string): ConversationMessage[] {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id)) // createdAt 同秒时用 id 兜底保序
    .all()
    .map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      role: r.role,
      content: r.content,
      providerId: r.providerId,
      // schema 用 text+json 模式，Drizzle 已 parse；DB 旧数据可能为 null
      toolCalls: (r.toolCalls ?? null) as ConversationMessage['toolCalls'],
      attachments: (r.attachments ?? null) as ConversationMessage['attachments'],
      createdAt: r.createdAt,
    }))
}

/**
 * 列出指定时间范围内的全部消息（跨所有会话，v1.8 日报用）。
 * 闭区间 [fromSec, toSec]。按时间正序（与 listMessages 同序，createdAt 同秒用 id 兜底）。
 *
 * 注意：messages 表只有 idx_messages_conversation_id（按会话建），按时间范围扫全表。
 * 数据量大时（万条+）可考虑加 idx_messages_created_at，当前规模够用。
 */
export function listMessagesInRange(fromSec: number, toSec: number): ConversationMessage[] {
  return getDb()
    .select()
    .from(messages)
    .where(and(gte(messages.createdAt, fromSec), lte(messages.createdAt, toSec)))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all()
    .map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      role: r.role,
      content: r.content,
      providerId: r.providerId,
      toolCalls: (r.toolCalls ?? null) as ConversationMessage['toolCalls'],
      attachments: (r.attachments ?? null) as ConversationMessage['attachments'],
      createdAt: r.createdAt,
    }))
}

// ---------- v1.22 对话搜索 ----------

/** 搜索命中项（跨会话搜消息内容，点击跳转到对应会话）。 */
export interface MessageSearchHit {
  messageId: string
  conversationId: string
  conversationTitle: string
  role: string
  snippet: string // 匹配处前后片段
  createdAt: number
}

/** 截取匹配处前后片段（照搬 noteStore makeSnippet 思路）。 */
function makeSnippet(content: string, query: string, radius = 40): string {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx < 0) return content.slice(0, radius * 2)
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + query.length + radius)
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
}

/**
 * 跨会话搜索消息内容（v1.22）。
 * LIKE 全表扫描（无 FTS，当前规模够用）。排除 role='tool'（FC 结果噪音）和空内容。
 * limit 100 防爆，按 createdAt desc（最近在前）。
 */
export function searchMessages(query: string): MessageSearchHit[] {
  const q = query.trim()
  if (!q) return []
  const rows = getDb()
    .select()
    .from(messages)
    .where(and(like(messages.content, `%${q}%`), not(inArray(messages.role, ['system', 'tool']))))
    .orderBy(desc(messages.createdAt))
    .limit(100)
    .all()

  // 批量取 conversation title（去重查询避免 N+1）
  const convIds = [...new Set(rows.map((r) => r.conversationId))]
  const titleMap = new Map<string, string>()
  for (const cid of convIds) {
    const c = getConversation(cid)
    titleMap.set(cid, c?.title ?? '已删除会话')
  }

  return rows.map((r) => ({
    messageId: r.id,
    conversationId: r.conversationId,
    conversationTitle: titleMap.get(r.conversationId) ?? '',
    role: r.role,
    snippet: makeSnippet(r.content, q),
    createdAt: r.createdAt,
  }))
}
