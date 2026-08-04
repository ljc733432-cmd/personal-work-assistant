import { useEffect, useMemo, useState } from 'react'
import { Check, Plus, CheckSquare, CaretDown, CaretRight, ArrowRight, Pencil } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/EmptyState'
import { useTasksStore } from '@/stores/tasks'
import type { Task, TaskInput, TaskPriority, TaskStatus } from '@/types'

// ---------- 状态/优先级 显示映射 ----------
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  done: '已完成',
}
// v1.2：状态/优先级色走语义 token（success/warning/danger/info/muted），
// 不再用 Tailwind 原生 slate/blue/green/amber/red 类（PRD §12.4 + 验收 V-O）。
const STATUS_STYLE: Record<TaskStatus, string> = {
  todo: 'bg-muted text-muted-foreground',
  in_progress: 'bg-info/10 text-info',
  done: 'bg-success/10 text-success',
}
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
}
const PRIORITY_STYLE: Record<TaskPriority, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-warning/10 text-warning',
  high: 'bg-danger/10 text-danger',
}

type Filter = 'all' | TaskStatus

export function TasksPage() {
  const { tasks, refresh, upsert, remove, createSubtask, promoteSubtask, setParent } = useTasksStore()
  const [filter, setFilter] = useState<Filter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  // v1.10.1 A1：删根任务，有子任务时 confirm 级联删
  const handleDeleteRoot = (task: Task, subCount: number) => {
    if (subCount > 0) {
      if (!confirm(`删除「${task.title}」及其 ${subCount} 个子任务？不可恢复。`)) return
      remove({ id: task.id, cascade: true })
    } else {
      remove({ id: task.id })
    }
  }

  // v1.10.1 A4：子任务勾选后检查是否全部完成 → 提示完成父任务（不强制）
  const handleSubtaskToggle = (parent: Task, sub: Task, subs: Task[]) => {
    const nextStatus = sub.status === 'done' ? 'todo' : 'done'
    upsert({ id: sub.id, title: sub.title, status: nextStatus })
    // 若切到 done 且父任务未完成，检查是否所有子任务都将完成
    if (nextStatus === 'done' && parent.status !== 'done') {
      const allDoneAfter = subs.every((s) => s.id === sub.id || s.status === 'done')
      if (allDoneAfter) {
        setTimeout(() => {
          if (confirm(`所有子任务已完成，是否完成父任务「${parent.title}」？`)) {
            upsert({ id: parent.id, title: parent.title, status: 'done' })
          }
        }, 100) // 延迟让 upsert 先落库
      }
    }
  }

  // v1.10：数据分组——根任务 + 子任务按父 id 索引（数据量小，前端 reduce）
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (t.parentId) {
        const arr = map.get(t.parentId) ?? []
        arr.push(t)
        map.set(t.parentId, arr)
      }
    }
    return map
  }, [tasks])

  const rootTasks = useMemo(() => tasks.filter((t) => t.parentId === null), [tasks])

  const filtered = useMemo(() => {
    if (filter === 'all') return rootTasks
    return rootTasks.filter((t) => t.status === filter)
  }, [rootTasks, filter])

  // counts 只算根任务（子任务不独立计数，避免重复）
  const counts = useMemo(() => ({
    all: rootTasks.length,
    todo: rootTasks.filter((t) => t.status === 'todo').length,
    in_progress: rootTasks.filter((t) => t.status === 'in_progress').length,
    done: rootTasks.filter((t) => t.status === 'done').length,
  }), [rootTasks])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        {/* 品牌头部（v1.5：电光蓝径向光晕 + 标题入场）*/}
        <header className="relative overflow-hidden">
          <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative animate-fade-up">
            <h1 className="font-display text-2xl font-semibold tracking-tight">任务</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              手动管理待办。支持子任务（两级）、来源溯源、AI 抽取与跟进。
            </p>
          </div>
        </header>

        {/* 筛选条 */}
        <div className="flex flex-wrap gap-1.5">
          <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')} label={`全部 ${counts.all}`} />
          <FilterBtn active={filter === 'todo'} onClick={() => setFilter('todo')} label={`待办 ${counts.todo}`} />
          <FilterBtn active={filter === 'in_progress'} onClick={() => setFilter('in_progress')} label={`进行中 ${counts.in_progress}`} />
          <FilterBtn active={filter === 'done'} onClick={() => setFilter('done')} label={`已完成 ${counts.done}`} />
        </div>

        {filtered.length === 0 && (
          <EmptyState
            icon={CheckSquare}
            title={tasks.length === 0 ? '还没有任务' : '该筛选下没有任务'}
            hint={tasks.length === 0 ? '点下方「添加任务」开始，或在对话里说「我明天要交报告」让 AI 抽取' : '换个筛选条件试试'}
          />
        )}

        {/* 任务列表（v1.5：stagger 错峰入场）*/}
        <div className="stagger-fade-up space-y-3">
          {filtered.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              subtasks={subtasksByParent.get(t.id) ?? EMPTY_TASKS}
              allRootTasks={rootTasks}
              editing={editingId === t.id}
              onEdit={() => setEditingId(editingId === t.id ? null : t.id)}
              onSave={(input) => {
                upsert(input)
                setEditingId(null)
              }}
              onToggleDone={() =>
                upsert({ id: t.id, title: t.title, status: t.status === 'done' ? 'todo' : 'done' })
              }
              onDelete={() => handleDeleteRoot(t, subtasksByParent.get(t.id)?.length ?? 0)}
              onAddSubtask={(title) => createSubtask({ parentId: t.id, title })}
              onToggleSubtaskDone={(sub) =>
                handleSubtaskToggle(t, sub, subtasksByParent.get(t.id) ?? EMPTY_TASKS)
              }
              onDeleteSubtask={(sub) => remove({ id: sub.id })}
              onPromoteSubtask={(sub) => promoteSubtask(sub.id)}
              onEditSubtask={(sub, title) => upsert({ id: sub.id, title })}
              onSetParent={(id, parentId) => setParent(id, parentId)}
            />
          ))}
        </div>

        <AddTaskCard onAdd={(input) => upsert(input)} />
      </div>
    </div>
  )
}

