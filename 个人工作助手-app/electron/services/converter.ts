import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { marked } from 'marked'
import { resolveSafePath } from './fileTools'
import { listEnabledWorkDirs } from './providers/factory'
import { getNotesDir } from './notes/config'

/**
 * 文档转换（M12.9 v1.2 工具扩展，PRD §13.2 工具 3）。
 *
 * 支持矩阵（PRD §13.2 v1.2 最小集）：
 *   md ↔ txt（纯文本）
 *   md → html（marked）
 *   md → docx（docx 库，简化排版：标题/正文段落）
 *   md → pdf（pdfkit + 系统中文字体，TV-4 验证）
 *   docx → md/txt/html（mammoth 已有）
 *
 * 安全（AGENTS.md 红线）：输入输出路径必须经 resolveSafePath（白名单/笔记库），
 * 防 ../ 逃逸 + 黑名单守密钥。转换在主进程，不执行系统命令。
 */

// 启用同步模式（marked 默认可能返回 Promise）
marked.setOptions({ async: false, gfm: true })

export type TargetFormat = 'md' | 'txt' | 'html' | 'docx' | 'pdf'

export interface ConvertResult {
  ok: boolean
  outputPath: string
  inputFormat: string
  targetFormat: TargetFormat
  bytes: number
  error?: string
}

/** 支持的输入→输出组合。 */
const SUPPORTED: Record<string, TargetFormat[]> = {
  md: ['txt', 'html', 'docx', 'pdf'],
  txt: ['md'],
  docx: ['md', 'txt', 'html'],
}

export function supportedTargets(inputExt: string): TargetFormat[] {
  const ext = inputExt.toLowerCase().replace(/^\./, '')
  return SUPPORTED[ext] ?? []
}

/**
 * 执行转换。inputPath/outputPath 都经 resolveSafePath。
 * outputPath 缺省时输出到与输入同目录、换扩展名。
 */
export async function convertDocument(params: {
  inputPath: string
  targetFormat: TargetFormat
  outputPath?: string
}): Promise<ConvertResult> {
  const { inputPath: inputRaw, targetFormat, outputPath: outputRaw } = params

  // 1. 校验输入路径（白名单内）
  const sources = buildSourcesForConvert()
  const inResolved = resolveSafePath(inputRaw, sources)
  if (!inResolved.ok || !inResolved.fullPath) {
    return fail(inputRaw, targetFormat, inResolved.error ?? '输入路径非法')
  }
  const inputPath = inResolved.fullPath
  if (!fs.existsSync(inputPath)) {
    return fail(inputRaw, targetFormat, `输入文件不存在：${inputPath}`)
  }

  // 2. 推断输出路径
  const inputExt = path.extname(inputPath).slice(1).toLowerCase()
  if (!SUPPORTED[inputExt]) {
    return fail(inputRaw, targetFormat, `不支持的输入格式：${inputExt || '无扩展名'}`)
  }
  if (!SUPPORTED[inputExt].includes(targetFormat)) {
    return fail(inputRaw, targetFormat, `${inputExt} → ${targetFormat} 不在支持矩阵内`)
  }
  const outputPath =
    outputRaw && outputRaw.trim()
      ? resolveOutput(outputRaw, sources, inputPath, targetFormat)
      : swapExt(inputPath, targetFormat)
  if (!outputPath) {
    return fail(inputRaw, targetFormat, '输出路径非法')
  }

  // 3. 读输入内容
  let content: string
  try {
    if (inputExt === 'docx') {
      content = await readDocx(inputPath, targetFormat)
    } else {
      content = await fsp.readFile(inputPath, 'utf8')
    }
  } catch (e) {
    return fail(inputRaw, targetFormat, `读输入失败：${String(e)}`)
  }

  // 4. 转换 + 写输出
  try {
    let outBuffer: Buffer | string
    if (inputExt === 'md' || inputExt === 'txt') {
      outBuffer = await convertFromMdOrTxt(content, inputExt, targetFormat)
    } else {
      // docx 已经在 readDocx 里转成目标格式字符串了
      outBuffer = content
    }
    await fsp.writeFile(outputPath, outBuffer)
    const bytes = fs.statSync(outputPath).size
    return { ok: true, outputPath, inputFormat: inputExt, targetFormat, bytes }
  } catch (e) {
    return fail(inputRaw, targetFormat, `转换/写入失败：${String(e)}`)
  }
}

