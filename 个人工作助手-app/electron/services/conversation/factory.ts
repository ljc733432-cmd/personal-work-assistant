import { eq, asc, desc } from 'drizzle-orm'
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
