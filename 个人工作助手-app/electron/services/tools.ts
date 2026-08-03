import type { ToolRegistration } from './providers/types'
import type { AccessibleDir } from './systemDirs'
import { randomUUID } from 'node:crypto'
import {
  createNote,
  searchNotes,
  getNote,
  updateNote,
} from './notes/noteStore'
import { convertDocument } from './converter'
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
import { webSearch, type ActiveSearchConfig } from './searchTools'
import type { ToolHandlerResult } from './providers/types'
import { getDb } from './db'
import { tasks, reminders } from './db/schema'
import { eq } from 'drizzle-orm'
import type { TaskStatus } from '../types'
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
  /** 用户确认读取某目录后，加入会话授权（只读，本次会话有效）。 */
  onSessionApprove: (dir: string, label: string) => void
  /** 用户授权写入某系统/只读目录后，把该目录标记为会话级可写（本次会话有效）。 */
  onSessionWritable: (dir: string) => void
  /**
   * 当前活跃的联网搜索配置（动态读取，设置页改了立即生效）。
   * 返回 null = 未配置/未启用 → web_search 走降级提示。
   * 与 sources 同模式：getter 在 IPC 层注入，每次调用现读。
   */
  getActiveSearchConfig?: () => ActiveSearchConfig | null
  /**
   * M6：当前会话类型。'followup' 时额外注册 update_task_status / append_followup_log 工具
   * （让 AI 在跟进会话里能改任务状态/追加跟进日志，走二次确认）。
   */
  conversationType?: 'normal' | 'followup'
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
  const locked = ctx.sources.length > 0
  return {
    def: {
      type: 'function',
      function: {
        name: 'find_files',
        description: locked
          ? '在已配置的目录里按文件名/日期/扩展名搜索。用户说「找某天的报告」时用。默认搜全部已配置目录。'
          : '按文件名/日期/扩展名搜索文件。当前为「全盘模式」（仅密钥/系统目录受保护）。因全盘扫描不现实，必须提供 searchDir 指定搜索的目录。如不知道目录，先问用户文件大概在哪。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文件名关键词（不区分大小写），可选' },
            dateFrom: { type: 'string', description: '修改日期起点，YYYY-MM-DD，含当天' },
            dateTo: { type: 'string', description: '修改日期终点，YYYY-MM-DD，含当天' },
            ext: { type: 'string', description: '扩展名，如 "md"、"docx"，可选' },
            baseLabel: { type: 'string', description: '锁定模式下限定某目录 label，可选' },
            searchDir: { type: 'string', description: '全盘模式下必填：要搜索的目录绝对路径，如 D:\\\\工作' },
          },
          required: locked ? [] : ['searchDir'],
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
        searchDir: args.searchDir ? String(args.searchDir) : undefined,
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
        description: `写入/创建文件，生成 markdown/文本等。可写目录：${rwLabels || '（首次写入任意可读目录会请求用户授权）'}。覆盖已存在文件前会要求确认。文档/桌面/下载默认只读，但用户授权后本次会话可写。`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目标文件路径，相对某可读目录或绝对路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    handler: async (args, confirm) => {
      const p = String(args.path ?? '')
      const content = String(args.content ?? '')

      const bytes = Buffer.byteLength(content, 'utf-8')
      if (bytes > MAX_WRITE_BYTES) {
        return {
          kind: 'result',
          value: JSON.stringify({ error: `内容过大（${(bytes / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_WRITE_BYTES / 1024 / 1024}MB` }),
        }
      }

      const r = resolveSafePath(p, ctx.sources, { forWrite: true })
      if (r.ok && r.fullPath) {
        return makeWriteConfirm(r.fullPath, content, r.belonging?.label)
      }
      // 落到只读系统位置/预填目录 → 请求写授权
      if (r.needsWriteConfirm) {
        const dir = r.needsWriteConfirm
        const label = path.basename(dir) || dir
        const prompt = `AI 请求向目录写入文件：\n${dir}\n\n该目录默认只读。允许后，本次会话内 AI 可向此目录写入（覆盖仍会单独确认）。是否允许？`
        if (!confirm) {
          return { kind: 'result', value: JSON.stringify({ error: `需向 ${dir} 写入，但当前不支持确认` }) }
        }
        return {
          kind: 'confirm',
          prompt,
          action: async () => {
            const approved = await confirm(prompt)
            if (!approved) {
              return JSON.stringify({ cancelled: true, message: '用户拒绝向该目录写入' })
            }
            ctx.onSessionWritable(dir)
            // 授权后重新解析（此时该目录已是 readwrite）
            const r2 = resolveSafePath(p, ctx.sources, { forWrite: true })
            if (r2.ok && r2.fullPath) {
              return await executeWrite(r2.fullPath, content, r2.belonging?.label)
            }
            return JSON.stringify({ error: r2.error ?? '授权后仍无法写入' })
          },
        }
      }
      return { kind: 'result', value: JSON.stringify({ error: r.error }) }
    },
  }
}