/** 读 docx → 目标格式字符串（用 mammoth）。 */
async function readDocx(file: string, target: TargetFormat): Promise<string> {
  // 动态 require（mammoth 是 CJS）
  const require = (await import('node:module')).createRequire(import.meta.url)
  const mammoth = require('mammoth') as {
    extractRawText: (opts: { path: string }) => Promise<{ value: string }>
    convertToHtml: (opts: { path: string }) => Promise<{ value: string }>
  }
  if (target === 'html') {
    const r = await mammoth.convertToHtml({ path: file })
    return r.value
  }
  // md / txt 都走纯文本（md 是 txt 的超集，纯文本可作为简化 md）
  const r = await mammoth.extractRawText({ path: file })
  return r.value
}

/** md/txt → 目标格式。 */
async function convertFromMdOrTxt(content: string, fromExt: string, to: TargetFormat): Promise<string | Buffer> {
  switch (to) {
    case 'txt':
      // 去 markdown 语法标记的简化版：保留文本，去 #/*/- 标记
      return stripMarkdown(content)
    case 'html':
      return fullHtml(marked.parse(content, { async: false }) as string)
    case 'md':
      // txt → md：直接当正文（无格式）
      return content
    case 'docx':
      return await buildDocx(content)
    case 'pdf':
      return await buildPdf(content)
  }
}

// ---------- 输出构造 helpers ----------

/** txt：去掉 markdown 标记（标题井号、粗体星号、列表短横、链接）。简化版。 */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '') // 标题
    .replace(/\*\*(.+?)\*\*/g, '$1') // 粗体
    .replace(/\*(.+?)\*/g, '$1') // 斜体
    .replace(/`(.+?)`/g, '$1') // 行内代码
    .replace(/^\s*[-*+]\s+/gm, '• ') // 列表
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1（$2）') // 链接
    .replace(/^>\s+/gm, '') // 引用
}

