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

/** v1.17 对话发图：OpenAI 多模态 content 的单部分。视觉模型专用。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: ChatRole
  content: string
  toolCalls?: unknown // FC 调用记录
  /** v1.17 对话发图：用户消息可带图片附件（dataUrl）。主进程按模型能力分流：
   *  视觉模型 → 多模态 image_url；纯文本模型 → OCR 转文字拼进 content。 */
  attachments?: { name: string; dataUrl: string }[]
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
export type TaskSource = 'manual' | 'from_chat' | 'from_note'

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: number | null // Unix 秒，null=无截止
  source: TaskSource
  sourceConversationId: string | null // M4 溯源用
  sourceNotePath: string | null // v1.9.1 笔记转任务溯源（笔记 fileName，可空）
  parentId: string | null // v1.10 父任务 id（v1.14 起无限层级，null=根任务）
  followupLog: string | null // M6 跟进日志
  completedAt: number | null // v1.8：完成时间戳，status→done 时写，null=未完成
  tags: string[] // v1.11：任务标签（JSON 字符串存库，rowToTask 解析）
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
  tags?: string[] // v1.11：标签，未传时 upsert 更新分支用 existing 兜底
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

/** 笔记转任务入参（v1.9.1，渲染层 → task:create_from_note，PRD §15.2②）。
 *  sourceNotePath 服务端从 noteId 解析为 fileName 填充（不信任前端传路径）。 */
export interface TaskFromNoteInput {
  title: string
  noteId: string // 笔记 frontmatter id（稳定主键）
  priority?: TaskPriority
  dueDate?: number | null
}

/** 子任务入参（v1.10，渲染层 → task:create_subtask）。
 *  source 跟随父任务（服务端查父任务后填），status 恒 todo，parentId 填入参。 */
export interface TaskSubtaskInput {
  parentId: string
  title: string
  priority?: TaskPriority
  dueDate?: number | null
}

