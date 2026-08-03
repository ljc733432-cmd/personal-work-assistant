import { create } from 'zustand'
import type { ModelTier } from '@/types'
import { invoke } from '@/lib/ipc'

/**
 * 模型档位 store（v1.6 M15）。
 *
 * 与 tasks/reminders store 的区别：档位不建表，存 settings KV `router.tiers` 的 JSON。
 * 所以 refresh/upsert/remove 都走 settings:get/set（读写整个 JSON 字符串），在 store 层 parse。
 *
 * 设计见 ADR-022：档位数量少、字段简单、零迁移。
 */
const TIER_KEY = 'router.tiers'

interface TiersState {
  tiers: ModelTier[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** 新增或更新（按 id 匹配）。upsert 后自动持久化 + refresh。 */
  upsert: (tier: ModelTier) => Promise<void>
  /** 删除。remove 后自动持久化 + refresh。 */
  remove: (id: string) => Promise<void>
}

export const useTiersStore = create<TiersState>((set, get) => ({
  tiers: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const json = await invoke<string | null>('settings:get', TIER_KEY)
      const tiers: ModelTier[] = json ? safeParse(json) : []
      set({ tiers, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  upsert: async (tier) => {
    const current = get().tiers
    const idx = current.findIndex((t) => t.id === tier.id)
    const next = idx >= 0 ? current.map((t) => (t.id === tier.id ? tier : t)) : [...current, tier]
    await invoke<true>('settings:set', TIER_KEY, JSON.stringify(next))
    set({ tiers: next })
  },

  remove: async (id) => {
    const next = get().tiers.filter((t) => t.id !== id)
    await invoke<true>('settings:set', TIER_KEY, JSON.stringify(next))
    set({ tiers: next })
  },
}))

/** 容错解析：JSON.parse 失败或结构不对返回空数组。 */
function safeParse(json: string): ModelTier[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is ModelTier =>
        t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.providerId === 'string',
    )
  } catch {
    return []
  }
}
