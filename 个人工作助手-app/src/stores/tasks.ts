import { create } from 'zustand'
import type {
  Task,
  TaskDraftInput,
  TaskFromNoteInput,
  TaskSubtaskInput,
  TaskDeleteParams,
  TaskInput,
} from '@/types'
import { invoke } from '@/lib/ipc'

interface TasksState {
  tasks: Task[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: TaskInput) => Promise<void>
  /** M4：草稿确认入库（source 服务端强制 from_chat）。 */
  createFromDraft: (input: TaskDraftInput) => Promise<Task>
  /** v1.9.1：笔记转任务（source 服务端强制 from_note + sourceNotePath 溯源）。 */
  createFromNote: (input: TaskFromNoteInput) => Promise<Task>
  /** v1.10：子任务（source 跟随父任务，parentId 关联）。 */
  createSubtask: (input: TaskSubtaskInput) => Promise<Task>
  /** v1.10.1：删任务，cascade=true 级联删子任务。 */
  remove: (params: TaskDeleteParams) => Promise<void>
  /** v1.10.1：子任务转根任务（清 parentId）。 */
  promoteSubtask: (id: string) => Promise<void>
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

  createFromDraft: async (input) => {
    const task = await invoke<Task>('task:create_from_draft', input)
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
    return task
  },

  createFromNote: async (input) => {
    const task = await invoke<Task>('task:create_from_note', input)
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
    return task
  },

  createSubtask: async (input) => {
    const task = await invoke<Task>('task:create_subtask', input)
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
    return task
  },

  remove: async (params) => {
    await invoke<true>('task:delete', params)
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
  },

  promoteSubtask: async (id) => {
    await invoke<true>('task:promote_subtask', id)
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
  },
}))
