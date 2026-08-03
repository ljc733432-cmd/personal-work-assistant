import { create } from 'zustand'
import type { Task, TaskInput } from '@/types'
import { invoke } from '@/lib/ipc'

interface TasksState {
  tasks: Task[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: TaskInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useTasksStore = create<TasksState>((set) => ({
  tasks: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const list = await invoke<Task[]>('task:list')
      set({ tasks: list, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  upsert: async (input) => {
    await invoke<Task>('task:upsert', input)
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
  },

  remove: async (id) => {
    await invoke<true>('task:delete', id)
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
  },
}))
