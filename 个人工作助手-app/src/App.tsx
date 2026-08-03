import { useEffect } from 'react'
import {
  House,
  MessageSquare,
  CheckSquare,
  Settings,
  StickyNote,
  Wrench,
  Sun,
  Moon,
} from '@/components/ui/icons'
import { cn } from '@/lib/utils'
import { on } from '@/lib/ipc'
import { useChatStore } from '@/stores/chat'
import { useThemeStore, startSystemThemeWatcher } from '@/stores/theme'
import { PomodoroWidget } from '@/components/PomodoroWidget'
import { ChatPage } from '@/pages/chat/ChatPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { TasksPage } from '@/pages/tasks/TasksPage'
import { ToolsPage } from '@/pages/tools/ToolsPage'
import { NotesPage } from '@/pages/notes/NotesPage'
import { OverviewPage } from '@/pages/overview/OverviewPage'
import { useNavStore, type Tab } from '@/pages/overview/nav'

// v1.3：导航 6 项（概览/对话/任务/笔记/工具/设置）。默认首页改为概览。
// 导航 store 化（useNavStore），跨页跳转（OverviewPage 快捷入口）用 setTab。

function App() {
  const tab = useNavStore((s) => s.tab)
  const setTab = useNavStore((s) => s.setTab)
  const resolved = useThemeStore((s) => s.resolved)
  const setMode = useThemeStore((s) => s.setMode)

  // M6：订阅跟进通知点击 → 跳转到对话页 + 切到跟进会话
  useEffect(() => {
    return on('followup:open', (...args) => {
      const ev = args[0] as { conversationId: string }
      setTab('chat')
      useChatStore.getState().switchConversation(ev.conversationId).catch(() => {})
    })
  }, [setTab])

  // v1.2：system 模式下监听系统主题变化，实时跟随
  useEffect(() => startSystemThemeWatcher(), [])

  const toggleTheme = () => {
    void setMode(resolved === 'dark' ? 'light' : 'dark')
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* 侧栏（v1.3 Soft UI：bg-surface-2 + 右侧 shadow 分隔）*/}
      <nav className="flex w-16 flex-col items-center gap-1 border-r bg-surface-2 py-4 shadow-sm">
        <NavBtn active={tab === 'overview'} onClick={() => setTab('overview')} label="概览">
          <House size={20} />
        </NavBtn>
        <NavBtn active={tab === 'chat'} onClick={() => setTab('chat')} label="对话">
          <MessageSquare size={20} />
        </NavBtn>
        <NavBtn active={tab === 'tasks'} onClick={() => setTab('tasks')} label="任务">
          <CheckSquare size={20} />
        </NavBtn>
        <NavBtn active={tab === 'notes'} onClick={() => setTab('notes')} label="笔记">
          <StickyNote size={20} />
        </NavBtn>
        <NavBtn active={tab === 'tools'} onClick={() => setTab('tools')} label="工具">
          <Wrench size={20} />
        </NavBtn>

        {/* 分组分隔（hairline）+ 设置 */}
        <div className="my-2 h-px w-6 bg-border" />
        <NavBtn active={tab === 'settings'} onClick={() => setTab('settings')} label="设置">
          <Settings size={20} />
        </NavBtn>

        {/* M12.6 番茄钟常驻小部件 */}
        <div className="mt-2 mb-2">
          <PomodoroWidget />
        </div>

        {/* 底部主题切换 */}
        <button
          onClick={toggleTheme}
          title={resolved === 'dark' ? '切换到浅色' : '切换到深色'}
          className="mt-auto mb-2 flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-3"
        >
          {resolved === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>

        <div className="px-2 text-center text-[10px] leading-tight text-muted-foreground">
          <div>v1.3</div>
        </div>
      </nav>

      {/* 主区 */}
      <main className="flex-1 overflow-hidden">
        {tab === 'overview' ? (
          <OverviewPage />
        ) : tab === 'chat' ? (
          <ChatPage />
        ) : tab === 'tasks' ? (
          <TasksPage />
        ) : tab === 'notes' ? (
          <NotesPage />
        ) : tab === 'tools' ? (
          <ToolsPage />
        ) : (
          <SettingsPage />
        )}
      </main>
    </div>
  )
}

function NavBtn({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      // v1.3 Soft UI：激活态用 accent 微背景 + shadow-xs（浮起感），非激活 hover surface-3
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-md transition-all duration-200 active:scale-95',
        active
          ? 'bg-accent/10 text-accent shadow-xs'
          : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export default App