/** v1.10.1：删任务入参。cascade=true 时级联删子任务（删根任务用）。 */
export interface TaskDeleteParams {
  id: string
  cascade?: boolean
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

// ---------- Note：快速笔记（M12.7 v1.2 工具扩展） ----------
// 见 PRD §13.2 工具 1。纯 .md 文件 + frontmatter，不入库。
export interface Note {
  id: string
  title: string
  tags: string[]
  content: string // 正文 Markdown（不含 frontmatter）
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
// 见 PRD §13.2 工具 3 + §15.5。
export type ConvertTarget = 'md' | 'txt' | 'html' | 'docx' | 'pdf' | 'csv' | 'xlsx'

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

// ---------- Dashboard：数据看板（v1.4 M14） ----------
// messages 表可能大，activity 走主进程聚合，只回 date+count，不传 content 大字段。
// date 形如 'YYYY-MM-DD'（SQLite date(unixepoch) 格式）。
export interface ActivityPoint {
  date: string
  count: number
}

/** dashboard:activity 入参。fromSec/toSec 为 Unix 秒，闭区间。 */
export interface ActivityQuery {
  fromSec: number
  toSec: number
}

// ---------- ModelTier：模型档位（v1.6 M15） ----------
// 存 settings KV `router.tiers` 的 JSON 字符串（零迁移），不建表。
export interface ModelTier {
  id: string
  name: string
  providerId: string
}

// ---------- PDF Toolbox（v1.7 M16，PRD §15.4⑥） ----------
export interface PdfInfo {
  pageCount: number
}

export interface PdfResult {
  ok: boolean
  outputPath: string
  bytes: number
  error?: string
}

export interface PdfSplitResult {
  ok: boolean
  outputs: string[]
  error?: string
}

// ---------- Report：AI 日报/周报（v1.8 M17，PRD §15.3④） ----------
// 报告复用笔记库存储（写成 .md 笔记 + tag=['日报'/'周报']），不建 ReportRecord 表（ADR-025 数据复用优先）。
// 生成走非流式（ADR-010 范式），providerId 从 settings KV `report.providerId` 读。

/** 报告数据载荷（喂给模型的聚合数据，已在 IPC 层按时间范围过滤 + 截断）。 */
export interface ReportPayload {
  range: ReportRange
  fromSec: number
  toSec: number
  /** 时间范围内完成的任务（done + completedAt 落在区间） */
  tasks: { title: string; priority: TaskPriority; completedAt: number | null }[]
  /** 时间范围内的对话消息（role/content，content 已截断） */
  conversations: { role: 'user' | 'assistant'; content: string; createdAt: number }[]
  /** 时间范围内的番茄钟（startedAt 落在区间） */
  pomodoros: { startedAt: number; durationMin: number; completed: boolean }[]
  /** 时间范围内触发的提醒 */
  reminders: { time: number; content: string; done: boolean }[]
}

/** 报告范围模式。custom = 用户自选日期区间（v1.8.1 打磨）。 */
export type ReportRange = 'daily' | 'weekly' | 'custom'

/** report:generate 入参。
 *  - 不传 fromSec/toSec 时按 range 算默认（daily=今日，weekly=本周一到今天）。
 *  - custom 模式必须传 fromSec/toSec。
 *  - reqId 用于可取消（v1.8.1 打磨）：传 report:cancel 时按此 id 中断。 */
export interface ReportGenerateParams {
  range: ReportRange
  fromSec?: number
  toSec?: number
  reqId?: string
}

/** report:generate 返回。note 为写入笔记库的报告笔记。 */
export interface ReportResult {
  note: Note
}

/** report:preview 入参（v1.8.1 打磨：生成前预览数据计数，不调模型）。与 generate 同构。 */
export interface ReportPreviewParams {
  range: ReportRange
  fromSec?: number
  toSec?: number
}

/** report:preview 返回：各类数据计数 + 区间标签，用于 UI「将基于以下数据」实时展示。 */
export interface ReportPreviewResult {
  taskCount: number
  messageCount: number
  pomoCount: number
  pomoMinutes: number
  reminderCount: number
  rangeLabel: string // 如「今日」「本周」「2026-08-01 ~ 2026-08-04」
  empty: boolean // 全空（generate 会拦截，preview 提前告知）
}

// ---------- Mindmap：AI 思维导图（v1.12，PRD §15.3 AI 产出组） ----------
// 复用 report.providerId（零新配置）。非流式，照搬 reportGenerator 范式。
// 两种输入：topic 主题 / material 素材（笔记或任务内容）。输出 Markdown 层级标题，markmap 渲染。
export interface MindmapGenerateParams {
  /** 主题模式：用户自由输入的主题字符串 */
  topic?: string
  /** 素材模式：笔记/任务内容，AI 基于此生成 */
  material?: string
  /** 素材来源标题（笔记标题或任务标题），用于命名生成的笔记 */
  sourceTitle?: string
  reqId?: string
}

/** mindmap:generate 返回。note 为写入笔记库的思维导图笔记（tag='思维导图'）。 */
export interface MindmapResult {
  note: Note
  /** 生成的 Markdown（与 note.content 同），UI 直接用于 markmap 渲染 */
  markdown: string
}

// ---------- NoteAiAssist：AI 笔记助手（v1.9 M18，PRD §15.2①） ----------
// 复用 report.providerId（与报告模型共用，零新配置项）。非流式，照搬 reportGenerator 范式。
// 结果以「可插入块」返回（Markdown），用户点插入才写进笔记（不静默改）。
export type NoteAiOp = 'summary' | 'todos' | 'questions' | 'continue'

/** note:ai 入参。 */
export interface NoteAiParams {
  op: NoteAiOp
  content: string // 当前笔记正文
  question?: string // op='questions' 时的可选用户追问（空则 AI 自行提问）
  reqId?: string // 可取消（v1.8.1 打磨同款）
}

/** note:ai 返回。result 为 AI 生成的 Markdown。 */
export interface NoteAiResult {
  result: string
}
