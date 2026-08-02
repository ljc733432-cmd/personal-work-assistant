import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChatPage } from '@/pages/chat/ChatPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'

type Tab = 'chat' | 'settings'

function App() {
  const [tab, setTab] = useState<Tab>('chat')

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* 侧栏 */}
      <nav className="flex w-16 flex-col items-center gap-2 border-r bg-card py-4">
        <NavBtn active={tab === 'chat'} onClick={() => setTab('chat')} label="对话">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </NavBtn>
        <NavBtn active={tab === 'settings'} onClick={() => setTab('settings')} label="设置">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </NavBtn>
        <div className="mt-auto px-2 text-center text-[10px] leading-tight text-muted-foreground">
          <div>M1</div>
          <div>骨架</div>
        </div>
      </nav>

      {/* 主区 */}
      <main className="flex-1 overflow-hidden">
        {tab === 'chat' ? <ChatPage /> : <SettingsPage />}
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
