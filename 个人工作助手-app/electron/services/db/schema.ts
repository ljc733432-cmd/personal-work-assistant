import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle schema（SQLite）。
 * M1：先建 providers + settings 两表，验证 Drizzle+Electron 打通。
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

export type ProviderRow = typeof providers.$inferSelect
export type ProviderInsert = typeof providers.$inferInsert
