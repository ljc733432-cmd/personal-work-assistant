import { useState } from 'react'
import { Bell, Timer, FileText, ArrowLeft, FilePdf, ClipboardText, Graph, Screenshot } from '@/components/ui/icons'
import { cn } from '@/lib/utils'
import { ReminderSection } from './ReminderSection'
import { ConverterSection } from './ConverterSection'
import { PdfToolbox } from './PdfToolbox'
import { ReportToolbox } from './ReportToolbox'
import { MindmapToolbox } from './MindmapToolbox'
import { ScreenshotToolbox } from './ScreenshotToolbox'

/**
 * 工具页（M12.5~M12.9 v1.2 + M16 v1.7 + M17 v1.8 + v1.12 思维导图）。
 * PRD §12.3：卡片网格入口 → 点进具体工具。
 * v1.2 四基础工具 + v1.7 PDF 工具箱 + v1.8 AI 日报/周报 + v1.12 AI 思维导图。
 */
type Tool = 'reminders' | 'pomodoro' | 'converter' | 'pdf' | 'report' | 'mindmap' | 'screenshot' | null

export function ToolsPage() {
  const [active, setActive] = useState<Tool>(null)

  if (active === 'reminders') {
    return <ReminderSection onBack={() => setActive(null)} />
  }
  if (active === 'converter') {
    return <ConverterSection onBack={() => setActive(null)} />
  }
  if (active === 'pdf') {
    return <PdfToolbox onBack={() => setActive(null)} />
  }
  if (active === 'report') {
    return <ReportToolbox onBack={() => setActive(null)} />
  }
  if (active === 'mindmap') {
    return <MindmapToolbox onBack={() => setActive(null)} />
  }
  if (active === 'screenshot') {
    return <ScreenshotToolbox onBack={() => setActive(null)} />
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* 品牌头部（v1.5：电光蓝径向光晕 + 标题入场）*/}
        <header className="relative mb-6 overflow-hidden">
          <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative animate-fade-up">
            <h1 className="font-display text-xl font-semibold tracking-tight">工具</h1>
            <p className="mt-1 text-sm text-muted-foreground">高频轻量工具集合</p>
          </div>
        </header>

        <div className="stagger-fade-up grid grid-cols-1 gap-3 sm:grid-cols-3">
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
          <ToolCard
            icon={FilePdf}
            title="PDF 工具箱"
            desc="合并 / 提取 / 拆分"
            onClick={() => setActive('pdf')}
          />
          <ToolCard
            icon={ClipboardText}
            title="AI 日报/周报"
            desc="自动汇总今日/本周工作"
            onClick={() => setActive('report')}
          />
          <ToolCard
            icon={Graph}
            title="AI 思维导图"
            desc="主题/素材生成可交互导图"
            onClick={() => setActive('mindmap')}
          />
          <ToolCard
            icon={Screenshot}
            title="截图标注"
            desc="桌面截屏 + 画笔/箭头标注"
            onClick={() => setActive('screenshot')}
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
