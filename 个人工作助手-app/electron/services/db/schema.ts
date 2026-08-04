import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle schema（SQLite）。
 * M1：providers + settings
 * M5：work_dirs（工作目录白名单）+ search_providers（联网搜索配置）
 * M3：tasks（任务，含 M4/M6 预留字段）
 * M2：conversations + messages（对话历史持久化）
 * M4/M6 会继续在已有表上追加字段（见 PRD §4.2）。
 */

// ---------- Provider：模型配置 ----------
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['deepseek', 'zhipu', 'custom'] }).notNull(),
  baseURL: text('base_url').notNull(),
  model: text('model').notNull(),
  // 指向 safeStorage 的引用 key，绝不存明文 Key
  apiKeyRef: text('api_key_ref').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// ---------- Settings：KV 设置表 ----------
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// ---------- WorkDir：工作目录白名单（M5） ----------
// mode：'read' 只读 | 'readwrite' 读写。
// 见 CONTEXT.md「工作目录白名单」「写入三重防护」。
export const workDirs = sqliteTable('work_dirs', {
  id: text('id').primaryKey(),
  label: text('label').notNull(), // 显示名（如「我的笔记」）
  path: text('path').notNull(), // 绝对路径
  mode: text('mode', { enum: ['read', 'readwrite'] }).notNull().default('read'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type ProviderRow = typeof providers.$inferSelect
export type ProviderInsert = typeof providers.$inferInsert
export type WorkDirRow = typeof workDirs.$inferSelect
export type WorkDirInsert = typeof workDirs.$inferInsert

// ---------- SearchProvider：联网搜索配置（M5 搜索半） ----------
// type 当前只 'tavily'（ADR-002 终态双家的第一半，bing 留 enum 扩展位）。
// apiKeyRef 同模型 Provider：指向 safeStorage，绝不存明文 Key。
export const searchProviders = sqliteTable('search_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['tavily'] }).notNull(),
  // 指向 safeStorage 的引用 key，绝不存明文 Key（与 providers 同模式）
  apiKeyRef: text('api_key_ref').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type SearchProviderRow = typeof searchProviders.$inferSelect
export type SearchProviderInsert = typeof searchProviders.$inferInsert

// ---------- Task：任务（M3，含 M4/M6 预留字段） ----------
// 见 PRD §4.2、CONTEXT.md「Task」。
// status：todo/in_progress/done；priority：low/medium/high；source：manual/from_chat。
// 预留字段（本轮 UI 不暴露，M4/M6 用）：
//  - source/sourceConversationId：M4 AI 抽取任务溯源
//  - followupLog：M6 跟进日志追加
//  - remindTimes 留到 M6 再加（避免现在过度设计）
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'), // 可空
  status: text('status', { enum: ['todo', 'in_progress', 'done'] }).notNull().default('todo'),
  priority: text('priority', { enum: ['low', 'medium', 'high'] }).notNull().default('medium'),
  dueDate: integer('due_date', { mode: 'number' }), // Unix 秒，可空，null=无截止
  source: text('source', { enum: ['manual', 'from_chat', 'from_note'] }).notNull().default('manual'),
  sourceConversationId: text('source_conversation_id'), // M4 溯源用，可空
  // v1.9.1：笔记转任务溯源（PRD §15.6），存笔记 fileName（笔记库内唯一稳定）。可空。
  sourceNotePath: text('source_note_path'),
  // v1.10：父任务 id（两级层级）。null=根任务；非空=子任务。不支持子任务的子任务（两级限制）。
  parentId: text('parent_id'),
  followupLog: text('followup_log'), // M6 跟进日志，可空
  // v1.8：完成时间戳（精确「今日完成」用于日报）。status→done 时写，切回非 done 清空。
  // 老库迁移见 db/index.ts 的幂等 ALTER（项目无 migrate 框架）。
  completedAt: integer('completed_at', { mode: 'number' }), // Unix 秒，可空
  // v1.11：任务标签（JSON 字符串，如 '["工作","紧急"]'）。parseTags 容错解析。
  // 存 JSON 而非关联表：零新表，照搬 completedAt/parentId 的列加法。
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type TaskRow = typeof tasks.$inferSelect
export type TaskInsert = typeof tasks.$inferInsert

// ---------- Conversation：会话（M2 对话历史持久化） ----------
// 见 PRD §4.2、CONTEXT.md「Conversation」「Message」。
// type：normal 普通会话 / followup 跟进会话（M6 用，本轮默认 normal）。
// pinned：置顶（M2 UI 预留，默认 0）。
// defaultProviderId：会话级默认模型（可空，null=用全局首个启用 Provider）。
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(), // 自动用首条 user 消息生成，可改
  type: text('type', { enum: ['normal', 'followup'] }).notNull().default('normal'),
  scenarioId: text('scenario_id'), // M6 跟进场景，可空
  defaultProviderId: text('default_provider_id'), // 会话级默认 Provider，可空
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// ---------- Message：消息（M2） ----------
// 消息不可改（PRD 只列 createdAt，无 updatedAt）。
// toolCalls / attachments 用 text+json 模式存（Drizzle 自动 stringify/parse）。
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
  content: text('content').notNull().default(''), // assistant 流式中间态可能为空字符串
  providerId: text('provider_id'), // 逐条记录用哪个模型（会话内切模型，可空）
  toolCalls: text('tool_calls', { mode: 'json' }), // FC 调用记录，可空
  attachments: text('attachments', { mode: 'json' }), // 预留，可空
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type ConversationRow = typeof conversations.$inferSelect
export type ConversationInsert = typeof conversations.$inferInsert
export type MessageRow = typeof messages.$inferSelect
export type MessageInsert = typeof messages.$inferInsert

// ---------- Reminder：提醒（M12.5 v1.2 工具扩展） ----------
// 见 PRD §13.2 工具 2 + §13.4 数据模型。
// 与 Task 区别（PRD §13.2）：任务是「有截止日的工作」（有完成度），
// 提醒是「到点告诉一件事」（信号，响一下就完），不进任务列表，避免污染。
// time/done：调度器轮询 time<=now && done=0 的行触发通知，触发后置 done=1。
// source：manual（工具页手建）/ from_chat（AI 从对话抽取，PRD §13.2 说提醒无副作用可静默建）。
export const reminders = sqliteTable('reminders', {
  id: text('id').primaryKey(),
  time: integer('time', { mode: 'number' }).notNull(), // Unix 秒，触发时间
  content: text('content').notNull(), // 提醒内容
  done: integer('done', { mode: 'boolean' }).notNull().default(false), // 已触发/取消
  source: text('source', { enum: ['manual', 'from_chat'] }).notNull().default('manual'),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type ReminderRow = typeof reminders.$inferSelect
export type ReminderInsert = typeof reminders.$inferInsert

// ---------- PomodoroSession：番茄钟历史（M12.6 v1.2 工具扩展） ----------
// 见 PRD §13.2 工具 2 + §13.4。番茄钟纯 B 轨（前端计时），完成后落一条历史。
// taskId 可关联任务（用于 v2「今天专注了多少」），v1.2 暂不强制。
// completed：是否完整完成（未中断）；中断不落库或落 completed=false（前端决定）。
export const pomodoroSessions = sqliteTable('pomodoro_sessions', {
  id: text('id').primaryKey(),
  startedAt: integer('started_at', { mode: 'number' }).notNull(), // Unix 秒
  durationMin: integer('duration_min', { mode: 'number' }).notNull(), // 时长（默认 25）
  taskId: text('task_id'), // 关联任务，可空
  completed: integer('completed', { mode: 'boolean' }).notNull().default(true),
})

export type PomodoroSessionRow = typeof pomodoroSessions.$inferSelect
export type PomodoroSessionInsert = typeof pomodoroSessions.$inferInsert
