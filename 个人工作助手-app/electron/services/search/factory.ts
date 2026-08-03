import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { searchProviders } from '../db/schema'
import { getSecret } from '../secret'
import type { SearchProvider } from '../../types'
import type { ActiveSearchConfig } from '../searchTools'

/**
 * SearchProvider 加载工厂（仿 providers/factory.ts）。
 *
 * 业务模型：库里存 SearchProvider 配置（含 apiKeyRef），明文 Key 在 safeStorage。
 * 运行时取启用的 provider → getSecret 解密 Key → 构造活跃配置供 web_search 用。
 */

/** drizzle 行 → 对外 SearchProvider 类型。 */
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

/** 列出全部 SearchProvider（设置页用）。 */
export function listSearchProviders(): SearchProvider[] {
  return getDb()
    .select()
    .from(searchProviders)
    .all()
    .map(rowToSearchProvider)
}

/** 列出启用的 SearchProvider。 */
export function listEnabledSearchProviders(): SearchProvider[] {
  return getDb()
    .select()
    .from(searchProviders)
    .where(eq(searchProviders.enabled, true))
    .all()
    .map(rowToSearchProvider)
}

/** 按 id 取一条。 */
export function getSearchProvider(id: string): SearchProvider | null {
  const row = getDb().select().from(searchProviders).where(eq(searchProviders.id, id)).get()
  return row ? rowToSearchProvider(row) : null
}

/**
 * 取当前活跃搜索配置：第一个启用的 provider + 解密 Key。
 * 无启用 provider 或 Key 缺失 → 返回 null（web_search 走降级）。
 *
 * 注意：本轮 provider type 只 'tavily'。将来加 bing 时在此按 type 分支，
 * 返回 { provider: 'bing', ... } 并在 searchTools.searchWithXxx 路由。
 */
export function getActiveSearchConfig(): ActiveSearchConfig | null {
  const providers = listEnabledSearchProviders()
  if (providers.length === 0) return null

  const first = providers[0]
  if (first.type !== 'tavily') return null // 本轮只支持 tavily

  const apiKey = getSecret(first.apiKeyRef)
  if (!apiKey) return null // Key 未配置或损坏

  return { provider: 'tavily', apiKey }
}
