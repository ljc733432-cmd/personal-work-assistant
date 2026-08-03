import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { settings } from '../db/schema'

/**
 * 笔记库配置（M12.7 v1.2 快速笔记）。
 *
 * PRD §13.2 工具 1：笔记根目录 = 用户设置里指定的「笔记库目录」
 *（默认 userData/notes/，可改）。
 * 该目录自动加入文件工具白名单（AI 能直接读写），无需用户额外配。
 *
 * 存储见 PRD §13.2：纯 .md 文件 + frontmatter，不入库（v2 才加索引）。
 */

const SETTING_KEY = 'notes.rootDir'

/**
 * 获取笔记库目录（绝对路径）。
 * 优先读 settings；未配则用默认 userData/notes/，并确保目录存在。
 */
export function getNotesDir(): string {
  const row = getDb().select().from(settings).where(eq(settings.key, SETTING_KEY)).get()
  const dir = row?.value?.trim() || defaultNotesDir()
  return dir
}

/** 设置笔记库目录（设置页调）。空字符串 = 恢复默认。 */
export function setNotesDir(dir: string): string {
  const trimmed = dir.trim()
  const value = trimmed || defaultNotesDir()
  const now = Math.floor(Date.now() / 1000)
  const db = getDb()
  const existing = db.select().from(settings).where(eq(settings.key, SETTING_KEY)).get()
  if (existing) {
    db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, SETTING_KEY)).run()
  } else {
    db.insert(settings).values({ key: SETTING_KEY, value, updatedAt: now }).run()
  }
  return value
}

/** 默认笔记库目录：userData/notes/。 */
function defaultNotesDir(): string {
  return path.join(app.getPath('userData'), 'notes')
}

/** 确保笔记库目录存在（首次访问时创建）。返回目录路径。 */
export function ensureNotesDir(): string {
  const dir = getNotesDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // 创建失败由调用方处理（读笔记时若目录不存在返回空列表）
  }
  return dir
}
