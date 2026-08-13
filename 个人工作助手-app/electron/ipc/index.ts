import { ipcMain, BrowserWindow, clipboard, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { eq, desc, and, gte, lte, sql, inArray } from 'drizzle-orm'
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
  parseTags,
} from '../services/providers/factory'
import {
  listConversations,
  getConversation,
  listMessages,
  listMessagesInRange,
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
import { getNotesDir, setNotesDir, ensureNotesDir } from '../services/notes/config'
import { resolveSafePath } from '../services/fileTools'
import fs from 'node:fs'
import { convertDocument, supportedTargets, parseCsv, readXlsxAsTable } from '../services/converter'
import { getPdfInfo, mergePdfs, extractPages, splitPdf } from '../services/pdfToolbox'
import { chatWithProvider, type ChatResult } from '../services/providers/chat'
import { truncateByTokenBudget } from '../services/providers/truncate'
import { recognizeImage } from '../services/ocrService'
import os from 'node:os'
import { resolveProviderId } from '../services/providers/router'
import { extractTasks } from '../services/taskExtractor'
import { generateReport } from '../services/reportGenerator'
import { assistNote } from '../services/noteAssistant'
import { captureScreen, type ScreenCaptureResult } from '../services/screenShot'
import { generateMindmap } from '../services/mindmapGenerator'
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
  TaskFromNoteInput,
  TaskSubtaskInput,
  TaskDeleteParams,
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
  ReportPayload,
  ReportGenerateParams,
  ReportResult,
  ReportPreviewParams,
  ReportPreviewResult,
  NoteAiParams,
  NoteAiResult,
  MindmapGenerateParams,
  MindmapResult,
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

// v1.17 对话发图：判断模型是否支持视觉（多模态）。
// 启发式按 model 名判断——智谱 GLM-4V/4.5/4.6 系列支持视觉，DeepSeek/flash 纯文本不支持。
// 不够准时可在设置页加手动标记（第二阶段），当前零配置。
function isVisionModel(model: string): boolean {
  return /glm-4v|glm-4\.5|glm-4\.6|vision|vl|multimodal/i.test(model)
}

// v1.17 对话发图：把消息里的图片附件按模型能力分流处理，返回处理后的 messages（供 chatWithProvider）。
//  - 视觉模型：user 消息 content 改成 OpenAI 多模态数组 [{type:'text'}, {type:'image_url'}]
//  - 纯文本模型：图片写临时文件 → OCR 转文字 → 拼进 content（[图片识别]\n{文字}）
// 返回新数组，不改原 messages。无附件的消息原样透传。
async function processImageAttachments(
  messages: { role: string; content: string; attachments?: { name: string; dataUrl: string }[] }[],
  model: string,
): Promise<{ role: string; content: string | unknown[] }[]> {
  const vision = isVisionModel(model)
  const result: { role: string; content: string | unknown[] }[] = []

  for (const m of messages) {
    if (!m.attachments || m.attachments.length === 0) {
      result.push({ role: m.role, content: m.content })
      continue
    }

    if (vision) {
      // 视觉模型：拼多模态 content 数组（OpenAI 格式）
      const parts: unknown[] = []
      if (m.content.trim()) {
        parts.push({ type: 'text', text: m.content })
      }
      for (const att of m.attachments) {
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } })
      }
      result.push({ role: m.role, content: parts })
    } else {
      // 纯文本模型：OCR 每张图，文字拼进 content
      let ocrText = m.content
      for (let i = 0; i < m.attachments.length; i++) {
        const att = m.attachments[i]
        try {
          // base64 写临时文件（ocrService 收文件路径）
          const tmpPath = await writeDataUrlToTemp(att.dataUrl)
          const text = await recognizeImage(tmpPath)
          fs.unlinkSync(tmpPath) // 删临时文件
          ocrText += `\n\n[图片${i + 1} 识别结果]\n${text || '（未识别到文字）'}`
        } catch (e) {
          ocrText += `\n\n[图片${i + 1} 识别失败：${String(e instanceof Error ? e.message : e)}]`
        }
      }
      result.push({ role: m.role, content: ocrText.trim() })
    }
  }
  return result
}

