import type { Icon } from '@phosphor-icons/react'

/**
 * 统一空状态（v1.3 M13.5）。
 * Phosphor 64px duotone 大图标 + 标题 + 引导文案，治「视觉元素太简」。
 * 全应用空状态走这个，保证品牌一致。
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: Icon
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent/5">
        <Icon size={48} weight="duotone" className="text-accent/60" />
      </div>
      <div className="text-base font-medium text-foreground">{title}</div>
      {hint && <div className="max-w-sm text-sm text-muted-foreground">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
