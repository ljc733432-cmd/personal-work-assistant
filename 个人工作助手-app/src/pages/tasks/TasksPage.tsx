import { useEffect, useMemo, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
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
  const { tasks, refresh, upsert, remove } = useTasksStore()
  const [filter, setFilter] = useState<Filter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    if (filter === 'all') return tasks
    return tasks.filter((t) => t.status === filter)
  }, [tasks, filter])

  const counts = useMemo(() => ({
    all: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
  }), [tasks])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-semibold">任务</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            手动管理待办。将来 AI 可从对话抽取任务（M4），到点主动跟进（M6）。
          </p>
        </div>

        {/* 筛选条 */}
        <div className="flex flex-wrap gap-1.5">
          <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')} label={`全部 ${counts.all}`} />
          <FilterBtn active={filter === 'todo'} onClick={() => setFilter('todo')} label={`待办 ${counts.todo}`} />
          <FilterBtn active={filter === 'in_progress'} onClick={() => setFilter('in_progress')} label={`进行中 ${counts.in_progress}`} />
          <FilterBtn active={filter === 'done'} onClick={() => setFilter('done')} label={`已完成 ${counts.done}`} />
        </div>

        {filtered.length === 0 && (
          <Card className="border-dashed bg-muted/30">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {tasks.length === 0 ? '还没有任务。在下方添加第一个。' : '该筛选下没有任务。'}
            </CardContent>
          </Card>
        )}

        {filtered.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            editing={editingId === t.id}
            onEdit={() => setEditingId(editingId === t.id ? null : t.id)}
            onSave={(input) => {
              upsert(input)
              setEditingId(null)
            }}
            onToggleDone={() =>
              upsert({ id: t.id, title: t.title, status: t.status === 'done' ? 'todo' : 'done' })
            }
            onDelete={() => remove(t.id)}
          />
        ))}

        <AddTaskCard onAdd={(input) => upsert(input)} />
      </div>
    </div>
  )
}

// ---------- 筛选按钮 ----------
function FilterBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
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

// ---------- 单个任务卡片 ----------
function TaskCard({
  task,
  editing,
  onEdit,
  onSave,
  onToggleDone,
  onDelete,
}: {
  task: Task
  editing: boolean
  onEdit: () => void
  onSave: (input: TaskInput) => void
  onToggleDone: () => void
  onDelete: () => void
}) {
  // 编辑态字段
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [priority, setPriority] = useState<TaskPriority>(task.priority)
  const [dueDate, setDueDate] = useState(task.dueDate ? toDateInput(task.dueDate) : '')

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
  return (
    <Card className={done ? 'opacity-60' : ''}>
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
              {done && <Check size={12} strokeWidth={3} />}
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
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={onEdit}>
              编辑
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
              删除
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------- 添加任务 ----------
function AddTaskCard({ onAdd }: { onAdd: (input: TaskInput) => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')

  if (!open) {
    return (
      <Button variant="outline" className="w-full gap-1.5 border-dashed" onClick={() => setOpen(true)}>
        <Plus size={14} strokeWidth={2} /> 添加任务
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
