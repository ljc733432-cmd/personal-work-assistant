import { app } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { WorkDir } from '../types'
import { logInfo, logError } from './logger'

const require = createRequire(import.meta.url)

/**
 * 文件工具核心（M5）——安全心脏。
 *
 * 三重防护见 CONTEXT.md「写入三重防护」：
 *  1. 路径校验：resolveSafePath 防 ../ 逃逸，必须在白名单内。
 *  2. 覆盖确认：write_file 目标已存在 → 由 FC 循环挂起弹窗（见 chat.ts）。
 *  3. 回收站：覆盖前原文件移到 userData/fileTrash/{timestamp}/。
 */

const MAX_READ_BYTES = 10 * 1024 * 1024 // 读上限 10MB
const MAX_WRITE_BYTES = 5 * 1024 * 1024 // 写上限 5MB
const MAX_LIST_ENTRIES = 200 // 列目录上限，防海量文件撑爆上下文
const MAX_FIND_RESULTS = 50
const READ_TRUNCATE_CHARS = 20000 // 文本读取超过此字符截断

// ---------- 路径校验 ----------

export interface ResolvedPath {
  ok: boolean
  fullPath?: string
  workDir?: WorkDir
  error?: string
}

/**
 * 把「模型给的路径」解析为安全的绝对路径。
 * - 相对路径：相对某个白名单根解析（优先用第一个匹配的根，或显式指定 baseLabel）。
 * - 绝对路径：必须落在某个白名单内。
 * - 防御 ../ 逃逸：用 path.resolve + startsWith 双重判定。
 */
export function resolveSafePath(
  inputPath: string,
  workDirs: WorkDir[],
  opts: { forWrite?: boolean; baseLabel?: string } = {},
): ResolvedPath {
  const { forWrite = false, baseLabel } = opts

  // 筛选可用白名单：写操作只要 readwrite 的
  const candidates = workDirs.filter((d) => (forWrite ? d.mode === 'readwrite' : true))
  if (candidates.length === 0) {
    return {
      ok: false,
      error: forWrite
        ? '未配置任何「读写」工作目录，无法写入。请在设置页添加。'
        : '未配置任何工作目录。',
    }
  }

  // 选基根：显式 baseLabel 优先，否则取第一个
  const base = baseLabel
    ? candidates.find((d) => d.label === baseLabel || d.path === baseLabel)
    : candidates[0]
  if (!base) {
    return { ok: false, error: `找不到工作目录「${baseLabel}」` }
  }

  // path.isAbsolute 判断。Windows 也认 D:\ 风格。
  const isAbs = path.isAbsolute(inputPath)
  const root = path.resolve(base.path)
  const full = isAbs ? path.resolve(inputPath) : path.resolve(root, inputPath)

  // 关键：规范化后必须在某白名单根之下（防 ../ 逃逸）
  const belonging = candidates.find((d) => {
    const rp = path.resolve(d.path)
    return full === rp || full.startsWith(rp + path.sep)
  })

  if (!belonging) {
    logError('[fileTools] 路径越界，拒绝：', full)
    return { ok: false, error: `路径越界（不在任何工作目录内），已拒绝：${inputPath}` }
  }

  // 写权限二次校验（即便路径落在 read 根下）
  if (forWrite && belonging.mode !== 'readwrite') {
    return { ok: false, error: `目录「${belonging.label}」是只读的，不允许写入。` }
  }

  return { ok: true, fullPath: full, workDir: belonging }
}

// ---------- 列目录 ----------

export interface DirEntry {
  name: string
  isDir: boolean
  size: number
  mtime: string // ISO
}

export async function listFiles(
  inputDir: string,
  workDirs: WorkDir[],
  baseLabel?: string,
): Promise<string> {
  const r = resolveSafePath(inputDir, workDirs, { baseLabel })
  if (!r.ok || !r.fullPath) return JSON.stringify({ error: r.error })

  try {
    const entries = await fsp.readdir(r.fullPath, { withFileTypes: true })
    const out: DirEntry[] = []
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) break
      const full = path.join(r.fullPath, e.name)
      let stat: fs.Stats
      try {
        stat = await fsp.stat(full)
      } catch {
        continue
      }
      out.push({
        name: e.name,
        isDir: e.isDirectory(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      })
    }
    return JSON.stringify({
      dir: r.fullPath,
      baseLabel: r.workDir?.label,
      count: out.length,
      truncated: entries.length > MAX_LIST_ENTRIES,
      entries: out,
    })
  } catch (e) {
    return JSON.stringify({ error: `读取目录失败: ${String(e)}` })
  }
}

// ---------- 读文件 ----------

