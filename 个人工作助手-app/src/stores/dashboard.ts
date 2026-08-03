import { create } from 'zustand'
import type {
  ActivityPoint,
  DashboardRange,
  Note,
  PomodoroSession,
  Reminder,
  Task,
} from '@/types'
import { invoke } from '@/lib/ipc'

/**
 * 数据看板 store（v1.4 M14）。
 *
 * 与 OverviewPage 的区别（PRD §16.5 + ADR-020）：
 *  - Overview 是「今日快照」（默认首页，今日数据 + 快捷入口）
 *  - Dashboard 是「历史趋势」（可切换 7天/30天/全部 的生产力分析）
 *
 * 数据源策略（见 ADR-020）：
 *  - pomodoro/tasks/reminders/notes 复用现有 list（数据量小，前端 reduce 聚合）
 *  - messages 表可能大 → 走 dashboard:activity 聚合 IPC，只回 date+count
 *
 * 注意：pomodoro/list 等返回全表，range 过滤在前端做（按 startedAt/createdAt 过滤）。
 * 这是数据量小的妥协；若未来数据增长再改主进程带范围参数的 list。
 */
interface DashboardState {
  range: DashboardRange
  pomodoro: PomodoroSession[]
  tasks: Task[]
  notes: Note[]
  reminders: Reminder[]
  activity: ActivityPoint[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  setRange: (range: DashboardRange) => Promise<void>
}

/** 把 DashboardRange 换算成 fromSec（Unix 秒，闭区间起点）。all 返回 0。 */
function rangeToFromSec(range: DashboardRange): number {
  if (range === 'all') return 0
  const days = range === '7d' ? 7 : 30
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (days - 1))
  return Math.floor(d.getTime() / 1000)
}

/** range 的 toSec（今天 23:59:59）。 */
function rangeToToSec(): number {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return Math.floor(d.getTime() / 1000)
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  range: '7d',
  pomodoro: [],
  tasks: [],
  notes: [],
  reminders: [],
  activity: [],
  loading: false,
  error: null,

  refresh: async () => {
    const { range } = get()
    set({ loading: true, error: null })
    try {
      const fromSec = rangeToFromSec(range)
      const toSec = rangeToToSec()
      // 并发拉取全部数据源。pomodoro/tasks/reminders/notes 走现有全量 list；
      // activity 走聚合 IPC（messages 表大，不传 content）。
      const [pomodoro, tasks, notes, reminders, activity] = await Promise.all([
        invoke<PomodoroSession[]>('pomodoro:list'),
        invoke<Task[]>('task:list'),
        invoke<Note[]>('note:list'),
        invoke<Reminder[]>('reminder:list'),
        invoke<ActivityPoint[]>('dashboard:activity', { fromSec, toSec }),
      ])
      set({
        pomodoro,
        tasks,
        notes,
        reminders,
        activity,
        loading: false,
      })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  setRange: async (range) => {
    set({ range })
    await get().refresh()
  },
}))
