import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { settings } from '../db/schema'
import type { ModelTier } from '../../types'

/**
 * 模型档位数据层（v1.6 M15）。
 *
 * 存 settings KV `router.tiers` 的 JSON 字符串（零迁移，不建表）：
 *   [{"id":"uuid","name":"快型","providerId":"xxx"},...]
 *
 * 设计依据 ADR-022：档位数量少（2-4 个）、字段简单（name+providerId）、
 * 无独立查询需求（每次全量读），用 KV 存 JSON 比建表更轻。
 */

const TIER_KEY = 'router.tiers'

/** 读取全部档位。解析失败返回空数组（容错，不抛）。 */
export function getTiers(): ModelTier[] {
  const row = getDb().select().from(settings).where(eq(settings.key, TIER_KEY)).get()
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    // 过滤无效结构（防御脏数据）
    return parsed.filter(
      (t): t is ModelTier =>
        t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.providerId === 'string',
    )
  } catch {
    return []
  }
}

/** 全量保存档位（覆盖写）。 */
export function saveTiers(tiers: ModelTier[]): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .insert(settings)
    .values({ key: TIER_KEY, value: JSON.stringify(tiers) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(tiers), updatedAt: now },
    })
    .run()
}

/** 按 id 查单个档位。返回 null = 不存在（路由解析时用于判断 requested 是不是档位 id）。 */
export function getTierById(id: string): ModelTier | null {
  return getTiers().find((t) => t.id === id) ?? null
}
