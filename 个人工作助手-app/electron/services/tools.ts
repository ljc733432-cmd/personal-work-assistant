import type { ToolRegistration } from './providers/types'
import type { AccessibleDir } from './systemDirs'
import {
  listFiles,
  readFileContent,
  findFiles,
  listAccessibleDirs,
  moveToTrash,
  resolveSafePath,
  MAX_WRITE_BYTES,
  type FindParams,
} from './fileTools'
import type { ToolHandlerResult } from './providers/types'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 工具组装（M5.1 多来源版）。
 *
 * sources = 系统位置 + 预填 workDirs + 会话已确认目录。
 *
 * 工具：
 *  - get_current_time（始终）
 *  - list_accessible_dirs（始终，只要有 sources）—— 让模型知道范围
 *  - list_files / read_file / find_files（只要有 sources）
 *  - write_file（只要有 readwrite source）
 *
 * 关键：read/list 遇到「需首次确认的目录」→ 返回 confirm →
 * 用户同意 → 调 onSessionApprove(dir) 加入会话授权 → 重试本次操作。
 */

export interface ToolContext {
  sources: AccessibleDir[]
  /** 用户确认访问某目录后，把它加入会话授权（本次会话有效）。 */
  onSessionApprove: (dir: string, label: string) => void
}

// ---------- 当前时间 ----------
const getCurrentTimeTool: ToolRegistration = {
  def: {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前的本地日期和时间。当用户询问现在几点、今天日期时调用。',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: '可选时区提示，如 Asia/Shanghai' },
        },
        required: [],
      },
    },
  },
  handler: () => {
    const now = new Date()
    return JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      weekday: now.toLocaleDateString('zh-CN', { weekday: 'long' }),
    })
  },
}

// ---------- list_accessible_dirs ----------
function makeListDirsTool(ctx: ToolContext): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'list_accessible_dirs',
        description: '列出当前可访问的目录（系统位置「文档/桌面/下载」+ 用户配置的常用目录 + 本次会话已授权的目录）。用户说「读某文件」「找某天文件」时先调这个看范围。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: () => listAccessibleDirs(ctx.sources),
  }
}

// ---------- list_files ----------
function makeListFilesTool(ctx: ToolContext): ToolRegistration {
  const labels = ctx.sources.map((d) => `「${d.label}」`).join('、')
  return {
    def: {
      type: 'function',
      function: {
        name: 'list_files',
        description: `列出目录里的文件和子目录。可访问目录：${labels}。dir 填目录 label 或路径。访问新目录会要求用户首次确认。`,
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: '目录 label（如"文档"）或绝对路径' },
          },
          required: ['dir'],
        },
      },
    },
    handler: async (args, confirm) => {
      const dir = String(args.dir ?? '')
      return await withDirConfirm(ctx, confirm, dir, async (sources) => listFiles(dir, sources))
    },
  }
}

