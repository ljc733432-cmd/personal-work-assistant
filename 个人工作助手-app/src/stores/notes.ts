import { create } from 'zustand'
import type { Note, NoteInput } from '@/types'
import { invoke } from '@/lib/ipc'

/**
 * 笔记 store（M12.7~8 v1.2）。
 * 双轨制 B 轨：笔记页手动 CRUD 走这里；A 轨 FC 在主进程直接写 .md 文件，
 * 用户切到笔记页 refresh() 即可看到（共享同一笔记库目录，PRD §13.1 关键约束）。
 */
interface NotesState {
  notes: Note[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (input: NoteInput) => Promise<Note>
  update: (input: NoteInput) => Promise<Note | null>
  remove: (id: string) => Promise<void>
}

export const useNotesStore = create<NotesState>((set) => ({
  notes: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const list = await invoke<Note[]>('note:list')
      set({ notes: list, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  create: async (input) => {
    const note = await invoke<Note>('note:create', input)
    const list = await invoke<Note[]>('note:list')
    set({ notes: list })
    return note
  },

  update: async (input) => {
    const note = await invoke<Note | null>('note:update', input)
    const list = await invoke<Note[]>('note:list')
    set({ notes: list })
    return note
  },

  remove: async (id) => {
    await invoke<true>('note:delete', id)
    const list = await invoke<Note[]>('note:list')
    set({ notes: list })
  },
}))
