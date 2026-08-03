import { useState } from 'react'
import { Bell, Timer, FileText, ArrowLeft } from '@/components/ui/icons'
import { cn } from '@/lib/utils'
import { ReminderSection } from './ReminderSection'
import { ConverterSection } from './ConverterSection'

/**
 * 工具页（M12.5~M12.9 v1.2 工具扩展）。
 * PRD §12.3：卡片网格入口 → 点进具体工具。
 * v1.2 四基础工具里：
 *   - 提醒（M12.5，本页内联）
 *   - 番茄钟（M12.6，顶栏小部件，本页只放说明卡）
 *   - 文档转换（M12.9，独立子页）
 *   - 笔记（M12.7~8，独立导航项，不在此）
 */
type Tool = 'reminders' | 'pomodoro' | 'converter' | null

export function ToolsPage() {
  const [active, setActive] = useState<Tool>(null)

  if (active === 'reminders') {
    return <ReminderSection onBack={() => setActive(null)} />
  }
  if (active === 'converter') {
    return <ConverterSection onBack={() => setActive(null)} />
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">工具</h1>
        <p className="mb-6 text-sm text-muted-foreground">高频轻量工具集合</p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ToolCard
            icon={Bell}
            title="提醒"
            desc="到点通知，区别于任务跟进"
            onClick={() => setActive('reminders')}
          />
          <ToolCard icon={Timer} title="番茄钟" desc="25 分钟专注计时（侧栏常驻）" />
          <ToolCard
            icon={FileText}
            title="文档转换"
            desc="Markdown / DOCX / PDF 互转"
            onClick={() => setActive('converter')}
          />
        </div>
      </div>
    </div>
  )
}

function ToolCard({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: typeof Bell
  title: string
  desc: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'group flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-5 text-left shadow-sm transition-all duration-200',
        onClick ? 'hover:-translate-y-0.5 hover:shadow-md' : 'cursor-not-allowed opacity-60',
      )}
    >
      {/* 图标容器：duotone 大图标 + accent 渐变背景（品牌感）*/}
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 transition-colors group-hover:bg-accent/15">
        <Icon size={26} weight="duotone" className="text-accent" />
      </div>
      <div className="font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{desc}</div>
    </button>
  )
}

/** 返回按钮（子页用）。 */
export function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={16} />
        返回
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  )
}
