import { useEffect, useState, useRef } from 'react'
import {
  Plus,
  Search,
  Eye,
  Pencil,
  Trash2,
  FileText,
  Sparkles,
  X,
  CheckCircle2,
  AlertCircle,
  CheckSquare,
} from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/Markdown'
import { EmptyState } from '@/components/ui/EmptyState'
import { useNotesStore } from '@/stores/notes'
import { useTasksStore } from '@/stores/tasks'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import type { Note, NoteSearchHit, NoteAiOp, NoteAiResult, Task } from '@/types'

/**
 * 笔记页（M12.8 B 轨 + v1.9 M18 AI 笔记助手）。
 * 左列笔记列表（含搜索）+ 中间编辑器（编辑/预览切换）+ AI 助手内联面板。
 * 双轨数据一致（PRD §13.1）：AI 在对话里 create_note 写入同一笔记库，
 * 用户切到本页 refresh 即可看到；反之用户编辑的笔记 AI 也能搜到。
 *
 * v1.9 AI 笔记助手（PRD §15.2①）：对当前笔记执行 摘要/待办/提问/续写，
 * 结果以内联面板展示（Markdown 渲染），用户点「插入」才写进笔记（不静默改）。
 */
export function NotesPage() {
  const { notes, refresh, create, update, remove } = useNotesStore()
  const { tasks, refresh: refreshTasks, createFromNote } = useTasksStore()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  // 当前编辑缓冲（标题/正文/标签），保存时落库
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')

  useEffect(() => {
    refresh()
    refreshTasks() // v1.9.1：拉任务列表用于判断笔记待办「已转」状态
  }, [refresh, refreshTasks])

  const active = notes.find((n) => n.id === activeId) ?? null

  // 选中笔记时，把它的内容载入编辑缓冲
  useEffect(() => {
    if (active) {
      setDraftTitle(active.title)
      setDraftContent(active.content)
      setEditing(false)
      setAiPanelOpen(false) // 切笔记时收起 AI 面板
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

  // AI 面板「插入到笔记末尾」回调：把结果追加到 draftContent 并落库
  const handleInsertAi = async (opLabel: string, result: string) => {
    if (!active) return
    const newContent = `${draftContent}\n\n## AI 生成（${opLabel}）\n\n${result}\n`
    setDraftContent(newContent)
    try {
      await update({
        id: active.id,
        title: draftTitle.trim() || '无标题笔记',
        content: newContent,
        tags: active.tags,
      })
      setAiPanelOpen(false) // 插入后收起面板
    } catch (e) {
      console.error('[notes] AI 插入失败', e)
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
              {/* AI 助手触发器（v1.9 M18）：切换内联面板 */}
              <Button
                size="sm"
                variant={aiPanelOpen ? 'default' : 'outline'}
                onClick={() => setAiPanelOpen((v) => !v)}
                className="h-8 gap-1.5"
              >
                <Sparkles size={13} /> AI 助手
              </Button>
              <Button size="sm" variant="ghost" onClick={handleDelete} className="h-8 text-destructive">
                <Trash2 size={14} />
              </Button>
            </div>

            {/* AI 助手内联面板（v1.9 M18）：正文区上方，可折叠 */}
            {aiPanelOpen && (
              <NoteAiPanel
                content={draftContent}
                onInsert={handleInsertAi}
                onClose={() => setAiPanelOpen(false)}
              />
            )}

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
                  {/* v1.9.1 笔记待办转任务面板（PRD §15.2②）：解析 - [ ] 未勾选项，提供转任务按钮 */}
                  <NoteTodosPanel
                    content={active.content}
                    noteId={active.id}
                    noteFileName={active.fileName}
                    tasks={tasks}
                    onConvert={createFromNote}
                  />
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

// ---------- AI 助手内联面板（v1.9 M18） ----------
const AI_OPS: { value: NoteAiOp; label: string }[] = [
  { value: 'summary', label: '摘要' },
  { value: 'todos', label: '提炼待办' },
  { value: 'questions', label: '提问' },
  { value: 'continue', label: '续写' },
]

type AiStatus =
  | { kind: 'idle' }
  | { kind: 'working'; reqId: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

function NoteAiPanel({
  content,
  onInsert,
  onClose,
}: {
  content: string
  onInsert: (opLabel: string, result: string) => void
  onClose: () => void
}) {
  const [op, setOp] = useState<NoteAiOp>('summary')
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState('')
  const [status, setStatus] = useState<AiStatus>({ kind: 'idle' })
  const reqIdRef = useRef(0)

  const run = async () => {
    if (!content.trim()) {
      setStatus({ kind: 'error', message: '笔记内容为空' })
      return
    }
    const reqId = `note-ai-${Date.now()}-${++reqIdRef.current}`
    setStatus({ kind: 'working', reqId })
    setResult('')
    try {
      const r = await invoke<NoteAiResult>('note:ai', {
        op,
        content,
        question: op === 'questions' ? question : undefined,
        reqId,
      })
      setResult(r.result)
      setStatus({ kind: 'done' })
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) })
    }
  }

  const cancel = async () => {
    if (status.kind !== 'working') return
    try {
      await invoke<true>('note:ai_cancel', status.reqId)
    } catch {
      // 忽略
    }
    setStatus({ kind: 'idle' })
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result)
    } catch {
      // 忽略
    }
  }

  const opLabel = AI_OPS.find((o) => o.value === op)?.label ?? op

  return (
    <div className="border-b bg-surface-2">
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-3">
        {/* 头部：操作切换 + 关闭 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 rounded-lg bg-surface-3 p-1">
            {AI_OPS.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  setOp(o.value)
                  setStatus({ kind: 'idle' })
                  setResult('')
                }}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  op === o.value
                    ? 'bg-accent/10 text-accent shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* questions 模式：额外输入框 */}
        {op === 'questions' && (
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="可选：输入你想问的具体问题（留空则 AI 自行提问）"
            className="h-8 text-xs"
          />
        )}

        {/* 操作按钮 */}
        <div className="flex gap-2">
          {status.kind === 'working' ? (
            <Button variant="outline" size="sm" onClick={cancel} className="flex-1">
              取消
            </Button>
          ) : (
            <Button size="sm" onClick={run} disabled={!content.trim()} className="flex-1">
              <Sparkles size={13} /> {opLabel}
            </Button>
          )}
        </div>

        {/* 结果区 */}
        {result && (
          <div className="space-y-2 rounded-md border bg-background p-3">
            <div className="msg-markdown max-h-60 overflow-y-auto text-sm">
              <Markdown content={result} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="default" onClick={() => onInsert(opLabel, result)}>
                插入到笔记末尾
              </Button>
              <Button size="sm" variant="outline" onClick={copy}>
                复制
              </Button>
            </div>
          </div>
        )}

        {/* 状态反馈 */}
        {status.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle size={13} className="mt-0.5" />
            <span className="break-all">{status.message}</span>
          </div>
        )}
        {status.kind === 'done' && !result && (
          <div className="flex items-start gap-2 rounded-md bg-success/10 p-2 text-xs text-success">
            <CheckCircle2 size={13} className="mt-0.5" />
            <span>操作完成，但模型未返回内容</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- 笔记待办转任务（v1.9.1 M19，PRD §15.2②） ----------
// GFM 任务列表行正则：前导空格 + 标记(-/*) + [ ]/[x] + 文本
// 仅解析未勾选项（- [ ]）展示转任务按钮，已勾选（- [x]）不显示（已完成无需转）。
const TASK_LINE_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/

interface ParsedTaskLine {
  text: string // 任务文本（去尾部空白）
  checked: boolean
}

/** 解析笔记内容里的 GFM 任务列表项。返回顺序与原文一致。 */
function parseTaskLines(content: string): ParsedTaskLine[] {
  const result: ParsedTaskLine[] = []
  for (const line of content.split('\n')) {
    const m = TASK_LINE_RE.exec(line)
    if (m) {
      result.push({
        text: m[4].trim(),
        checked: m[3].toLowerCase() === 'x',
      })
    }
  }
  return result
}

function NoteTodosPanel({
  content,
  noteId,
  noteFileName,
  tasks,
  onConvert,
}: {
  content: string
  noteId: string
  noteFileName: string
  tasks: Task[]
  onConvert: (input: { title: string; noteId: string }) => Promise<Task>
}) {
  const [converting, setConverting] = useState<string | null>(null) // 正在转的 title
  const [error, setError] = useState<string | null>(null)
  const todoLines = parseTaskLines(content).filter((l) => !l.checked && l.text)

  // 判断某 title 是否已转（source=from_note + sourceNotePath 匹配 + title 精确匹配）
  const isConverted = (title: string) =>
    tasks.some(
      (t) => t.source === 'from_note' && t.sourceNotePath === noteFileName && t.title === title,
    )

  if (todoLines.length === 0) return null // 无未勾选待办，不显示面板

  const handleConvert = async (title: string) => {
    setConverting(title)
    setError(null)
    try {
      await onConvert({ title, noteId })
    } catch (e) {
      setError(String(e))
    } finally {
      setConverting(null)
    }
  }

  return (
    <div className="mb-4 rounded-md border bg-surface-2 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CheckSquare size={13} />
        <span>笔记待办（{todoLines.length}）</span>
        <span className="text-[10px] text-muted-foreground/70">点「转任务」加入任务列表</span>
      </div>
      <ul className="space-y-1">
        {todoLines.map((line, i) => {
          const converted = isConverted(line.text)
          return (
            <li key={i} className="flex items-center gap-2 rounded-md bg-background px-2.5 py-1.5">
              <span className="flex-1 truncate text-xs">{line.text}</span>
              {converted ? (
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <CheckCircle2 size={11} /> 已转
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleConvert(line.text)}
                  disabled={converting === line.text}
                  className="h-6 gap-1 px-2 text-[10px]"
                >
                  {converting === line.text ? (
                    <AlertCircle size={11} className="animate-pulse" />
                  ) : (
                    <Sparkles size={11} />
                  )}
                  转任务
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {error && (
        <p className="mt-2 text-[10px] text-destructive">转任务失败：{error}</p>
      )}
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
