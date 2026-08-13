import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Plus, CheckSquare, CaretDown, CaretRight, ArrowRight, Pencil, AlertCircle, Sun, Bell, CheckCircle2, Trash2, X } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/EmptyState'
import { useTasksStore } from '@/stores/tasks'
import { isLogicallyDone } from '@/lib/taskStatus'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'
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
// v1.10.8：智能分组维度（按截止日/按优先级/不分组），默认按截止日
type GroupBy = 'due' | 'priority' | 'none'

// ---------- v1.10.8：智能分组（纯前端 reduce，零新 IPC/表/字段） ----------
// 截止日分组 key（顺序即渲染顺序，逾期置顶警示）
type DueGroupKey = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'later' | 'noDate'
const DUE_GROUP_ORDER: DueGroupKey[] = ['overdue', 'today', 'tomorrow', 'thisWeek', 'later', 'noDate']
const DUE_GROUP_LABEL: Record<DueGroupKey, string> = {
  overdue: '已逾期',
  today: '今天',
  tomorrow: '明天',
  thisWeek: '本周内',
  later: '更远',
  noDate: '无截止日',
}
// 优先级分组 key（顺序：高→中→低）
const PRIORITY_GROUP_ORDER: TaskPriority[] = ['high', 'medium', 'low']

interface TaskGroup {
  key: string
  label: string
  tasks: Task[]
}

// 算任务相对今天的截止分组（复用 formatDueDate 的 diffDays 逻辑，抽纯函数）
function getDueGroupKey(task: Task): DueGroupKey {
  if (!task.dueDate) return 'noDate'
  const diffDays = diffDaysFromToday(task.dueDate)
  if (diffDays < 0) return 'overdue'
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  if (diffDays <= 7) return 'thisWeek'
  return 'later'
}

// 拆分未完成/已完成（已完成统一沉底）。
// v1.10.8：用「逻辑完成」判定——根任务+所有子任务全 done 才算完成（isLogicallyDone）。
// 子任务（parentId 非空）不在此拆分（filtered 只含根任务），仅根任务参与分组/沉底。
function partitionDone(list: Task[], subtasksByParent: Map<string, Task[]>): { undone: Task[]; done: Task[] } {
  const undone: Task[] = []
  const done: Task[] = []
  for (const t of list) {
    const subs = subtasksByParent.get(t.id) ?? EMPTY_TASKS
    if (isLogicallyDone(t, subs)) done.push(t)
    else undone.push(t)
  }
  return { undone, done }
}

// 按截止日分组（组内排序：逾期按逾期天数降序，其他按截止日升序）
function groupByDue(undone: Task[]): TaskGroup[] {
  const buckets = new Map<DueGroupKey, Task[]>()
  for (const k of DUE_GROUP_ORDER) buckets.set(k, [])
  for (const t of undone) {
    buckets.get(getDueGroupKey(t))!.push(t)
  }
  for (const [k, arr] of buckets) {
    arr.sort((a, b) => {
      const da = a.dueDate ?? Number.MAX_SAFE_INTEGER
      const db = b.dueDate ?? Number.MAX_SAFE_INTEGER
      if (k === 'overdue') return da - db // 逾期越早越严重，排前面
      return da - db // 其他按截止日升序（最近在前）
    })
  }
  return DUE_GROUP_ORDER.filter((k) => (buckets.get(k)?.length ?? 0) > 0).map((k) => ({
    key: k,
    label: DUE_GROUP_LABEL[k],
    tasks: buckets.get(k)!,
  }))
}

// 按优先级分组（组内保持 updatedAt 倒序）
function groupByPriority(undone: Task[]): TaskGroup[] {
  const buckets = new Map<TaskPriority, Task[]>()
  for (const p of PRIORITY_GROUP_ORDER) buckets.set(p, [])
  for (const t of undone) {
    buckets.get(t.priority)!.push(t)
  }
  return PRIORITY_GROUP_ORDER.filter((p) => (buckets.get(p)?.length ?? 0) > 0).map((p) => ({
    key: p,
    label: PRIORITY_LABEL[p] + '优先级',
    tasks: buckets.get(p)!,
  }))
}

