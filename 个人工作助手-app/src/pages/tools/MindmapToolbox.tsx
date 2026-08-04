import { useEffect, useState, useRef } from 'react'
import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'
import {
  Graph,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  StickyNote,
  CheckSquare,
} from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { invoke } from '@/lib/ipc'
import { BackHeader } from './ToolsPage'
import { useNotesStore } from '@/stores/notes'
import { useTasksStore } from '@/stores/tasks'
import { useNavigate } from '@/pages/overview/nav'
import type { MindmapResult } from '@/types'
import { cn } from '@/lib/utils'

/**
 * AI 思维导图工具页（v1.12，PRD §15.3 AI 产出组）。
 *
 * 照搬 ReportToolbox 骨架（Status 判别联合 + 可取消）。
 * 两种输入模式：topic 主题（AI 自由展开）/ material 素材（选笔记或任务内容）。
 * 生成走非流式（mindmap:generate IPC），结果用 markmap-lib + markmap-view 渲染成 SVG。
 * 复用 report.providerId（零新配置），结果存为笔记 tag='思维导图'。
 */

type Mode = 'topic' | 'material'
type MaterialSource = 'note' | 'task'

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; reqId: string }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

export function MindmapToolbox({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('topic')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // 主题模式
  const [topic, setTopic] = useState('')
  // 素材模式
  const [materialSource, setMaterialSource] = useState<MaterialSource>('note')
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState('')
  // 渲染结果
  const [markdown, setMarkdown] = useState('')
  const svgRef = useRef<SVGSVGElement>(null)
  const mmRef = useRef<Markmap | null>(null)

  const { notes, refresh: refreshNotes } = useNotesStore()
  const { tasks, refresh: refreshTasks } = useTasksStore()
  const goto = useNavigate()
  const reqIdRef = useRef(0)

  useEffect(() => {
    refreshNotes()
    refreshTasks()
  }, [refreshNotes, refreshTasks])

  // markmap 渲染：markdown 变化时 transform + setData
  useEffect(() => {
    if (!markdown || !svgRef.current) return
    const transformer = new Transformer()
    const { root } = transformer.transform(markdown)
    if (!mmRef.current) {
      mmRef.current = new Markmap(svgRef.current, { zoom: true, pan: true, initialExpandLevel: 3 })
    }
    mmRef.current.setData(root).then(() => {
      mmRef.current?.fit()
    })
  }, [markdown])

  // 历史思维导图笔记
  const history = notes
    .filter((n) => n.tags.includes('思维导图'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)

  const openNotes = () => goto('notes')

  const run = async () => {
    // 构建入参（按模式）
    let params: { topic?: string; material?: string; sourceTitle?: string }
    if (mode === 'topic') {
      if (!topic.trim()) {
        setStatus({ kind: 'error', message: '请输入主题' })
        return
      }
      params = { topic: topic.trim() }
    } else {
      // 素材模式
      if (materialSource === 'note') {
        const note = notes.find((n) => n.id === selectedNoteId)
        if (!note) {
          setStatus({ kind: 'error', message: '请选择一个笔记' })
          return
        }
        params = { material: note.content, sourceTitle: note.title }
      } else {
        const task = tasks.find((t) => t.id === selectedTaskId)
        if (!task) {
          setStatus({ kind: 'error', message: '请选择一个任务' })
          return
        }
        // 任务素材 = 标题 + 详情 + 子任务
        const subtasks = tasks.filter((t) => t.parentId === task.id)
        const material = [
          `# ${task.title}`,
          task.description ?? '',
          subtasks.length > 0 ? '## 子任务' : '',
          ...subtasks.map((s) => `- ${s.title}（${s.status === 'done' ? '已完成' : '未完成'}）`),
        ]
          .filter(Boolean)
          .join('\n')
        params = { material, sourceTitle: task.title }
      }
    }

    const reqId = `mindmap-${Date.now()}-${++reqIdRef.current}`
    setStatus({ kind: 'working', reqId })
    setMarkdown('')
    try {
      const r = await invoke<MindmapResult>('mindmap:generate', { ...params, reqId })
      setMarkdown(r.markdown)
      setStatus({ kind: 'done', message: `已生成思维导图：${r.note.title}` })
      await refreshNotes()
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) })
    }
  }

  const cancel = async () => {
    if (status.kind !== 'working') return
    try {
      await invoke<true>('mindmap:cancel', status.reqId)
    } catch {
      // 忽略
    }
    setStatus({ kind: 'idle' })
  }

  return (
    <div className="flex h-full flex-col">
      <BackHeader title="AI 思维导图" onBack={onBack} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {/* 模式切换 */}
          <div className="flex justify-center">
            <div className="flex items-center gap-1 rounded-lg bg-surface-3 p-1">
              {(['topic', 'material'] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m)
                    setStatus({ kind: 'idle' })
                  }}
                  className={cn(
                    'rounded-md px-4 py-1.5 text-xs font-medium transition-colors',
                    mode === m
                      ? 'bg-accent/10 text-accent shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'topic' ? '主题生成' : '基于素材'}
                </button>
              ))}
            </div>
          </div>

          {/* 主题模式输入 */}
          {mode === 'topic' && (
            <div className="space-y-1.5">
              <Label>主题</Label>
              <Input
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value)
                  setStatus({ kind: 'idle' })
                }}
                placeholder="如：Q4 产品规划 / 学习 Rust / 周末旅行准备"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && topic.trim() && status.kind !== 'working') run()
                }}
              />
              <p className="text-[10px] text-muted-foreground">
                输入一个主题，AI 会自动展开成多层级的思维导图
              </p>
            </div>
          )}

          {/* 素材模式选择 */}
          {mode === 'material' && (
            <div className="space-y-3">
              {/* 素材来源切换（笔记/任务） */}
              <div className="flex items-center gap-1 rounded-lg bg-surface-3 p-1">
                {(['note', 'task'] as MaterialSource[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setMaterialSource(s)
                      setStatus({ kind: 'idle' })
                    }}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                      materialSource === s
                        ? 'bg-accent/10 text-accent shadow-xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {s === 'note' ? <StickyNote size={12} /> : <CheckSquare size={12} />}
                    {s === 'note' ? '从笔记' : '从任务'}
                  </button>
                ))}
              </div>
              {/* 笔记选择 */}
              {materialSource === 'note' && (
                <div className="space-y-1.5">
                  <Label>选择笔记</Label>
                  <select
                    value={selectedNoteId}
                    onChange={(e) => {
                      setSelectedNoteId(e.target.value)
                      setStatus({ kind: 'idle' })
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">— 选择一个笔记 —</option>
                    {notes
                      .slice()
                      .sort((a, b) => b.updatedAt - a.updatedAt)
                      .slice(0, 50)
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.title}
                        </option>
                      ))}
                  </select>
                  <p className="text-[10px] text-muted-foreground">
                    AI 会提炼笔记内容的结构和要点，生成思维导图
                  </p>
                </div>
              )}
              {/* 任务选择 */}
              {materialSource === 'task' && (
                <div className="space-y-1.5">
                  <Label>选择任务（根任务，含其子任务）</Label>
                  <select
                    value={selectedTaskId}
                    onChange={(e) => {
                      setSelectedTaskId(e.target.value)
                      setStatus({ kind: 'idle' })
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">— 选择一个根任务 —</option>
                    {tasks
                      .filter((t) => t.parentId === null)
                      .slice()
                      .sort((a, b) => b.updatedAt - a.updatedAt)
                      .slice(0, 50)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                  </select>
                  <p className="text-[10px] text-muted-foreground">
                    AI 会基于任务标题、详情和子任务展开思维导图
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 生成/取消按钮 */}
          <div className="flex gap-2">
            {status.kind === 'working' ? (
              <Button variant="outline" onClick={cancel} className="flex-1">
                <Loader2 size={14} className="mr-1.5 animate-spin" />
                生成中...
              </Button>
            ) : (
              <Button onClick={run} className="flex-1">
                生成思维导图
              </Button>
            )}
            {status.kind === 'done' && (
              <Button variant="outline" onClick={openNotes}>
                打开笔记
              </Button>
            )}
          </div>

          {/* 思维导图渲染（markmap SVG） */}
          {markdown && (
            <div className="rounded-md border bg-card p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Graph size={13} weight="duotone" className="text-accent" />
                思维导图预览（可拖拽缩放，点击节点折叠/展开）
              </div>
              <svg ref={svgRef} className="h-[400px] w-full" />
            </div>
          )}

          {/* 历史思维导图 */}
          <div className="space-y-3 rounded-md border bg-card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">历史思维导图</h3>
              <button
                onClick={openNotes}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                查看全部 <ArrowRight size={12} />
              </button>
            </div>
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无历史思维导图，生成后会显示在这里。</p>
            ) : (
              <ul className="space-y-1.5">
                {history.map((n) => (
                  <li
                    key={n.id}
                    className="flex items-center gap-2 rounded-md border bg-background px-3 py-2"
                  >
                    <Graph size={14} className="flex-shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-xs">{n.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(n.updatedAt * 1000).toLocaleDateString('zh-CN')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <StatusBlock status={status} />
        </div>
      </div>
    </div>
  )
}

// ---------- 状态反馈条（照搬 ReportToolbox） ----------
function StatusBlock({ status }: { status: Status }) {
  if (status.kind === 'idle' || status.kind === 'working') return null
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md p-3 text-xs',
        status.kind === 'done' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
      )}
    >
      {status.kind === 'done' ? (
        <CheckCircle2 size={14} className="mt-0.5" />
      ) : (
        <AlertCircle size={14} className="mt-0.5" />
      )}
      <span className="break-all">{status.message}</span>
    </div>
  )
}
