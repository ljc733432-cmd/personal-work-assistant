import OpenAI from 'openai'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { providers } from '../db/schema'
import { getSecret } from '../secret'
import type { Provider } from '../../types'

/**
 * Provider 加载 + OpenAI client 工厂。
 *
 * 业务模型：库里存 Provider 配置（含 apiKeyRef），明文 Key 在 safeStorage。
 * 运行时按 providerId 查库 → 取明文 Key → 构造 OpenAI client。
 */

/** 按 id 读 Provider 行（drizzle 行 → 对外 Provider 类型）。 */
export function getProvider(providerId: string): Provider | null {
  const row = getDb().select().from(providers).where(eq(providers.id, providerId)).get()
  if (!row) return null
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

/** 列出全部 Provider。 */
export function listProviders(): Provider[] {
  return getDb()
    .select()
    .from(providers)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      baseURL: row.baseURL,
      model: row.model,
      apiKeyRef: row.apiKeyRef,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
}

/**
 * 为某个 Provider 构造 OpenAI client。
 * 明文 Key 从 safeStorage 解密读取，不落变量以外的地方。
 */
export function createClientForProvider(providerId: string): {
  client: OpenAI
  model: string
} {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Provider 不存在: ${providerId}`)
  if (!provider.enabled) throw new Error(`Provider 已禁用: ${provider.name}`)

  const apiKey = getSecret(provider.apiKeyRef)
  if (!apiKey) throw new Error(`Provider「${provider.name}」未配置 API Key（或 Key 已损坏）`)

  const client = new OpenAI({
    apiKey,
    baseURL: provider.baseURL,
  })
  return { client, model: provider.model }
}
