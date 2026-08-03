import type { ToolRegistration } from './providers/types'
import type { WorkDir } from '../types'
import {
  listFiles,
  readFileContent,
  findFiles,
  moveToTrash,
  resolveSafePath,
  MAX_WRITE_BYTES,
} from './fileTools'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 工具组装（M5）。
 *
 * 静态工具（get_current_time）始终注册。
 * 文件工具按当前启用的 workDirs 动态注册：
 *  - 只要有任何 WorkDir → 注册 list_files / read_file / find_files（只读即可）
 *  - 有 readwrite WorkDir → 额外注册 write_file
 *  - 无 WorkDir → 不注册任何文件工具（模型不知道有这能力）
 */

// ---------- 当前时间（始终注册） ----------
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

// ---------- list_files ----------
function makeListFilesTool(workDirs: WorkDir[]): ToolRegistration {
  const labels = workDirs.map((d) => `「${d.label}」(${d.path})`).join('、')
  return {
    def: {
      type: 'function',
      function: {
        name: 'list_files',
        description: `列出工作目录里的文件和子目录。可用工作目录：${labels}。dir 可填目录名（label）或相对路径。`,
        parameters: {
          type: 'object',
          properties: {
            dir: {
              type: 'string',
              description: '目录。填工作目录 label（如"我的笔记"）表示列根目录，或相对该根的子路径。',
            },
          },
          required: ['dir'],
        },
      },
    },
    handler: async (args) => {
      const dir = String(args.dir ?? '')
      const baseLabel = looksLikeLabel(dir, workDirs) ? dir : undefined
      const target = baseLabel ? '' : dir
      return listFiles(target, workDirs, baseLabel)
    },
  }
}

// ---------- read_file ----------
function makeReadFileTool(workDirs: WorkDir[]): ToolRegistration {
  const labels = workDirs.map((d) => `「${d.label}」`).join('、')
  return {
    def: {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取工作目录里的文件内容（支持 txt/md/json/csv/代码/pdf/docx）。可用工作目录：${labels}。大文件会截断。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径。可填 find_files 返回的相对路径，或「label/子路径」形式。',
            },
          },
          required: ['path'],
        },
      },
    },
    handler: async (args) => {
      const p = String(args.path ?? '')
      const { baseLabel, rest } = splitLabelAndRest(p, workDirs)
      return readFileContent(rest, workDirs, baseLabel)
    },
  }
}

