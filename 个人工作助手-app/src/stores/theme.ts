import { create } from 'zustand'
import { invoke } from '@/lib/ipc'

// v1.2 主题切换（PRD §12.5）。
//
// 持久化双轨：
//   1. localStorage —— 渲染层同步可读，用于防首屏闪烁（React 挂载前 initTheme 就能应用 .dark）
//   2. settings 表 appearance.theme —— 跨重启持久化（与其他 settings KV 一致）
// 两者在 setMode 时同步写；启动时 initTheme 从 localStorage 读（快路径），
// IPC 读 settings 校准（慢路径，防 localStorage 被清后仍能恢复）。
//
// 防闪烁：index.html 内联一段极小脚本在 React 之前从 localStorage 读并加 .dark class。
// 见 applySystemOrMode 注释。

export type ThemeMode = 'system' | 'light' | 'dark'
type Resolved = 'light' | 'dark'

const STORAGE_KEY = 'pwa.theme'
const SETTING_KEY = 'appearance.theme'

/** 模块级：判断系统当前深浅（用于 system 模式解析）。 */
function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

/** 把解析后的主题应用到 <html>（加/去 .dark class）。 */
export function applyDarkClass(dark: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', dark)
}

/** 启动时调用：从 localStorage 读 mode，应用初始 class（防闪烁）。 */
export function initTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  const stored = (localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? 'system'
  const dark = stored === 'dark' || (stored === 'system' && systemPrefersDark())
  applyDarkClass(dark)
  return stored
}

interface ThemeState {
  mode: ThemeMode
  /** mode 解析后的实际主题（system 时跟随系统）。组件订阅它做图标切换等。 */
  resolved: Resolved
  /** 启动后异步从 settings 表校准 mode（localStorage 可能被清）。 */
  hydrateFromSettings: () => Promise<void>
  setMode: (mode: ThemeMode) => Promise<void>
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  // 初始值：initTheme 已在模块加载时跑过（见下方立即调用），这里同步取
  mode: (typeof localStorage !== 'undefined'
    ? (localStorage.getItem(STORAGE_KEY) as ThemeMode | null)
    : null) ?? 'system',
  resolved: (typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
    ? 'dark'
    : 'light',

  hydrateFromSettings: async () => {
    try {
      const saved = await invoke<string | null>('settings:get', SETTING_KEY)
      if (saved === 'system' || saved === 'light' || saved === 'dark') {
        // settings 表是权威源（用户可能在另一处改过），校准
        await get().setMode(saved)
      }
    } catch {
      // IPC 失败（如 dev 早期）忽略，用 localStorage 的值
    }
  },

  setMode: async (mode) => {
    const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark())
    applyDarkClass(dark)
    set({ mode, resolved: dark ? 'dark' : 'light' })
    // 双轨持久化
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // localStorage 不可用（隐私模式）忽略
    }
    try {
      await invoke<true>('settings:set', SETTING_KEY, mode)
    } catch {
      // IPC 失败忽略（localStorage 已存，下次启动仍能恢复）
    }
  },
}))

/**
 * system 模式下监听系统主题变化，实时跟随。
 * 在 App 顶层 useEffect 调一次，卸载时取消。
 */
export function startSystemThemeWatcher(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    const { mode, setMode } = useThemeStore.getState()
    if (mode === 'system') {
      // 重新应用（setMode 内部会重新解析系统偏好）
      void setMode('system')
    }
  }
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
