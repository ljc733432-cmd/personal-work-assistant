import { useEffect, useState, useRef, useMemo, type ClipboardEvent } from 'react'
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
  CaretDown,
  CaretRight,
  TextAlignLeft,
  ImageSquare,
} from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MindmapView } from '@/components/ui/MindmapView'
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
  const { tasks, refresh: refreshTasks, createFromNote, createSubtask } = useTasksStore()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  // 当前编辑缓冲（标题/正文/标签），保存时落库
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  // v1.17 笔记贴图：textarea ref（光标处插入图片引用）+ 隐藏 file input
  const taRef = useRef<HTMLTextAreaElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  // v1.17 笔记贴图：笔记库目录（预览态解析图片相对路径用），挂载时拉一次
  const [notesDir, setNotesDir] = useState('')

  useEffect(() => {
    refresh()
    refreshTasks() // v1.9.1：拉任务列表用于判断笔记待办「已转」状态
    // v1.17：拉笔记库目录，预览态解析图片相对路径
    invoke<string>('note:getDir').then(setNotesDir).catch(() => {})
  }, [refresh, refreshTasks])

  const active = notes.find((n) => n.id === activeId) ?? null

  // v1.15 笔记大纲（§15.2③）：解析当前笔记标题层级。
  // 编辑态读 draftContent（用户最新输入），预览态读 active.content（落库版本）——
  // 与 NoteAiPanel（读 draft）/ NoteTodosPanel（读 active）的「两态读不同内容」现状一致。
  const outlineContent = editing ? draftContent : active?.content ?? ''
  const headings = useMemo(() => parseHeadings(outlineContent), [outlineContent])

  // 预览态点击大纲跳转到对应标题（Markdown 组件给 heading 加了 slugified id）。
  // 编辑态不跳转（textarea 无法滚动到行，体验差，按 §15.2 方案 A 决策）。
  const handleJumpHeading = (slug: string) => {
    if (editing) return
    const el = document.getElementById(slug)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

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

  // v1.17 笔记贴图：把图片 dataUrl 存到笔记库 images/，在 textarea 光标处插入 ![](relPath)。
  // 粘贴和上传都走这条。需在编辑态（有 active 笔记）才能贴图。
  const insertImageAtCursor = async (dataUrl: string) => {
    if (!active) return
    try {
      const r = await invoke<{ relPath: string }>('note:save_image', {
        noteId: active.id,
        dataUrl,
      })
      const md = `![](${r.relPath})`
      const ta = taRef.current
      if (ta) {
        // 光标处插入（setRangeText 同步更新 value + 光标位置）
        const start = ta.selectionStart
        const end = ta.selectionEnd
        ta.setRangeText(md, start, end, 'end')
        setDraftContent(ta.value)
        ta.focus()
      } else {
        // 兜底：无 ref 时追加到末尾
        setDraftContent((c) => `${c}\n${md}\n`)
      }
    } catch (e) {
      console.error('[notes] 插入图片失败', e)
      alert('插入图片失败：' + String(e))
    }
  }

  // 粘贴图片：拦截 clipboardData 里的图片项，转 dataUrl 后插入
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    let imgItem: DataTransferItem | null = null
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        imgItem = it
        break
      }
    }
    if (!imgItem) return // 没图片，走默认粘贴（文本）
    e.preventDefault()
    const file = imgItem.getAsFile()
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') insertImageAtCursor(reader.result)
    }
    reader.readAsDataURL(file)
  }

  // 上传图片：隐藏 input change → 同流程
  const handlePickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') insertImageAtCursor(reader.result)
    }
    reader.readAsDataURL(file)
    e.target.value = '' // 清空，允许重复选同一文件
  }

  // AI 面板「插入到笔记末尾」回调。
  // v1.10.3 去重：
  //  - todos（提炼待办）：剥标题，只取 - [ ] 行，按标题去重（笔记里已有的不加），
  //    直接追加到笔记末尾（不包「## AI 生成」标题，避免污染待办区）。
  //  - 其他操作：原样包标题块追加。
  const handleInsertAi = async (opLabel: string, result: string, op?: string) => {
    if (!active) return
    let appendBlock: string
    if (op === 'todos') {
      // 提取结果里的任务行（含缩进子任务），按标题去重
      const newTaskLines = result
        .split('\n')
        .filter((l) => TASK_LINE_RE.test(l))
        .map((l) => l.trimEnd())
      const existingTitles = new Set(
        parseTaskLines(draftContent).map((t) => normalizeTitle(t.text)),
      )
      const deduped = newTaskLines.filter((line) => {
        const m = TASK_LINE_RE.exec(line)
        if (!m) return true // 容错：非任务行保留（理论上不会进这）
        return !existingTitles.has(normalizeTitle(m[4].trim()))
      })
      if (deduped.length === 0) {
        setAiPanelOpen(false)
        return // 全部已存在，不追加
      }
      appendBlock = `\n${deduped.join('\n')}\n`
    } else {
      appendBlock = `\n\n## AI 生成（${opLabel}）\n\n${result}\n`
    }
    const newContent = `${draftContent}${appendBlock}`
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
            <div className="flex flex-1 flex-col overflow-hidden px-6 py-4">
              {editing ? (
                <>
                  {/* v1.17 笔记贴图：编辑工具条（始终可见，不藏折叠区——v1.10.6 红线） */}
                  <div className="mb-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => imgInputRef.current?.click()}
                      className="h-7 gap-1.5 text-xs"
                    >
                      <ImageSquare size={13} /> 插入图片
                    </Button>
                    <span className="text-[10px] text-muted-foreground">
                      也可直接 Ctrl+V 粘贴图片（自动存入笔记库 images/）
                    </span>
                    <input
                      ref={imgInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handlePickImage}
                      className="hidden"
                    />
                  </div>
                  <Textarea
                    ref={taRef}
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    onPaste={handlePaste}
                    placeholder="输入 Markdown 正文…（Shift+Enter 换行，可粘贴图片）"
                    className="min-h-0 flex-1 resize-none border-transparent bg-transparent font-mono text-sm focus-visible:ring-0"
                  />
                </>
              ) : (
                <div className="mx-auto flex-1 overflow-y-auto max-w-5xl px-2">
                  {/* v1.9.1 笔记待办转任务面板（PRD §15.2②）：解析 - [ ] 未勾选项，提供转任务按钮 */}
                  <NoteTodosPanel
                    content={active.content}
                    noteId={active.id}
                    noteFileName={active.fileName}
                    tasks={tasks}
                    onConvert={createFromNote}
                    onConvertSub={createSubtask}
                  />
                  {/* v1.12：思维导图笔记（tag 含「思维导图」）额外渲染 markmap 预览。
                      限宽 max-w-3xl 居中，避免太宽难看；正文区用更宽的 max-w-4xl。 */}
                  {active.tags.includes('思维导图') && active.content.trim() && (
                    <div className="mx-auto mb-4 max-w-3xl">
                      <MindmapView key={active.content} markdown={active.content} />
                    </div>
                  )}
                  {active.content.trim() ? (
                    <div className="mx-auto max-w-4xl">
                      <Markdown content={active.content} imgBaseUrl={notesDir} />
                    </div>
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

      {/* 右列：大纲（v1.15 §15.2③）。预览态点击跳转，编辑态只读展示。
          选中笔记即显示（无标题时侧栏仍在，内部提示「无标题」），便于排查渲染问题。 */}
      {active && (
        <OutlinePanel headings={headings} editing={editing} onJump={handleJumpHeading} />
      )}
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
  onInsert: (opLabel: string, result: string, op?: string) => void
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
      // v1.10.4：todos 操作时，剔除笔记里已有的任务行（含缩进子任务），
      // 只发纯正文给 AI。避免反复提炼老待办（即使已转任务/已勾选也不再重复提炼）。
      const sendContent =
        op === 'todos'
          ? content
              .split('\n')
              .filter((line) => !TASK_LINE_RE.test(line))
              .join('\n')
          : content
      if (op === 'todos' && !sendContent.trim()) {
        setStatus({ kind: 'error', message: '笔记里除待办外没有其他正文可提炼' })
        return
      }
      const r = await invoke<NoteAiResult>('note:ai', {
        op,
        content: sendContent,
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
              <Button size="sm" variant="default" onClick={() => onInsert(opLabel, result, op)}>
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

// ---------- 笔记待办转任务（v1.9.1 M19 + v1.10.2 子任务层级对齐） ----------
// GFM 任务列表行正则：前导空格 + 标记(-/*) + [ ]/[x] + 文本
// v1.10.2：用 indent（前导空格数）识别父子层级——indent=0 根待办，indent>0 子待办。
const TASK_LINE_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/

interface ParsedTaskLine {
  text: string
  checked: boolean
  indent: number // 前导空格数（0=根待办，>0=子待办）
}

/** 解析笔记内容里的 GFM 任务列表项。返回顺序与原文一致（含 indent 用于父子分组）。 */
function parseTaskLines(content: string): ParsedTaskLine[] {
  const result: ParsedTaskLine[] = []
  for (const line of content.split('\n')) {
    const m = TASK_LINE_RE.exec(line)
    if (m) {
      result.push({
        text: m[4].trim(),
        checked: m[3].toLowerCase() === 'x',
        indent: m[1].length,
      })
    }
  }
  return result
}

/** 把扁平 ParsedTaskLine 分成父子结构（v1.10.2）。
 *  v1.10.3：去重——同层级相同标题只保留第一个（根按全笔记去重，子任务按父内去重）。 */
interface TodoNode {
  line: ParsedTaskLine
  children: ParsedTaskLine[]
  /** 内部去重用（不渲染）：记录已添加的子任务归一化标题 */
  _seenChildTitles: Set<string>
}

function buildTodoTree(lines: ParsedTaskLine[]): TodoNode[] {
  const roots: TodoNode[] = []
  const seenRootTitles = new Set<string>()
  let currentRoot: TodoNode | null = null
  for (const line of lines) {
    const norm = normalizeTitle(line.text)
    if (line.indent === 0) {
      if (seenRootTitles.has(norm)) {
        // 重复根：其后续子任务也跳过（归到已存在的同名根？不——简单跳过整块）
        currentRoot = null
        continue
      }
      seenRootTitles.add(norm)
      currentRoot = { line, children: [], _seenChildTitles: new Set<string>() }
      roots.push(currentRoot)
    } else if (currentRoot) {
      if (currentRoot._seenChildTitles.has(norm)) continue
      currentRoot._seenChildTitles.add(norm)
      currentRoot.children.push(line)
    } else {
      // 缩进行无父根（异常），当根处理
      if (seenRootTitles.has(norm)) continue
      seenRootTitles.add(norm)
      roots.push({ line, children: [], _seenChildTitles: new Set<string>() })
      currentRoot = roots[roots.length - 1]!
    }
  }
  return roots
}

/** 标题归一化用于去重：去首尾空白 + 转小写 + 折叠连续空白。中文不转大小写（无影响）。 */
function normalizeTitle(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function NoteTodosPanel({
  content,
  noteId,
  noteFileName,
  tasks,
  onConvert,
  onConvertSub,
}: {
  content: string
  noteId: string
  noteFileName: string
  tasks: Task[]
  onConvert: (input: { title: string; noteId: string }) => Promise<Task>
  onConvertSub: (input: { parentId: string; title: string }) => Promise<Task>
}) {
  const [converting, setConverting] = useState<string | null>(null) // 正在转的 key（title 或 title>subtitle）
  const [error, setError] = useState<string | null>(null)
  // v1.12：面板默认折叠（避免待办多时挤占视野），用户需要才展开
  const [expanded, setExpanded] = useState(false)

  const tree = buildTodoTree(parseTaskLines(content).filter((l) => !l.checked && l.text))
  const totalCount = tree.reduce((sum, n) => sum + 1 + n.children.length, 0)
  // v1.12：限制显示数量，超 20 条默认折叠剩余（避免一次渲染太多卡顿）
  const MAX_VISIBLE = 20
  const visibleTree = expanded ? tree : tree.slice(0, MAX_VISIBLE)
  const hiddenCount = tree.length - visibleTree.length

  // 根待办是否已转（source=from_note + sourceNotePath + title）
  const findRootTask = (title: string) =>
    tasks.find(
      (t) =>
        t.source === 'from_note' &&
        t.sourceNotePath === noteFileName &&
        t.title === title &&
        t.parentId === null,
    )
  // 子待办是否已转（parentId 匹配根任务 + title）
  const findSubTask = (rootTaskId: string, title: string) =>
    tasks.find((t) => t.parentId === rootTaskId && t.title === title)

  if (totalCount === 0) return null

  const handleConvertRoot = async (title: string) => {
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
  const handleConvertSub = async (rootTaskId: string, title: string) => {
    const key = `${rootTaskId}>${title}`
    setConverting(key)
    setError(null)
    try {
      await onConvertSub({ parentId: rootTaskId, title })
    } catch (e) {
      setError(String(e))
    } finally {
      setConverting(null)
    }
  }

  return (
    <div className="mb-4 rounded-md border bg-surface-2 p-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mb-1 flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
        <CheckSquare size={13} />
        <span>笔记待办（{totalCount}）</span>
        <span className="text-[10px] text-muted-foreground/70">点「转任务」加入任务列表（缩进=子任务）</span>
      </button>
      {expanded && (
        <ul className="space-y-1">
          {visibleTree.map((node, i) => {
          const rootTask = findRootTask(node.line.text)
          const rootConverted = !!rootTask
          return (
            <li key={i} className="space-y-0.5">
              {/* 根待办 */}
              <div className="flex items-center gap-2 rounded-md bg-background px-2.5 py-1.5">
                <span className="flex-1 truncate text-xs font-medium">{node.line.text}</span>
                {rootConverted ? (
                  <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                    <CheckCircle2 size={11} /> 已转
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleConvertRoot(node.line.text)}
                    disabled={converting === node.line.text}
                    className="h-6 gap-1 px-2 text-[10px]"
                  >
                    {converting === node.line.text ? (
                      <AlertCircle size={11} className="animate-pulse" />
                    ) : (
                      <Sparkles size={11} />
                    )}
                    转任务
                  </Button>
                )}
              </div>
              {/* 子待办（缩进 + 左竖线，v1.10.2 对齐 TasksPage 子任务样式）*/}
              {node.children.length > 0 && (
                <ul className="ml-3 space-y-0.5 border-l border-border pl-3">
                  {node.children.map((child, j) => {
                    const subConverted = rootTask ? !!findSubTask(rootTask.id, child.text) : false
                    const subDisabled = !rootTask // 父未转时子不可转（需 parentId）
                    return (
                      <li key={j} className="flex items-center gap-2 bg-background/50 px-2.5 py-1">
                        <span className="flex-1 truncate text-xs text-muted-foreground">{child.text}</span>
                        {subConverted ? (
                          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                            <CheckCircle2 size={10} /> 已转
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => rootTask && handleConvertSub(rootTask.id, child.text)}
                            disabled={subDisabled || converting === `${rootTask?.id}>${child.text}`}
                            className="h-5 gap-1 px-1.5 text-[10px]"
                            title={subDisabled ? '先转父任务' : '转为子任务'}
                          >
                            {converting === `${rootTask?.id}>${child.text}` ? (
                              <AlertCircle size={10} className="animate-pulse" />
                            ) : (
                              <Sparkles size={10} />
                            )}
                            转子任务
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
          {hiddenCount > 0 && (
            <li className="py-1 text-center text-[11px] text-muted-foreground">
              还有 {hiddenCount} 条待办，转完上面的再展开查看
            </li>
          )}
        </ul>
      )}
      {error && <p className="mt-2 text-[10px] text-destructive">转任务失败：{error}</p>}
    </div>
  )
}

// ---------- 笔记大纲（v1.15 §15.2③）----------
// 解析 Markdown 标题行 → 大纲树。预览态点击跳转到对应 heading id。
// slugify 必须与 Markdown.tsx 的 slugify 完全一致，否则跳转 id 对不上。

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

interface Heading {
  level: number // 1-6
  text: string
  slug: string // 与 Markdown 渲染出的 heading id 一致
}

/** slugify：与 Markdown.tsx 的实现严格保持一致（保留中文，标点/空白转 -）。 */
function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** 解析笔记内容里的标题行，生成带 slug 的大纲列表。
 *  slug 按出现顺序加序号，与 Markdown 组件的 idCounter 逻辑一致——
 *  保证点击大纲跳转的 id 与实际渲染的 heading id 完全对应。 */
function parseHeadings(content: string): Heading[] {
  const result: Heading[] = []
  const seen = new Map<string, number>()
  for (const line of content.split('\n')) {
    const m = HEADING_RE.exec(line)
    if (!m) continue
    const level = m[1].length
    const text = m[2].trim()
    const base = slugifyHeading(text) || 'heading'
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    result.push({ level, text, slug: count === 0 ? base : `${base}-${count}` })
  }
  return result
}

function OutlinePanel({
  headings,
  editing,
  onJump,
}: {
  headings: Heading[]
  editing: boolean
  onJump: (slug: string) => void
}) {
  // 折叠的 level 集合：点某个标题的折叠箭头，其下属（更深 level）标题收起。
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const toggle = (idx: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  // 判断某个标题是否可见：从最近祖先往上查，任一祖先被折叠则隐藏。
  const isVisible = (idx: number): boolean => {
    const target = headings[idx]
    for (let i = idx - 1; i >= 0; i--) {
      const h = headings[i]
      if (h.level < target.level) {
        // h 是 idx 的最近祖先（level 更浅）。h 被折叠 → 整个子树隐藏。
        if (collapsed.has(i)) return false
        // h 未折叠 → idx 是否可见取决于 h 自己的祖先链。
        return isVisible(i)
      }
    }
    return true // 无祖先（顶层标题）永远可见
  }

  return (
    <div className="flex w-[220px] shrink-0 flex-col border-l bg-card">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <TextAlignLeft size={13} />
        <span>大纲</span>
        {editing && <span className="text-[10px] text-muted-foreground/60">（编辑态仅展示）</span>}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {headings.length === 0 ? (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            这条笔记没有 Markdown 标题（# 开头的行）。
            <br />
            加个标题就会出现大纲。
          </div>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {headings.map((h, i) => {
              if (!isVisible(i)) return null
              // 是否有子标题（更深 level 的后续标题，且未被折叠隐藏）——决定显示折叠箭头
              const hasChildren = headings.slice(i + 1).some((nh) => nh.level > h.level)
              const isCollapsed = collapsed.has(i)
              return (
                <li
                  key={i}
                  style={{ paddingLeft: `${(h.level - 1) * 12 + 4}px` }}
                  className="flex items-center gap-1"
                >
                  {hasChildren ? (
                    <button
                      onClick={() => toggle(i)}
                      className="shrink-0 text-muted-foreground/70 transition-colors hover:text-foreground"
                    >
                      {isCollapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
                    </button>
                  ) : (
                    <span className="w-[11px] shrink-0" />
                  )}
                  <button
                    onClick={() => onJump(h.slug)}
                    disabled={editing}
                    title={editing ? '编辑态不可跳转' : '跳转到此处'}
                    className={cn(
                      'flex-1 truncate rounded px-1 py-0.5 text-left transition-colors',
                      editing
                        ? 'cursor-default text-muted-foreground'
                        : 'text-foreground/80 hover:bg-surface-3 hover:text-foreground',
                    )}
                  >
                    {h.text}
                  </button>
                </li>
              )
            })}
          </ul>
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
