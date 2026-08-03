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
`

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db

  const dbPath = getDbPath()
  _raw = new Database(dbPath)
  _raw.pragma('journal_mode = WAL') // WAL 提升并发写
  _raw.pragma('foreign_keys = ON')

  // 启动建表
  _raw.exec(BOOTSTRAP_SQL)

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
