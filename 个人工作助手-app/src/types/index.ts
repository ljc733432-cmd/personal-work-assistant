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
  reqId: string
  providerId: string
  messages: { role: ChatRole; content: string }[]
  enableTools?: boolean
  conversationId: string // M2：本轮归属会话，主进程据此落库
}

// ---------- Conversation / Message（M2 对话历史持久化） ----------
export type ConversationType = 'normal' | 'followup'

export interface Conversation {
  id: string
  title: string
  type: ConversationType
  scenarioId: string | null
  defaultProviderId: string | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface ConversationInput {
  id?: string
  title?: string
  type?: ConversationType
  defaultProviderId?: string | null
  pinned?: boolean
}

// 持久化的消息结构（带 id/conversationId/createdAt）。
// 与内存 ChatMessage 区别：ChatMessage 无 id 外部键，是组件流式用的临时结构。
export interface ConversationMessage {
  id: string
  conversationId: string
  role: ChatRole
  content: string
  providerId: string | null
  toolCalls: ToolCallInfo[] | null
  attachments: unknown | null
  createdAt: number
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

// ---------- SearchProvider：联网搜索配置（M5 搜索半） ----------
export type SearchProviderType = 'tavily'

export interface SearchProvider {
  id: string
  name: string
  type: SearchProviderType
  apiKeyRef: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface SearchProviderInput {
  id?: string
  name: string
  type: SearchProviderType
  apiKey?: string
  enabled: boolean
}

// ---------- Task：任务（M3） ----------
export type TaskStatus = 'todo' | 'in_progress' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskSource = 'manual' | 'from_chat'

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: number | null
  source: TaskSource
  sourceConversationId: string | null
  followupLog: string | null
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
}

// ---------- Reminder：提醒（M12.5 v1.2 工具扩展） ----------
// 见 PRD §13.2 工具 2。与 Task 区别：信号型，无完成度，不进任务列表。
export type ReminderSource = 'manual' | 'from_chat'

export interface Reminder {
  id: string
  time: number // Unix 秒，触发时间
  content: string
  done: boolean
  source: ReminderSource
  createdAt: number
}

export interface ReminderInput {
  id?: string
  time: number
  content: string
  source?: ReminderSource
}

// ---------- PomodoroSession：番茄钟历史（M12.6 v1.2 工具扩展） ----------
export interface PomodoroSession {
  id: string
  startedAt: number
  durationMin: number
  taskId: string | null
  completed: boolean
}

export interface PomodoroRecordInput {
  startedAt: number
  durationMin: number
  taskId?: string | null
  completed?: boolean
}

// ---------- Note：快速笔记（M12.7 v1.2 工具扩展） ----------
export interface Note {
  id: string
  title: string
  tags: string[]
  content: string
  createdAt: number
  updatedAt: number
  fileName: string
}

export interface NoteInput {
  id?: string
  title: string
  content?: string
  tags?: string[]
}

export interface NoteSearchHit {
  id: string
  title: string
  fileName: string
  snippet: string
  updatedAt: number
}

// ---------- Document Converter（M12.9 v1.2 工具扩展） ----------
export type ConvertTarget = 'md' | 'txt' | 'html' | 'docx' | 'pdf'

export interface ConvertParams {
  inputPath: string
  targetFormat: ConvertTarget
  outputPath?: string
}

export interface ConvertResultData {
  ok: boolean
  outputPath: string
  inputFormat: string
  targetFormat: ConvertTarget
  bytes: number
  error?: string
}

// ---------- TaskDraft：任务抽取草稿（M4） ----------
// AI 从对话抽出的任务草稿，不直接入库，用户点"加入任务"才落库。
export interface TaskDraft {
  title: string
  description: string | null
  priority: TaskPriority
  dueDate: number | null // Unix 秒，null=无截止
}

/** 草稿确认入库入参。 */
export interface TaskDraftInput {
  title: string
  description?: string | null
  priority?: TaskPriority
  dueDate?: number | null
  conversationId: string // 溯源用
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

// ---------- Dashboard：数据看板（v1.4 M14） ----------
// 见 CONTEXT.md「数据看板」。与 Overview Page 区别：Overview 是今日快照，Dashboard 是历史趋势。
// messages 表可能大，activity 走主进程聚合 IPC，只回 date+count，不传 content 大字段。
export type DashboardRange = '7d' | '30d' | 'all'

/** messages 按天聚合计数（对话活跃度）。date 形如 'YYYY-MM-DD'。 */
export interface ActivityPoint {
  date: string
  count: number
}

/** dashboard:activity 入参。fromSec/toSec 为 Unix 秒，闭区间。 */
export interface ActivityQuery {
  fromSec: number
  toSec: number
}
