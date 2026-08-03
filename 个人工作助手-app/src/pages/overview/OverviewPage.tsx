import { useEffect, useState } from 'react'
import { useNavigate } from './nav'
import { CheckSquare, StickyNote, Bell, Timer, Sparkles, MessageSquare } from '@/components/ui/icons'
import { Card, CardContent } from '@/components/ui/card'
import { useTasksStore } from '@/stores/tasks'
import { useNotesStore } from '@/stores/notes'
import { useRemindersStore } from '@/stores/reminders'
import { invoke } from '@/lib/ipc'
import { useCountUp } from '@/lib/useCountUp'
import type { PomodoroSession, Task, Note } from '@/types'

/**
 * 概览首页（M13.4 v1.3 信息架构升级）。
 * 治「信息架构单一」：给应用一个有数据感的首页，聚合今日任务/跟进/专注/笔记。
 *
 * 数据全部从现有 store/IPC 取，无需新 IPC：
 *  - tasks/reminders/notes：现有 store refresh
 *  - pomodoro：pomodoro:list IPC（今日专注时长 = 今天 completed session 的 durationMin 之和）
 */
export function OverviewPage() {
  const goto = useNavigate()
  const { tasks, refresh: refreshTasks } = useTasksStore()
  const { notes, refresh: refreshNotes } = useNotesStore()
  const { reminders, refresh: refreshReminders } = useRemindersStore()
  const [focusMin, setFocusMin] = useState(0)

  useEffect(() => {
    refreshTasks()
    refreshNotes()
    refreshReminders()
    // 今日番茄钟专注时长
    ;(async () => {
      try {
        const sessions = await invoke<PomodoroSession[]>('pomodoro:list')
        const todayStart = new Date().setHours(0, 0, 0, 0) / 1000
        setFocusMin(
          sessions
            .filter((s) => s.completed && s.startedAt >= todayStart)
            .reduce((sum, s) => sum + s.durationMin, 0),
        )
      } catch {
        // 忽略
      }
    })()
  }, [refreshTasks, refreshNotes, refreshReminders])

  // 今日到期/逾期/高优先级未完成任务
  const now = Math.floor(Date.now() / 1000)
  const endOfToday = Math.floor(new Date().setHours(23, 59, 59, 999) / 1000)
  const pendingTasks = tasks.filter((t) => t.status !== 'done')
  const dueToday = pendingTasks.filter(
    (t) => (t.dueDate && t.dueDate <= endOfToday) || t.priority === 'high',
  )
  const pendingReminders = reminders.filter((r) => !r.done)
  const recentTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)
  const recentNotes = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)

  const hour = new Date().getHours()
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
        {/* 品牌头部（v1.5：电光蓝径向光晕 + 标题入场）*/}
        <header className="relative mb-8 overflow-hidden">
          <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative flex items-end justify-between">
            <div className="animate-fade-up">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles size={14} weight="fill" className="text-accent" />
                个人工作助手
              </div>
              <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
                {greeting}，今天专注什么？
              </h1>
            </div>
            <div className="text-right text-sm text-muted-foreground">
              <div>{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</div>
              <div className="font-mono tabular-nums">
                {new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        </header>

        {/* 今日概览卡片网格（v1.5：stagger 入场 + count-up + hover）*/}
        <section className="mb-8 grid grid-cols-2 gap-4 stagger-fade-up lg:grid-cols-4">
          <StatCard
            icon={CheckSquare}
            label="待办任务"
            value={pendingTasks.length}
            hint={`${dueToday.length} 项今日紧急`}
            tone="info"
            onClick={() => goto('tasks')}
          />
          <StatCard
            icon={Bell}
            label="待触发提醒"
            value={pendingReminders.length}
            hint={pendingReminders.length > 0 ? '最近的会到点通知' : '暂无'}
            tone="warning"
            onClick={() => goto('tools')}
          />
          <StatCard
            icon={Timer}
            label="今日专注"
            value={focusMin}
            unit="分钟"
            hint={focusMin > 0 ? `${Math.floor(focusMin / 25)} 个番茄钟` : '开始一个吧'}
            tone="success"
            onClick={() => goto('chat')}
          />
          <StatCard
            icon={StickyNote}
            label="笔记总数"
            value={notes.length}
            hint={recentNotes.length > 0 ? `最近：${recentNotes[0].title}` : '暂无'}
            tone="accent"
            onClick={() => goto('notes')}
          />
        </section>

        {/* 快捷入口（v1.5：stagger 入场 + hover）*/}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">快捷入口</h2>
          <div className="stagger-fade-up grid grid-cols-2 gap-3 sm:grid-cols-4">
            <QuickAction icon={MessageSquare} label="开始对话" desc="问点什么" onClick={() => goto('chat')} />
            <QuickAction icon={CheckSquare} label="新建任务" desc="添加待办" onClick={() => goto('tasks')} />
            <QuickAction icon={StickyNote} label="写笔记" desc="记录想法" onClick={() => goto('notes')} />
            <QuickAction icon={Timer} label="番茄钟" desc="开始专注" onClick={() => goto('chat')} />
          </div>
        </section>

        {/* 最近活动 */}
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <RecentList
            title="最近任务"
            icon={CheckSquare}
            items={recentTasks.map((t) => ({
              id: t.id,
              primary: t.title,
              secondary: t.status === 'done' ? '已完成' : t.priority === 'high' ? '高优先级' : '待办',
              done: t.status === 'done',
            }))}
            emptyHint="还没有任务，去任务页新建一个"
            onMore={() => goto('tasks')}
          />
          <RecentList
            title="最近笔记"
            icon={StickyNote}
            items={recentNotes.map((n) => ({
              id: n.id,
              primary: n.title,
              secondary: relativeTime(n.updatedAt),
            }))}
            emptyHint="还没有笔记，在对话里说「把这段存成笔记」让 AI 帮你记"
            onMore={() => goto('notes')}
          />
        </section>
      </div>
    </div>
  )
}

// ---------- 子组件 ----------

type Tone = 'info' | 'success' | 'warning' | 'accent'
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
  onClick,
}: {
  icon: typeof CheckSquare
  label: string
  value: number
  unit?: string
  hint: string
  tone: Tone
  onClick: () => void
}) {
  const t = TONE_STYLE[tone]
  const animated = useCountUp(value)
  return (
    <button onClick={onClick} className="text-left">
      <Card className="cursor-pointer p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg">
        <CardContent className="flex items-start justify-between p-0">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="font-display text-3xl font-semibold tabular-nums">{animated}</span>
              {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
          </div>
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${t.bg}`}>
            <Icon size={20} weight="duotone" className={t.text} />
          </div>
        </CardContent>
      </Card>
    </button>
  )
}

function QuickAction({
  icon: Icon,
  label,
  desc,
  onClick,
}: {
  icon: typeof CheckSquare
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

function RecentList({
  title,
  icon: Icon,
  items,
  emptyHint,
  onMore,
}: {
  title: string
  icon: typeof CheckSquare
  items: { id: string; primary: string; secondary: string; done?: boolean }[]
  emptyHint: string
  onMore: () => void
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          <Icon size={14} weight="fill" className="text-muted-foreground" />
          {title}
        </h2>
        <button onClick={onMore} className="text-xs text-accent hover:underline">
          查看全部
        </button>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {emptyHint}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div
              key={it.id}
              className="stagger-item flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2 shadow-xs"
            >
              <span className={`truncate text-sm ${it.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                {it.primary}
              </span>
              <span className="ml-2 flex-shrink-0 text-xs text-muted-foreground">{it.secondary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  const d = new Date(unixSec * 1000)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}