export function TasksPage() {
  const { tasks, refresh, upsert, remove, createSubtask, promoteSubtask, setParent, batchUpsert, batchDelete } = useTasksStore()
  const [filter, setFilter] = useState<Filter>('all')
  // v1.10.8：分组维度，默认按截止日
  // v1.18：偏好持久化到 settings KV tasks.groupBy，切回任务页记住上次选择
  const [groupBy, setGroupBy] = useState<GroupBy>('due')
  const handleGroupByChange = (v: GroupBy) => {
    setGroupBy(v)
    invoke<true>('settings:set', 'tasks.groupBy', v).catch(() => {})
  }
  const [editingId, setEditingId] = useState<string | null>(null)
  // v1.11：标签筛选（'all'=全部，null=未标注，其他=指定标签）
  const [tagFilter, setTagFilter] = useState<string | 'all' | null>('all')
  // v1.11：标签字典（最近用过的标签，settings KV tasks.tagDict，最多 50 个）
  const [tagDict, setTagDict] = useState<string[]>(EMPTY_TAGS)
  // v1.22 批量操作：selectMode 时每张卡显示 checkbox，selectedIds 存选中的任务 id
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }
  const selectAllFiltered = (ids: string[]) => {
    setSelectedIds(new Set(ids))
  }

  /** v1.22 批量改状态/优先级：从 tasks 查每个选中任务的当前 title（upsert 更新分支强制写 title） */
  const batchUpdateField = async (field: 'status' | 'priority', value: string) => {
    if (selectedIds.size === 0) return
    const inputs = tasks
      .filter((t) => selectedIds.has(t.id))
      .map((t) => ({ id: t.id, title: t.title, [field]: value }))
    await batchUpsert(inputs as Parameters<typeof batchUpsert>[0])
    exitSelectMode()
  }
  /** v1.22 批量删除 */
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`批量删除 ${selectedIds.size} 个任务？含子任务的会级联删除子任务，不可恢复。`)) return
    await batchDelete([...selectedIds])
    exitSelectMode()
  }

  useEffect(() => {
    refresh()
    // 加载标签字典
    invoke<string | null>('settings:get', 'tasks.tagDict').then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) setTagDict(parsed.filter((t) => typeof t === 'string'))
        } catch {
          /* 容错：坏数据忽略 */
        }
      }
    })
    // v1.18：加载分组偏好（持久化，之前每次默认 due，现在记住用户选择）
    invoke<string | null>('settings:get', 'tasks.groupBy').then((raw) => {
      if (raw === 'due' || raw === 'priority' || raw === 'none') {
        setGroupBy(raw)
      }
    })
  }, [refresh])

  // 所有任务用过的标签去重列表（前端 reduce，零新 IPC）+ 合并字典，给筛选条用
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) for (const tag of t.tags) set.add(tag)
    for (const tag of tagDict) set.add(tag)
    return Array.from(set).sort()
  }, [tasks, tagDict])

  // v1.11：保存任务时把新标签追加到字典（去重 + 截断 50 个）
  const upsertWithTags = async (input: TaskInput) => {
    await upsert(input)
    // 收集本次用到的新标签，追加字典
    if (input.tags && input.tags.length > 0) {
      const newTags = input.tags.filter((t) => !tagDict.includes(t))
      if (newTags.length > 0) {
        const next = [...input.tags.filter((t) => !tagDict.includes(t)), ...tagDict]
        const trimmed = Array.from(new Set(next)).slice(0, 50)
        setTagDict(trimmed)
        await invoke<true>('settings:set', 'tasks.tagDict', JSON.stringify(trimmed))
      }
    }
  }

  // v1.22：标签字典管理——删除不在用的标签（被任务引用的不让删）
  const [tagManageOpen, setTagManageOpen] = useState(false)

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

  // v1.22 标签字典管理（放 rootTasks 后避免 TDZ：isTagInUse 引用 rootTasks）
  /** 检查标签是否被根任务使用（与筛选条口径一致：子任务不独立计数，只看根任务） */
  const isTagInUse = (tag: string): boolean => rootTasks.some((t) => (t.tags ?? []).includes(tag))
  /** 从字典删除标签（仅未被根任务使用的可删）。同时清理所有任务上残留的同名标签。 */
  const deleteTagFromDict = async (tag: string) => {
    if (isTagInUse(tag)) {
      alert(`标签「${tag}」仍被根任务使用，无法删除。请先从所有任务移除该标签。`)
      return
    }
    // 1. 字典删除
    const trimmed = tagDict.filter((t) => t !== tag)
    setTagDict(trimmed)
    await invoke<true>('settings:set', 'tasks.tagDict', JSON.stringify(trimmed))
    // 2. 清理所有任务（含子任务）上残留的同名标签（根任务已被 isTagInUse 拦住，子任务可能还有）
    const affected = tasks.filter((t) => (t.tags ?? []).includes(tag))
    if (affected.length > 0) {
      await batchUpsert(affected.map((t) => ({ id: t.id, title: t.title, tags: (t.tags ?? []).filter((x) => x !== tag) })))
    }
    // 3. 若当前筛选正指向被删标签，回退到全部（tagFilter 守护 effect 也会兜底）
    if (tagFilter === tag) setTagFilter('all')
  }
  /** tagFilter 守护：指向的标签已不在 allTags 里时自动回退 'all'（删标签/任务变更后兜底） */
  useEffect(() => {
    if (tagFilter !== 'all' && tagFilter !== null && !allTags.includes(tagFilter)) {
      setTagFilter('all')
    }
  }, [tagFilter, allTags])

  // v1.10.8：每个根任务是否「逻辑完成」（自身 done 且所有子任务 done）
  const logicallyDoneIds = useMemo(() => {
    const set = new Set<string>()
    for (const t of rootTasks) {
      const subs = subtasksByParent.get(t.id) ?? EMPTY_TASKS
      if (isLogicallyDone(t, subs)) set.add(t.id)
    }
    return set
  }, [rootTasks, subtasksByParent])

  const filtered = useMemo(() => {
    // v1.11：先按状态过滤
    let byStatus: Task[]
    if (filter === 'all') byStatus = rootTasks
    else if (filter === 'done') byStatus = rootTasks.filter((t) => logicallyDoneIds.has(t.id))
    else byStatus = rootTasks.filter((t) => t.status === filter && !logicallyDoneIds.has(t.id))
    // v1.11：再叠加标签过滤（与状态筛选正交）
    if (tagFilter === 'all') return byStatus
    if (tagFilter === null) return byStatus.filter((t) => t.tags.length === 0)
    return byStatus.filter((t) => t.tags.includes(tagFilter))
  }, [rootTasks, filter, logicallyDoneIds, tagFilter])

  // v1.10.8：分组计算（先 partition done/undone，再对 undone 按维度分组）
  // 筛选「已完成」时不分组（用户已显式要看完成的，平铺即可）
  const { undoneView, doneView, groups } = useMemo(() => {
    if (filter === 'done') {
      // 筛选已完成：用 status==='done' 原始筛选（filtered 已按 status 过滤），平铺
      return { undoneView: [], doneView: filtered, groups: [] as TaskGroup[] }
    }
    const { undone, done } = partitionDone(filtered, subtasksByParent)
    if (groupBy === 'none') {
      return { undoneView: undone, doneView: done, groups: [] as TaskGroup[] }
    }
    const gs = groupBy === 'due' ? groupByDue(undone) : groupByPriority(undone)
    return { undoneView: undone, doneView: done, groups: gs }
  }, [filtered, groupBy, filter, subtasksByParent])

  // counts 只算根任务（子任务不独立计数，避免重复）。
  // v1.10.8：done 用逻辑完成（根+子任务全 done），todo/in_progress 按原始 status 但排除逻辑完成的。
  const counts = useMemo(() => {
    const done = logicallyDoneIds.size
    return {
      all: rootTasks.length,
      todo: rootTasks.filter((t) => t.status === 'todo' && !logicallyDoneIds.has(t.id)).length,
      in_progress: rootTasks.filter((t) => t.status === 'in_progress' && !logicallyDoneIds.has(t.id)).length,
      done,
    }
  }, [rootTasks, logicallyDoneIds])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        {/* 品牌头部（v1.5：电光蓝径向光晕 + 标题入场）*/}
        <header className="relative overflow-hidden">
          <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative animate-fade-up">
            <h1 className="font-display text-2xl font-semibold tracking-tight">任务</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              手动管理待办。支持无限层级子任务、来源溯源、AI 抽取与跟进。
            </p>
          </div>
        </header>

        {/* 筛选条 + 分组控制（v1.10.8：右侧加维度下拉）*/}
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')} label={`全部 ${counts.all}`} />
          <FilterBtn active={filter === 'todo'} onClick={() => setFilter('todo')} label={`待办 ${counts.todo}`} />
          <FilterBtn active={filter === 'in_progress'} onClick={() => setFilter('in_progress')} label={`进行中 ${counts.in_progress}`} />
          <FilterBtn active={filter === 'done'} onClick={() => setFilter('done')} label={`已完成 ${counts.done}`} />
          <div className="ml-auto flex items-center gap-1.5">
            {/* v1.11：标签筛选（有标签时才显示），与状态筛选正交 */}
            {allTags.length > 0 && (
              <>
                <span className="text-[11px] text-muted-foreground">标签</span>
                <select
                  value={tagFilter === null ? '__none__' : tagFilter}
                  onChange={(e) => {
                    const v = e.target.value
                    setTagFilter(v === 'all' ? 'all' : v === '__none__' ? null : v)
                  }}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="all">全部标签</option>
                  <option value="__none__">未标注</option>
                  {allTags.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
                {/* v1.22 标签字典管理入口 */}
                <button
                  onClick={() => setTagManageOpen((v) => !v)}
                  title="管理标签字典（删除不在用的标签）"
                  className={cn(
                    'flex h-7 items-center rounded-md border px-1.5 text-xs transition-colors',
                    tagManageOpen ? 'border-accent bg-accent/10 text-accent' : 'border-input text-muted-foreground hover:bg-accent/5',
                  )}
                >
                  <Trash2 size={11} />
                </button>
              </>
            )}
            <span className="text-[11px] text-muted-foreground">分组</span>
            <select
              value={groupBy}
              onChange={(e) => handleGroupByChange(e.target.value as GroupBy)}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="due">按截止日</option>
              <option value="priority">按优先级</option>
              <option value="none">不分组</option>
            </select>
            {/* v1.22 批量操作入口 */}
            <Button
              variant={selectMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className="h-7 gap-1 text-xs"
            >
              {selectMode ? '退出' : '批量'}
            </Button>
          </div>
        </div>

        {/* v1.22 标签字典管理面板（点整理按钮展开）*/}
        {tagManageOpen && (
          <div className="rounded-md border border-border bg-card p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">标签字典（未被任务使用的可删除）</span>
              <button onClick={() => setTagManageOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">收起</button>
            </div>
            {tagDict.length === 0 ? (
              <div className="text-xs text-muted-foreground">字典为空</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tagDict.map((tag) => {
                  const inUse = isTagInUse(tag)
                  return (
                    <span
                      key={tag}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                        inUse ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-accent/5 text-muted-foreground',
                      )}
                    >
                      {tag}
                      {inUse ? (
                        <span className="text-[10px] text-muted-foreground/60" title="被任务使用，不可删除">使用中</span>
                      ) : (
                        <button
                          onClick={() => deleteTagFromDict(tag)}
                          title="从字典删除"
                          className="text-muted-foreground hover:text-danger"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* v1.22 批量操作工具栏（仅 selectMode 时显示）*/}
        {selectMode && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-accent/30 bg-accent/5 p-2">
            <span className="text-xs font-medium text-accent">已选 {selectedIds.size} 个</span>
            <Button variant="outline" size="sm" disabled={selectedIds.size === 0} onClick={() => batchUpdateField('status', 'done')} className="h-7 text-xs">标记完成</Button>
            <Button variant="outline" size="sm" disabled={selectedIds.size === 0} onClick={() => batchUpdateField('status', 'todo')} className="h-7 text-xs">标记待办</Button>
            <select
              disabled={selectedIds.size === 0}
              onChange={(e) => { if (e.target.value) batchUpdateField('priority', e.target.value); e.target.value = '' }}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
              defaultValue=""
            >
              <option value="" disabled>改优先级…</option>
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
            <Button variant="outline" size="sm" onClick={() => selectAllFiltered(filtered.map((t) => t.id))} className="h-7 text-xs">全选</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())} disabled={selectedIds.size === 0} className="h-7 text-xs">清空选择</Button>
            <Button variant="outline" size="sm" disabled={selectedIds.size === 0} onClick={handleBatchDelete} className="ml-auto h-7 gap-1 text-xs text-danger hover:bg-danger/5">
              <Trash2 size={12} /> 删除
            </Button>
          </div>
        )}

        {filtered.length === 0 && (
          <EmptyState
            icon={CheckSquare}
            title={tasks.length === 0 ? '还没有任务' : '该筛选下没有任务'}
            hint={tasks.length === 0 ? '点下方「添加任务」开始，或在对话里说「我明天要交报告」让 AI 抽取' : '换个筛选条件试试'}
          />
        )}

        {/* v1.10.8：分组模式渲染——按维度分区块 + 已完成折叠到底部 */}
        {groups.length > 0 ? (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.key} className="animate-fade-up space-y-2">
                <GroupHeader groupKey={g.key} label={g.label} count={g.tasks.length} groupBy={groupBy} />
                <div className="stagger-fade-up space-y-3">
                  {g.tasks.map((t) => renderTaskCard(t))}
                </div>
              </section>
            ))}
            {doneView.length > 0 && (
              <DoneSection tasks={doneView} renderTaskCard={renderTaskCard} />
            )}
          </div>
        ) : (
          /* 无分组模式：未完成平铺 + 已完成折叠到底部（筛选「已完成」时 doneView 就是全部，平铺） */
          <>
            {undoneView.length > 0 && (
              <div className="stagger-fade-up space-y-3">
                {undoneView.map((t) => renderTaskCard(t))}
              </div>
            )}
            {filter !== 'done' && doneView.length > 0 && (
              <DoneSection tasks={doneView} renderTaskCard={renderTaskCard} />
            )}
            {filter === 'done' && doneView.length > 0 && (
              <div className="stagger-fade-up space-y-3">
                {doneView.map((t) => renderTaskCard(t))}
              </div>
            )}
          </>
        )}

        <AddTaskCard onAdd={(input) => upsert(input)} />
      </div>
    </div>
  )

  // v1.10.8：渲染单个 TaskCard（抽出来避免分组/平铺/已完成三处重复写一大坨 props）
  function renderTaskCard(t: Task) {
    return (
      <TaskCard
        key={t.id}
        task={t}
        selectMode={selectMode}
        selected={selectedIds.has(t.id)}
        onToggleSelect={() => toggleSelect(t.id)}
        subtasks={subtasksByParent.get(t.id) ?? EMPTY_TASKS}
        allRootTasks={rootTasks}
        allTasks={tasks}
        subtasksByParent={subtasksByParent}
        tagDict={tagDict}
        editing={editingId === t.id}
        onEdit={() => setEditingId(editingId === t.id ? null : t.id)}
        onSave={(input) => {
          upsertWithTags(input)
          setEditingId(null)
        }}
        onToggleDone={() =>
          upsert({ id: t.id, title: t.title, status: t.status === 'done' ? 'todo' : 'done' })
        }
        onDelete={() => handleDeleteRoot(t, subtasksByParent.get(t.id)?.length ?? 0)}
        onAddSubtask={(parentId, title) => createSubtask({ parentId, title })}
        onToggleSubtaskDone={(sub) =>
          handleSubtaskToggle(t, sub, subtasksByParent.get(t.id) ?? EMPTY_TASKS)
        }
        onDeleteSubtask={(sub) => remove({ id: sub.id })}
        onPromoteSubtask={(sub) => promoteSubtask(sub.id)}
        onEditSubtask={(sub, title) => upsert({ id: sub.id, title })}
        onSetParent={(id, parentId) => setParent(id, parentId)}
      />
    )
  }
}

