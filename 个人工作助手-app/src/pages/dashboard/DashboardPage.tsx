import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Timer, CheckSquare, StickyNote, MessageSquare, TrendUp, TrendDown, Minus } from '@/components/ui/icons'
import { Card, CardContent } from '@/components/ui/card'
import { useDashboardStore } from '@/stores/dashboard'
import { useCountUp } from '@/lib/useCountUp'
import { computeLogicallyDoneIds } from '@/lib/taskStatus'
import { useNavigate } from '@/pages/overview/nav'
import {
  FocusTrendChart,
  TaskTrendChart,
  TaskStatusPie,
  FocusByHourBar,
  STATUS_COLORS,
  type FocusPoint,
  type TaskTrendPoint,
  type StatusSlice,
  type HourBucket,
} from './charts'
import type { DashboardRange } from '@/types'

/**
 * 数据看板页（v1.4 M14）。
 *
 * 与概览页的区别（见 stores/dashboard.ts 注释 + ADR-020）：
 *  - 概览 = 今日快照（默认首页，今日数据 + 快捷入口）
 *  - 看板 = 历史趋势（可切换 7天/30天/全部 的生产力分析）
 *
 * 数据源：全部从 useDashboardStore 取（store 内部按 range 并发拉取多源）。
 * 聚合在前端做：pomodoro 按 startedAt、tasks/notes 按 createdAt 过滤到当前 range。
 */
const RANGE_OPTIONS: { value: DashboardRange; label: string }[] = [
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
]

/** 图表模式：趋势（折线+柱状）/ 分布（饼图+柱状）。每次只显示一组，省纵向空间。 */
type ChartMode = 'trend' | 'distribution'
const CHART_MODE_OPTIONS: { value: ChartMode; label: string }[] = [
  { value: 'trend', label: '趋势' },
  { value: 'distribution', label: '分布' },
]

/** Unix 秒转 'YYYY-MM-DD'（本地时区，与 SQLite date(unixepoch) 的 UTC 不同，但前端一致即可）。 */
function toDateLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 生成 [fromSec..今天] 每一天的日期标签数组。all 模式返回 null（不补零，按实际有数据的天显示）。 */
function buildDateRange(fromSec: number, isAll: boolean): string[] | null {
  if (isAll) return null
  const dates: string[] = []
  const startDay = new Date(fromSec * 1000)
  startDay.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let d = new Date(startDay); d <= today; d.setDate(d.getDate() + 1)) {
    dates.push(toDateLabel(Math.floor(d.getTime() / 1000)))
  }
  return dates
}

