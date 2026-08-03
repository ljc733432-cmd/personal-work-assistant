import { useEffect, useState } from 'react'
import { MessageSquare, CheckSquare, Settings, StickyNote, Wrench, Sun, Moon } from '@/components/ui/icons'
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

// v1.2：导航从 3 项扩到 5 项（对话/任务/笔记/工具/设置）。
// 笔记页与工具页（M12.5~M12.9）暂未实现，先占位渲染空状态，
// 后续里程碑填充。主题切换按钮（底部 Sun/Moon）随 M12.4 主题 store 一起加。
type Tab = 'chat' | 'tasks' | 'notes' | 'tools' | 'settings'

function App() {
  const [tab, setTab] = useState<Tab>('chat')
  const resolved = useThemeStore((s) => s.resolved)
  const setMode = useThemeStore((s) => s.setMode)

  // M6：订阅跟进通知点击 → 跳转到对话页 + 切到跟进会话
  useEffect(() => {
    return on('followup:open', (...args) => {
      const ev = args[0] as { conversationId: string }
      setTab('chat')
      // 切到跟进会话（store 会按需 hydrate 历史，能看到 AI 的问候消息）
      useChatStore.getState().switchConversation(ev.conversationId).catch(() => {})
    })
  }, [])

  // v1.2：system 模式下监听系统主题变化，实时跟随
  useEffect(() => startSystemThemeWatcher(), [])

  // 底部主题按钮：点击在 light/dark 间切换（system 选项在设置页选）
  const toggleTheme = () => {
    void setMode(resolved === 'dark' ? 'light' : 'dark')
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* 侧栏：64px 纯图标，hairline 分隔分组（PRD §12.3）*/}
      <nav className="flex w-16 flex-col items-center gap-1 border-r bg-card py-4">
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

        {/* M12.6 番茄钟常驻小部件（PRD §12.3）*/}
        <div className="mt-2 mb-2">
          <PomodoroWidget />
        </div>

        {/* 底部主题切换：light/dark 间切换（system 在设置页选） */}
        <button
          onClick={toggleTheme}
          title={resolved === 'dark' ? '切换到浅色' : '切换到深色'}
          className="mt-auto mb-2 flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent"
        >
          {resolved === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>

        <div className="px-2 text-center text-[10px] leading-tight text-muted-foreground">
          <div>v1.2</div>
        </div>
      </nav>

      {/* 主区 */}
      <main className="flex-1 overflow-hidden">
        {tab === 'chat' ? (
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
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-md transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}

export default App
