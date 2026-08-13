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
  /** v1.10.5：移动任务到某父任务下（parentId=null 变根任务）。 */
  setParent: (id: string, parentId: string | null) => Promise<void>
  /** v1.22 批量改任务（状态/优先级/标签等）。循环 upsert 后单次 refresh（避免 N 次 list）。 */
  batchUpsert: (inputs: TaskInput[]) => Promise<void>
  /** v1.22 批量删任务。循环 delete 后单次 refresh。 */
  batchDelete: (ids: string[]) => Promise<void>
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

  setParent: async (id, parentId) => {
    await invoke<true>('task:set_parent', { id, parentId })
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
  },

  batchUpsert: async (inputs) => {
    // 并发 upsert（每个带 id 走更新分支，未传字段服务端用 existing 兜底）
    await Promise.all(inputs.map((input) => invoke<Task>('task:upsert', input)))
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
  },

  batchDelete: async (ids) => {
    // task:delete 服务端已内置递归删后代，单个删根任务不留孤儿
    await Promise.all(ids.map((id) => invoke<true>('task:delete', { id, cascade: true })))
    const list = await invoke<Task[]>('task:list')
    set({ tasks: list })
  },
}))
