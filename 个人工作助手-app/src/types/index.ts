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

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  streaming?: boolean // 该条正在流式接收中
  toolCallName?: string // 若是 FC 触发标记
}

export interface ChatSendParams {
  providerId: string
  messages: { role: ChatRole; content: string }[]
  enableTools?: boolean
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface ChatStreamEvent {
  reqId: string
  text?: string
  name?: string
  args?: string
  message?: string
}
