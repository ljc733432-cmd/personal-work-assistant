import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as schema from './schema'
import { logInfo } from '../logger'

/**
 * 数据库单例。
 *
 * 库文件：app.getPath('userData')/app.db（见 CONTEXT.md「app.db」）。
 * M1 采用「启动时建表」的简单策略（drizzle-kit push 不适合分发到用户机）：
 *  - 首次启动检测表不存在 → 执行建表 SQL。
 *  - 后续 M3+ 改用 drizzle-kit generate 产出的迁移文件 + migrate()。
 */

let _db: BetterSQLite3Database<typeof schema> | null = null
let _raw: Database.Database | null = null

function getDbPath(): string {
  const userData = app.getPath('userData')
  // 确保 userData 目录存在（首次运行可能未创建）
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true })
  return path.join(userData, 'app.db')
}

/** 建表 DDL（与 schema.ts 对齐）。M3+ 会替换为迁移文件。 */
const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  model        TEXT NOT NULL,
  api_key_ref  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS work_dirs (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  path        TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'read',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS search_providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  api_key_ref  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tasks (
  id                       TEXT PRIMARY KEY,
  title                    TEXT NOT NULL,
  description              TEXT,
  status                   TEXT NOT NULL DEFAULT 'todo',
  priority                 TEXT NOT NULL DEFAULT 'medium',
  due_date                 INTEGER,
  source                   TEXT NOT NULL DEFAULT 'manual',
  source_conversation_id   TEXT,
  source_note_path         TEXT,                          -- v1.9.1：笔记转任务溯源（笔记 fileName，可空）
  parent_id                TEXT,                          -- v1.10：父任务 id（v1.14 起无限层级，可空）
  followup_log             TEXT,
  completed_at             INTEGER,                       -- v1.8：完成时间戳（可空）
  tags                     TEXT NOT NULL DEFAULT '[]',     -- v1.11：任务标签（JSON 字符串）
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS conversations (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'normal',
  scenario_id           TEXT,
  default_provider_id   TEXT,
  pinned                INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  provider_id       TEXT,
  tool_calls        TEXT,   -- JSON 字符串
  attachments       TEXT,   -- JSON 字符串
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

-- M12.5：提醒（v1.2 工具扩展）
CREATE TABLE IF NOT EXISTS reminders (
  id          TEXT PRIMARY KEY,
  time        INTEGER NOT NULL,           -- Unix 秒，触发时间
  content     TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0, -- 0=未触发 1=已触发/取消
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(done, time);

-- M12.6：番茄钟历史（v1.2 工具扩展，纯 B 轨）
CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id            TEXT PRIMARY KEY,
  started_at    INTEGER NOT NULL,           -- Unix 秒
  duration_min  INTEGER NOT NULL,           -- 时长（默认 25）
  task_id       TEXT,                       -- 关联任务，可空
  completed     INTEGER NOT NULL DEFAULT 1  -- 1=完整完成 0=中断
);
`

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db

  const dbPath = getDbPath()
  _raw = new Database(dbPath)
  _raw.pragma('journal_mode = WAL') // WAL 提升并发写
  _raw.pragma('foreign_keys = ON')

  // 启动建表
  _raw.exec(BOOTSTRAP_SQL)

  // v1.8 迁移：tasks 加 completed_at 列（老库补列，新库 CREATE TABLE 已含）。
  // 项目无 drizzle-kit migrate 框架，老库加列用幂等 ALTER：先 PRAGMA 探测列是否存在。
  // 模式：后续再加列照抄此块，换表名/列名/DDL。
  const taskCols = _raw.pragma('table_info(tasks)') as { name: string }[]
  if (!taskCols.some((c) => c.name === 'completed_at')) {
    _raw.exec('ALTER TABLE tasks ADD COLUMN completed_at INTEGER')
    logInfo('[db] 迁移：tasks 已加列 completed_at')
  }
  // v1.9.1 迁移：tasks 加 source_note_path 列（笔记转任务溯源，照搬 completed_at 幂等 ALTER 模式）
  if (!taskCols.some((c) => c.name === 'source_note_path')) {
    _raw.exec('ALTER TABLE tasks ADD COLUMN source_note_path TEXT')
    logInfo('[db] 迁移：tasks 已加列 source_note_path')
  }
  // v1.10 迁移：tasks 加 parent_id 列（子任务层级，v1.14 起支持无限深度）
  if (!taskCols.some((c) => c.name === 'parent_id')) {
    _raw.exec('ALTER TABLE tasks ADD COLUMN parent_id TEXT')
    logInfo('[db] 迁移：tasks 已加列 parent_id')
  }
  // v1.11 迁移：tasks 加 tags 列（任务标签，JSON 字符串，照搬幂等 ALTER 模式）
  if (!taskCols.some((c) => c.name === 'tags')) {
    _raw.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
    logInfo('[db] 迁移：tasks 已加列 tags')
  }

  // v1.10.8 数据修复：清除孤儿子任务（parent_id 指向已不存在的任务）。
  // v1.14：无限层级下孤儿可能多层（删一层后暴露新的孤儿层），循环清理直到 0 行。
  // 成因：早期 task:delete 未强制级联删子任务，删根任务后子任务变孤儿残留。
  // 幂等——无孤儿时 DELETE 0 行，每次启动跑无副作用。
  const orphanStmt = _raw.prepare(
    `DELETE FROM tasks
     WHERE parent_id IS NOT NULL
       AND parent_id NOT IN (SELECT id FROM tasks)`,
  )
  let totalOrphans = 0
  for (;;) {
    const r = orphanStmt.run()
    if (r.changes === 0) break
    totalOrphans += r.changes
  }
  if (totalOrphans > 0) {
    logInfo(`[db] 数据修复：已清除 ${totalOrphans} 条孤儿子任务`)
  }

  _db = drizzle(_raw, { schema })
  logInfo('[db] 已初始化：', dbPath)
  return _db
}

/** 健康检查（M1 验证落库用）：写一条临时记录再读回。 */
export function dbHealthCheck(): { ok: boolean; dbPath: string; detail: string } {
  try {
    const db = getDb()
    const probeKey = '__health_probe__'
    db.insert(schema.settings)
      .values({ key: probeKey, value: String(Date.now()) })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: String(Date.now()) },
      })
      .run()
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, probeKey))
      .get()
    return {
      ok: !!row,
      dbPath: getDbPath(),
      detail: row ? `读写成功，probe=${row.value}` : '写入后读不到',
    }
  } catch (e) {
    return { ok: false, dbPath: getDbPath(), detail: String(e) }
  }
}

/** 应用退出前关闭连接。 */
export function closeDb() {
  try {
    _raw?.close()
  } catch {
    /* ignore */
  }
  _db = null
  _raw = null
}
