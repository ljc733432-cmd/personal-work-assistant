import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm'
import { getDb, dbHealthCheck } from '../services/db'
import {
  providers,
  settings,
  workDirs,
  searchProviders,
  tasks,
  conversations,
  messages,
  reminders,
  pomodoroSessions,
} from '../services/db/schema'
import { setSecret, getSecret, deleteSecret } from '../services/secret'
import {
  listProviders,
  createClientForProvider,
  listEnabledWorkDirs,
  listAllWorkDirs,
  listTasks,
  listFollowupCandidates,
  listReminders,
} from '../services/providers/factory'
import {
  listConversations,
  getConversation,
  listMessages,
} from '../services/conversation/factory'
import { listSearchProviders, getActiveSearchConfig } from '../services/search/factory'
import { pingTavily } from '../services/searchTools'
import {
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  searchNotes,
} from '../services/notes/noteStore'
import { getNotesDir, setNotesDir } from '../services/notes/config'
import { convertDocument, supportedTargets } from '../services/converter'
import { getPdfInfo, mergePdfs, extractPages, splitPdf } from '../services/pdfToolbox'
import { chatWithProvider, type ChatResult } from '../services/providers/chat'
import { truncateByTokenBudget } from '../services/providers/truncate'
import { resolveProviderId } from '../services/providers/router'
import { extractTasks } from '../services/taskExtractor'
import { assembleTools, type ToolContext } from '../services/tools'
import { getSystemDirs, type AccessibleDir } from '../services/systemDirs'
import { PROVIDER_PRESETS } from '../services/providers/types'
import { logInfo } from '../services/logger'
import type {
  ChatSendParams,
  IpcResult,
  ProviderInput,
  Provider,
  WorkDir,
  WorkDirInput,
  SearchProviderInput,
  SearchProvider,
  Task,
  TaskInput,
  TaskDraft,
  TaskDraftInput,
  Reminder,
  ReminderInput,
  PomodoroSession,
  PomodoroRecordInput,
  Note,
  NoteInput,
  NoteSearchHit,
  ConvertParams,
  ConvertResultData,
  ConvertTarget,
  Conversation,
  ConversationInput,
  ConversationMessage,
  MessageInsertInput,
  MessageToolCall,
  ActivityPoint,
  ActivityQuery,
  PdfInfo,
  PdfResult,
  PdfSplitResult,
} from '../types'

/**
 * IPC handler 注册中心。
 * channel 必须与 preload 的白名单一一对应（AGENTS.md §3）。
 */

// 当前持有流式对话的窗口引用（chat:send 用）
function getFocusedWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  return wins[0] ?? null
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function err(error: string): IpcResult<never> {
  return { ok: false, error }
}

/**
 * M2：把本轮对话落库（user 消息 + assistant 最终消息）。
 *
 * 落库策略（与渲染层合并式语义对齐，见 ChatPage）：
 *  - params.messages 是完整历史，但只有最后一条 user 是本轮新增，
 *    其余消息已在之前轮次落库 → 这里只落「最后一条 user」。
 *  - assistant 只落一条：chatWithProvider 返回的合并 finalText + toolCalls。
 *    中间 tool 结果消息（chat.ts working 数组里的 role:'tool'）不落库
 *    （渲染层从不显示，历史回放也不需要）。
 *  - 会话标题：首次有消息（title 仍是默认「新会话」）时用 user 文本回填。
 *
 * 失败不抛：调用方已用 try 包住，落库失败不影响本轮已流式推给前端的回复。
 */
function persistTurn(
  conversationId: string,
  providerId: string,
  history: ChatSendParams['messages'],
  result: ChatResult,
): void {
  const db = getDb()
  // 校验会话存在（防御：渲染层传错 id 时静默跳过，避免外键悬空）
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  if (!conv) throw new Error(`会话不存在: ${conversationId}`)

  // 找本轮新增的 user 消息（最后一条 user）
  let lastUser: { role: 'user'; content: string } | null = null
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      lastUser = { role: 'user', content: history[i].content }
      break
    }
  }

  const now = Math.floor(Date.now() / 1000)

  // 1) 落 user 消息
  if (lastUser) {
    db.insert(messages)
      .values({
        id: randomUUID(),
        conversationId,
        role: 'user',
        content: lastUser.content,
      })
      .run()

    // 2) 首次消息回填标题（仅当 title 还是默认占位）
    if (conv.title === '新会话') {
      const title = lastUser.content.slice(0, 30).trim() || '新会话'
      db.update(conversations).set({ title, updatedAt: now }).where(eq(conversations.id, conversationId)).run()
    }
  }

  // 3) 落 assistant 最终消息（content 可能为空——纯工具调用轮；仍落一条以保留 toolCalls 记录）
  const toolCalls: MessageToolCall[] | null =
    result.toolCalls.length > 0 ? result.toolCalls : null
  db.insert(messages)
    .values({
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      content: result.finalText,
      providerId,
      toolCalls,
    })
    .run()

  // 4) 刷新会话 updatedAt（侧栏排序）
  db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversationId)).run()
}