/** 把 data URL（data:image/png;base64,xxx）写成临时文件，返回路径。OCR 用。 */
async function writeDataUrlToTemp(dataUrl: string): Promise<string> {
  const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl)
  if (!m) throw new Error('无效的图片 dataUrl')
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
  const buf = Buffer.from(m[2], 'base64')
  const tmpDir = path.join(os.tmpdir(), 'pwa-ocr')
  fs.mkdirSync(tmpDir, { recursive: true })
  const filePath = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  fs.writeFileSync(filePath, buf)
  return filePath
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

      // v1.17 对话发图：按模型能力处理图片附件（视觉→多模态；纯文本→OCR 转文字）。
      // 在截断后处理——当前轮的 user 消息（含附件）在最后，不会被截断丢弃。
      const messagesWithImages = await processImageAttachments(
        messagesForModel as { role: string; content: string; attachments?: { name: string; dataUrl: string }[] }[],
        model,
      )

      const result = await chatWithProvider({
        client,
        model,
        messages: messagesWithImages as any,
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
    sourceNotePath: row.sourceNotePath,
    parentId: row.parentId,
    followupLog: row.followupLog,
    completedAt: row.completedAt,
    tags: parseTags(row.tags),
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
        // v1.8：completedAt 由 status 推导（切到 done 写 now，切出 done 清 null），
        //   与 source/followupLog 同样「服务端控制」策略，不入 TaskInput。
        const prevStatus = existing.status
        const nextStatus = input.status ?? existing.status
        const completedAt =
          nextStatus === 'done' && prevStatus !== 'done'
            ? now
            : nextStatus !== 'done' && prevStatus === 'done'
              ? null
              : existing.completedAt // 状态未变或 done→done 保持
        db.update(tasks)
          .set({
            title: input.title,
            // v1.10.6：未传的字段用 existing 兜底（避免子任务 inline 改标题时
            //   误清 description/dueDate）。原写法 input.x ?? null 会把未传字段清空。
            description: input.description !== undefined ? input.description : existing.description,
            status: input.status ?? existing.status,
            priority: input.priority ?? existing.priority,
            dueDate: input.dueDate !== undefined ? input.dueDate : existing.dueDate,
            // v1.11：tags 未传用 existing 兜底（JSON 字符串存库）
            tags: input.tags !== undefined ? JSON.stringify(input.tags) : existing.tags,
            completedAt,
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
            tags: JSON.stringify(input.tags ?? []),
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

  ipcMain.handle('task:delete', (_, params: TaskDeleteParams): IpcResult<true> => {
    try {
      const db = getDb()
      // v1.14：递归删所有后代（无限层级）。之前只删一级子任务，孙子变孤儿。
      // 收集所有后代 id：从 params.id 出发，逐层查 parentId IN 当前层 的下一层，直到无更多。
      const allRows = db.select({ id: tasks.id, parentId: tasks.parentId }).from(tasks).all()
      const childrenOf = new Map<string, string[]>()
      for (const r of allRows) {
        if (r.parentId) {
          const arr = childrenOf.get(r.parentId) ?? []
          arr.push(r.id)
          childrenOf.set(r.parentId, arr)
        }
      }
      const toDelete: string[] = []
      let frontier = [params.id]
      while (frontier.length > 0) {
        const next: string[] = []
        for (const id of frontier) {
          toDelete.push(id)
          const children = childrenOf.get(id) ?? []
          next.push(...children)
        }
        frontier = next
      }
      if (toDelete.length > 0) {
        db.delete(tasks).where(inArray(tasks.id, toDelete)).run()
      }
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  // v1.10.1：子任务转根任务（清 parentId）。用于解除父子关系让子任务独立。
  ipcMain.handle('task:promote_subtask', (_, id: string): IpcResult<true> => {
    try {
      const now = Math.floor(Date.now() / 1000)
      getDb().update(tasks).set({ parentId: null, updatedAt: now }).where(eq(tasks.id, id)).run()
      return ok(true)
    } catch (e) {
      return err(String(e))
    }
  })

  // v1.10.5：手动移动任务到某父任务下（或移出变根任务）。
  // 入参 { id, parentId }：parentId=null 变根任务；parentId=某任务 id 变其子任务。
  // v1.14：支持无限层级。移动 A 到 B 下时：
  //   - 只改 A 的 parentId，不动 A 的后代（整棵子树跟着 A 移动，保持内部结构）
  //   - 环路检测：B 不能是 A 自己，也不能是 A 的后代（否则 A→B→...→A 成环）
  ipcMain.handle(
    'task:set_parent',
    (_, params: { id: string; parentId: string | null }): IpcResult<true> => {
      try {
        if (params.parentId === params.id) return err('不能把任务移到自己下面')
        const db = getDb()
        const target = params.parentId
          ? db.select().from(tasks).where(eq(tasks.id, params.parentId)).get()
          : null
        if (params.parentId && !target) return err('目标父任务不存在')
        // v1.14 环路检测：parentId 不能是 id 的后代。递归收集 id 的所有后代 id。
        if (params.parentId) {
          const descendantIds = new Set<string>()
          let frontier = [params.id]
          while (frontier.length > 0) {
            const rows = db
              .select({ id: tasks.id })
              .from(tasks)
              .all()
              .filter((r) => {
                // 查 parentId IN frontier（drizzle in 子句简化为全量 filter，任务量小）
                const row = db
                  .select()
                  .from(tasks)
                  .where(eq(tasks.id, r.id))
                  .get()
                return row && frontier.includes(row.parentId ?? '')
              })
            const next: string[] = []
            for (const r of rows) {
              if (!descendantIds.has(r.id)) {
                descendantIds.add(r.id)
                next.push(r.id)
              }
            }
            frontier = next
          }
          if (descendantIds.has(params.parentId)) {
            return err('不能把任务移到它自己的子任务下面（会形成循环）')
          }
        }
        const now = Math.floor(Date.now() / 1000)
        // v1.14：只移动本任务，不动后代（整棵子树保持内部结构跟着移动）
        db.update(tasks)
          .set({ parentId: params.parentId, updatedAt: now })
          .where(eq(tasks.id, params.id))
          .run()
        return ok(true)
      } catch (e) {
        return err(String(e))
      }
    },
  )

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

  // v1.9.1：笔记转任务（PRD §15.2②）。与 create_from_draft 平行，
  // source 强制 from_note + 填 sourceNotePath（从 noteId 解析为 fileName，不信任前端传路径）。
  // 不静默入库——前端点「转任务」按钮才调（与抽取草稿确认同源）。
  ipcMain.handle('task:create_from_note', (_, input: TaskFromNoteInput): IpcResult<Task> => {
    try {
      const note = getNote(input.noteId)
      if (!note) return err('笔记不存在，可能已被删除')
      const db = getDb()
      const id = randomUUID()
      db.insert(tasks)
        .values({
          id,
          title: input.title,
          status: 'todo',
          priority: input.priority ?? 'medium',
          dueDate: input.dueDate ?? null,
          source: 'from_note',
          sourceNotePath: note.fileName, // 溯源（笔记库内 fileName 唯一稳定）
        })
        .run()
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get()!
      return ok(rowToTask(row))
    } catch (e) {
      return err(String(e))
    }
  })

  // v1.10：子任务（v1.14 起支持无限层级）。与 create_from_draft/note 平行。
  // source 跟随父任务（服务端查父任务后填，保持溯源一致），status 恒 todo，parentId 填入参。
  // v1.14：任意任务都可作为父任务（不限根任务），UI 每个节点都有「添加子任务」入口。
  ipcMain.handle('task:create_subtask', (_, input: TaskSubtaskInput): IpcResult<Task> => {
    try {
      const db = getDb()
      const parent = db.select().from(tasks).where(eq(tasks.id, input.parentId)).get()
      if (!parent) return err('父任务不存在')
      const id = randomUUID()
      db.insert(tasks)
        .values({
          id,
          title: input.title,
          status: 'todo',
          priority: input.priority ?? 'medium',
          dueDate: input.dueDate ?? null,
          source: parent.source, // 跟随父任务溯源
          parentId: input.parentId,
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

  // v1.17 笔记贴图（PRD §15.2 笔记增强）：保存粘贴/上传的图片到笔记库 images/ 子目录。
  // 入参 {noteId, dataUrl}，dataUrl 形如 data:image/png;base64,xxxx。
  // 返回 markdown 相对引用路径 images/xxx.png，前端在光标处插入 ![](images/xxx.png)。
  // 图片与 .md 同库（笔记库/images/），预览态 react-markdown 用相对路径能正确渲染。
  ipcMain.handle(
    'note:save_image',
    (_, params: { noteId: string; dataUrl: string }): IpcResult<{ relPath: string }> => {
      try {
        // 解析 dataUrl：data:image/png;base64,xxxx
        const m = /^data:image\/(\w+);base64,(.+)$/.exec(params.dataUrl)
        if (!m) return err('无效的图片 dataUrl（期望 data:image/xxx;base64,...）')
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
        const buf = Buffer.from(m[2], 'base64')
        const notesDir = ensureNotesDir()
        const imagesDir = path.join(notesDir, 'images')
        fs.mkdirSync(imagesDir, { recursive: true })
        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        fs.writeFileSync(path.join(imagesDir, fileName), buf)
        return ok({ relPath: `images/${fileName}` })
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // ---------- AI 笔记助手（v1.9 M18，PRD §15.2①） ----------
  // 复用 report.providerId（与报告模型共用，零新配置项）。非流式，照搬 report:generate 的可取消模式。
  // 结果以「可插入块」返回 Markdown，用户点插入才写进笔记（不静默改）。
  const noteAbortMap = new Map<string, AbortController>()

  ipcMain.handle(
    'note:ai',
    async (_, params: NoteAiParams): Promise<IpcResult<NoteAiResult>> => {
      try {
        if (!params.content.trim()) return err('笔记内容为空，无法执行 AI 操作')

        // 复用 report.providerId（语义相近：都是非流式文本处理，零新配置项）
        const providerRow = getDb()
          .select()
          .from(settings)
          .where(eq(settings.key, 'report.providerId'))
          .get()
        const providerId = providerRow?.value ?? null
        if (!providerId) {
          return err('未配置报告模型，AI 笔记助手共用此模型，请在设置页「报告模型」区选择')
        }

        const reqId = params.reqId ?? ''
        const ac = new AbortController()
        if (reqId) noteAbortMap.set(reqId, ac)

        try {
          const result = await assistNote(providerId, params.op, params.content, {
            question: params.question,
            signal: ac.signal,
          })
          return ok({ result })
        } finally {
          if (reqId) noteAbortMap.delete(reqId)
        }
      } catch (e) {
        return err(String(e))
      }
    },
  )

  ipcMain.handle('note:ai_cancel', (_, reqId: string): IpcResult<true> => {
    const ac = noteAbortMap.get(reqId)
    if (ac) {
      ac.abort()
      noteAbortMap.delete(reqId)
    }
    return ok(true)
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
          { name: '文档', extensions: ['md', 'txt', 'docx', 'csv', 'xlsx'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) return ok(null)
      return ok(result.filePaths[0])
    } catch (e) {
      return err(String(e))
    }
  })

  // v1.20 表格预览（V-Z9）：读 csv/xlsx 文件 → string[][] 返前端渲染。路径经 resolveSafePath
  ipcMain.handle(
    'convert:preview_table',
    async (_, filePath: string): Promise<IpcResult<string[][]>> => {
      try {
        // 构建最小 sources（workDirs + 笔记库），照搬 chat:send 的 buildSources 简化版
        const sources: AccessibleDir[] = listEnabledWorkDirs().map((wd) => ({
          label: wd.label,
          path: wd.path,
          source: 'workdir' as const,
          mode: wd.mode,
        }))
        try {
          sources.push({ label: '笔记库', path: getNotesDir(), source: 'workdir', mode: 'readwrite' })
        } catch {
          // notesDir 取不到忽略
        }
        const r = resolveSafePath(filePath, sources)
        if (!r.ok || !r.fullPath) return err(r.error ?? '输入路径非法')
        const ext = path.extname(r.fullPath).slice(1).toLowerCase()
        if (ext === 'csv') {
          const text = fs.readFileSync(r.fullPath, 'utf8')
          return ok(parseCsv(text))
        }
        if (ext === 'xlsx') {
          return ok(await readXlsxAsTable(r.fullPath))
        }
        return err('预览仅支持 csv / xlsx')
      } catch (e) {
        return err(String(e))
      }
    },
  )
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

// ---------- Report handlers（v1.8 M17 AI 日报/周报，PRD §15.3④） ----------
// 生成走非流式（ADR-010 范式，照搬 task:extract），providerId 从 settings KV `report.providerId` 读。
// 数据聚合：tasks(按 completedAt) + messages(按 createdAt，复用 listMessagesInRange)
//   + pomodoros(按 startedAt) + reminders(按 time)。全量拉后内存过滤（数据量小，与 dashboard 同策略）。
// 报告写成 .md 笔记存入笔记库（ADR-025 复用不建表），路径安全在 noteStore 内部闭环。
function registerReportHandlers() {
  // 可取消的生成请求登记表（reqId → AbortController，v1.8.1 打磨）
  // 模块级 Map，进程内单例。generate 生成前注册，cancel 时 abort，结束（成功/失败）清理。
  const reportAbortMap = new Map<string, AbortController>()

  // ---------- report:preview（v1.8.1 打磨：生成前预览数据计数，不调模型）----------
  // UI 切换范围/日期时调，实时显示「X 任务 / Y 对话 / Z 分钟」让用户确认范围合理（PRD §15.8）。
  ipcMain.handle(
    'report:preview',
    (_, params: ReportPreviewParams): IpcResult<ReportPreviewResult> => {
      try {
        const { fromSec, toSec } = computeRange(params)
        const data = aggregateReportData(fromSec, toSec)
        const preview: ReportPreviewResult = {
          taskCount: data.tasks.length,
          messageCount: data.conversations.length,
          pomoCount: data.pomodoros.length,
          pomoMinutes: data.pomodoros.reduce((s, p) => s + p.durationMin, 0),
          reminderCount: data.reminders.length,
          rangeLabel: buildRangeLabel(params, fromSec, toSec),
          empty:
            data.tasks.length === 0 &&
            data.conversations.length === 0 &&
            data.pomodoros.length === 0 &&
            data.reminders.length === 0,
        }
        return ok(preview)
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // ---------- report:generate（生成报告，支持取消）----------
  ipcMain.handle(
    'report:generate',
    async (_, params: ReportGenerateParams): Promise<IpcResult<ReportResult>> => {
      try {
        // 1. 读报告模型配置（不信任前端传，保证用配置的模型）
        const providerRow = getDb()
          .select()
          .from(settings)
          .where(eq(settings.key, 'report.providerId'))
          .get()
        const reportProviderId = providerRow?.value ?? null
        if (!reportProviderId) {
          return err('未配置报告模型，请在设置页「报告模型」区选择一个模型')
        }

        // 2. 算时间范围（custom 必须传 fromSec/toSec，否则当 daily 兜底）
        const { fromSec, toSec } = computeRange(params)

        // 3. 聚合数据（与 preview 共用 aggregateReportData）
        const data = aggregateReportData(fromSec, toSec)

        // 4. 全空拦截（PRD §15.8 风险对策：数据全空别浪费 API）
        if (
          data.tasks.length === 0 &&
          data.conversations.length === 0 &&
          data.pomodoros.length === 0 &&
          data.reminders.length === 0
        ) {
          return err(`${buildRangeLabel(params, fromSec, toSec)}暂无工作数据（无完成任务/对话/番茄/提醒），无法生成报告`)
        }

        // 5. 注册可取消控制器（v1.8.1 打磨）
        const reqId = params.reqId ?? ''
        const ac = new AbortController()
        if (reqId) reportAbortMap.set(reqId, ac)

        try {
          // 6. 调模型生成 Markdown（传 signal，可被 report:cancel 中断）
          const payload: ReportPayload = {
            range: params.range,
            fromSec,
            toSec,
            ...data,
          }
          const markdown = await generateReport(reportProviderId, payload, { signal: ac.signal })

          // 7. 写入笔记库（tag 区分日报/周报/自定义，标题带日期）
          const tag = params.range === 'weekly' ? '周报' : '日报' // custom 归日报 tag
          const title = buildReportTitle(params.range, fromSec, toSec)
          const note = createNote({ title, content: markdown, tags: [tag] })

          return ok({ note })
        } finally {
          if (reqId) reportAbortMap.delete(reqId)
        }
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // ---------- report:cancel（v1.8.1 打磨：取消进行中的生成）----------
  ipcMain.handle('report:cancel', (_, reqId: string): IpcResult<true> => {
    const ac = reportAbortMap.get(reqId)
    if (ac) {
      ac.abort()
      reportAbortMap.delete(reqId)
    }
    return ok(true)
  })
}

// ---------- v1.12：AI 思维导图 handlers（照搬 report 可取消范式） ----------
function registerMindmapHandlers() {
  const mindmapAbortMap = new Map<string, AbortController>()

  ipcMain.handle(
    'mindmap:generate',
    async (_, params: MindmapGenerateParams): Promise<IpcResult<MindmapResult>> => {
      try {
        // 1. 读报告模型配置（复用 report.providerId，零新配置）
        const providerRow = getDb()
          .select()
          .from(settings)
          .where(eq(settings.key, 'report.providerId'))
          .get()
        const providerId = providerRow?.value ?? null
        if (!providerId) {
          return err('未配置模型，请在设置页「报告模型」区选择一个模型')
        }

        // 2. 输入校验：topic 或 material 至少一个非空
        const topic = params.topic?.trim()
        const material = params.material?.trim()
        if (!topic && !material) {
          return err('请输入主题，或选择一个笔记/任务作为素材')
        }

        // 3. 注册可取消控制器
        const reqId = params.reqId ?? ''
        const ac = new AbortController()
        if (reqId) mindmapAbortMap.set(reqId, ac)

        try {
          // 4. 调模型生成 Markdown 层级标题
          const markdown = await generateMindmap(providerId, { topic, material }, { signal: ac.signal })

          // 5. 写入笔记库（tag='思维导图'，标题取主题或素材来源）
          const title = `思维导图：${topic || params.sourceTitle || '未命名'}`
          const note = createNote({ title, content: markdown, tags: ['思维导图'] })

          return ok({ note, markdown })
        } finally {
          if (reqId) mindmapAbortMap.delete(reqId)
        }
      } catch (e) {
        return err(String(e))
      }
    },
  )

  ipcMain.handle('mindmap:cancel', (_, reqId: string): IpcResult<true> => {
    const ac = mindmapAbortMap.get(reqId)
    if (ac) {
      ac.abort()
      mindmapAbortMap.delete(reqId)
    }
    return ok(true)
  })
}

/**
 * 聚合报告数据（v1.8.1 抽出，preview 与 generate 共用）。
 * 按时间范围过滤 tasks(按 completedAt) + messages(按 createdAt) + pomodoros(按 startedAt) + reminders(按 time)。
 * messages 只取 user/assistant、content 截 200 字、限 50 条（与原 generate 逻辑一致）。
 */
function aggregateReportData(fromSec: number, toSec: number): Omit<ReportPayload, 'range' | 'fromSec' | 'toSec'> {
  const db = getDb()

  // 任务：done + completedAt 落在区间（completedAt 为 null 的历史 done 任务忽略，无法判定何时完成）
  const reportTasks = listTasks()
    .filter(
      (t) =>
        t.status === 'done' &&
        t.completedAt !== null &&
        t.completedAt >= fromSec &&
        t.completedAt <= toSec,
    )
    .map((t) => ({ title: t.title, priority: t.priority, completedAt: t.completedAt }))

  // 对话：按时间范围取（跨所有会话），role 只取 user/assistant（system/tool 噪音），
  //   content 截前 200 字，总数限 50 条防超长
  const reportMsgs = listMessagesInRange(fromSec, toSec)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(0, 50)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content,
      createdAt: m.createdAt,
    }))

  // 番茄钟：startedAt 落在区间
  const reportPomos = db
    .select()
    .from(pomodoroSessions)
    .where(and(gte(pomodoroSessions.startedAt, fromSec), lte(pomodoroSessions.startedAt, toSec)))
    .all()
    .map((r) => ({ startedAt: r.startedAt, durationMin: r.durationMin, completed: r.completed }))

  // 提醒：time 落在区间（提醒的「发生时间」语义最贴近日报）
  const reportReminders = listReminders()
    .filter((r) => r.time >= fromSec && r.time <= toSec)
    .map((r) => ({ time: r.time, content: r.content, done: r.done }))

  return { tasks: reportTasks, conversations: reportMsgs, pomodoros: reportPomos, reminders: reportReminders }
}

/** 算报告时间范围（Unix 秒，闭区间）。
 *  - 显式传 fromSec/toSec：直接用（custom 模式必走此分支）。
 *  - daily：今日 0:00 ~ 23:59:59。
 *  - weekly：本周一 0:00 ~ 今天 23:59:59。 */
function computeRange(params: { range: string; fromSec?: number; toSec?: number }): {
  fromSec: number
  toSec: number
} {
  if (params.fromSec !== undefined && params.toSec !== undefined) {
    return { fromSec: params.fromSec, toSec: params.toSec }
  }
  const now = new Date()
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  const toSec = Math.floor(endOfDay.getTime() / 1000)

  if (params.range === 'weekly') {
    const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1 // 周日=6，周一=0
    const monday = new Date(now)
    monday.setDate(now.getDate() - dayOfWeek)
    monday.setHours(0, 0, 0, 0)
    return { fromSec: Math.floor(monday.getTime() / 1000), toSec }
  }
  // daily / 兜底
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  return { fromSec: Math.floor(startOfDay.getTime() / 1000), toSec }
}

/** 区间标签（UI 展示用）：daily=「今日」/ weekly=「本周」/ custom=「2026-08-01 ~ 2026-08-04」。 */
function buildRangeLabel(
  params: { range: string; fromSec?: number; toSec?: number },
  fromSec: number,
  toSec: number,
): string {
  if (params.range === 'daily') return '今日'
  if (params.range === 'weekly') return '本周'
  return `${fmtDate(fromSec)} ~ ${fmtDate(toSec)}`
}

/** 报告笔记标题：daily「日报 2026-08-04」/ weekly「周报 2026-08-04~2026-08-10」/ custom「日报 2026-08-01~2026-08-04」。 */
function buildReportTitle(range: string, fromSec: number, toSec: number): string {
  const prefix = range === 'weekly' ? '周报' : '日报'
  // daily 单日期；weekly/custom 起止（同一天时不重复）
  if (range === 'daily' || fromSec === toSec) return `${prefix} ${fmtDate(fromSec)}`
  return `${prefix} ${fmtDate(fromSec)}~${fmtDate(toSec)}`
}

/** Unix 秒 → YYYY-MM-DD（本地时区）。 */
function fmtDate(sec: number): string {
  const d = new Date(sec * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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

// ---------- v1.19 截图标注 handlers（PRD §15.4⑧ 收官） ----------
// 截屏用 desktopCapturer（主进程调，sandbox 限制渲染层用不了）；
// 保存照搬 note:save_image 落盘到笔记库 images/（路径应用自决，不经 resolveSafePath）；
// 复制剪贴板用 clipboard.writeImage（项目首次用主进程剪贴板写图）。
function registerScreenHandlers() {
  // 截取整屏，返 dataUrl + 原图尺寸
  ipcMain.handle('screen:capture', async (): Promise<IpcResult<ScreenCaptureResult>> => {
    try {
      return ok(await captureScreen())
    } catch (e) {
      return err(String(e))
    }
  })

  // 保存标注图到笔记库 images/（照搬 note:save_image 范式）
  // 入参 {dataUrl}，返 markdown 相对引用路径 images/xxx.png
  ipcMain.handle(
    'screen:save',
    (_, params: { dataUrl: string }): IpcResult<{ relPath: string }> => {
      try {
        const m = /^data:image\/(\w+);base64,(.+)$/.exec(params.dataUrl)
        if (!m) return err('无效的图片 dataUrl（期望 data:image/xxx;base64,...）')
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
        const buf = Buffer.from(m[2], 'base64')
        const notesDir = ensureNotesDir()
        const imagesDir = path.join(notesDir, 'images')
        fs.mkdirSync(imagesDir, { recursive: true })
        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        fs.writeFileSync(path.join(imagesDir, fileName), buf)
        return ok({ relPath: `images/${fileName}` })
      } catch (e) {
        return err(String(e))
      }
    },
  )

  // 复制标注图到系统剪贴板
  ipcMain.handle(
    'screen:copy_clipboard',
    (_, params: { dataUrl: string }): IpcResult<true> => {
      try {
        const m = /^data:image\/(\w+);base64,(.+)$/.exec(params.dataUrl)
        if (!m) return err('无效的图片 dataUrl')
        const buf = Buffer.from(m[2], 'base64')
        clipboard.writeImage(nativeImage.createFromBuffer(buf))
        return ok(true)
      } catch (e) {
        return err(String(e))
      }
    },
  )
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
  registerReportHandlers()
  registerMindmapHandlers()
  registerScreenHandlers()
  registerMetaHandlers()
  logInfo('[ipc] handlers registered')
}