// ---------- find_files ----------
function makeFindFilesTool(workDirs: WorkDir[]): ToolRegistration {
  const labels = workDirs.map((d) => `「${d.label}」`).join('、')
  return {
    def: {
      type: 'function',
      function: {
        name: 'find_files',
        description: `在工作目录里按文件名/日期/扩展名搜索文件。可用工作目录：${labels}。用户说"找某天的报告"时用这个。`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文件名关键词（不区分大小写），可选' },
            dateFrom: { type: 'string', description: '修改日期起点，YYYY-MM-DD，可选，含当天' },
            dateTo: { type: 'string', description: '修改日期终点，YYYY-MM-DD，可选，含当天' },
            ext: { type: 'string', description: '扩展名，如 "md"、"docx"，可选' },
            baseLabel: { type: 'string', description: '限定某个工作目录，可选' },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      return findFiles(
        {
          query: args.query ? String(args.query) : undefined,
          dateFrom: args.dateFrom ? String(args.dateFrom) : undefined,
          dateTo: args.dateTo ? String(args.dateTo) : undefined,
          ext: args.ext ? String(args.ext) : undefined,
          baseLabel: args.baseLabel ? String(args.baseLabel) : undefined,
        },
        workDirs,
      )
    },
  }
}

// ---------- write_file（仅 readwrite 目录） ----------
function makeWriteFileTool(workDirs: WorkDir[]): ToolRegistration {
  const rwLabels = workDirs
    .filter((d) => d.mode === 'readwrite')
    .map((d) => `「${d.label}」`)
    .join('、')
  return {
    def: {
      type: 'function',
      function: {
        name: 'write_file',
        description: `向「读写」工作目录写入/创建文件。可写目录：${rwLabels}。覆盖已存在文件前会要求用户确认。`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目标文件路径，相对工作目录或「label/子路径」' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    handler: async (args) => {
      const p = String(args.path ?? '')
      const content = String(args.content ?? '')
      const { baseLabel, rest } = splitLabelAndRest(p, workDirs)

      // 路径校验（forWrite）
      const r = resolveSafePath(rest, workDirs, { forWrite: true, baseLabel })
      if (!r.ok || !r.fullPath) {
        return { kind: 'result', value: JSON.stringify({ error: r.error }) }
      }

      // 大小校验
      const bytes = Buffer.byteLength(content, 'utf-8')
      if (bytes > MAX_WRITE_BYTES) {
        return {
          kind: 'result',
          value: JSON.stringify({ error: `内容过大（${(bytes / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_WRITE_BYTES / 1024 / 1024}MB` }),
        }
      }

      const exists = fs.existsSync(r.fullPath)
      const prompt = exists
        ? `AI 要覆盖文件：\n${r.fullPath}\n\n原文件会先移入回收站。是否允许覆盖？`
        : `AI 要创建新文件：\n${r.fullPath}\n\n是否允许？`

      // 返回 confirm 类型 → FC 循环挂起弹窗
      return {
        kind: 'confirm',
        prompt,
        action: async () => {
          try {
            // 覆盖前 → 回收站（三重防护第 3 层）
            let trashed: string | null = null
            if (exists) {
              trashed = moveToTrash(r.fullPath!)
            }
            // 确保父目录存在
            await fsp.mkdir(path.dirname(r.fullPath!), { recursive: true })
            await fsp.writeFile(r.fullPath!, content, 'utf-8')
            return JSON.stringify({
              ok: true,
              path: r.fullPath,
              written: bytes,
              overwritten: exists,
              trashedTo: trashed,
            })
          } catch (e) {
            return JSON.stringify({ error: `写入失败: ${String(e)}` })
          }
        },
      }
    },
  }
}

// ---------- 工具组装入口 ----------
export function assembleTools(workDirs: WorkDir[]): ToolRegistration[] {
  const tools: ToolRegistration[] = [getCurrentTimeTool]
  if (workDirs.length === 0) return tools

  tools.push(makeListFilesTool(workDirs))
  tools.push(makeReadFileTool(workDirs))
  tools.push(makeFindFilesTool(workDirs))

  if (workDirs.some((d) => d.mode === 'readwrite')) {
    tools.push(makeWriteFileTool(workDirs))
  }
  return tools
}

// ---------- 辅助：label 解析 ----------
/** 判断字符串是否是某个 workDir 的 label 或其根路径。 */
function looksLikeLabel(s: string, workDirs: WorkDir[]): boolean {
  return workDirs.some((d) => d.label === s || d.path === s)
}

/** 把「label/子路径」或纯路径拆成 baseLabel + rest。
 *  若首段匹配某 label，则 baseLabel=该 label，rest=剩余部分；否则 baseLabel=undefined, rest=原值。
 */
function splitLabelAndRest(s: string, workDirs: WorkDir[]): { baseLabel?: string; rest: string } {
  const idx = s.indexOf('/')
  if (idx > 0) {
    const head = s.slice(0, idx)
    if (workDirs.some((d) => d.label === head)) {
      return { baseLabel: head, rest: s.slice(idx + 1) }
    }
  }
  // 也支持反斜杠
  const idx2 = s.indexOf('\\')
  if (idx2 > 0) {
    const head = s.slice(0, idx2)
    if (workDirs.some((d) => d.label === head)) {
      return { baseLabel: head, rest: s.slice(idx2 + 1) }
    }
  }
  return { rest: s }
}

// 兼容：旧导出名（M1 时代 chat handler 用过，现已被 assembleTools 取代，保留以防误引用）
export const builtinTools: ToolRegistration[] = [getCurrentTimeTool]