/** 实际执行写入（覆盖前进回收站）。 */
async function executeWrite(fullPath: string, content: string, label?: string): Promise<string> {
  try {
    const exists = fs.existsSync(fullPath)
    let trashed: string | null = null
    if (exists) trashed = moveToTrash(fullPath)
    await fsp.mkdir(path.dirname(fullPath), { recursive: true })
    await fsp.writeFile(fullPath, content, 'utf-8')
    const bytes = Buffer.byteLength(content, 'utf-8')
    return JSON.stringify({ ok: true, path: fullPath, baseLabel: label, written: bytes, overwritten: exists, trashedTo: trashed })
  } catch (e) {
    return JSON.stringify({ error: `写入失败: ${String(e)}` })
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
    action: () => executeWrite(fullPath, content, label),
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
  // 解析失败：把可用目录告诉 AI，引导它用对路径
  return {
    kind: 'result',
    value: JSON.stringify({
      error: r.error ?? '路径解析失败',
      inputPath,
      hint: '可访问的目录（用这些路径或 label 前缀）：',
      accessibleDirs: ctx.sources.map((d) => ({ label: d.label, path: d.path })),
      suggestion: `试试 list_accessible_dirs 查看可用目录，或用「${ctx.sources[0]?.label ?? '文档'}/文件名」格式。`,
    }),
  }
}

// ---------- web_search（联网搜索，M5 搜索半） ----------
function makeWebSearchTool(ctx: ToolContext): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '联网搜索获取实时信息或最新数据。当用户问「最新的 XX」「最近的政策」「现在」等需要联网才能确认的事实时调用。结果含每条的 url，请在回答里标注来源链接。断网或未配置时会返回降级提示。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            timeRange: {
              type: 'string',
              enum: ['day', 'week', 'month', 'year'],
              description: '可选：结果时间范围（day=一天内，week=一周内，以此类推）',
            },
            topic: {
              type: 'string',
              enum: ['general', 'news', 'finance'],
              description: '可选：搜索类别，默认 general。新闻类用 news',
            },
          },
          required: ['query'],
        },
      },
    },
    handler: async (args) => {
      const params = {
        query: String(args.query ?? ''),
        ...(args.timeRange ? { timeRange: args.timeRange as 'day' | 'week' | 'month' | 'year' } : {}),
        ...(args.topic ? { topic: args.topic as 'general' | 'news' | 'finance' } : {}),
      }
      return await webSearch(params, ctx.getActiveSearchConfig)
    },
  }
}

// ---------- 工具组装入口 ----------
// ---------- M6：任务状态修改工具（仅跟进会话注册，走二次确认） ----------

const STATUS_ZH: Record<TaskStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  done: '已完成',
}

