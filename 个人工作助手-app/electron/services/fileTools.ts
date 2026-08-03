import { app } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { WorkDir } from '../types'
import type { AccessibleDir } from './systemDirs'
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
  belonging?: AccessibleDir
  /** 读取需首次确认的目录（绝对路径）。 */
  needsConfirm?: string
  /** 写入需用户授权的目录（绝对路径，落到只读 source 内）。授权后本次会话可写。 */
  needsWriteConfirm?: string
  error?: string
}

/**
 * 把「模型给的路径」解析为安全的绝对路径（M5.1 多来源版）。
 *
 * sources = 系统位置 + 预填 workDirs + 会话已确认目录。
 * - 绝对路径：若落在某 source 内 → ok；否则视为「新目录」→ needsConfirm。
 * - 相对路径：按 baseLabel 或首个 source 解析；解析后仍需落在某 source 内。
 * - 防御 ../ 逃逸：path.resolve + startsWith 双重判定。
 *
 * forWrite 时：只接受 mode=readwrite 的 source（系统位置/只读预填都拒绝写）。
 */
export function resolveSafePath(
  inputPath: string,
  sources: AccessibleDir[],
  opts: { forWrite?: boolean; baseLabel?: string } = {},
): ResolvedPath {
  const { forWrite = false, baseLabel } = opts

  // 写操作：只要 readwrite 的 source
  const candidates = sources.filter((d) => (forWrite ? d.mode === 'readwrite' : true))

  const isAbs = path.isAbsolute(inputPath)
  const full = isAbs
    ? path.resolve(inputPath)
    : path.resolve(baseRoot(sources, baseLabel), inputPath)

  // 是否落在某 source 内
  const belonging = candidates.find((d) => {
    const rp = path.resolve(d.path)
    return full === rp || full.startsWith(rp + path.sep)
  })

  if (belonging) {
    return { ok: true, fullPath: full, belonging }
  }

  // 写操作：落在只读 source（如系统位置）→ 需用户授权，授权后本次会话可写
  if (forWrite) {
    const inReadonly = sources.find((d) => {
      const rp = path.resolve(d.path)
      return (full === rp || full.startsWith(rp + path.sep)) && d.mode === 'read'
    })
    if (inReadonly) {
      // 不直接拒，而是要求授权（用户同意后本次会话该目录变可写）
      return { ok: false, needsWriteConfirm: path.resolve(inReadonly.path) }
    }
    // 写入到全新目录 → 拒绝（写入必须落在已知目录内）
    return { ok: false, error: `写入路径不在任何可访问目录内：${inputPath}。可让用户在「常用目录」里添加该目录为「读写」。` }
  }

  // 读操作：绝对路径但不在任何 source 内 → 需用户首次确认
  if (isAbs) {
    return { ok: false, needsConfirm: extractDirRoot(full) }
  }

  // 相对路径解析后越界 → 拒绝（相对路径不触发首次确认，避免歧义）
  logError('[fileTools] 相对路径越界，拒绝：', full)
  return { ok: false, error: `路径不在可访问范围内：${inputPath}（可用 list_accessible_dirs 查看）` }
}

/** 取 base 根路径：显式 baseLabel 优先，否则首个 source。 */
function baseRoot(sources: AccessibleDir[], baseLabel?: string): string {
  if (baseLabel) {
    const f = sources.find((d) => d.label === baseLabel || d.path === baseLabel)
    if (f) return path.resolve(f.path)
  }
  return sources.length > 0 ? path.resolve(sources[0].path) : process.cwd()
}

/** 从完整路径提取"目录根"用于首次确认。
 *  策略：取到盘符下一级（如 D:\工作\报告 → D:\工作），避免一次确认整个盘。
 *  若已是盘根（D:\）则原样返回。 */
function extractDirRoot(full: string): string {
  const resolved = path.resolve(full)
  const parsed = path.parse(resolved)
  // resolved = D:\工作\报告 → dir = D:\工作
  // 若 dir 等于盘根（D:\），直接用 resolved
  const parent = parsed.dir
  if (parent.toLowerCase() === parsed.root.toLowerCase()) {
    return resolved // 已经是盘根下一级
  }
  return parent
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
  sources: AccessibleDir[],
  baseLabel?: string,
): Promise<string> {
  const r = resolveSafePath(inputDir, sources, { baseLabel })
  if (!r.ok || !r.fullPath) {
    return JSON.stringify({ error: r.error, needsConfirm: r.needsConfirm })
  }

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
      baseLabel: r.belonging?.label,
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
  sources: AccessibleDir[],
  baseLabel?: string,
): Promise<string> {
  const r = resolveSafePath(inputPath, sources, { baseLabel })
  if (!r.ok || !r.fullPath) {
    return JSON.stringify({ error: r.error, needsConfirm: r.needsConfirm })
  }

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

/** 递归扫描可访问目录，按 名/日期/扩展名 过滤。跨系统位置/预填/会话确认的目录。 */
export async function findFiles(params: FindParams, sources: AccessibleDir[]): Promise<string> {
  const roots = params.baseLabel
    ? sources.filter((d) => d.label === params.baseLabel || d.path === params.baseLabel)
    : sources
  if (roots.length === 0) {
    return JSON.stringify({ error: '没有可访问的目录（系统位置/工作目录均不可用）' })
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

// ---------- 列出可访问目录（让模型知道范围） ----------

/** 返回当前可访问的目录清单（label/path/source/mode），供模型决定去哪找。 */
export function listAccessibleDirs(sources: AccessibleDir[]): string {
  const dirs = sources.map((d) => ({
    label: d.label,
    path: d.path,
    source: d.source, // system | workdir | session
    mode: d.mode, // read | readwrite
  }))
  return JSON.stringify({
    count: dirs.length,
    hint: '这些是当前可读的目录。用户说「读某文件」时优先在这些目录找；find_files 默认搜全部。如需访问其他目录，告诉用户路径或让用户在对话里指定。',
    dirs,
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
