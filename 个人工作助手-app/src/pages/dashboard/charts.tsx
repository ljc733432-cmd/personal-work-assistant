import { useEffect, useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Dashboard as ChartBar } from '@/components/ui/icons'
import { useThemeStore } from '@/stores/theme'

/**
 * 看板图表组件（v1.4 M14.3）。
 *
 * 关键设计：
 *  - 颜色读 CSS 变量（--accent/--success/--muted-foreground），不写死十六进制，
 *    浅深主题切换时自动跟随。recharts 不会响应 CSS 变量变化，故监听 theme.resolved
 *    触发重渲染（key 改变重建图表）。
 *  - 空数据走 EmptyState（v1.3 红线：不手写 div+小图标）。
 *  - ResponsiveContainer 必须有明确高度的父容器，故 ChartCard 固定图表区高度 240px。
 *  - cssVar 带 fallback：首次渲染/变量未就绪时返回安全兜底色，避免空字符串传给 SVG。
 */

/** 读 CSS 颜色变量并转 hsl() 字符串（变量存的是 HSL 分量，如 '221 100% 50%'）。读不到用 fallback。 */
function cssVar(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw) return fallback
  return raw.includes('%') ? `hsl(${raw})` : raw
}

/** 监听主题变化，返回一个 key 用于强制重建图表（让颜色变量重新读取）。 */
function useThemeKey(): string {
  const resolved = useThemeStore((s) => s.resolved)
  const [key, setKey] = useState(resolved)
  // resolved 变化后延迟一帧，确保 CSS 变量已切换再读
  useEffect(() => {
    const id = requestAnimationFrame(() => setKey(resolved))
    return () => cancelAnimationFrame(id)
  }, [resolved])
  return key
}

/** 通用图表卡片：标题 + 图表区（固定高度）+ 空状态兜底。 */
function ChartCard({
  title,
  isEmpty,
  children,
}: {
  title: string
  isEmpty: boolean
  children: React.ReactNode
}) {
  return (
    <Card className="p-5">
      <CardContent className="p-0">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {isEmpty ? (
          <EmptyState icon={ChartBar} title="暂无数据" hint="这个时间段还没有记录" />
        ) : (
          <div className="h-60 w-full">{children}</div>
        )}
      </CardContent>
    </Card>
  )
}

export type FocusPoint = { date: string; minutes: number }

/** 专注趋势折线图：按天显示专注分钟数（电光蓝描边 + 渐变填充）。 */
export function FocusTrendChart({ data }: { data: FocusPoint[] }) {
  const themeKey = useThemeKey()
  const accent = cssVar('--accent', '#0066FF')
  const muted = cssVar('--muted-foreground', '#71717A')
  const grid = cssVar('--border', '#E4E4E7')
  const surface2 = cssVar('--surface-2', '#FFFFFF')
  const foreground = cssVar('--foreground', '#18181B')

  return (
    <ChartCard title="专注趋势（分钟/天）" isEmpty={data.length === 0}>
      <ResponsiveContainer key={themeKey} width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="focusGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={accent} stopOpacity={0.3} />
              <stop offset="95%" stopColor={accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
          <XAxis
            dataKey="date"
            stroke={muted}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis stroke={muted} tick={{ fontSize: 11 }} width={36} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: surface2,
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
              color: foreground,
            }}
            labelStyle={{ color: muted }}
            formatter={(value) => [`${value} 分钟`, '专注']}
          />
          <Line
            type="monotone"
            dataKey="minutes"
            stroke={accent}
            strokeWidth={2}
            dot={{ r: 3, fill: accent, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
            fill="url(#focusGradient)"
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

export type TaskTrendPoint = { date: string; created: number }

/**
 * 任务新建趋势柱状图。
 * 不做"完成趋势"双柱——因为任务表无独立 completedAt 字段，用 updatedAt 近似完成日会误导
 * （updatedAt 可能是改标题而非完成）。完成数据在 StatCard 用完成率体现更诚实。
 */
export function TaskTrendChart({ data }: { data: TaskTrendPoint[] }) {
  const themeKey = useThemeKey()
  const accent = cssVar('--accent', '#0066FF')
  const muted = cssVar('--muted-foreground', '#71717A')
  const grid = cssVar('--border', '#E4E4E7')
  const surface2 = cssVar('--surface-2', '#FFFFFF')
  const foreground = cssVar('--foreground', '#18181B')

  return (
    <ChartCard title="任务新建（条/天）" isEmpty={data.length === 0}>
      <ResponsiveContainer key={themeKey} width="100%" height="100%">
        <BarChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
          <XAxis
            dataKey="date"
            stroke={muted}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis stroke={muted} tick={{ fontSize: 11 }} width={36} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: surface2,
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
              color: foreground,
            }}
            labelStyle={{ color: muted }}
            cursor={{ fill: grid, opacity: 0.3 }}
            formatter={(value) => [`${value} 条`, '新建']}
          />
          <Bar dataKey="created" fill={accent} radius={[3, 3, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ---------- 分布图（M14.4） ----------

export type StatusSlice = { name: string; value: number; color: string }

const STATUS_COLORS = {
  done: '#22C55E',
  in_progress: '#0066FF',
  todo: '#F59E0B',
}

/**
 * 任务状态分布饼图。
 * 注意：分布是「范围内任务的当前状态」，非历史快照（任务表无状态变更日志）。
 * 即统计 createdAt 在范围内的任务，看它们现在的状态构成。全完成则全绿。
 */
export function TaskStatusPie({ data }: { data: StatusSlice[] }) {
  const themeKey = useThemeKey()
  const muted = cssVar('--muted-foreground', '#71717A')
  const grid = cssVar('--border', '#E4E4E7')
  const surface2 = cssVar('--surface-2', '#FFFFFF')
  const foreground = cssVar('--foreground', '#18181B')
  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <ChartCard title="任务状态分布" isEmpty={total === 0}>
      <ResponsiveContainer key={themeKey} width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={45}
            outerRadius={75}
            paddingAngle={2}
            label={({ name, percent }) =>
              `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
            }
            labelLine={{ stroke: muted }}
          >
            {data.map((entry, i) => (
              <Cell key={`cell-${i}`} fill={entry.color} stroke={surface2} strokeWidth={2} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: surface2,
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
              color: foreground,
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

export type HourBucket = { label: string; minutes: number }

/** 专注按时段分布柱状图：把番茄钟按 startedAt 的小时分到 4 个时段。 */
export function FocusByHourBar({ data }: { data: HourBucket[] }) {
  const themeKey = useThemeKey()
  const accent = cssVar('--accent', '#0066FF')
  const muted = cssVar('--muted-foreground', '#71717A')
  const grid = cssVar('--border', '#E4E4E7')
  const surface2 = cssVar('--surface-2', '#FFFFFF')
  const foreground = cssVar('--foreground', '#18181B')

  return (
    <ChartCard title="专注时段分布（分钟）" isEmpty={data.every((d) => d.minutes === 0)}>
      <ResponsiveContainer key={themeKey} width="100%" height="100%">
        <BarChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
          <XAxis dataKey="label" stroke={muted} tick={{ fontSize: 11 }} />
          <YAxis stroke={muted} tick={{ fontSize: 11 }} width={36} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: surface2,
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
              color: foreground,
            }}
            labelStyle={{ color: muted }}
            cursor={{ fill: grid, opacity: 0.3 }}
            formatter={(value) => [`${value} 分钟`, '专注']}
          />
          <Bar dataKey="minutes" fill={accent} radius={[3, 3, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

export { STATUS_COLORS }