// 模块级空数组保证引用稳定（避免 zustand selector 返回内联数组陷阱）
const EMPTY_TASKS: Task[] = []
const EMPTY_TAGS: string[] = []

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

// ---------- v1.10.8：分组标题（语义色：逾期=红警示，今天=橙提醒，其他=灰） ----------
function GroupHeader({
  groupKey,
  label,
  count,
  groupBy,
}: {
  groupKey: string
  label: string
  count: number
  groupBy: GroupBy
}) {
  // 截止日维度：逾期红 / 今天橙 / 明天提醒蓝，其他灰
  // 优先级维度：高红 / 中橙 / 低灰
  let Icon = Bell
  let color = 'text-muted-foreground'
  if (groupBy === 'due') {
    if (groupKey === 'overdue') {
      Icon = AlertCircle
      color = 'text-danger'
    } else if (groupKey === 'today') {
      Icon = Sun
      color = 'text-warning'
    } else if (groupKey === 'tomorrow') {
      Icon = Bell
      color = 'text-info'
    } else if (groupKey === 'noDate') {
      Icon = Bell
      color = 'text-muted-foreground'
    } else {
      Icon = Bell
      color = 'text-muted-foreground'
    }
  } else if (groupBy === 'priority') {
    if (groupKey === 'high') {
      Icon = AlertCircle
      color = 'text-danger'
    } else if (groupKey === 'medium') {
      Icon = Bell
      color = 'text-warning'
    } else {
      Icon = Bell
      color = 'text-muted-foreground'
    }
  }
  return (
    <div className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
      <Icon size={13} weight="duotone" />
      <span>{label}</span>
      <span className={color}>{count}</span>
    </div>
  )
}

