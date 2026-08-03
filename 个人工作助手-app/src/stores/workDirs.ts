import { create } from 'zustand'
import type { WorkDir, WorkDirInput } from '@/types'
import { invoke } from '@/lib/ipc'

interface WorkDirsState {
  workDirs: WorkDir[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: WorkDirInput) => Promise<void>
  remove: (id: string) => Promise<void>
  pick: () => Promise<string | null>
}

export const useWorkDirsStore = create<WorkDirsState>((set) => ({
  workDirs: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const list = await invoke<WorkDir[]>('workdir:list')
      set({ workDirs: list, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  upsert: async (input) => {
    await invoke<WorkDir>('workdir:upsert', input)
    const list = await invoke<WorkDir[]>('workdir:list')
    set({ workDirs: list })
  },

  remove: async (id) => {
    await invoke<true>('workdir:delete', id)
    const list = await invoke<WorkDir[]>('workdir:list')
    set({ workDirs: list })
  },

  pick: async () => {
    return await invoke<string | null>('workdir:pick')
  },
}))