export function DashboardPage() {
  const { range, pomodoro, tasks, notes, activity, loading, error, refresh, setRange } =
    useDashboardStore()
  const [chartMode, setChartMode] = useState<ChartMode>('trend')
  const goto = useNavigate()

  useEffect(() => {
    refresh()
  }, [refresh])

  // range 换算成 fromSec，用于前端过滤全量 list（all 不过滤）
  const fromSec = useMemo(() => {
    if (range === 'all') return 0
    const days = range === '7d' ? 7 : 30
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - (days - 1))
    return Math.floor(d.getTime() / 1000)
  }, [range])

  // 按范围过滤后的数据
  const pomodoroInRange = useMemo(
    () => pomodoro.filter((s) => s.startedAt >= fromSec),
    [pomodoro, fromSec],
  )
  // v1.10.8：只算根任务（子任务不独立计数，与任务页/概览页口径一致）。
  // 子任务是根任务的组成部分，独立计数会导致「总数对不上」。
  const tasksInRange = useMemo(
    () => tasks.filter((t) => t.parentId === null && t.createdAt >= fromSec),
    [tasks, fromSec],
  )
  const notesInRange = useMemo(() => notes.filter((n) => n.createdAt >= fromSec), [notes, fromSec])

  // 指标计算
  const totalFocusMin = pomodoroInRange
    .filter((s) => s.completed)
    .reduce((sum, s) => sum + s.durationMin, 0)
  const completedCount = pomodoroInRange.filter((s) => s.completed).length
  const interruptedCount = pomodoroInRange.filter((s) => !s.completed).length

  // v1.10.8：doneTasks 用「逻辑完成」判定（根+所有子任务全 done）。
  // computeLogicallyDoneIds 基于全量 tasks 算（需完整子任务索引），再与时间范围取交集。
  const logicallyDoneIds = useMemo(() => computeLogicallyDoneIds(tasks), [tasks])
  const doneTasks = tasksInRange.filter((t) => logicallyDoneIds.has(t.id)).length
  const completionRate =
    tasksInRange.length > 0 ? Math.round((doneTasks / tasksInRange.length) * 100) : 0

  const messageCount = activity.reduce((sum, a) => sum + a.count, 0)

  // 图表数据聚合（按天分组，补零让折线连续）
  const focusTrend = useMemo<FocusPoint[]>(() => {
    const dateList = buildDateRange(fromSec, range === 'all')
    // all 模式：只显示有数据的天；范围模式：补零显示每一天
    if (!dateList) {
      const map = new Map<string, number>()
      for (const s of pomodoroInRange) {
        if (!s.completed) continue
        const key = toDateLabel(s.startedAt)
        map.set(key, (map.get(key) ?? 0) + s.durationMin)
      }
      return Array.from(map, ([date, minutes]) => ({ date, minutes })).sort((a, b) =>
        a.date < b.date ? -1 : 1,
      )
    }
    const map = new Map<string, number>()
    for (const s of pomodoroInRange) {
      if (!s.completed) continue
      const key = toDateLabel(s.startedAt)
      map.set(key, (map.get(key) ?? 0) + s.durationMin)
    }
    return dateList.map((date) => ({ date, minutes: map.get(date) ?? 0 }))
  }, [pomodoroInRange, fromSec, range])

  const taskTrend = useMemo<TaskTrendPoint[]>(() => {
    const dateList = buildDateRange(fromSec, range === 'all')
    if (!dateList) {
      const map = new Map<string, number>()
      for (const t of tasksInRange) {
        const key = toDateLabel(t.createdAt)
        map.set(key, (map.get(key) ?? 0) + 1)
      }
      return Array.from(map, ([date, created]) => ({ date, created })).sort((a, b) =>
        a.date < b.date ? -1 : 1,
      )
    }
    const map = new Map<string, number>()
    for (const t of tasksInRange) {
      const key = toDateLabel(t.createdAt)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return dateList.map((date) => ({ date, created: map.get(date) ?? 0 }))
  }, [tasksInRange, fromSec, range])

  // 任务状态分布（范围内任务的当前状态构成）
  const statusSlices = useMemo<StatusSlice[]>(() => {
    const counts = { todo: 0, in_progress: 0, done: 0 }
    for (const t of tasksInRange) counts[t.status]++
    return [
      { name: '已完成', value: counts.done, color: STATUS_COLORS.done },
      { name: '进行中', value: counts.in_progress, color: STATUS_COLORS.in_progress },
      { name: '待办', value: counts.todo, color: STATUS_COLORS.todo },
    ].filter((s) => s.value > 0)
  }, [tasksInRange])

  // 专注时段分布（按 startedAt 的小时分 4 桶）
  const hourBuckets = useMemo<HourBucket[]>(() => {
    const buckets = [
      { label: '深夜', minutes: 0 },
      { label: '早晨', minutes: 0 },
      { label: '下午', minutes: 0 },
      { label: '晚间', minutes: 0 },
    ]
    for (const s of pomodoroInRange) {
      if (!s.completed) continue
      const h = new Date(s.startedAt * 1000).getHours()
      const idx = Math.floor(h / 6)
      buckets[idx].minutes += s.durationMin
    }
    return buckets
  }, [pomodoroInRange])

  // StatCard 趋势数据（v1.10.8：近 7 天 vs 前 7 天，算百分比变化，替代裸 sparkline）
  const sevenDaysAgo = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - 6)
    return Math.floor(d.getTime() / 1000)
  }, [])
  const fourteenDaysAgo = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - 13)
    return Math.floor(d.getTime() / 1000)
  }, [])

  // 趋势类型（模块级定义，StatCard/TrendBadge 共用）
  // pct=null 表示前7天无数据（显示「新增」而非百分比）

  // 算一组值的趋势：currentSum（近7天）/ previousSum（前7天）
  function computeTrend(currentSum: number, previousSum: number): TrendInfo {
    if (previousSum === 0) {
      return { pct: null, dir: currentSum > 0 ? 'up' : 'flat' }
    }
    const pct = Math.round(((currentSum - previousSum) / previousSum) * 100)
    return { pct, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
  }

  const trends = useMemo(() => {
    // 近7天 / 前7天 各指标总和
    const sum = (arr: { ts: number; val: number }[], from: number, to: number) =>
      arr.filter((x) => x.ts >= from && x.ts < to).reduce((s, x) => s + x.val, 0)

    const focusData = pomodoro
      .filter((s) => s.completed)
      .map((s) => ({ ts: s.startedAt, val: s.durationMin }))
    const taskData = tasks
      .filter((t) => !t.parentId && t.completedAt)
      .map((t) => ({ ts: t.completedAt as number, val: 1 }))
    const noteData = notes.map((n) => ({ ts: n.createdAt, val: 1 }))
    const msgData = activity.map((a) => ({
      ts: Math.floor(new Date(a.date).getTime() / 1000),
      val: a.count,
    }))

    return {
      focus: computeTrend(sum(focusData, sevenDaysAgo, Date.now() / 1000), sum(focusData, fourteenDaysAgo, sevenDaysAgo)),
      task: computeTrend(sum(taskData, sevenDaysAgo, Date.now() / 1000), sum(taskData, fourteenDaysAgo, sevenDaysAgo)),
      note: computeTrend(sum(noteData, sevenDaysAgo, Date.now() / 1000), sum(noteData, fourteenDaysAgo, sevenDaysAgo)),
      msg: computeTrend(sum(msgData, sevenDaysAgo, Date.now() / 1000), sum(msgData, fourteenDaysAgo, sevenDaysAgo)),
    }
  }, [pomodoro, tasks, notes, activity, sevenDaysAgo, fourteenDaysAgo])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
        {/* 品牌头部 + 时间范围切换器（v1.4：电光蓝径向光晕 + 标题入场）*/}
        <header className="relative mb-8 overflow-hidden">
          <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative flex items-end justify-between">
            <div className="animate-fade-up">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles size={14} weight="fill" className="text-accent" />
                数据看板
              </div>
              <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
                生产力分析
              </h1>
            </div>
            <SegmentedSwitcher value={range} onChange={setRange} options={RANGE_OPTIONS} />
          </div>
        </header>

        {error ? (
          <div className="text-sm text-danger">加载失败：{error}</div>
        ) : loading && pomodoro.length === 0 ? (
          <div className="text-sm text-muted-foreground">加载中…</div>
        ) : (
          <>
            {/* 快捷入口（v1.4：一打开就能用，看完数据直接行动）*/}
            <section className="mb-6 stagger-fade-up grid grid-cols-2 gap-3 sm:grid-cols-4">
              <QuickAction
                icon={Timer}
                label="开始专注"
                desc="番茄钟"
                onClick={() => goto('chat')}
              />
              <QuickAction
                icon={CheckSquare}
                label="新建任务"
                desc="添加待办"
                onClick={() => goto('tasks')}
              />
              <QuickAction
                icon={StickyNote}
                label="写笔记"
                desc="记录想法"
                onClick={() => goto('notes')}
              />
              <QuickAction
                icon={MessageSquare}
                label="开始对话"
                desc="问点什么"
                onClick={() => goto('chat')}
              />
            </section>

            {/* StatCard 网格（v1.10.8：count-up + hover + 趋势徽标，替代裸 sparkline）*/}
            <section className="mb-8 grid grid-cols-2 gap-4 stagger-fade-up lg:grid-cols-4">
              <StatCard
                icon={Timer}
                label="专注时长"
                value={totalFocusMin}
                unit="分钟"
                hint={
                  completedCount + interruptedCount > 0
                    ? `完成 ${completedCount} / 中断 ${interruptedCount}`
                    : '暂无番茄钟记录'
                }
                tone="success"
                trend={trends.focus}
              />
              <StatCard
                icon={CheckSquare}
                label="完成任务"
                value={doneTasks}
                unit={`/ ${tasksInRange.length}`}
                hint={
                  tasksInRange.length > 0 ? `完成率 ${completionRate}%` : '该时段无任务'
                }
                tone="info"
                trend={trends.task}
              />
              <StatCard
                icon={StickyNote}
                label="新增笔记"
                value={notesInRange.length}
                hint={notesInRange.length > 0 ? '篇笔记' : '暂无新笔记'}
                tone="accent"
                trend={trends.note}
              />
              <StatCard
                icon={MessageSquare}
                label="对话消息"
                value={messageCount}
                hint={messageCount > 0 ? `${activity.length} 天有活跃` : '暂无对话'}
                tone="warning"
                trend={trends.msg}
              />
            </section>

            {/* 图表模式切换器（趋势/分布）+ 图表 */}
            <div className="mb-4 flex justify-center">
              <SegmentedSwitcher value={chartMode} onChange={setChartMode} options={CHART_MODE_OPTIONS} />
            </div>

            {chartMode === 'trend' ? (
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <FocusTrendChart data={focusTrend} />
                <TaskTrendChart data={taskTrend} />
              </section>
            ) : (
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <TaskStatusPie data={statusSlices} />
                <FocusByHourBar data={hourBuckets} />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 子组件 ----------

/** 通用分段切换器：选中态用 v1.3 红线规范（bg-accent/10 + text-accent，不用实色 bg-accent）。 */
function SegmentedSwitcher<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-surface-3 p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            value === opt.value
              ? 'bg-accent/10 text-accent shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/** 快捷入口卡（v1.4：hover 微交互，skill Standard tier：y:-1+shadow 加深，CSS transition 实现）*/
function QuickAction({
  icon: Icon,
  label,
  desc,
  onClick,
}: {
  icon: typeof Timer
  label: string
  desc: string
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className="text-left">
      <Card className="cursor-pointer p-4 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg">
        <CardContent className="flex items-center gap-3 p-0">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Icon size={18} weight="duotone" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{label}</div>
            <div className="truncate text-xs text-muted-foreground">{desc}</div>
          </div>
        </CardContent>
      </Card>
    </button>
  )
}

type Tone = 'info' | 'success' | 'warning' | 'accent'
// v1.10.8：趋势信息（近7天 vs 前7天）。pct=null 表示前7天无数据。
type TrendInfo = { pct: number | null; dir: 'up' | 'down' | 'flat' }
const TONE_STYLE: Record<Tone, { bg: string; text: string }> = {
  info: { bg: 'bg-info/10', text: 'text-info' },
  success: { bg: 'bg-success/10', text: 'text-success' },
  warning: { bg: 'bg-warning/10', text: 'text-warning' },
  accent: { bg: 'bg-accent/10', text: 'text-accent' },
}

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  hint,
  tone,
  trend,
}: {
  icon: typeof Timer
  label: string
  value: number
  unit?: string
  hint: string
  tone: Tone
  trend?: TrendInfo
}) {
  const t = TONE_STYLE[tone]
  const animated = useCountUp(value)
  return (
    <Card className="p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg">
      <CardContent className="flex items-start justify-between p-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="font-display text-3xl font-semibold tabular-nums">{animated}</span>
            {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate text-xs text-muted-foreground">{hint}</span>
            {trend && <TrendBadge trend={trend} />}
          </div>
        </div>
        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${t.bg}`}>
          <Icon size={20} weight="duotone" className={t.text} />
        </div>
      </CardContent>
    </Card>
  )
}

// v1.10.8：趋势徽标（替代裸 sparkline）。近7天 vs 前7天的百分比变化。
// ↑ 绿（增长）/ ↓ 红（下降）/ → 灰（持平）/ 新增 灰（前7天无数据）。
// 裸折线无上下文用户以为出 bug（NN/g、PatternFly 共识：sparkline 必须配标签）。
function TrendBadge({ trend }: { trend: TrendInfo }) {
  const { pct, dir } = trend
  if (pct === null) {
    // 前7天无数据
    if (dir === 'flat') return null // 近7天也0，不显示
    return (
      <span className="flex flex-shrink-0 items-center gap-0.5 text-[10px] font-medium text-muted-foreground">
        <TrendUp size={11} weight="bold" /> 新增
      </span>
    )
  }
  const color = dir === 'up' ? 'text-success' : dir === 'down' ? 'text-danger' : 'text-muted-foreground'
  const Icon = dir === 'up' ? TrendUp : dir === 'down' ? TrendDown : Minus
  const sign = pct > 0 ? '+' : ''
  return (
    <span className={`flex flex-shrink-0 items-center gap-0.5 text-[10px] font-medium ${color}`}>
      <Icon size={11} weight="bold" /> {sign}{pct}%
    </span>
  )
}
