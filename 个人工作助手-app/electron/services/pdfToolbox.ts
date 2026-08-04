import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { resolveSafePath } from './fileTools'
import { listEnabledWorkDirs } from './providers/factory'
import { getNotesDir } from './notes/config'
import type { AccessibleDir } from './systemDirs'

/**
 * PDF 工具箱（v1.7 M16，PRD §15.4⑥）。
 *
 * 三个核心操作 + 页数查询（纯 pdf-lib，零 native 依赖，Electron 打包零地雷）：
 *  - 合并：多个 PDF → 一个
 *  - 提取：指定页码 → 新 PDF
 *  - 拆分：按每份页数 → 多个 PDF
 *
 * 安全（AGENTS.md 红线）：输入输出路径必须经 resolveSafePath（白名单/笔记库），
 * 防 ../ 逃逸 + 黑名单守密钥。照搬 converter 模式。
 *
 * 页码约定：UI 层 1-indexed（用户直觉），本服务层内部统一 0-indexed（pdf-lib 要求）。
 * 页码解析（如 "1,3,5-7"）在服务层做，容错非法输入。
 *
 * 不做（PRD 明确砍 v2）：压缩（pdf-lib 无真压缩）、预览（pdfjs-dist worker 坑）。
 */

export interface PdfInfo {
  pageCount: number
}

export interface PdfResult {
  ok: boolean
  outputPath: string
  bytes: number
  error?: string
}

export interface PdfSplitResult {
  ok: boolean
  outputs: string[] // 成功时各分片路径
  error?: string
}

/** 构造 sources（照搬 converter：workDirs + 笔记库 readwrite）。 */
function buildSources(): AccessibleDir[] {
  const list: AccessibleDir[] = []
  for (const wd of listEnabledWorkDirs()) {
    list.push({ label: wd.label, path: wd.path, source: 'workdir', mode: wd.mode })
  }
  try {
    list.push({ label: '笔记库', path: getNotesDir(), source: 'workdir', mode: 'readwrite' })
  } catch {
    // notesDir 取不到忽略
  }
  return list
}

/** 校验输入路径在白名单内，返回绝对路径或抛错。 */
function resolveInput(inputRaw: string): string {
  const sources = buildSources()
  const r = resolveSafePath(inputRaw, sources)
  if (!r.ok || !r.fullPath) {
    throw new Error(r.error || '输入路径不在可访问目录内')
  }
  return r.fullPath
}

/** 校验输出路径在白名单内（readwrite），返回绝对路径或抛错。 */
function resolveOutputPath(outputRaw: string): string {
  const sources = buildSources()
  const r = resolveSafePath(outputRaw, sources, { forWrite: true })
  if (!r.ok || !r.fullPath) {
    throw new Error(r.error || '输出路径不在可写目录内')
  }
  return r.fullPath
}

/** 读 PDF 字节并 load（统一入口，复用读文件 + pdf-lib load）。 */
async function loadPdf(filePath: string): Promise<PDFDocument> {
  const bytes = await fsp.readFile(filePath)
  return PDFDocument.load(bytes, { ignoreEncryption: true })
}

/** 查页数。 */
export async function getPdfInfo(inputPath: string): Promise<PdfInfo> {
  const full = resolveInput(inputPath)
  const doc = await loadPdf(full)
  return { pageCount: doc.getPageCount() }
}

/** 合并多个 PDF（按 paths 顺序）。outputPath 是输出绝对路径。 */
export async function mergePdfs(paths: string[], outputPath: string): Promise<PdfResult> {
  if (paths.length === 0) throw new Error('至少选择一个 PDF')
  const merged = await PDFDocument.create()
  for (const p of paths) {
    const full = resolveInput(p)
    const doc = await loadPdf(full)
    const copied = await merged.copyPages(doc, doc.getPageIndices())
    copied.forEach((page) => merged.addPage(page))
  }
  const out = resolveOutputPath(outputPath)
  const bytes = await merged.save()
  await fsp.writeFile(out, bytes)
  return { ok: true, outputPath: out, bytes: bytes.length }
}

/**
 * 提取指定页码。pagesInput 是用户输入（1-indexed，如 "1,3,5-7"），内部转 0-indexed。
 */
export async function extractPages(
  inputPath: string,
  pagesInput: string,
  outputPath: string,
): Promise<PdfResult> {
  const full = resolveInput(inputPath)
  const src = await loadPdf(full)
  const total = src.getPageCount()
  const indices = parsePageInput(pagesInput, total) // 转 0-indexed + 校验范围
  if (indices.length === 0) throw new Error('没有有效的页码')

  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, indices)
  copied.forEach((page) => out.addPage(page))

  const outPath = resolveOutputPath(outputPath)
  const bytes = await out.save()
  await fsp.writeFile(outPath, bytes)
  return { ok: true, outputPath: outPath, bytes: bytes.length }
}

/**
 * 拆分 PDF。perChunk = 每份页数（如 2 表示每 2 页一份）。
 * 输出到 outputDir，文件名原文件名加 _part1/_part2...
 */
export async function splitPdf(
  inputPath: string,
  perChunk: number,
  outputDir: string,
): Promise<PdfSplitResult> {
  if (perChunk < 1) throw new Error('每份页数必须 ≥ 1')
  const full = resolveInput(inputPath)
  const src = await loadPdf(full)
  const total = src.getPageCount()

  // 输出目录校验（用 resolveSafePath 校验目录可写：拼一个占位文件路径测）
  const baseName = path.basename(full, '.pdf')
  const probePath = path.join(outputDir, `${baseName}_part1.pdf`)
  const resolvedDir = path.dirname(resolveOutputPath(probePath))

  const outputs: string[] = []
  const partCount = Math.ceil(total / perChunk)
  for (let i = 0; i < partCount; i++) {
    const start = i * perChunk
    const end = Math.min(start + perChunk, total)
    const indices = Array.from({ length: end - start }, (_, k) => start + k)

    const part = await PDFDocument.create()
    const copied = await part.copyPages(src, indices)
    copied.forEach((page) => part.addPage(page))

    const outPath = path.join(resolvedDir, `${baseName}_part${i + 1}.pdf`)
    const bytes = await part.save()
    await fsp.writeFile(outPath, bytes)
    outputs.push(outPath)
  }
  return { ok: true, outputs }
}

/**
 * 解析页码输入（1-indexed，如 "1,3,5-7"）转 0-indexed 数组。
 * 容错：忽略空白、非法 token；超范围页码自动夹紧并跳过。
 * 返回去重排序后的 0-indexed 数组。
 */
function parsePageInput(input: string, total: number): number[] {
  const tokens = input.split(/[,，\s]+/).filter(Boolean)
  const set = new Set<number>()
  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)[-~](\d+)$/)
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10)
      const b = parseInt(rangeMatch[2], 10)
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      for (let p = lo; p <= hi; p++) {
        if (p >= 1 && p <= total) set.add(p - 1) // 转 0-indexed
      }
      continue
    }
    const n = parseInt(token, 10)
    if (Number.isFinite(n) && n >= 1 && n <= total) set.add(n - 1)
  }
  return Array.from(set).sort((a, b) => a - b)
}
