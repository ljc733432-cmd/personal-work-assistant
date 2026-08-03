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