/** html：包一个完整 HTML 文档（含 utf-8 meta + 基础样式）。 */
function fullHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>文档转换输出</title>
<style>
body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 760px; margin: 2em auto; padding: 0 1em; line-height: 1.7; color: #18181b; }
h1,h2,h3 { line-height: 1.3; }
code { background: #f4f4f5; padding: 0.1em 0.3em; border-radius: 3px; font-family: Consolas, monospace; }
pre { background: #f4f4f5; padding: 1em; border-radius: 6px; overflow-x: auto; }
pre code { background: transparent; padding: 0; }
blockquote { border-left: 3px solid #e4e4e7; padding-left: 1em; color: #71717a; }
table { border-collapse: collapse; } th, td { border: 1px solid #e4e4e7; padding: 0.4em 0.7em; }
</style>
</head>
<body>
${body}
</body>
</html>`
}

/** docx：按行分割，标题行用 Heading，其他用正文段落。 */
async function buildDocx(md: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx')
  const paragraphs: InstanceType<typeof Paragraph>[] = []
  for (const line of md.split(/\r?\n/)) {
    const trimmed = line.trimEnd()
    if (/^#\s+/.test(trimmed)) {
      paragraphs.push(new Paragraph({ text: trimmed.replace(/^#\s+/, ''), heading: HeadingLevel.HEADING_1 }))
    } else if (/^##\s+/.test(trimmed)) {
      paragraphs.push(new Paragraph({ text: trimmed.replace(/^##\s+/, ''), heading: HeadingLevel.HEADING_2 }))
    } else if (/^###\s+/.test(trimmed)) {
      paragraphs.push(new Paragraph({ text: trimmed.replace(/^###\s+/, ''), heading: HeadingLevel.HEADING_3 }))
    } else if (/^\s*[-*+]\s+/.test(trimmed)) {
      paragraphs.push(new Paragraph({ text: trimmed.replace(/^\s*[-*+]\s+/, ''), bullet: { level: 0 } }))
    } else if (trimmed === '') {
      paragraphs.push(new Paragraph({ text: '' }))
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: trimmed })] }))
    }
  }
  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buf = await Packer.toBuffer(doc)
  return buf
}

/** pdf：pdfkit + 系统中文字体（TV-4 验证：simhei.ttf）。 */
async function buildPdf(md: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // 中文字体：Windows simhei.ttf（TV-4 验证）；找不到则退默认（中文乱码但不崩）
    const fontCandidates = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf']
    // pdfkit 不支持 .ttc，跳过；优先 simhei.ttf
    const fontPath = 'C:/Windows/Fonts/simhei.ttf'
    if (fs.existsSync(fontPath)) {
      try {
        doc.font(fontPath)
      } catch {
        // 字体加载失败用默认
      }
    }

    // 按行写：标题大字号，正文常规
    const lines = md.split(/\r?\n/)
    let firstLine = true
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '')
      if (firstLine) firstLine = false
      else doc.moveDown(0.3)
      if (/^#\s+/.test(line)) {
        doc.fontSize(20).text(line.replace(/^#\s+/, ''))
      } else if (/^#{2,3}\s+/.test(line)) {
        doc.fontSize(15).text(line.replace(/^#{2,3}\s+/, ''))
      } else if (/^\s*[-*+]\s+/.test(line)) {
        doc.fontSize(11).text('  • ' + line.replace(/^\s*[-*+]\s+/, ''))
      } else {
        doc.fontSize(11).text(line)
      }
    }
    doc.end()
  })
}

// ---------- 路径 helpers ----------

/** 转换用的 sources：白名单 + 笔记库（readwrite）。 */
function buildSourcesForConvert() {
  // 复用 fileTools 的 sources 概念：系统位置 + workDirs + 笔记库
  // 这里简化：用 workDirs + 笔记库（转换操作对象通常是用户文件）
  // resolveSafePath 内部会处理黑名单
  const list: { label: string; path: string; source: 'workdir' | 'system' | 'session'; mode: 'read' | 'readwrite' }[] = []
  for (const wd of listEnabledWorkDirs()) {
    list.push({ label: wd.label, path: wd.path, source: 'workdir', mode: wd.mode })
  }
  // 笔记库恒可读写
  try {
    list.push({ label: '笔记库', path: getNotesDir(), source: 'workdir', mode: 'readwrite' })
  } catch {
    // notesDir 取不到忽略
  }
  return list
}

/** 解析输出路径（白名单内）。返回 null=非法。 */
function resolveOutput(
  outputRaw: string,
  sources: ReturnType<typeof buildSourcesForConvert>,
  inputPath: string,
  target: TargetFormat,
): string | null {
  // 绝对路径：校验白名单
  if (path.isAbsolute(outputRaw)) {
    const r = resolveSafePath(outputRaw, sources, { forWrite: true })
    if (r.ok && r.fullPath) return r.fullPath
    // 输出路径不在白名单 → 退到输入文件同目录（更友好）
  }
  // 相对路径 / 非法 → 输入文件同目录换扩展名
  return swapExt(inputPath, target)
}

/** 同目录换扩展名。 */
function swapExt(filePath: string, target: TargetFormat): string {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath, path.extname(filePath))
  return path.join(dir, `${base}.${target}`)
}

function fail(input: string, target: TargetFormat, error: string): ConvertResult {
  return { ok: false, outputPath: '', inputFormat: '', targetFormat: target, bytes: 0, error }
}
