import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle schema（SQLite）。
 * M1：providers + settings
 * M5：work_dirs（工作目录白名单）+ search_providers（联网搜索配置）
 * M3：tasks（任务，含 M4/M6 预留字段）
 * M2/M4/M6 会追加 conversations / messages 等（见 PRD §4.2）。
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
  source: text('source', { enum: ['manual', 'from_chat'] }).notNull().default('manual'),
  sourceConversationId: text('source_conversation_id'), // M4 溯源用，可空
  followupLog: text('followup_log'), // M6 跟进日志，可空
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type TaskRow = typeof tasks.$inferSelect
export type TaskInsert = typeof tasks.$inferInsert
