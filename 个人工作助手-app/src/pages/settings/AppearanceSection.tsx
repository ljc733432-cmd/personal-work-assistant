import { Monitor, Sun, Moon } from 'lucide-react'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import { cn } from '@/lib/utils'

/**
 * 外观分区（M12.4）。
 * 三选一：跟随系统 / 浅色 / 深色。主题逻辑见 stores/theme.ts。
 */
const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'system', label: '跟随系统', icon: Monitor },
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'dark', label: '深色', icon: Moon },
]

export function AppearanceSection() {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">外观</h2>
      <p className="text-sm text-muted-foreground">选择应用主题。跟随系统会随操作系统深浅模式自动切换。</p>

      <div className="flex gap-2 pt-1">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon
          const active = mode === opt.mode
          return (
            <button
              key={opt.mode}
              onClick={() => void setMode(opt.mode)}
              className={cn(
                'flex flex-1 flex-col items-center gap-1.5 border px-3 py-3 text-sm transition-colors',
                active
                  ? 'border-accent bg-accent/5 text-accent'
                  : 'border-border text-muted-foreground hover:bg-accent/5',
              )}
            >
              <Icon size={18} strokeWidth={2} />
              <span>{opt.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
