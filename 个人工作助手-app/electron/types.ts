/**
 * 主进程与渲染进程共享的类型定义。
 * 渲染层通过 `window.api` 调用，参数/返回值类型以此为准。
 */

// ---------- Provider（模型配置） ----------
export type ProviderType = 'deepseek' | 'zhipu' | 'custom'

export interface Provider {
  id: string
  name: string
  type: ProviderType
  baseURL: string
  model: string
  apiKeyRef: string // 指向 safeStorage 的引用 key，不存明文
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderInput {
  id?: string
  name: string
  type: ProviderType
  baseURL: string
  model: string
  apiKey?: string // 明文，仅 upsert 时传入，落库前走 safeStorage 加密
  enabled: boolean
}

// ---------- 对话 ----------
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
  toolCalls?: unknown // FC 调用记录
}

export interface ChatSendParams {
  /** 由渲染层生成，用于在流式事件里匹配本轮（订阅必须先于发起）。 */
  reqId: string
  providerId: string
  messages: ChatMessage[]
  enableTools?: boolean // 是否带工具（FC 实测开关）
}

// ---------- 流式事件（主进程 -> 渲染层） ----------
export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// ---------- IPC 结果包装 ----------
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ---------- WorkDir：工作目录白名单（M5） ----------
export type WorkDirMode = 'read' | 'readwrite'

export interface WorkDir {
  id: string
  label: string
  path: string
  mode: WorkDirMode
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface WorkDirInput {
  id?: string
  label: string
  path: string
  mode: WorkDirMode
  enabled: boolean
}

// ---------- SearchProvider：联网搜索配置（M5 搜索半） ----------
// 本轮 type 只 'tavily'（ADR-002 终态双家的第一半）。
export type SearchProviderType = 'tavily'

export interface SearchProvider {
  id: string
  name: string
  type: SearchProviderType
  apiKeyRef: string // 指向 safeStorage 的引用 key，不存明文
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface SearchProviderInput {
  id?: string
  name: string
  type: SearchProviderType
  apiKey?: string // 明文，仅 upsert 时传入，落库前走 safeStorage 加密
  enabled: boolean
}

// ---------- Task：任务（M3，含 M4/M6 预留字段） ----------
export type TaskStatus = 'todo' | 'in_progress' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskSource = 'manual' | 'from_chat'

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: number | null // Unix 秒，null=无截止
  source: TaskSource
  sourceConversationId: string | null // M4 溯源用
  followupLog: string | null // M6 跟进日志
  createdAt: number
  updatedAt: number
}

export interface TaskInput {
  id?: string
  title: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  dueDate?: number | null
  // source/sourceConversationId/followupLog 由服务端控制，不入 TaskInput
  // （M3 手动建默认 source=manual；M4 抽取入库走单独路径填 from_chat）
  enabled?: boolean // 未用，保留以与 WorkDirInput 风格一致（可忽略）
}
