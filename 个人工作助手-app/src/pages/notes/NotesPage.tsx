import { useEffect, useState } from 'react'
import { Plus, Search, Eye, Pencil, Trash2, FileText } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/Markdown'
import { EmptyState } from '@/components/ui/EmptyState'
import { useNotesStore } from '@/stores/notes'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import type { Note, NoteSearchHit } from '@/types'

/**
 * 笔记页（M12.8 B 轨，PRD §12.4）。
 * 左列笔记列表（含搜索）+ 中间编辑器（编辑/预览切换）。
 * 双轨数据一致（PRD §13.1）：AI 在对话里 create_note 写入同一笔记库，
 * 用户切到本页 refresh 即可看到；反之用户编辑的笔记 AI 也能搜到。
 */
export function NotesPage() {
  const { notes, refresh, create, update, remove } = useNotesStore()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null)
  const [editing, setEditing] = useState(false)
  // 当前编辑缓冲（标题/正文/标签），保存时落库
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')

  useEffect(() => {
    refresh()
  }, [refresh])

  const active = notes.find((n) => n.id === activeId) ?? null

  // 选中笔记时，把它的内容载入编辑缓冲
  useEffect(() => {
    if (active) {
      setDraftTitle(active.title)
      setDraftContent(active.content)
      setEditing(false)
    }
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNew = async () => {
    try {
      const note = await create({ title: '无标题笔记', content: '' })
      setActiveId(note.id)
      setEditing(true)
    } catch (e) {
      console.error('[notes] 新建失败', e)
    }
  }

  const handleSave = async () => {
    if (!active) return
    try {
      await update({
        id: active.id,
        title: draftTitle.trim() || '无标题笔记',
        content: draftContent,
        tags: active.tags,
      })
      setEditing(false)
    } catch (e) {
      console.error('[notes] 保存失败', e)
    }
  }

  const handleDelete = async () => {
    if (!active) return
    if (!confirm(`删除笔记「${active.title}」？不可恢复。`)) return
    try {
      await remove(active.id)
      setActiveId(null)
    } catch (e) {
      console.error('[notes] 删除失败', e)
    }
  }

  const handleSearch = async (q: string) => {
    setQuery(q)
    if (!q.trim()) {
      setHits(null)
      return
    }
    try {
      const result = await invoke<NoteSearchHit[]>('note:search', q)
      setHits(result)
    } catch {
      setHits(null)
    }
  }

  // 列表显示：有搜索结果用搜索结果，否则用全部笔记
  const displayList = hits
    ? hits.map((h) => notes.find((n) => n.id === h.id) ?? null).filter((n): n is Note => n !== null)
    : notes

  return (
    <div className="flex h-full">
      {/* 左列：列表 */}
      <div className="flex w-[240px] flex-col border-r bg-card">
        <div className="space-y-2 border-b p-2">
          <Button onClick={handleNew} variant="outline" className="w-full justify-start gap-1.5">
            <Plus size={14} /> 新建笔记
          </Button>
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="搜索笔记"
              className="h-8 pl-7 text-sm"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {displayList.length === 0 ? (
            <div className="mt-4 px-2 text-center text-xs text-muted-foreground">
              {query ? '未找到匹配笔记' : '暂无笔记。也可在对话里说「把这段存成笔记」让 AI 创建。'}
            </div>
          ) : (
            <div className="stagger-fade-up space-y-0.5">
              {displayList.map((n) => (
                <button
                  key={n.id}
                  onClick={() => setActiveId(n.id)}
                  className={cn(
                    'block w-full rounded-md px-2.5 py-2 text-left transition-colors',
                    n.id === activeId
                      ? 'bg-accent/10 text-accent'
                      : 'hover:bg-surface-3',
                  )}
                >
                  <div className="truncate text-sm font-medium text-foreground">{n.title}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {relativeTime(n.updatedAt)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 中间：编辑器 */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {active ? (
          <>
            {/* 顶栏：标题 + 模式切换 + 操作 */}
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <Input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                disabled={!editing}
                className="h-8 flex-1 border-transparent bg-transparent px-1 text-base font-medium focus-visible:border-input focus-visible:bg-background"
              />
              <Button
                size="sm"
                variant={editing ? 'default' : 'outline'}
                onClick={() => (editing ? handleSave() : setEditing(true))}
                className="h-8 gap-1.5"
              >
                {editing ? (
                  <>
                    <Pencil size={13} /> 保存
                  </>
                ) : (
                  <>
                    <Pencil size={13} /> 编辑
                  </>
                )}
              </Button>
              {!editing && (
                <Button size="sm" variant="outline" disabled className="h-8 gap-1.5 opacity-60">
                  <Eye size={13} /> 预览
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={handleDelete} className="h-8 text-destructive">
                <Trash2 size={14} />
              </Button>
            </div>

            {/* 正文 */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {editing ? (
                <Textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  placeholder="输入 Markdown 正文…（Shift+Enter 换行）"
                  className="min-h-full resize-none border-transparent bg-transparent font-mono text-sm focus-visible:ring-0"
                />
              ) : (
                <div className="mx-auto max-w-3xl">
                  {active.content.trim() ? (
                    <Markdown content={active.content} />
                  ) : (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      这条笔记是空的。点「编辑」开始写。
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <EmptyState
            icon={FileText}
            title="选择一条笔记"
            hint="从左侧选一条笔记开始编辑，或点「新建笔记」创建。也可在对话里说「把这段存成笔记」让 AI 帮你记"
          />
        )}
      </div>
    </div>
  )
}

/** Unix 秒 → 相对时间。 */
function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  const d = new Date(unixSec * 1000)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}
