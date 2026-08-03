import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle schema（SQLite）。
 * M1：providers + settings
 * M5：work_dirs（工作目录白名单）
 * M2~M6 会追加 conversations / messages / tasks 等（见 PRD §4.2）。
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
