import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, dbHealthCheck } from '../services/db'
import { providers, settings, workDirs, searchProviders } from '../services/db/schema'
import { setSecret, getSecret, deleteSecret } from '../services/secret'
import {
  listProviders,
  createClientForProvider,
  listEnabledWorkDirs,
  listAllWorkDirs,
} from '../services/providers/factory'
import { listSearchProviders, getActiveSearchConfig } from '../services/search/factory'
import { pingTavily } from '../services/searchTools'
import { chatWithProvider } from '../services/providers/chat'
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
      const { client, model } = createClientForProvider(params.providerId)
      const ac = new AbortController()
      abortMap.set(reqId, ac)

      // 构建 sources = 系统位置 + 启用的预填 workDirs + 会话已确认目录
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

      await chatWithProvider({
        client,
        model,
        messages: params.messages,
        tools,
        onToken,
        onToolCall,
        onFirstToken,
        onConfirm,
        signal: ac.signal,
      })

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

function registerDbHandlers() {
  ipcMain.handle('db:health', (): IpcResult<{ ok: boolean; dbPath: string; detail: string }> => {
    return ok(dbHealthCheck())
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
  registerDbHandlers()
  registerMetaHandlers()
  logInfo('[ipc] handlers registered')
}