/** update_task_status：改任务状态。状态修改类 FC 必须二次确认（AGENTS.md §4 红线）。 */
function makeUpdateTaskStatusTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'update_task_status',
        description:
          '更新任务状态（todo/in_progress/done）。仅用于跟进会话中根据用户反馈改任务状态。改状态前必须征得用户确认。',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 ID' },
            status: { type: 'string', enum: ['todo', 'in_progress', 'done'], description: '新状态' },
          },
          required: ['taskId', 'status'],
        },
      },
    },
    handler: async (args) => {
      const taskId = String(args.taskId ?? '')
      const status = String(args.status ?? '') as TaskStatus
      if (!['todo', 'in_progress', 'done'].includes(status)) {
        return { kind: 'result', value: JSON.stringify({ error: '非法状态' }) }
      }
      const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!row) return { kind: 'result', value: JSON.stringify({ error: '任务不存在' }) }

      const prompt = `AI 要把任务「${row.title}」从「${STATUS_ZH[row.status]}」改为「${STATUS_ZH[status]}」，是否允许？`
      return {
        kind: 'confirm',
        prompt,
        action: async () => {
          const now = Math.floor(Date.now() / 1000)
          getDb().update(tasks).set({ status, updatedAt: now }).where(eq(tasks.id, taskId)).run()
          return JSON.stringify({ ok: true, taskId, status })
        },
      }
    },
  }
}

/** append_followup_log：往任务的 followupLog 追加一条记录。追加式文本（CONTEXT.md「跟进日志」）。 */
function makeAppendFollowupLogTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'append_followup_log',
        description: '往任务的跟进日志追加一条记录（用户在跟进会话里的回复摘要）。追加前需用户确认。',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 ID' },
            content: { type: 'string', description: '要追加的跟进记录内容' },
          },
          required: ['taskId', 'content'],
        },
      },
    },
    handler: async (args) => {
      const taskId = String(args.taskId ?? '')
      const content = String(args.content ?? '').trim()
      if (!content) return { kind: 'result', value: JSON.stringify({ error: '内容不能为空' }) }
      const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!row) return { kind: 'result', value: JSON.stringify({ error: '任务不存在' }) }

      const prompt = `AI 要往任务「${row.title}」追加跟进记录：\n\n${content}\n\n是否允许？`
      return {
        kind: 'confirm',
        prompt,
        action: async () => {
          const now = Math.floor(Date.now() / 1000)
          const dateStr = new Date().toLocaleString('zh-CN')
          // 追加式：旧内容 + 换行 + 新记录（带时间戳）
          const newLog = row.followupLog ? `${row.followupLog}\n[${dateStr}] ${content}` : `[${dateStr}] ${content}`
          getDb()
            .update(tasks)
            .set({ followupLog: newLog, updatedAt: now })
            .where(eq(tasks.id, taskId))
            .run()
          return JSON.stringify({ ok: true, taskId })
        },
      }
    },
  }
}

export function assembleTools(ctx: ToolContext): ToolRegistration[] {
  // 始终注册文件工具（全盘模式 sources 为空，工具内部处理）
  const list: ToolRegistration[] = [
    getCurrentTimeTool,
    makeListDirsTool(ctx),
    makeListFilesTool(ctx),
    makeReadFileTool(ctx),
    makeFindFilesTool(ctx),
    makeWriteFileTool(ctx),
    makeWebSearchTool(ctx),
    // M12.5：提醒（A 轨 FC）。无副作用，直接入库，不走二次确认
    // （PRD §13.2：提醒区别于任务，响一下就完，可随时删，不需确认）。
    makeSetReminderTool(),
    // M12.7：快速笔记（A 轨 FC）。create/search/read 直接返回，
    // update 走二次确认（覆盖原内容，AGENTS.md 红线）。
    makeCreateNoteTool(),
    makeSearchNotesTool(),
    makeReadNoteTool(),
    makeUpdateNoteTool(),
    // M12.9：文档转换（A 轨 FC）。无破坏性（原文件不动），不走二次确认。
    makeConvertDocumentTool(),
  ]
  // M6：跟进会话额外注册任务状态修改工具（走二次确认）
  if (ctx.conversationType === 'followup') {
    list.push(makeUpdateTaskStatusTool(), makeAppendFollowupLogTool())
  }
  return list
}