// ---------- v1.10.8：已完成折叠区（沉到底部，默认折叠） ----------
function DoneSection({
  tasks,
  renderTaskCard,
}: {
  tasks: Task[]
  renderTaskCard: (t: Task) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <CheckCircle2 size={13} weight="duotone" className="text-success" />
        <span>已完成</span>
        <span>{tasks.length}</span>
      </button>
      {open && <div className="stagger-fade-up space-y-3">{tasks.map(renderTaskCard)}</div>}
    </section>
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

// v1.11：标签编辑器（编辑态用）。候选 = 字典 ∪ 当前标签，点选切换 + 输入新标签回车追加。
function TagEditor({
  tags,
  setTags,
  tagDict,
}: {
  tags: string[]
  setTags: (next: string[]) => void
  tagDict: string[]
}) {
  const [input, setInput] = useState('')
  // 候选标签 = 字典 ∪ 当前标签（去重），最多展示 20 个避免太长
  const candidates = useMemo(() => {
    const set = new Set<string>([...tagDict, ...tags])
    return Array.from(set).slice(0, 20)
  }, [tagDict, tags])

  const toggle = (tag: string) => {
    setTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag])
  }
  const addNew = () => {
    const t = input.trim()
    if (t && !tags.includes(t)) setTags([...tags, t])
    setInput('')
  }

  return (
    <div className="space-y-1.5">
      <Label>标签（可选）</Label>
      {/* 已选标签徽标（可点删除）*/}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => toggle(tag)}
              className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"
            >
              {tag} ✕
            </button>
          ))}
        </div>
      )}
      {/* 候选标签（点选切换）*/}
      {candidates.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {candidates
            .filter((c) => !tags.includes(c))
            .map((tag) => (
              <button
                key={tag}
                onClick={() => toggle(tag)}
                className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/10 hover:text-accent"
              >
                + {tag}
              </button>
            ))}
        </div>
      )}
      {/* 输入新标签：回车/失焦/保存时自动提交（不用手动回车）*/}
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="输入新标签，回车或失焦自动添加"
        className="h-8 text-xs"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            e.preventDefault()
            addNew()
          }
        }}
        onBlur={() => {
          if (input.trim()) addNew()
        }}
      />
    </div>
  )
}