/** 读文件内容，支持 txt/md/json 等文本 + pdf/docx。大文件截断。 */
export async function readFileContent(
  inputPath: string,
  workDirs: WorkDir[],
  baseLabel?: string,
): Promise<string> {
  const r = resolveSafePath(inputPath, workDirs, { baseLabel })
  if (!r.ok || !r.fullPath) return JSON.stringify({ error: r.error })

  try {
    const stat = await fsp.stat(r.fullPath)
    if (stat.isDirectory()) return JSON.stringify({ error: '目标是目录，不是文件' })
    if (stat.size > MAX_READ_BYTES) {
      return JSON.stringify({ error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_READ_BYTES / 1024 / 1024}MB` })
    }

    const ext = path.extname(r.fullPath).toLowerCase()
    let text: string

    if (ext === '.pdf') {
      text = await readPdf(r.fullPath)
    } else if (ext === '.docx') {
      text = await readDocx(r.fullPath)
    } else if (ext === '.doc') {
      return JSON.stringify({ error: '旧版 .doc 暂不支持，请转成 .docx' })
    } else {
      // 默认按文本读（txt/md/json/csv/log/code 等）
      text = await fsp.readFile(r.fullPath, 'utf-8')
    }

    const truncated = text.length > READ_TRUNCATE_CHARS
    const content = truncated ? text.slice(0, READ_TRUNCATE_CHARS) : text
    return JSON.stringify({
      path: r.fullPath,
      size: stat.size,
      ext,
      truncated,
      truncatedAt: truncated ? READ_TRUNCATE_CHARS : undefined,
      content,
    })
  } catch (e) {
    return JSON.stringify({ error: `读取失败: ${String(e)}` })
  }
}

async function readPdf(file: string): Promise<string> {
  // 用 require 而非 import，避开 pdf-parse 的 ESM/CJS 导出差异
  const pdfParse = require('pdf-parse') as (data: Buffer) => Promise<{ text: string }>
  const buf = await fsp.readFile(file)
  const data = await pdfParse(buf)
  return data.text || ''
}

async function readDocx(file: string): Promise<string> {
  const mammoth = require('mammoth') as {
    extractRawText: (opts: { path: string }) => Promise<{ value: string }>
  }
  const result = await mammoth.extractRawText({ path: file })
  return result.value || ''
}

// ---------- 智能搜索 ----------

export interface FindParams {
  query?: string // 文件名关键词（不区分大小写）
  dateFrom?: string // ISO 日期，含
  dateTo?: string
  ext?: string // 扩展名，如 "md" 或 ".md"
  baseLabel?: string // 限定某个白名单根，不填则搜全部
}

export interface FindResult {
  path: string // 相对根的路径，便于模型引用
  absPath: string
  name: string
  size: number
  mtime: string
  baseLabel: string
}

/** 递归扫描白名单，按 名/日期/扩展名 过滤。 */
export async function findFiles(params: FindParams, workDirs: WorkDir[]): Promise<string> {
  const roots = params.baseLabel
    ? workDirs.filter((d) => d.label === params.baseLabel || d.path === params.baseLabel)
    : workDirs
  if (roots.length === 0) {
    return JSON.stringify({ error: '未配置工作目录，或指定的目录不存在' })
  }

  const extNorm = params.ext ? (params.ext.startsWith('.') ? params.ext.toLowerCase() : '.' + params.ext.toLowerCase()) : null
  const queryLower = params.query?.toLowerCase()
  const fromMs = params.dateFrom ? new Date(params.dateFrom).getTime() : null
  const toMs = params.dateTo ? new Date(params.dateTo).getTime() + 86400000 : null // dateTo 含当天

  const results: FindResult[] = []

  for (const root of roots) {
    const rootAbs = path.resolve(root.path)
    await walk(rootAbs, rootAbs, root.label, async (abs, rel, stat) => {
      if (results.length >= MAX_FIND_RESULTS) return
      const name = path.basename(abs)
      // 关键词
      if (queryLower && !name.toLowerCase().includes(queryLower)) return
      // 扩展名
      if (extNorm && path.extname(name).toLowerCase() !== extNorm) return
      // 日期
      const mt = stat.mtimeMs
      if (fromMs !== null && mt < fromMs) return
      if (toMs !== null && mt > toMs) return
      results.push({
        path: rel,
        absPath: abs,
        name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        baseLabel: root.label,
      })
    }).catch((e) => logError('[findFiles] walk error:', String(e)))
  }

  return JSON.stringify({
    count: results.length,
    truncated: results.length >= MAX_FIND_RESULTS,
    results,
  })
}

/** 递归遍历目录，对每个文件调 cb。跳过 node_modules/.git 等。 */
async function walk(
  rootAbs: string,
  current: string,
  label: string,
  cb: (abs: string, rel: string, stat: fs.Stats) => Promise<void> | void,
): Promise<void> {
  const SKIP = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue
    const abs = path.join(current, e.name)
    const rel = path.relative(rootAbs, abs)
    try {
      const stat = await fsp.stat(abs)
      if (e.isDirectory()) {
        await walk(rootAbs, abs, label, cb)
      } else if (e.isFile()) {
        await cb(abs, rel, stat)
      }
    } catch {
      continue
    }
  }
}

// ---------- 回收站（写入三重防护第 3 层） ----------

function trashDir(): string {
  const dir = path.join(app.getPath('userData'), 'fileTrash')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 把目标文件移入回收站（带时间戳子目录），返回回收站路径。 */
export function moveToTrash(filePath: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(trashDir(), ts, path.basename(filePath))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(filePath, dest)
  logInfo('[fileTools] 文件进回收站:', filePath, '->', dest)
  return dest
}

export { MAX_WRITE_BYTES }
