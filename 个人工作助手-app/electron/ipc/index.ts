import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb, dbHealthCheck } from '../services/db'
import { providers, settings } from '../services/db/schema'
import { setSecret, deleteSecret } from '../services/secret'
import { listProviders, createClientForProvider } from '../services/providers/factory'
import { chatWithProvider } from '../services/providers/chat'
import { builtinTools } from '../services/tools'
import { PROVIDER_PRESETS } from '../services/providers/types'
import { logInfo } from '../services/logger'
import type { ChatSendParams, IpcResult, ProviderInput, Provider } from '../types'

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

function registerChatHandlers() {
  // 取消用 send（单向）。当前实现：维护一个 AbortController 映射。
  const abortMap = new Map<string, AbortController>()

  ipcMain.on('chat:cancel', (_, reqId: string) => {
    abortMap.get(reqId)?.abort()
  })

  ipcMain.handle('chat:send', async (_, params: ChatSendParams): Promise<IpcResult<string>> => {
    const reqId = params.reqId
    const win = getFocusedWindow()
    if (!win) return err('无可用窗口')

    try {
      const { client, model } = createClientForProvider(params.providerId)
      const ac = new AbortController()
      abortMap.set(reqId, ac)

      const onToken = (text: string) => {
        win.webContents.send('chat:token', { reqId, text })
      }
      const onToolCall = (name: string, args: string) => {
        win.webContents.send('chat:tool_call', { reqId, name, args })
      }
      const onFirstToken = (elapsedMs: number) => {
        win.webContents.send('chat:first_token', { reqId, elapsedMs })
      }

      await chatWithProvider({
        client,
        model,
        messages: params.messages,
        tools: params.enableTools ? builtinTools : undefined,
        onToken,
        onToolCall,
        onFirstToken,
        signal: ac.signal,
      })

      win.webContents.send('chat:done', { reqId })
      abortMap.delete(reqId)
      return ok(reqId)
    } catch (e: unknown) {
      abortMap.delete(reqId)
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
  registerChatHandlers()
  registerDbHandlers()
  registerMetaHandlers()
  logInfo('[ipc] handlers registered')
}