function rowToProvider(row: typeof providers.$inferSelect): Provider {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseURL: row.baseURL,
    model: row.model,
    apiKeyRef: row.apiKeyRef,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function registerProviderHandlers() {
  // 列出全部
  ipcMain.handle('provider:list', (): IpcResult<Provider[]> => {
    try {
      return ok(listProviders())
    } catch (e) {
      return err(String(e))
    }
  })

  // 新增 / 更新（含明文 Key 落 safeStorage）
  ipcMain.handle('provider:upsert', (_, input: ProviderInput): IpcResult<Provider> => {
    try {
      const db = getDb()
      const id = input.id ?? randomUUID()
      const apiKeyRef = `provider_${id}`

      // 若带了明文 Key → 写 safeStorage
      if (input.apiKey) setSecret(apiKeyRef, input.apiKey)

      const now = Math.floor(Date.now() / 1000)
      const existing = db.select().from(providers).where(eq(providers.id, id)).get()

      if (existing) {
        db.update(providers)
          .set({
            name: input.name,
            type: input.type,
            baseURL: input.baseURL,
            model: input.model,
            enabled: input.enabled,
            updatedAt: now,
          })
          .where(eq(providers.id, id))
          .run()
      } else {
        db.insert(providers)
          .values({
            id,
            name: input.name,
            type: input.type,
            baseURL: input.baseURL,
            model: input.model,
            apiKeyRef,
            enabled: input.enabled,
          })
          .run()
      }
      const row = db.select().from(providers).where(eq(providers.id, id)).get()!
      return ok(rowToProvider(row))
    } catch (e) {
      return err(String(e))
    }
  })

  // 删除（同时清 Key）
  ipcMain.handle('provider:delete', (_, id: string): IpcResult<true> => {
    try {
      const db = getDb()
      const row = db.select().from(providers).where(eq(providers.id, id)).get()
      if (row) deleteSecret(row.apiKeyRef)
      db.delete(providers).where(eq(providers.id, id)).run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  // 测试连接：发一个极小请求验证 Key+baseURL+model 可用
  ipcMain.handle('provider:test', async (_, id: string): Promise<IpcResult<string>> => {
    try {
      const { client, model } = createClientForProvider(id)
      const t0 = Date.now()
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: false,
      })
      const ms = Date.now() - t0
      const reply = res.choices?.[0]?.message?.content ?? '(空回复)'
      return ok(`连接成功（${ms}ms）：${reply}`.slice(0, 120))
    } catch (e) {
      return err(String(e))
    }
  })
}

function registerSettingsHandlers() {
  ipcMain.handle('settings:get', (_, key: string): IpcResult<string | null> => {
    try {
      const row = getDb().select().from(settings).where(eq(settings.key, key)).get()
      return ok(row?.value ?? null)
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('settings:set', (_, key: string, value: string): IpcResult<true> => {
    try {
      getDb()
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: Math.floor(Date.now() / 1000) },
        })
        .run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })
}

// ---------- SearchProvider CRUD（联网搜索配置，照搬 provider 模式） ----------
function rowToSearchProvider(row: typeof searchProviders.$inferSelect): SearchProvider {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    apiKeyRef: row.apiKeyRef,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function registerSearchProviderHandlers() {
  ipcMain.handle('search-provider:list', (): IpcResult<SearchProvider[]> => {
    try {
      return ok(listSearchProviders())
    } catch (e) {
      return err(String(e))
    }
  })

  // 新增/更新（含明文 Key 落 safeStorage）
  ipcMain.handle('search-provider:upsert', (_, input: SearchProviderInput): IpcResult<SearchProvider> => {
    try {
      const db = getDb()
      const id = input.id ?? randomUUID()
      // ref 前缀 searchprovider_，与模型 Provider 的 provider_ 区分，互不冲突
      const apiKeyRef = `searchprovider_${id}`

      if (input.apiKey) setSecret(apiKeyRef, input.apiKey)

      const now = Math.floor(Date.now() / 1000)
      const existing = db.select().from(searchProviders).where(eq(searchProviders.id, id)).get()

      if (existing) {
        db.update(searchProviders)
          .set({ name: input.name, type: input.type, enabled: input.enabled, updatedAt: now })
          .where(eq(searchProviders.id, id))
          .run()
      } else {
        db.insert(searchProviders)
          .values({ id, name: input.name, type: input.type, apiKeyRef, enabled: input.enabled })
          .run()
      }
      const row = db.select().from(searchProviders).where(eq(searchProviders.id, id)).get()!
      return ok(rowToSearchProvider(row))
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('search-provider:delete', (_, id: string): IpcResult<true> => {
    try {
      const db = getDb()
      const row = db.select().from(searchProviders).where(eq(searchProviders.id, id)).get()
      if (row) deleteSecret(row.apiKeyRef)
      db.delete(searchProviders).where(eq(searchProviders.id, id)).run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  // 测试连接：发一个最小 query ping，验证 Key 可用 + 网络可达
  ipcMain.handle('search-provider:test', async (_, id: string): Promise<IpcResult<string>> => {
    try {
      const row = getDb().select().from(searchProviders).where(eq(searchProviders.id, id)).get()
      if (!row) return err('Provider 不存在')
      const apiKey = getSecret(row.apiKeyRef)
      if (!apiKey) return err('未配置 API Key（或 Key 已损坏）')

      const t0 = Date.now()
      const count = await pingTavily(apiKey)
      const ms = Date.now() - t0
      return ok(`连接成功（${ms}ms，返回 ${count} 条测试结果）`)
    } catch (e) {
      return err(String(e))
    }
  })
}

function registerChatHandlers() {
  // reqId → AbortController（取消）
  const abortMap = new Map<string, AbortController>()
  // reqId → confirm resolver（工具需要用户确认时挂起）
  const confirmMap = new Map<string, (approved: boolean) => void>()
  // 本次会话（应用运行期间）已授权读取的目录，只读，重启清空
  const sessionApprovedDirs: AccessibleDir[] = []
  // 本次会话用户授权可写的目录路径（系统位置/预填目录被授权写后加入），重启清空
  const sessionWritableDirs: string[] = []

  // 路径比较（大小写不敏感 + 规范化，兼容 Win）
  const samePath = (a: string, b: string) =>
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

  ipcMain.on('chat:cancel', (_, reqId: string) => {
    abortMap.get(reqId)?.abort()
    // 同时唤醒挂起的 confirm（视为拒绝）
    confirmMap.get(reqId)?.(false)
  })

  // 前端确认结果回传：approve 或拒绝
  ipcMain.on('chat:confirm_response', (_, payload: { reqId: string; approved: boolean }) => {
    const resolve = confirmMap.get(payload.reqId)
    if (resolve) {
      confirmMap.delete(payload.reqId)
      resolve(payload.approved)
    }
  })

  ipcMain.handle('chat:send', async (_, params: ChatSendParams): Promise<IpcResult<string>> => {
    const reqId = params.reqId
    const win = getFocusedWindow()
    if (!win) return err('无可用窗口')

    try {
      // M15：路由解析（当前透传；若传档位 id 则解析成 providerId，为未来自动路由预留）
      const effectiveProviderId = resolveProviderId(params.providerId)
      const { client, model } = createClientForProvider(effectiveProviderId)
      const ac = new AbortController()
      abortMap.set(reqId, ac)

      // 构建 sources = 系统位置 + 启用的预填 workDirs + 笔记库目录 + 会话已确认目录
      const buildSources = (): AccessibleDir[] => {
        const list: AccessibleDir[] = []
        // 系统位置（文档/桌面/下载，只读）
        for (const d of getSystemDirs()) {
          if (!list.some((x) => samePath(x.path, d.path))) list.push(d)
        }
        // 预填 workDirs
        for (const wd of listEnabledWorkDirs()) {
          if (!list.some((x) => samePath(x.path, wd.path))) {
            list.push({
              label: wd.label,
              path: wd.path,
              source: 'workdir',
              mode: wd.mode,
            })
          }
        }
        // M12.7：笔记库目录（readwrite，自动入白名单，PRD §13.2 无需用户额外配）
        const notesDir = getNotesDir()
        if (!list.some((x) => samePath(x.path, notesDir))) {
          list.push({ label: '笔记库', path: notesDir, source: 'workdir', mode: 'readwrite' })
        }
        // 会话已确认读取（只读，会话级）
        for (const sd of sessionApprovedDirs) {
          if (!list.some((x) => samePath(x.path, sd.path))) {
            list.push({ ...sd, source: 'session' })
          }
        }
        // 会话已授权写入 → 把匹配的目录 mode 提升为 readwrite
        for (let i = 0; i < list.length; i++) {
          if (sessionWritableDirs.some((wd) => samePath(wd, list[i].path))) {
            list[i] = { ...list[i], mode: 'readwrite' }
          }
        }
        return list
      }

      const ctx: ToolContext = {
        get sources() {
          return buildSources() // 动态读取（sessionApproved/Writable 会变）
        },
        onSessionApprove: (dir, label) => {
          if (!sessionApprovedDirs.some((x) => samePath(x.path, dir))) {
            sessionApprovedDirs.push({ label, path: dir, source: 'session', mode: 'read' })
          }
        },
        onSessionWritable: (dir) => {
          if (!sessionWritableDirs.some((wd) => samePath(wd, dir))) {
            sessionWritableDirs.push(dir)
          }
        },
        // 联网搜索配置：动态读取（设置页改了立即生效，无配置返回 null 走降级）
        getActiveSearchConfig: () => getActiveSearchConfig(),
        // M6：会话类型（followup 时额外注册任务状态修改工具）
        conversationType: (() => {
          const conv = getDb()
            .select()
            .from(conversations)
            .where(eq(conversations.id, params.conversationId))
            .get()
          return conv?.type ?? 'normal'
        })(),
      }

      const tools = params.enableTools ? assembleTools(ctx) : undefined

      const onToken = (text: string) => {
        win.webContents.send('chat:token', { reqId, text })
      }
      const onToolCall = (name: string, args: string) => {
        win.webContents.send('chat:tool_call', { reqId, name, args })
      }
      const onFirstToken = (elapsedMs: number) => {
        win.webContents.send('chat:first_token', { reqId, elapsedMs })
      }
      // 工具需要确认（write_file 覆盖 / 目录首次访问）→ 推事件给前端，挂起等响应
      const onConfirm = (prompt: string) => {
        return new Promise<boolean>((resolve) => {
          confirmMap.set(reqId, resolve)
          win.webContents.send('chat:confirm_request', { reqId, prompt })
        })
      }

      // M2-Step7：上下文截断（按 token 预算，非条数）。
      // 注意：截断只作用于「发给模型的历史」，不影响落库（落库的是完整历史 params.messages）。
      const { messages: truncated, dropped } = truncateByTokenBudget(params.messages)
      if (dropped > 0) {
        // 禁忌：不静默丢历史。推事件让渲染层 UI 提示「已省略较早的 X 条」。
        win.webContents.send('chat:truncated', { reqId, dropped })
      }

      // M6：跟进会话注入系统提示，引导 AI 用 update_task_status / append_followup_log 工具。
      // 关键：必须把候选任务的 ID + 标题列出来，否则 AI 拿不到 taskId 无法调工具。
      const messagesForModel =
        ctx.conversationType === 'followup'
          ? (() => {
              const candidates = listFollowupCandidates()
              const taskList = candidates
                .map((t) => `- ID: ${t.id} | 标题: ${t.title} | 状态: ${t.status} | 优先级: ${t.priority}`)
                .join('\n')
              return [
                {
                  role: 'system' as const,
                  content:
                    '这是一个跟进会话。用户会回复任务的进展。\n\n' +
                    '当前待跟进任务（含 ID，调工具时用这个 ID）：\n' +
                    taskList +
                    '\n\n规则：\n' +
                    '1. 当用户表示某任务已完成/进行中时，调用 update_task_status(taskId, status) 更新状态（会弹确认给用户）。\n' +
                    '2. 根据用户回复的内容匹配上面的任务标题来确定 taskId，不要问用户要 ID。\n' +
                    '3. 如果用户补充了跟进信息，可调用 append_followup_log(taskId, content) 记录。\n' +
                    '4. 没有匹配的任务时正常对话，不要强行调工具。',
                },
                ...truncated,
              ]
            })()
          : truncated

      const result = await chatWithProvider({
        client,
        model,
        messages: messagesForModel,
        tools,
        onToken,
        onToolCall,
        onFirstToken,
        onConfirm,
        signal: ac.signal,
      })

      // M2 落库：user + assistant 最终消息（与渲染层合并语义对齐，中间 tool 结果不落库）。
      // 用 try 包住：落库失败不应让对话本身失败（已生成的内容已通过流式推给前端）。
      try {
        await persistTurn(params.conversationId, params.providerId, params.messages, result)
      } catch (persistErr) {
        logInfo('[chat] 落库失败（不影响本轮回复）:', String(persistErr))
      }

      win.webContents.send('chat:done', { reqId })
      abortMap.delete(reqId)
      confirmMap.delete(reqId)
      return ok(reqId)
    } catch (e: unknown) {
      abortMap.delete(reqId)
      confirmMap.delete(reqId)
      // 取消走 done（不算错误），其他异常走 error
      if (e instanceof Error && e.name === 'AbortError') {
        win.webContents.send('chat:done', { reqId, cancelled: true })
        return ok(reqId)
      }
      const message = String(e)
      win.webContents.send('chat:error', { reqId, message })
      return err(message)
    }
  })
}

// ---------- WorkDir CRUD ----------
function registerWorkDirHandlers() {
  ipcMain.handle('workdir:list', (): IpcResult<WorkDir[]> => {
    return ok(listAllWorkDirs())
  })

  ipcMain.handle('workdir:upsert', (_, input: WorkDirInput): IpcResult<WorkDir> => {
    try {
      const db = getDb()
      const id = input.id ?? randomUUID()
      const now = Math.floor(Date.now() / 1000)
      const existing = db.select().from(workDirs).where(eq(workDirs.id, id)).get()

      if (existing) {
        db.update(workDirs)
          .set({ label: input.label, path: input.path, mode: input.mode, enabled: input.enabled, updatedAt: now })
          .where(eq(workDirs.id, id))
          .run()
      } else {
        db.insert(workDirs)
          .values({ id, label: input.label, path: input.path, mode: input.mode, enabled: input.enabled })
          .run()
      }
      const row = db.select().from(workDirs).where(eq(workDirs.id, id)).get()!
      return ok({
        id: row.id,
        label: row.label,
        path: row.path,
        mode: row.mode,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('workdir:delete', (_, id: string) => {
    try {
      getDb().delete(workDirs).where(eq(workDirs.id, id)).run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  // 选目录对话框（设置页添加目录用）
  ipcMain.handle('workdir:pick', async (): Promise<IpcResult<string | null>> => {
    const { dialog } = await import('electron')
    const win = BrowserWindow.getAllWindows()[0] ?? null
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return ok(null)
    return ok(result.filePaths[0])
  })
}

// ---------- Task CRUD（M3，照搬 workdir 模式） ----------
function rowToTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.dueDate,
    source: row.source,
    sourceConversationId: row.sourceConversationId,
    followupLog: row.followupLog,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function registerTaskHandlers() {
  ipcMain.handle('task:list', (): IpcResult<Task[]> => {
    try {
      return ok(listTasks())
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('task:upsert', (_, input: TaskInput): IpcResult<Task> => {
    try {
      const db = getDb()
      const id = input.id ?? randomUUID()
      const now = Math.floor(Date.now() / 1000)
      const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()

      if (existing) {
        // 更新（不改 source/sourceConversationId/followupLog，这些由服务端控制）
        db.update(tasks)
          .set({
            title: input.title,
            description: input.description ?? null,
            status: input.status ?? existing.status,
            priority: input.priority ?? existing.priority,
            dueDate: input.dueDate ?? null,
            updatedAt: now,
          })
          .where(eq(tasks.id, id))
          .run()
      } else {
        // 新增：M3 手动建，source 默认 manual
        db.insert(tasks)
          .values({
            id,
            title: input.title,
            description: input.description ?? null,
            status: input.status ?? 'todo',
            priority: input.priority ?? 'medium',
            dueDate: input.dueDate ?? null,
            source: 'manual',
          })
          .run()
      }
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get()!
      return ok(rowToTask(row))
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('task:delete', (_, id: string): IpcResult<true> => {
    try {
      getDb().delete(tasks).where(eq(tasks.id, id)).run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  // M4：抽取任务草稿（不直接入库，红线：必须人工确认）。
  // providerId 从 settings 读（extract.providerId），不信任前端传——保证用「最便宜模型」。
  ipcMain.handle('task:extract', async (_, conversationId: string): Promise<IpcResult<TaskDraft[]>> => {
    try {
      // 读抽取模型配置
      const providerRow = getDb().select().from(settings).where(eq(settings.key, 'extract.providerId')).get()
      const extractProviderId = providerRow?.value ?? null
      if (!extractProviderId) return err('未配置抽取模型，请在设置页「任务抽取」区选择一个模型')
      // 读会话历史
      const history = listMessages(conversationId).map((m) => ({
        role: m.role,
        content: m.content,
      }))
      if (history.length === 0) return ok([])
      const drafts = await extractTasks(extractProviderId, history)
      return ok(drafts)
    } catch (e) {
      return err(String(e))
    }
  })

  // M4：草稿确认入库（用户点"加入任务"后调）。
  // source 强制 from_chat + 填 sourceConversationId（溯源），与 task:upsert（manual）平行。
  ipcMain.handle('task:create_from_draft', (_, input: TaskDraftInput): IpcResult<Task> => {
    try {
      const db = getDb()
      const id = randomUUID()
      db.insert(tasks)
        .values({
          id,
          title: input.title,
          description: input.description ?? null,
          status: 'todo', // 草稿入库恒为待办
          priority: input.priority ?? 'medium',
          dueDate: input.dueDate ?? null,
          source: 'from_chat',
          sourceConversationId: input.conversationId, // 溯源
        })
        .run()
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get()!
      return ok(rowToTask(row))
    } catch (e) {
      return err(String(e))
    }
  })
}

// ---------- Reminder handlers（M12.5 v1.2 提醒功能） ----------
// 双轨制（PRD §13.1）：B 轨工具页手动 CRUD + A 轨 FC set_reminder 都走这套 IPC。
// source 由调用方控制：工具页默认 manual；FC 工具传 from_chat。
// 提醒无副作用（PRD §13.2），不像任务抽取需人工确认，可直接入库。
function registerReminderHandlers() {
  ipcMain.handle('reminder:list', (): IpcResult<Reminder[]> => {
    try {
      return ok(listReminders())
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('reminder:upsert', (_, input: ReminderInput): IpcResult<Reminder> => {
    try {
      const db = getDb()
      const id = input.id ?? randomUUID()
      const existing = db.select().from(reminders).where(eq(reminders.id, id)).get()

      if (existing) {
        // 更新（不改 source，由服务端控制）
        db.update(reminders)
          .set({
            time: input.time,
            content: input.content,
          })
          .where(eq(reminders.id, id))
          .run()
      } else {
        db.insert(reminders)
          .values({
            id,
            time: input.time,
            content: input.content,
            source: input.source ?? 'manual',
          })
          .run()
      }
      const row = db.select().from(reminders).where(eq(reminders.id, id)).get()!
      return ok({
        id: row.id,
        time: row.time,
        content: row.content,
        done: row.done,
        source: row.source,
        createdAt: row.createdAt,
      })
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('reminder:delete', (_, id: string): IpcResult<true> => {
    try {
      getDb().delete(reminders).where(eq(reminders.id, id)).run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })
}

// ---------- Pomodoro handlers（M12.6 v1.2 番茄钟，纯 B 轨） ----------
// 前端计时器跑完，落一条历史。list 供 v2 数据看板用（v1.2 不强求展示）。
function registerPomodoroHandlers() {
  // 记录一次番茄钟（完成后调）
  ipcMain.handle('pomodoro:record', (_, input: PomodoroRecordInput): IpcResult<PomodoroSession> => {
    try {
      const db = getDb()
      const id = randomUUID()
      db.insert(pomodoroSessions)
        .values({
          id,
          startedAt: input.startedAt,
          durationMin: input.durationMin,
          taskId: input.taskId ?? null,
          completed: input.completed ?? true,
        })
        .run()
      const row = db.select().from(pomodoroSessions).where(eq(pomodoroSessions.id, id)).get()!
      return ok({
        id: row.id,
        startedAt: row.startedAt,
        durationMin: row.durationMin,
        taskId: row.taskId,
        completed: row.completed,
      })
    } catch (e) {
      return err(String(e))
    }
  })

  // 列历史（按开始时间倒序，v2 数据看板用）
  ipcMain.handle('pomodoro:list', (): IpcResult<PomodoroSession[]> => {
    try {
      const rows = getDb()
        .select()
        .from(pomodoroSessions)
        .orderBy(desc(pomodoroSessions.startedAt))
        .all()
      return ok(
        rows.map((r) => ({
          id: r.id,
          startedAt: r.startedAt,
          durationMin: r.durationMin,
          taskId: r.taskId,
          completed: r.completed,
        })),
      )
    } catch (e) {
      return err(String(e))
    }
  })
}

// ---------- Note handlers（M12.7 v1.2 快速笔记，双轨） ----------
// B 轨笔记页手动 CRUD + A 轨 FC（create/search/read/update）共享这套 IPC。
// 存储：纯 .md 文件（noteStore），路径校验在 noteStore 内（笔记库目录内）。
function registerNoteHandlers() {
  ipcMain.handle('note:list', (): IpcResult<Note[]> => {
    try {
      return ok(listNotes())
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('note:get', (_, id: string): IpcResult<Note | null> => {
    try {
      return ok(getNote(id))
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('note:create', (_, input: NoteInput): IpcResult<Note> => {
    try {
      if (!input.title?.trim()) return err('title 不能为空')
      return ok(createNote(input))
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('note:update', (_, input: NoteInput): IpcResult<Note | null> => {
    try {
      if (!input.id) return err('更新笔记需传 id')
      return ok(updateNote(input.id, input))
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('note:delete', (_, id: string): IpcResult<true> => {
    try {
      deleteNote(id)
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('note:search', (_, query: string): IpcResult<NoteSearchHit[]> => {
    try {
      return ok(searchNotes(query))
    } catch (e) {
      return err(String(e))
    }
  })

  // 笔记库目录配置（设置页 + FC 工具都要读）
  ipcMain.handle('note:getDir', (): IpcResult<string> => {
    try {
      return ok(getNotesDir())
    } catch (e) {
      return err(String(e))
    }
  })

  ipcMain.handle('note:setDir', (_, dir: string): IpcResult<string> => {
    try {
      return ok(setNotesDir(dir))
    } catch (e) {
      return err(String(e))
    }
  })
}

// ---------- Document Converter handlers（M12.9 v1.2 工具扩展） ----------
// 双轨：B 轨工具页拖文件转换 + A 轨 FC convert_document 共享。
// 安全：路径在 converter 内部经 resolveSafePath（白名单/笔记库）。
function registerConverterHandlers() {
  // 查某扩展名支持的目标格式（UI 灰掉不支持的）
  ipcMain.handle('convert:targets', (_, ext: string): IpcResult<ConvertTarget[]> => {
    try {
      return ok(supportedTargets(ext))
    } catch (e) {
      return err(String(e))
    }
  })

  // 执行转换
  ipcMain.handle(
    'convert:run',
    async (_, params: ConvertParams): Promise<IpcResult<ConvertResultData>> => {
      try {
        if (!params.inputPath?.trim()) return err('inputPath 不能为空')
        const result = await convertDocument(params)
        return ok(result)
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // 选输入文件（dialog.showOpenDialog，B 轨 UI 用）
  ipcMain.handle('convert:pickFile', async (): Promise<IpcResult<string | null>> => {
    try {
      const { dialog } = await import('electron')
      const win = BrowserWindow.getAllWindows()[0] ?? null
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openFile'],
        filters: [
          { name: '文档', extensions: ['md', 'txt', 'docx'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) return ok(null)
      return ok(result.filePaths[0])
    } catch (e) {
      return err(String(e))
    }
  })
}

// ---------- PDF Toolbox handlers（v1.7 M16，PRD §15.4⑥） ----------
// 纯 pdf-lib 操作（合并/提取/拆分），路径安全在 pdfToolbox 内经 resolveSafePath。
function registerPdfHandlers() {
  // 查页数（UI 辅助：显示总页数，辅助提取/拆分输入）
  ipcMain.handle('pdf:info', async (_, inputPath: string): Promise<IpcResult<PdfInfo>> => {
    try {
      return ok(await getPdfInfo(inputPath))
    } catch (e) {
      return err(String(e))
    }
  })

  // 合并：paths[] 按顺序合并到 outputPath
  ipcMain.handle(
    'pdf:merge',
    async (_, paths: string[], outputPath: string): Promise<IpcResult<PdfResult>> => {
      try {
        return ok(await mergePdfs(paths, outputPath))
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // 提取：pagesInput 是 1-indexed 用户输入（如 "1,3,5-7"），服务层解析
  ipcMain.handle(
    'pdf:extract',
    async (_, inputPath: string, pagesInput: string, outputPath: string): Promise<IpcResult<PdfResult>> => {
      try {
        return ok(await extractPages(inputPath, pagesInput, outputPath))
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // 拆分：perChunk 每份页数，输出到 outputDir
  ipcMain.handle(
    'pdf:split',
    async (_, inputPath: string, perChunk: number, outputDir: string): Promise<IpcResult<PdfSplitResult>> => {
      try {
        return ok(await splitPdf(inputPath, perChunk, outputDir))
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // 选 PDF 文件（dialog，B 轨 UI 用，照搬 convert:pickFile）
  ipcMain.handle('pdf:pickFile', async (): Promise<IpcResult<string | null>> => {
    try {
      const { dialog } = await import('electron')
      const win = BrowserWindow.getAllWindows()[0] ?? null
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (result.canceled || result.filePaths.length === 0) return ok(null)
      return ok(result.filePaths[0])
    } catch (e) {
      return err(String(e))
    }
  })
}

function registerDbHandlers() {
  ipcMain.handle('db:health', (): IpcResult<{ ok: boolean; dbPath: string; detail: string }> => {
    return ok(dbHealthCheck())
  })
}

// ---------- Dashboard handlers（v1.4 M14 数据看板） ----------
// 看板是只读聚合页。pomodoro/tasks/reminders/notes 复用现有 list（数据量小，前端 reduce）；
// messages 表可能大，activity 单独走聚合 IPC，只回 date+count，不传 content 大字段。
function registerDashboardHandlers() {
  // 对话活跃度：按天聚合 messages 数量（含 user/assistant/tool 全 role）。
  // created_at 是 Unix 秒，SQLite date(created_at,'unixepoch') 转 'YYYY-MM-DD'。
  ipcMain.handle(
    'dashboard:activity',
    (_, query: ActivityQuery): IpcResult<ActivityPoint[]> => {
      try {
        const db = getDb()
        const rows = db
          .select({
            date: sql<string>`date(${messages.createdAt}, 'unixepoch')`.as('date'),
            count: sql<number>`count(*)`.as('count'),
          })
          .from(messages)
          .where(and(gte(messages.createdAt, query.fromSec), lte(messages.createdAt, query.toSec)))
          .groupBy(sql`date(${messages.createdAt}, 'unixepoch')`)
          .orderBy(sql`date(${messages.createdAt}, 'unixepoch')`)
          .all()
        return ok(rows.map((r) => ({ date: r.date, count: r.count })))
      } catch (e) {
        return err(String(e))
      }
    },
  )
}

// ---------- Conversation / Message CRUD（M2，照搬 task 模式） ----------
function rowToConversation(row: typeof conversations.$inferSelect): Conversation {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    scenarioId: row.scenarioId,
    defaultProviderId: row.defaultProviderId,
    pinned: row.pinned,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowToMessage(row: typeof messages.$inferSelect): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    providerId: row.providerId,
    toolCalls: (row.toolCalls ?? null) as ConversationMessage['toolCalls'],
    attachments: (row.attachments ?? null) as ConversationMessage['attachments'],
    createdAt: row.createdAt,
  }
}

function registerConversationHandlers() {
  // 列出全部会话（侧栏用）
  ipcMain.handle('conversation:list', (): IpcResult<Conversation[]> => {
    try {
      return ok(listConversations())
    } catch (e) {
      return err(String(e))
    }
  })

  // 新建会话。title 可空（首次创建），由后续首条消息或 rename 回填。
  ipcMain.handle('conversation:create', (_, input: ConversationInput): IpcResult<Conversation> => {
    try {
      const db = getDb()
      const id = input.id ?? randomUUID()
      const title = input.title?.trim() || '新会话'
      db.insert(conversations)
        .values({
          id,
          title,
          type: input.type ?? 'normal',
          defaultProviderId: input.defaultProviderId ?? null,
          pinned: input.pinned ?? false,
        })
        .run()
      const row = db.select().from(conversations).where(eq(conversations.id, id)).get()!
      return ok(rowToConversation(row))
    } catch (e) {
      return err(String(e))
    }
  })

  // 重命名（同时刷新 updatedAt，让会话在侧栏排序前移）
  ipcMain.handle(
    'conversation:rename',
    (_, id: string, title: string): IpcResult<Conversation> => {
      try {
        const db = getDb()
        const now = Math.floor(Date.now() / 1000)
        db.update(conversations)
          .set({ title: title.trim() || '新会话', updatedAt: now })
          .where(eq(conversations.id, id))
          .run()
        const row = db.select().from(conversations).where(eq(conversations.id, id)).get()
        if (!row) return err('会话不存在')
        return ok(rowToConversation(row))
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // M15：设置会话默认 provider（档位/模型选择的会话级记忆，复用闲置字段 defaultProviderId）
  ipcMain.handle(
    'conversation:setProvider',
    (_, id: string, providerId: string): IpcResult<true> => {
      try {
        const db = getDb()
        db.update(conversations)
          .set({ defaultProviderId: providerId, updatedAt: Math.floor(Date.now() / 1000) })
          .where(eq(conversations.id, id))
          .run()
        return ok(true)
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // 删除会话 + 级联删消息（SQLite foreign_keys=ON 但未声明外键约束，手动删更稳）
  ipcMain.handle('conversation:delete', (_, id: string): IpcResult<true> => {
    try {
      const db = getDb()
      db.delete(messages).where(eq(messages.conversationId, id)).run()
      db.delete(conversations).where(eq(conversations.id, id)).run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  // 列出某会话全部消息（历史 hydrate 用）
  ipcMain.handle(
    'message:list',
    (_, conversationId: string): IpcResult<ConversationMessage[]> => {
      try {
        return ok(listMessages(conversationId))
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // 写单条消息（供 chat:send 落库 + 未来 M4 抽取回灌用）。
  // 注意：流式 token 不逐条写库，由 chat:send 在 done 前用此接口一次性落 assistant 最终文本。
  ipcMain.handle('message:insert', (_, input: MessageInsertInput): IpcResult<ConversationMessage> => {
    try {
      const db = getDb()
      const id = input.id ?? randomUUID()
      db.insert(messages)
        .values({
          id,
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          providerId: input.providerId ?? null,
          toolCalls: input.toolCalls ?? null,
        })
        .run()
      // 写消息后顺手刷新会话 updatedAt（侧栏排序）
      db.update(conversations)
        .set({ updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(conversations.id, input.conversationId))
        .run()
      const row = db.select().from(messages).where(eq(messages.id, id)).get()!
      return ok(rowToMessage(row))
    } catch (e) {
      return err(String(e))
    }
  })
}

/** 暴露 Provider 预设给渲染层（设置页用）。 */
function registerMetaHandlers() {
  ipcMain.handle('meta:provider-presets', () => ok(PROVIDER_PRESETS))
}

export function registerIpcHandlers() {
  registerProviderHandlers()
  registerSettingsHandlers()
  registerSearchProviderHandlers()
  registerChatHandlers()
  registerWorkDirHandlers()
  registerTaskHandlers()
  registerReminderHandlers()
  registerPomodoroHandlers()
  registerNoteHandlers()
  registerConverterHandlers()
  registerPdfHandlers()
  registerConversationHandlers()
  registerDbHandlers()
  registerDashboardHandlers()
  registerMetaHandlers()
  logInfo('[ipc] handlers registered')
}