// ---------- set_reminder：设置提醒（M12.5 v1.2 A 轨） ----------
// AI 从对话抽取提醒（"10 分钟后提醒我开会"）直接入库，无需人工确认。
// time 接受 ISO 字符串或相对描述，模型负责换算成绝对 Unix 秒。
function makeSetReminderTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'set_reminder',
        description:
          '设置一条提醒。当用户说"N 分钟/小时后提醒我..."或"明天 X 点提醒..."时调用。' +
          '提醒到点会弹桌面通知。与任务的区别：提醒是到点告诉一件事（信号），' +
          '不是有完成度的工作；无副作用，可直接设置不需确认。',
        parameters: {
          type: 'object',
          properties: {
            time: {
              type: 'number',
              description:
                '触发时间，Unix 秒。可用 get_current_time 获取当前秒数后加上偏移量' +
                '（如 10 分钟 = +600）。必须是把来的绝对时间。',
            },
            content: {
              type: 'string',
              description: '提醒内容，到点通知里会原样显示。简洁一句话。',
            },
          },
          required: ['time', 'content'],
        },
      },
    },
    handler: (args) => {
      const time = Number(args.time)
      const content = String(args.content ?? '').trim()
      if (!Number.isFinite(time) || time <= 0) {
        return { kind: 'result', value: JSON.stringify({ error: 'time 非法，需为正数 Unix 秒' }) }
      }
      if (!content) {
        return { kind: 'result', value: JSON.stringify({ error: 'content 不能为空' }) }
      }
      const id = randomUUID()
      getDb()
        .insert(reminders)
        .values({ id, time, content, source: 'from_chat' })
        .run()
      const trigger = new Date(time * 1000).toLocaleString('zh-CN')
      return {
        kind: 'result',
        value: JSON.stringify({
          ok: true,
          id,
          content,
          triggerAt: trigger,
          message: `已设置提醒：${trigger} - ${content}`,
        }),
      }
    },
  }
}

// ---------- 快速笔记（M12.7 v1.2 A 轨 FC） ----------
// 见 PRD §13.2 工具 1。笔记存纯 .md 文件（noteStore），自动入白名单。
// create_note：新建（无副作用，直接入库）；update_note：覆盖，走二次确认。

function makeCreateNoteTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'create_note',
        description:
          '把内容存成一条笔记（Markdown 文件）。当用户说"把这段存成笔记"' +
          '"记录一下"或需要保存对话要点时调用。新建不覆盖，无副作用。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '笔记标题（简短，会成为文件名）' },
            content: {
              type: 'string',
              description: '笔记正文（Markdown）。应包含完整内容，不要省略。',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: '可选标签数组，如 ["工作","周报"]',
            },
          },
          required: ['title', 'content'],
        },
      },
    },
    handler: (args) => {
      const title = String(args.title ?? '').trim()
      const content = String(args.content ?? '')
      if (!title) return { kind: 'result', value: JSON.stringify({ error: 'title 不能为空' }) }
      const tagsRaw = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : []
      const note = createNote({ title, content, tags: tagsRaw })
      return {
        kind: 'result',
        value: JSON.stringify({
          ok: true,
          id: note.id,
          title: note.title,
          fileName: note.fileName,
          message: `已创建笔记「${note.title}」`,
        }),
      }
    },
  }
}

function makeSearchNotesTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'search_notes',
        description:
          '全文搜索已有笔记（标题 + 正文，大小写不敏感）。当用户问"我之前写过 X 吗"' +
          '或需要查找历史笔记时调用。返回匹配笔记的标题 + 摘要列表。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    },
    handler: (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) return { kind: 'result', value: JSON.stringify({ error: 'query 不能为空' }) }
      const hits = searchNotes(query)
      return {
        kind: 'result',
        value: JSON.stringify({
          ok: true,
          count: hits.length,
          hits: hits.slice(0, 10), // 限制 10 条避免上下文过长
          message: hits.length === 0 ? `未找到含「${query}」的笔记` : `找到 ${hits.length} 条`,
        }),
      }
    },
  }
}

function makeReadNoteTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'read_note',
        description: '按 id 读取一条笔记的完整内容。需要先通过 search_notes 拿到 id。',
        parameters: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: '笔记 id（search_notes 返回的）' },
          },
          required: ['noteId'],
        },
      },
    },
    handler: (args) => {
      const id = String(args.noteId ?? '').trim()
      const note = getNote(id)
      if (!note) return { kind: 'result', value: JSON.stringify({ error: `笔记 ${id} 不存在` }) }
      return {
        kind: 'result',
        value: JSON.stringify({
          ok: true,
          id: note.id,
          title: note.title,
          tags: note.tags,
          content: note.content,
          updatedAt: note.updatedAt,
        }),
      }
    },
  }
}

function makeUpdateNoteTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'update_note',
        description:
          '更新一条笔记（覆盖内容）。会覆盖原笔记，必须征得用户确认。' +
          '需先通过 search_notes / read_note 拿到 noteId。',
        parameters: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: '笔记 id' },
            title: { type: 'string', description: '新标题（不改可不传）' },
            content: { type: 'string', description: '新正文（覆盖，要完整不要省略）' },
            tags: { type: 'array', items: { type: 'string' }, description: '新标签（覆盖）' },
          },
          required: ['noteId', 'content'],
        },
      },
    },
    handler: (args) => {
      const id = String(args.noteId ?? '').trim()
      const existing = getNote(id)
      if (!existing) return { kind: 'result', value: JSON.stringify({ error: `笔记 ${id} 不存在` }) }
      // 覆盖 → 走二次确认（AGENTS.md 红线：write 类工具必须 confirm）
      const newTitle = args.title != null ? String(args.title) : existing.title
      return {
        kind: 'confirm',
        prompt: `AI 要更新笔记「${existing.title}」（覆盖原内容），是否允许？`,
        action: async () => {
          const updated = updateNote(id, {
            title: newTitle,
            content: String(args.content ?? ''),
            tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : existing.tags,
          })
          if (!updated) return JSON.stringify({ error: '更新失败' })
          return JSON.stringify({
            ok: true,
            id: updated.id,
            title: updated.title,
            message: `笔记「${updated.title}」已更新`,
          })
        },
      }
    },
  }
}

// ---------- 文档转换（M12.9 v1.2 A 轨 FC） ----------
// 见 PRD §13.2 工具 3。路径在 converter 内部经 resolveSafePath（白名单/笔记库）。
// 无破坏性（原文件不动），不走二次确认。
function makeConvertDocumentTool(): ToolRegistration {
  return {
    def: {
      type: 'function',
      function: {
        name: 'convert_document',
        description:
          '转换文档格式。支持 md↔txt、md→html/docx/pdf、docx→md/txt/html。' +
          '当用户说「把这份 md 转成 docx/pdf」时调用。路径须在工作目录或笔记库内。',
        parameters: {
          type: 'object',
          properties: {
            inputPath: {
              type: 'string',
              description: '输入文件绝对路径（须在白名单内，可用 list_accessible_dirs 查）',
            },
            targetFormat: {
              type: 'string',
              enum: ['md', 'txt', 'html', 'docx', 'pdf'],
              description: '目标格式',
            },
            outputPath: {
              type: 'string',
              description: '可选输出路径；缺省输出到输入同目录换扩展名',
            },
          },
          required: ['inputPath', 'targetFormat'],
        },
      },
    },
    handler: async (args) => {
      const inputPath = String(args.inputPath ?? '').trim()
      const targetFormat = String(args.targetFormat ?? '').trim() as 'md' | 'txt' | 'html' | 'docx' | 'pdf'
      if (!inputPath) return { kind: 'result', value: JSON.stringify({ error: 'inputPath 不能为空' }) }
      if (!['md', 'txt', 'html', 'docx', 'pdf'].includes(targetFormat)) {
        return { kind: 'result', value: JSON.stringify({ error: 'targetFormat 非法' }) }
      }
      const result = await convertDocument({
        inputPath,
        targetFormat,
        outputPath: args.outputPath ? String(args.outputPath) : undefined,
      })
      return {
        kind: 'result',
        value: JSON.stringify(
          result.ok
            ? { ok: true, outputPath: result.outputPath, bytes: result.bytes, message: `已转换为 ${result.outputPath}` }
            : { ok: false, error: result.error ?? '转换失败' },
        ),
      }
    },
  }
}