// ---------- v1.14：递归任务节点（支持无限层级）----------
// 渲染单个子任务 + 它的后代（递归）。缩进 + 左竖线表达层级。
// 每个节点都有：勾选/inline编辑标题/加子任务/转根/删除。
interface TaskNodeProps {
  task: Task
  depth: number
  subtasksByParent: Map<string, Task[]>
  onToggleDone: (sub: Task) => void
  onEditTitle: (sub: Task, title: string) => void
  onAddSubtask: (parentId: string, title: string) => void
  onPromote: (sub: Task) => void
  onDelete: (sub: Task) => void
}
function TaskNode({
  task,
  depth,
  subtasksByParent,
  onToggleDone,
  onEditTitle,
  onAddSubtask,
  onPromote,
  onDelete,
}: TaskNodeProps) {
  const subs = subtasksByParent.get(task.id) ?? EMPTY_TASKS
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(task.title)
  const [open, setOpen] = useState(subs.length > 0) // 有子任务默认展开
  const [adding, setAdding] = useState(false)
  const [addInput, setAddInput] = useState('')

  const done = task.status === 'done'
  return (
    <div className="space-y-0.5">
      <div
        className="group flex items-center gap-2 py-0.5"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <button
          onClick={() => onToggleDone(task)}
          title={done ? '标记为待办' : '标记完成'}
          className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-2 transition-colors ${
            done
              ? 'border-success bg-success text-primary-foreground'
              : 'border-muted-foreground/40 hover:border-primary'
          }`}
        >
          {done && <Check size={10} />}
        </button>
        {editing ? (
          <input
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            className="flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && editText.trim()) {
                onEditTitle(task, editText.trim())
                setEditing(false)
              } else if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={() => {
              if (editText.trim() && editText.trim() !== task.title) onEditTitle(task, editText.trim())
              setEditing(false)
            }}
          />
        ) : (
          <span
            className={`flex-1 text-sm ${done ? 'line-through opacity-60' : ''}`}
            onDoubleClick={() => {
              setEditing(true)
              setEditText(task.title)
            }}
          >
            {task.title}
          </span>
        )}
        {!editing && (
          <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => { setEditing(true); setEditText(task.title) }}
              title="编辑标题"
              className="text-muted-foreground hover:text-foreground"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={() => onPromote(task)}
              title="转为根任务"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowRight size={11} />
            </button>
            <button
              onClick={() => onDelete(task)}
              title="删除"
              className="text-muted-foreground hover:text-destructive"
            >
              删除
            </button>
          </div>
        )}
      </div>
      {/* 子任务区（递归）*/}
      {subs.length > 0 && (
        <div className="border-l border-border" style={{ marginLeft: `${depth * 16 + 8}px` }}>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 py-0.5 pl-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
            <span>子任务（{subs.length}）</span>
          </button>
          {open && (
            <div className="space-y-0.5 pl-2">
              {subs.map((sub) => (
                <TaskNode
                  key={sub.id}
                  task={sub}
                  depth={depth + 1}
                  subtasksByParent={subtasksByParent}
                  onToggleDone={onToggleDone}
                  onEditTitle={onEditTitle}
                  onAddSubtask={onAddSubtask}
                  onPromote={onPromote}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {/* 添加子任务（每个节点都有入口）*/}
      <div style={{ paddingLeft: `${depth * 16 + 16}px` }}>
        {adding ? (
          <Input
            autoFocus
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            placeholder="子任务标题，回车确认"
            className="h-7 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && addInput.trim()) {
                onAddSubtask(task.id, addInput.trim())
                setAddInput('')
                setAdding(false)
                setOpen(true)
              } else if (e.key === 'Escape') {
                setAddInput('')
                setAdding(false)
              }
            }}
            onBlur={() => { if (!addInput.trim()) setAdding(false) }}
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus size={11} /> 添加子任务
          </button>
        )}
      </div>
    </div>
  )
}

// ---------- 单个任务卡片（根任务，v1.10 含子任务区） ----------
function TaskCard({
  task,
  selectMode,
  selected,
  onToggleSelect,
  subtasks,
  allRootTasks,
  allTasks,
  subtasksByParent,
  tagDict,
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
  selectMode: boolean
  selected: boolean
  onToggleSelect: () => void
  subtasks: Task[]
  allRootTasks: Task[]
  allTasks: Task[]
  subtasksByParent: Map<string, Task[]>
  tagDict: string[]
  editing: boolean
  onEdit: () => void
  onSave: (input: TaskInput) => void
  onToggleDone: () => void
  onDelete: () => void
  onAddSubtask: (parentId: string, title: string) => void
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
  // v1.11：标签（编辑态本地副本，保存时随其他字段一起 upsert）
  const [tags, setTags] = useState<string[]>(task.tags)
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
      setTags(task.tags)
    }
  }, [editing, task])

  // 子任务数量变化时，无子任务自动收起
  useEffect(() => {
    if (subtasks.length === 0) setSubOpen(false)
  }, [subtasks.length])

  // v1.14：算自身所有后代 id（移动到下拉排除，防环路）。
  // 必须在 if(editing) return 之前定义——编辑态用到了它，否则 TDZ 报错。
  const descendantIds = useMemo(() => {
    const set = new Set<string>()
    let frontier = [task.id]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const id of frontier) {
        for (const child of subtasksByParent.get(id) ?? []) {
          if (!set.has(child.id)) {
            set.add(child.id)
            next.push(child.id)
          }
        }
      }
      frontier = next
    }
    return set
  }, [task.id, subtasksByParent])

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
          {/* v1.14：移动到（无限层级，列全部任务，排除自身和后代防环路）*/}
          <div className="space-y-1.5">
            <Label>移动到</Label>
            <SelectInput
              value={task.parentId ?? ''}
              onChange={(v) => onSetParent(task.id, v || null)}
              options={[
                { value: '', label: '独立（根任务）' },
                ...allTasks
                  .filter((r) => r.id !== task.id && !descendantIds.has(r.id))
                  .map((r) => ({ value: r.id, label: r.title })),
              ]}
            />
            <p className="text-[10px] text-muted-foreground">
              选一个任务作为父任务（支持任意层级）；选「独立」变回根任务。不能移到自己的子任务下
            </p>
          </div>
          {/* v1.11：标签编辑（候选来自字典 + 当前标签 + 输入新标签）*/}
          <TagEditor tags={tags} setTags={setTags} tagDict={tagDict} />
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
                  tags,
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

  // 展示态。v1.10.8：done 用「逻辑完成」（根+所有子任务全 done），与分组判定一致，
  // 避免根任务 status=done 但子任务未完成时显示已勾选却在未完成组的矛盾。
  const done = isLogicallyDone(task, subtasks)
  const doneSubCount = subtasks.filter((s) => s.status === 'done').length
  return (
    <Card className={`transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${done ? 'opacity-60' : ''} ${selected ? 'ring-2 ring-accent' : ''}`}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            {/* v1.22 批量选择 checkbox（仅 selectMode 时显示，在完成按钮左侧）*/}
            {selectMode && (
              <button
                onClick={onToggleSelect}
                title={selected ? '取消选择' : '选择'}
                className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 transition-colors ${
                  selected ? 'border-accent bg-accent text-primary-foreground' : 'border-muted-foreground/40 hover:border-accent'
                }`}
              >
                {selected && <Check size={12} />}
              </button>
            )}
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
          {/* v1.11：标签徽标（统一 accent 蓝，避免色彩泛滥）*/}
          {task.tags.map((tag) => (
            <span key={tag} className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              {tag}
            </span>
          ))}
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

        {/* v1.14：子任务区（无限层级，递归 TaskNode 渲染）。根任务的直接子任务列表可折叠。*/}
        <div className="space-y-1 border-t pt-2">
          {subtasks.length > 0 && (
            <button
              onClick={() => setSubOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {subOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}
              <span>子任务（{doneSubCount}/{subtasks.length}）</span>
            </button>
          )}
          {subOpen && subtasks.map((sub) => (
            <TaskNode
              key={sub.id}
              task={sub}
              depth={0}
              subtasksByParent={subtasksByParent}
              onToggleDone={onToggleSubtaskDone}
              onEditTitle={onEditSubtask}
              onAddSubtask={onAddSubtask}
              onPromote={onPromoteSubtask}
              onDelete={onDeleteSubtask}
            />
          ))}
          {/* 根任务的添加子任务入口（TaskNode 内部每个节点也各自有入口）*/}
          {addingSub ? (
            <Input
              autoFocus
              value={subInput}
              onChange={(e) => setSubInput(e.target.value)}
              placeholder="子任务标题，回车确认"
              className="h-7 text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && subInput.trim()) {
                  onAddSubtask(task.id, subInput.trim())
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
  const diffDays = diffDaysFromToday(unixSec)
  const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`
  if (diffDays === 0) return `今天（${dateStr}）`
  if (diffDays === 1) return `明天（${dateStr}）`
  if (diffDays < 0) return `已逾期 ${Math.abs(diffDays)} 天（${dateStr}）`
  if (diffDays <= 7) return `${diffDays} 天后（${dateStr}）`
  return dateStr
}

// v1.10.8：截止日相对今天的天数差（负=逾期，0=今天），抽公共给 getDueGroupKey 和 formatDueDate 共用
function diffDaysFromToday(unixSec: number): number {
  const d = new Date(unixSec * 1000)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((target.getTime() - today.getTime()) / 86400000)
}
