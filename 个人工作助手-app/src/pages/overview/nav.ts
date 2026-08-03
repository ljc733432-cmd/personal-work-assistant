import { create } from 'zustand'

/**
 * 轻量导航 store（v1.3 M13.4）。
 *
 * 项目无 router 库（App.tsx 用 useState 切 tab），概览页等需要跨页面跳转的
 * 场景用这个 store 协调：OverviewPage 调 setTab，App.tsx 订阅 tab 渲染对应页。
 * 避免引入 react-router（Electron 桌面应用单窗口，状态机切 tab 足够）。
 */
export type Tab = 'overview' | 'dashboard' | 'chat' | 'tasks' | 'notes' | 'tools' | 'settings'

interface NavState {
  tab: Tab
  setTab: (tab: Tab) => void
}

export const useNavStore = create<NavState>((set) => ({
  tab: 'overview', // v1.3 默认首页从 chat 改为 overview
  setTab: (tab) => set({ tab }),
}))

/**
 * 类 router 的 useNavigate hook（返回 setTab 函数）。
 * 给 OverviewPage 等需要跳转的组件用，语义直观：const goto = useNavigate(); goto('tasks')。
 */
export function useNavigate(): (tab: Tab) => void {
  return useNavStore((s) => s.setTab)
}

