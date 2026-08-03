import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import type { Conversation } from '@/types'

/**
 * 会话列表侧栏（M2-Step5）。
 * 列出全部会话，支持：新建 / 切换 / 重命名（双击）/ 删除。
 * 与 ChatPage 同级，布局在对话区左侧（宽 220px）。
 */

/** Unix 秒 → 相对时间显示（"刚刚"/"3分钟前"/"2小时前"/"昨天"/"MM-DD"）。 */
function relativeTime(unixSec: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - unixSec
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  if (diff < 172800) return '昨天'
  // 同年省年份
  const d = new Date(unixSec * 1000)
  const thisYear = new Date().getFullYear()
  return d.getFullYear() === thisYear
    ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
    : `${d.getFullYear()}-${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}

export function ConversationList() {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  // 订阅 metaByConv 整体，渲染时按 conv.id 取 streaming（让列表显示哪个会话在回复中）
  const metaByConv = useChatStore((s) => s.metaByConv)
  const createConversation = useChatStore((s) => s.createConversation)
  const switchConversation = useChatStore((s) => s.switchConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) editRef.current?.focus()
  }, [editingId])

  const handleNew = async () => {
    await createConversation()
  }

  const startRename = (conv: Conversation) => {
    setEditingId(conv.id)
    setEditTitle(conv.title)
  }

  const commitRename = async () => {
    if (!editingId) return
    const title = editTitle.trim()
    if (title) {
      try {
        await renameConversation(editingId, title)
      } catch (e) {
        console.error('[chat] 重命名失败', e)
      }
    }
    setEditingId(null)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('删除该会话？其所有消息将一并删除，不可恢复。')) return
    try {
      await deleteConversation(id)
    } catch (e) {
      console.error('[chat] 删除会话失败', e)
    }
  }

  return (
    <div className="flex h-full w-[220px] flex-col border-r bg-card">
      {/* 顶部：新建 */}
      <div className="border-b p-2">
        <Button onClick={handleNew} variant="outline" className="w-full justify-start gap-1.5">
          <span className="text-base leading-none">+</span> 新会话
        </Button>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {conversations.length === 0 && (
          <div className="mt-4 px-2 text-center text-xs text-muted-foreground">
            暂无会话
          </div>
        )}
        <div className="space-y-0.5">
          {conversations.map((conv) => {
            const isActive = conv.id === activeId
            const isEditing = conv.id === editingId
            return (
              <div
                key={conv.id}
                onClick={() => !isEditing && switchConversation(conv.id)}
                onDoubleClick={() => startRename(conv)}
                className={`group relative cursor-pointer rounded-md px-2.5 py-2 transition-colors ${
                  isActive ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                {isEditing ? (
                  <input
                    ref={editRef}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full rounded border bg-background px-1 py-0.5 text-sm outline-none focus:border-primary"
                  />
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      {/* 流式中指示器：该会话后台还在回复时显示 */}
                      {metaByConv[conv.id]?.streaming && (
                        <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-blue-500" />
                      )}
                      <div className="truncate text-sm font-medium text-foreground">
                        {conv.title}
                      </div>
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {metaByConv[conv.id]?.streaming ? '回复中…' : relativeTime(conv.updatedAt)}
                    </div>
                    {/* 删除按钮：hover 才出现，避免误触 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(conv.id)
                      }}
                      title="删除会话"
                      className="absolute right-1.5 top-1.5 hidden h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
