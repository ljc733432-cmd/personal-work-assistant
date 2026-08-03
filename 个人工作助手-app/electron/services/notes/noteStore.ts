import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureNotesDir, getNotesDir } from './config'

/**
 * 笔记存储（M12.7 v1.2 快速笔记，纯 .md 文件 + frontmatter）。
 *
 * PRD §13.2 工具 1 + §15.2：笔记 = 一个 .md 文件，frontmatter 存元数据。
 * 不入库（v2 才加索引层）。搜索 v1.2 用文件遍历 + 字符串匹配（限制 <500 条）。
 *
 * 文件名：{slug}.md，基于 title 生成（去特殊字符）。冲突追加 -2/-3。
 * title 改了不重命名文件（保持引用稳定）；frontmatter.title 是权威标题。
 *
 * 安全：所有路径在笔记库目录内（path.resolve + 起始校验，防 ../ 逃逸）。
 */

export interface Note {
  id: string
  title: string
  tags: string[]
  content: string // 正文 Markdown（不含 frontmatter）
  createdAt: number // Unix 秒
  updatedAt: number
  fileName: string // 相对笔记库的文件名（{slug}.md）
}

export interface NoteInput {
  id?: string // 更新时传
  title: string
  content?: string
  tags?: string[]
}

// ---------- frontmatter 解析/序列化 ----------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(FM_RE)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { meta, body: m[2] }
}

function serializeFrontmatter(note: Note): string {
  const lines = [
    '---',
    `id: ${note.id}`,
    `title: ${escapeYaml(note.title)}`,
    `tags: [${note.tags.map(escapeYaml).join(', ')}]`,
    `createdAt: ${note.createdAt}`,
    `updatedAt: ${note.updatedAt}`,
    '---',
    '',
    note.content,
  ]
  return lines.join('\n')
}

/** YAML 标量转义：含特殊字符（: # [ ] 等）或空格时加引号。保守起见全加双引号。 */
function escapeYaml(s: string): string {
  if (s === '') return '""'
  // 含双引号先转义，再整体包双引号
  if (/["\n\r]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`
  // 含其他特殊字符也包双引号
  if (/[:#\[\]{}&*!|>'%@`,]/.test(s)) return `"${s}"`
  return s
}

function rowToNote(fileName: string, raw: string): Note | null {
  const { meta, body } = parseFrontmatter(raw)
  if (!meta.id || !meta.title) return null
  return {
    id: meta.id,
    title: meta.title.replace(/^"|"$/g, ''),
    tags: parseTags(meta.tags),
    content: body,
    createdAt: Number(meta.createdAt) || 0,
    updatedAt: Number(meta.updatedAt) || 0,
    fileName,
  }
}

function parseTags(raw: string): string[] {
  const inner = raw.replace(/^\[|\]$/g, '').trim()
  if (!inner) return []
  return inner.split(',').map((t) => t.trim().replace(/^"|"$/g, '')).filter(Boolean)
}

// ---------- 文件名 slug ----------

function slugify(title: string): string {
  // 保留中文/字母/数字，其他替换为 -，去重复 -，trim -
  const s = title
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s || 'untitled'
}

/** 在笔记库内找一个不冲突的文件名（{slug}.md，冲突追加 -2/-3）。 */
function uniqueFileName(slug: string): string {
  const dir = getNotesDir()
  let candidate = `${slug}.md`
  let n = 2
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${slug}-${n}.md`
    n++
  }
  return candidate
}

// ---------- CRUD ----------

/** 列出全部笔记（按更新时间倒序）。目录不存在返回空数组。 */
export function listNotes(): Note[] {
  const dir = getNotesDir()
  if (!fs.existsSync(dir)) return []
  const out: Note[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8')
      const note = rowToNote(name, raw)
      if (note) out.push(note)
    } catch {
      // 单个文件读失败跳过（不影响整列）
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 按 id 读单条笔记。找不到返回 null。 */
export function getNote(id: string): Note | null {
  const dir = getNotesDir()
  if (!fs.existsSync(dir)) return null
  // 遍历找匹配 id 的（id 在 frontmatter，非文件名）
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8')
      const note = rowToNote(name, raw)
      if (note && note.id === id) return note
    } catch {
      // 跳过
    }
  }
  return null
}

/** 新建笔记。返回创建的笔记（含 id/fileName）。 */
export function createNote(input: NoteInput): Note {
  ensureNotesDir()
  const id = input.id ?? randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const fileName = uniqueFileName(slugify(input.title))
  const note: Note = {
    id,
    title: input.title,
    tags: input.tags ?? [],
    content: input.content ?? '',
    createdAt: now,
    updatedAt: now,
    fileName,
  }
  fs.writeFileSync(path.join(getNotesDir(), fileName), serializeFrontmatter(note), 'utf8')
  return note
}

/**
 * 更新笔记（按 id）。fileName 保持不变（除非传 changeFileName，默认 false）。
 * 找不到返回 null。
 */
export function updateNote(id: string, input: Partial<NoteInput>): Note | null {
  const existing = getNote(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const updated: Note = {
    ...existing,
    title: input.title ?? existing.title,
    tags: input.tags ?? existing.tags,
    content: input.content ?? existing.content,
    updatedAt: now,
  }
  fs.writeFileSync(path.join(getNotesDir(), existing.fileName), serializeFrontmatter(updated), 'utf8')
  return updated
}

/** 删除笔记（按 id）。直接删文件（v1.2 不进回收站——笔记是用户自己删，非覆盖场景）。 */
export function deleteNote(id: string): boolean {
  const existing = getNote(id)
  if (!existing) return false
  try {
    fs.unlinkSync(path.join(getNotesDir(), existing.fileName))
    return true
  } catch {
    return false
  }
}

/**
 * 全文搜索笔记（v1.2 文件遍历，PRD §13.2 限制 <500 条）。
 * 匹配 title 或 content（大小写不敏感），返回摘要（前 100 字）。
 */
export interface NoteSearchHit {
  id: string
  title: string
  fileName: string
  snippet: string // 匹配处前后片段
  updatedAt: number
}

export function searchNotes(query: string): NoteSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const all = listNotes()
  const hits: NoteSearchHit[] = []
  for (const n of all) {
    const inTitle = n.title.toLowerCase().includes(q)
    const idx = n.content.toLowerCase().indexOf(q)
    if (!inTitle && idx < 0) continue
    const snippet = makeSnippet(n.content, idx, q.length)
    hits.push({ id: n.id, title: n.title, fileName: n.fileName, snippet, updatedAt: n.updatedAt })
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt)
}

function makeSnippet(content: string, idx: number, len: number): string {
  if (idx < 0) return content.slice(0, 100)
  const start = Math.max(0, idx - 30)
  const end = Math.min(content.length, idx + len + 70)
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
}
