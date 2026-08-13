import { useEffect } from 'react'
import { useNavStore, type Tab } from '@/pages/overview/nav'
import { useChatStore } from '@/stores/chat'
import { useTasksStore } from '@/stores/tasks'
import { useNotesStore } from '@/stores/notes'

/**
 * 全局快捷键（v1.21）。
 *
 * 分两层：
 *  - 本 hook（window 监听）：Ctrl+1~7 切板块 + Ctrl+N 上下文新建（按当前 tab 分流）
 *  - 页面内 useEffect：ChatPage 的 Ctrl+Enter/Esc（常驻挂载全局生效）、NotesPage 的 Ctrl+S/E
 *
 * Ctrl+N 策略：对话→新建会话、任务→新建空任务、笔记→新建笔记、其他→无。
 * Ctrl+N 不依赖组件内 state（store action 可外部调），但笔记的"切到编辑态"需组件内配合——
 * 这里只调 create 落库，编辑态由 NotesPage 挂载时读 store 的 lastCreatedId 自动进入（见 NotesPage 改动）。
 *
 * 注意：不拦截裸字母键（避免干扰 input/textarea）。所有快捷键都是 Ctrl/Cmd 组合，输入框内也不冲突。
 */

/** 板块顺序 ↔ Ctrl+数字 映射（与侧栏导航顺序一致）。 */
const TAB_BY_DIGIT: Tab[] = ['overview', 'dashboard', 'chat', 'tasks', 'notes', 'tools', 'settings']

export function useGlobalShortcuts() {
  const tab = useNavStore((s) => s.tab)
  const setTab = useNavStore((s) => s.setTab)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd 组合键才处理（Mac 用 metaKey）
      if (!e.ctrlKey && !e.metaKey) return

      // Ctrl+1~7：切板块
      if (e.key >= '1' && e.key <= '7') {
        const idx = parseInt(e.key, 10) - 1
        if (idx < TAB_BY_DIGIT.length) {
          e.preventDefault()
          setTab(TAB_BY_DIGIT[idx])
        }
        return
      }

      // Ctrl+N：上下文新建（按当前 tab 分流）
      if (e.key === 'n' || e.key === 'N') {
        const currentTab = useNavStore.getState().tab
        if (currentTab === 'chat') {
          e.preventDefault()
          useChatStore.getState().createConversation().catch(() => {})
        } else if (currentTab === 'tasks') {
          e.preventDefault()
          useTasksStore.getState().upsert({ title: '', status: 'todo', priority: 'medium' })
        } else if (currentTab === 'notes') {
          e.preventDefault()
          useNotesStore.getState().create({ title: '无标题笔记', content: '' }).then((note) => {
            // 标记刚创建的笔记 id，NotesPage 挂载时读它自动进入编辑态
            lastCreatedNoteId = note?.id ?? null
            setTab('notes')
          }).catch(() => {})
        }
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setTab, tab])
}

/** 记录 Ctrl+N 刚创建的笔记 id（NotesPage 挂载时消费，消费后清空）。 */
export let lastCreatedNoteId: string | null = null
export function consumeLastCreatedNoteId(): string | null {
  const id = lastCreatedNoteId
  lastCreatedNoteId = null
  return id
}
