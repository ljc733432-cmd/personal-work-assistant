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
  /** M2：本轮归属的会话 id。主进程据此把 user/assistant 消息落库。 */
  conversationId: string
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

// ---------- TaskDraft：任务抽取草稿（M4） ----------
// 见 CONTEXT.md「任务抽取草稿」。AI 从对话抽出的任务**草稿**，不直接入库。
// 用户点"加入任务"才落库（→ task:create_from_draft，source 强制 from_chat）。
// 字段比 Task 少：无 id/source/时间戳（这些入库时服务端填）。
export interface TaskDraft {
  title: string
  description: string | null
  priority: TaskPriority
  dueDate: number | null // Unix 秒，null=无截止
}

/** 草稿确认入库入参（渲染层 → task:create_from_draft）。 */
export interface TaskDraftInput {
  title: string
  description?: string | null
  priority?: TaskPriority
  dueDate?: number | null
  conversationId: string // 溯源用，入库填 sourceConversationId
}

// ---------- Conversation / Message（M2 对话历史持久化） ----------
// 见 PRD §4.2、CONTEXT.md「Conversation」「Message」。
// type=normal 普通会话；type=followup 跟进会话（M6）。
export type ConversationType = 'normal' | 'followup'

export interface Conversation {
  id: string
  title: string
  type: ConversationType
  scenarioId: string | null // M6 跟进场景，本轮恒 null
  defaultProviderId: string | null // 会话级默认 Provider，可空
  pinned: boolean
  createdAt: number
  updatedAt: number
}

// ---------- Reminder：提醒（M12.5 v1.2 工具扩展） ----------
// 见 PRD §13.2 工具 2 + §13.4。与 Task 区别：提醒是「到点告诉一件事」，
// 信号型，无完成度，不进任务列表。source: manual=工具页手建 / from_chat=AI 从对话抽。
export type ReminderSource = 'manual' | 'from_chat'

export interface Reminder {
  id: string
  time: number // Unix 秒，触发时间
  content: string
  done: boolean // 已触发/取消
  source: ReminderSource
  createdAt: number
}

/** reminder:upsert 入参。id 缺省=新建；source 由服务端按调用方控制。 */
export interface ReminderInput {
  id?: string
  time: number
  content: string
  source?: ReminderSource // 工具页调用默认 manual；FC 工具传 from_chat
}

// ---------- PomodoroSession：番茄钟历史（M12.6 v1.2 工具扩展） ----------
// 纯 B 轨：前端计时器跑完，落一条历史。taskId 可关联任务（v2 数据看板用）。
export interface PomodoroSession {
  id: string
  startedAt: number // Unix 秒
  durationMin: number
  taskId: string | null
  completed: boolean
}

/** pomodoro:record 入参（计时结束后落库）。 */
export interface PomodoroRecordInput {
  startedAt: number
  durationMin: number
  taskId?: string | null
  completed?: boolean
}

export interface ConversationInput {
  id?: string
  title?: string // 可空：首次创建可由首条消息回填
  type?: ConversationType // 默认 normal
  defaultProviderId?: string | null
  pinned?: boolean
}

// 消息（领域术语 Message）。TS 类型加 Conversation 前缀，
// 与现有 ChatMessage（传给模型的无 id 结构，types.ts:34）区分：
//  - ChatMessage = 内存/传输结构（role/content/toolCalls，无 id）
//  - ConversationMessage = 持久化结构（带 id/conversationId/createdAt/providerId）
export type MessageToolCall = { name: string; args: string } // args 为 JSON 字符串（与渲染层 ToolCallInfo 一致）

export interface ConversationMessage {
  id: string
  conversationId: string
  role: ChatRole
  content: string
  providerId: string | null
  toolCalls: MessageToolCall[] | null
  attachments: unknown | null // 预留
  createdAt: number
}

// 单条消息新增入参（写操作由 chat:send 内部调用，不直接暴露给渲染层 upsert）
export interface MessageInsertInput {
  id?: string
  conversationId: string
  role: ChatRole
  content: string
  providerId?: string | null
  toolCalls?: MessageToolCall[] | null
}