// 模块级空数组保证引用稳定（避免 zustand selector 返回内联数组陷阱）
const EMPTY_TASKS: Task[] = []

// ---------- 筛选按钮 ----------
function FilterBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      // v1.3：选中态改 Soft UI（accent 微背景 + 阴影浮起，替代 v1.2 近黑硬反差）
      className={`rounded-full px-3 py-1 text-xs font-medium transition-all duration-200 ${
        active
          ? 'bg-accent/10 text-accent shadow-xs'
          : 'bg-surface-3 text-muted-foreground hover:bg-accent/5 hover:text-foreground'
      }`}
    >
      {label}
    </button>
  )
}

// ---------- 任务状态/优先级徽标 ----------
function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}
function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_STYLE[priority]}`}>
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

// ---------- 单个任务卡片（根任务，v1.10 含子任务区） ----------
function TaskCard({
  task,
  subtasks,
  allRootTasks,
  editing,
  onEdit,
  onSave,
  onToggleDone,
  onDelete,
  onAddSubtask,
  onToggleSubtaskDone,
  onDeleteSubtask,
  onPromoteSubtask,
  onEditSubtask,
  onSetParent,
}: {
  task: Task
  subtasks: Task[]
  allRootTasks: Task[]
  editing: boolean
  onEdit: () => void
  onSave: (input: TaskInput) => void
  onToggleDone: () => void
  onDelete: () => void
  onAddSubtask: (title: string) => void
  onToggleSubtaskDone: (sub: Task) => void
  onDeleteSubtask: (sub: Task) => void
  onPromoteSubtask: (sub: Task) => void
  onEditSubtask: (sub: Task, title: string) => void
  onSetParent: (id: string, parentId: string | null) => void
}) {
  // 编辑态字段
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [priority, setPriority] = useState<TaskPriority>(task.priority)
  const [dueDate, setDueDate] = useState(task.dueDate ? toDateInput(task.dueDate) : '')
  // v1.10：子任务区折叠态（默认展开若有子任务）
  const [subOpen, setSubOpen] = useState(subtasks.length > 0)
  const [subInput, setSubInput] = useState('')
  const [addingSub, setAddingSub] = useState(false)
  // v1.10.1 A2：子任务 inline 编辑态
  const [editingSubId, setEditingSubId] = useState<string | null>(null)
  const [subEditText, setSubEditText] = useState('')

  // 进入编辑态时同步字段（处理切到不同任务编辑）
  useEffect(() => {
    if (editing) {
      setTitle(task.title)
      setDescription(task.description ?? '')
      setStatus(task.status)
      setPriority(task.priority)
      setDueDate(task.dueDate ? toDateInput(task.dueDate) : '')
    }
  }, [editing, task])

  // 子任务数量变化时，无子任务自动收起
  useEffect(() => {
    if (subtasks.length === 0) setSubOpen(false)
  }, [subtasks.length])

  if (editing) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="space-y-1.5">
            <Label>标题</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>详情（可选）</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[60px]"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>状态</Label>
              <SelectInput value={status} onChange={(v) => setStatus(v as TaskStatus)} options={statusOptions} />
            </div>
            <div className="space-y-1.5">
              <Label>优先级</Label>
              <SelectInput value={priority} onChange={(v) => setPriority(v as TaskPriority)} options={priorityOptions} />
            </div>
            <div className="space-y-1.5">
              <Label>截止日期</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          {/* v1.10.5：移动到（手动调整父子层级，解 AI 提炼不准的问题）*/}
          <div className="space-y-1.5">
            <Label>移动到</Label>
            <SelectInput
              value={task.parentId ?? ''}
              onChange={(v) => onSetParent(task.id, v || null)}
              options={[
                { value: '', label: '独立（根任务）' },
                ...allRootTasks
                  .filter((r) => r.id !== task.id)
                  .map((r) => ({ value: r.id, label: r.title })),
              ]}
            />
            <p className="text-[10px] text-muted-foreground">
              选一个根任务作为父任务，本任务变为其子任务；选「独立」变回根任务
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={!title.trim()}
              onClick={() =>
                onSave({
                  id: task.id,
                  title: title.trim(),
                  description: description.trim() || null,
                  status,
                  priority,
                  dueDate: dueDate ? fromDateInput(dueDate) : null,
                })
              }
            >
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              取消
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // 展示态
  const done = task.status === 'done'
  const doneSubCount = subtasks.filter((s) => s.status === 'done').length
  return (
    <Card className={`transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${done ? 'opacity-60' : ''}`}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <button
              onClick={onToggleDone}
              title={done ? '标记为待办' : '标记完成'}
              className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 transition-colors ${
                done ? 'border-success bg-success text-primary-foreground' : 'border-muted-foreground/40 hover:border-primary'
              }`}
            >
              {done && <Check size={12} />}
            </button>
            <div className="space-y-1">
              <div className={`font-medium ${done ? 'line-through' : ''}`}>{task.title}</div>
              {task.description && (
                <div className="whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</div>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          {task.dueDate && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              截止 {formatDueDate(task.dueDate)}
            </span>
          )}
          {task.source === 'from_chat' && (
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">来自对话</span>
          )}
          {task.source === 'from_note' && (
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">来自笔记</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={onEdit}>
              编辑
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
              删除
            </Button>
          </div>
        </div>

        {/* v1.10：子任务区（两级层级）*/}
        <div className="space-y-1.5 border-t pt-2">
          <button
            onClick={() => setSubOpen((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {subOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}
            <span>子任务 {subtasks.length > 0 && `（${doneSubCount}/${subtasks.length}）`}</span>
          </button>
          {subOpen && (
            <div className="space-y-1 pl-3">
              {/* 子任务列表（缩进 + 左竖线表示层级）*/}
              <div className="space-y-0.5 border-l border-border pl-3">
                {subtasks.map((sub) => {
                  const subDone = sub.status === 'done'
                  const isEditingSub = editingSubId === sub.id
                  return (
                    <div key={sub.id} className="group flex items-center gap-2 py-0.5">
                      <button
                        onClick={() => onToggleSubtaskDone(sub)}
                        title={subDone ? '标记为待办' : '标记完成'}
                        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-2 transition-colors ${
                          subDone
                            ? 'border-success bg-success text-primary-foreground'
                            : 'border-muted-foreground/40 hover:border-primary'
                        }`}
                      >
                        {subDone && <Check size={10} />}
                      </button>
                      {isEditingSub ? (
                        // v1.10.1 A2：inline 编辑子任务标题
                        <input
                          autoFocus
                          value={subEditText}
                          onChange={(e) => setSubEditText(e.target.value)}
                          className="flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-sm"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && subEditText.trim()) {
                              onEditSubtask(sub, subEditText.trim())
                              setEditingSubId(null)
                            } else if (e.key === 'Escape') {
                              setEditingSubId(null)
                            }
                          }}
                          onBlur={() => {
                            if (subEditText.trim() && subEditText.trim() !== sub.title) {
                              onEditSubtask(sub, subEditText.trim())
                            }
                            setEditingSubId(null)
                          }}
                        />
                      ) : (
                        <span
                          className={`flex-1 text-sm ${subDone ? 'line-through opacity-60' : ''}`}
                          onDoubleClick={() => {
                            setEditingSubId(sub.id)
                            setSubEditText(sub.title)
                          }}
                        >
                          {sub.title}
                        </span>
                      )}
                      {/* v1.10.1 A2/A3：hover 显示 编辑/转根/删除 */}
                      {!isEditingSub && (
                        <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            onClick={() => {
                              setEditingSubId(sub.id)
                              setSubEditText(sub.title)
                            }}
                            title="编辑标题"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            onClick={() => onPromoteSubtask(sub)}
                            title="转为根任务"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ArrowRight size={11} />
                          </button>
                          <button
                            onClick={() => onDeleteSubtask(sub)}
                            title="删除"
                            className="text-muted-foreground hover:text-destructive"
                          >
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              {/* 添加子任务 */}
              {addingSub ? (
                <Input
                  autoFocus
                  value={subInput}
                  onChange={(e) => setSubInput(e.target.value)}
                  placeholder="子任务标题，回车确认"
                  className="h-7 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && subInput.trim()) {
                      onAddSubtask(subInput.trim())
                      setSubInput('')
                      setAddingSub(false)
                    } else if (e.key === 'Escape') {
                      setSubInput('')
                      setAddingSub(false)
                    }
                  }}
                  onBlur={() => {
                    if (!subInput.trim()) setAddingSub(false)
                  }}
                />
              ) : (
                <button
                  onClick={() => setAddingSub(true)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Plus size={11} /> 添加子任务
                </button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------- 添加任务（恒为根任务，parentId=null） ----------
function AddTaskCard({ onAdd }: { onAdd: (input: TaskInput) => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')

  if (!open) {
    return (
      <Button variant="outline" className="w-full gap-1.5 border-dashed" onClick={() => setOpen(true)}>
        <Plus size={14} /> 添加任务
      </Button>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="space-y-1.5">
          <Label>标题</Label>
          <Input
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：周五前交季度复盘"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && title.trim()) {
                onAdd({ title: title.trim(), priority })
                setTitle('')
                setOpen(false)
              }
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>优先级</Label>
            <SelectInput value={priority} onChange={(v) => setPriority(v as TaskPriority)} options={priorityOptions} />
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            disabled={!title.trim()}
            onClick={() => {
              onAdd({ title: title.trim(), priority })
              setTitle('')
              setOpen(false)
            }}
          >
            添加
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------- 通用：原生 select 封装（与项目风格一致，不引入 Radix） ----------
const statusOptions = [
  { value: 'todo', label: '待办' },
  { value: 'in_progress', label: '进行中' },
  { value: 'done', label: '已完成' },
]
const priorityOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]
function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// ---------- 日期工具（Unix 秒 ↔ date input 的 YYYY-MM-DD） ----------
// 截止日只精确到日（不含时分），存当天 23:59:59 的 Unix 秒，避免时区边界问题。
function toDateInput(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function fromDateInput(yyyy_mm_dd: string): number {
  // 当地时间当天 23:59:59
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000)
}
function formatDueDate(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000)
  const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`
  if (diffDays === 0) return `今天（${dateStr}）`
  if (diffDays === 1) return `明天（${dateStr}）`
  if (diffDays < 0) return `已逾期 ${Math.abs(diffDays)} 天（${dateStr}）`
  if (diffDays <= 7) return `${diffDays} 天后（${dateStr}）`
  return dateStr
}