// ---------- read_file ----------
function makeReadFileTool(ctx: ToolContext): ToolRegistration {
  const labels = ctx.sources.map((d) => `「${d.label}」`).join('、')
  return {
    def: {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取文件内容（支持 txt/md/json/csv/代码/pdf/docx）。可访问目录：${labels}。大文件截断。访问新目录会要求用户首次确认。`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，可用 find_files 返回的路径，或「label/子路径」' },
          },
          required: ['path'],
        },
      },
    },
    handler: async (args, confirm) => {
      const p = String(args.path ?? '')
      return await withDirConfirm(ctx, confirm, p, async (sources) => readFileContent(p, sources))
    },
  }
}

// ---------- find_files ----------
function makeFindFilesTool(ctx: ToolContext): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'find_files',
        description: '在可访问目录里按文件名/日期/扩展名搜索。用户说「找某天的报告」「7月30号的文件」时用这个。默认搜全部可访问目录。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文件名关键词（不区分大小写），可选' },
            dateFrom: { type: 'string', description: '修改日期起点，YYYY-MM-DD，含当天' },
            dateTo: { type: 'string', description: '修改日期终点，YYYY-MM-DD，含当天' },
            ext: { type: 'string', description: '扩展名，如 "md"、"docx"，可选' },
            baseLabel: { type: 'string', description: '限定某个目录 label，可选' },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      const params: FindParams = {
        query: args.query ? String(args.query) : undefined,
        dateFrom: args.dateFrom ? String(args.dateFrom) : undefined,
        dateTo: args.dateTo ? String(args.dateTo) : undefined,
        ext: args.ext ? String(args.ext) : undefined,
        baseLabel: args.baseLabel ? String(args.baseLabel) : undefined,
      }
      return findFiles(params, ctx.sources)
    },
  }
}

// ---------- write_file ----------
function makeWriteFileTool(ctx: ToolContext): ToolRegistration {
  const rwLabels = ctx.sources
    .filter((d) => d.mode === 'readwrite')
    .map((d) => `「${d.label}」`)
    .join('、')
  return {
    def: {
      type: 'function',
      function: {
        name: 'write_file',
        description: `写入/创建文件。可写目录：${rwLabels || '（暂无，写入需用户确认）'}。覆盖已存在文件前会要求用户确认。注意：文档/桌面/下载是只读的，不能写。`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目标文件路径，相对可写目录或绝对路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    handler: async (args) => {
      const p = String(args.path ?? '')
      const content = String(args.content ?? '')

      // 大小校验先做
      const bytes = Buffer.byteLength(content, 'utf-8')
      if (bytes > MAX_WRITE_BYTES) {
        return {
          kind: 'result',
          value: JSON.stringify({ error: `内容过大（${(bytes / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_WRITE_BYTES / 1024 / 1024}MB` }),
        }
      }

      const r = resolveSafePath(p, ctx.sources, { forWrite: true })
      if (r.ok && r.fullPath) {
        // 路径合法 → 走覆盖确认
        return makeWriteConfirm(r.fullPath, content, r.belonging?.label)
      }
      return { kind: 'result', value: JSON.stringify({ error: r.error }) }
    },
  }
}

/** write_file 的覆盖确认（复用 FC confirm 挂起）。 */
function makeWriteConfirm(fullPath: string, content: string, label?: string): ToolHandlerResult {
  const exists = fs.existsSync(fullPath)
  const prompt = exists
    ? `AI 要覆盖文件：\n${fullPath}\n\n原文件会先移入回收站。是否允许？`
    : `AI 要创建新文件：\n${fullPath}\n\n是否允许？`
  return {
    kind: 'confirm',
    prompt,
    action: async () => {
      try {
        let trashed: string | null = null
        if (exists) trashed = moveToTrash(fullPath)
        await fsp.mkdir(path.dirname(fullPath), { recursive: true })
        await fsp.writeFile(fullPath, content, 'utf-8')
        const bytes = Buffer.byteLength(content, 'utf-8')
        return JSON.stringify({ ok: true, path: fullPath, baseLabel: label, written: bytes, overwritten: exists, trashedTo: trashed })
      } catch (e) {
        return JSON.stringify({ error: `写入失败: ${String(e)}` })
      }
    },
  }
}

/**
 * 包装：read/list 遇到「需首次确认的目录」时挂起，用户同意后授权并重试。
 * - 首次 resolveSafePath 返回 needsConfirm → 返回 confirm ToolHandlerResult
 * - 用户同意 → onSessionApprove 加入会话 → 用更新后的 sources 重试原操作
 * - 用户拒绝 → 返回 cancelled
 */
async function withDirConfirm(
  ctx: ToolContext,
  confirm: ((prompt: string) => Promise<boolean>) | undefined,
  inputPath: string,
  op: (sources: AccessibleDir[]) => Promise<string>,
): Promise<ToolHandlerResult | string> {
  const r = resolveSafePath(inputPath, ctx.sources)
  if (r.ok) {
    return { kind: 'result', value: await op(ctx.sources) }
  }
  if (r.needsConfirm) {
    const dir = r.needsConfirm
    const label = path.basename(dir) || dir
    const prompt = `AI 请求访问目录：\n${dir}\n\n允许后，本次会话内 AI 可读取该目录。是否允许？`
    // 需要 confirm 机制支持；若不支持则拒绝
    if (!confirm) {
      return { kind: 'result', value: JSON.stringify({ error: `需访问目录 ${dir}，但当前不支持确认` }) }
    }
    return {
      kind: 'confirm',
      prompt,
      action: async () => {
        const approved = await confirm(prompt)
        if (!approved) {
          return JSON.stringify({ cancelled: true, message: '用户拒绝访问该目录' })
        }
        // 授权 + 重试
        ctx.onSessionApprove(dir, label)
        return await op(ctx.sources)
      },
    }
  }
  return { kind: 'result', value: JSON.stringify({ error: r.error }) }
}

// ---------- 工具组装入口 ----------
export function assembleTools(ctx: ToolContext): ToolRegistration[] {
  const tools: ToolRegistration[] = [getCurrentTimeTool]
  if (ctx.sources.length === 0) return tools

  tools.push(makeListDirsTool(ctx))
  tools.push(makeListFilesTool(ctx))
  tools.push(makeReadFileTool(ctx))
  tools.push(makeFindFilesTool(ctx))
  tools.push(makeWriteFileTool(ctx))
  return tools
}
