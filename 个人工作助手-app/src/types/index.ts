// 渲染层共享类型（与 electron/types.ts 保持一致，跨进程不直接 import）。

export type ProviderType = 'deepseek' | 'zhipu' | 'custom'

export interface Provider {
  id: string
  name: string
  type: ProviderType
  baseURL: string
  model: string
  apiKeyRef: string
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
  apiKey?: string
  enabled: boolean
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallInfo {
  name: string
  args: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  streaming?: boolean // 该条正在流式接收中
  toolCalls?: ToolCallInfo[] // 本轮发起的工具调用（独立展示，不混入 content）
}

export interface ChatSendParams {
  providerId: string
  messages: { role: ChatRole; content: string }[]
  enableTools?: boolean
}

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

// ---------- 工具确认请求（write_file 覆盖等） ----------
export interface ConfirmRequest {
  reqId: string
  prompt: string
}

export interface ChatStreamEvent {
  reqId: string
  text?: string
  name?: string
  args?: string
  message?: string
}
