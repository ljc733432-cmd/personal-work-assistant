import { create } from 'zustand'
import type { Reminder, ReminderInput } from '@/types'
import { invoke } from '@/lib/ipc'

/**
 * 提醒 store（M12.5 v1.2）。
 * 双轨制 B 轨：工具页手动 CRUD 走这里；A 轨 FC set_reminder 在主进程直接落库，
 * 用户切到工具页时 refresh() 即可看到（共享同一 reminders 表）。
 */
interface RemindersState {
  reminders: Reminder[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: ReminderInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useRemindersStore = create<RemindersState>((set) => ({
  reminders: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const list = await invoke<Reminder[]>('reminder:list')
      set({ reminders: list, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  upsert: async (input) => {
    await invoke<Reminder>('reminder:upsert', input)
    const list = await invoke<Reminder[]>('reminder:list')
    set({ reminders: list })
  },

  remove: async (id) => {
    await invoke<true>('reminder:delete', id)
    const list = await invoke<Reminder[]>('reminder:list')
    set({ reminders: list })
  },
}))
