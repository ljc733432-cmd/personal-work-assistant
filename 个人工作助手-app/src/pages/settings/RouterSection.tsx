import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Plus, Trash2 } from '@/components/ui/icons'
import { useProvidersStore } from '@/stores/providers'
import { useTiersStore } from '@/stores/tiers'
import { invoke } from '@/lib/ipc'
import type { ModelTier } from '@/types'

/**
 * 模型档位配置区（v1.6 M15）。
 *
 * 档位 = 用户自定义的语义化快捷分组（如「快型」→glm-flash、「强力」→glm-4.5）。
 * 对话页 select 显示档位名，选中走档位绑定的 provider（比选具体 provider 更直觉）。
 *
 * 数据存 settings KV `router.tiers` JSON（零迁移，见 tiers store）。
 * 设计依据 ADR-022：手动分层（不做自动判定）+ 为未来自动路由预留挂钩。
 */
export function RouterSection() {
  const { providers, refresh: refreshProviders } = useProvidersStore()
  const { tiers, loading, refresh, upsert, remove } = useTiersStore()
  const [newName, setNewName] = useState('')

  useEffect(() => {
    refreshProviders()
    refresh()
  }, [refreshProviders, refresh])

  const enabledProviders = providers.filter((p) => p.enabled)

  const handleAdd = async () => {
    if (!newName.trim() || enabledProviders.length === 0) return
    const tier: ModelTier = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      providerId: enabledProviders[0].id,
    }
    await upsert(tier)
    setNewName('')
  }

  const handleChangeName = async (id: string, name: string) => {
    const t = tiers.find((x) => x.id === id)
    if (!t) return
    await upsert({ ...t, name })
  }

  const handleChangeProvider = async (id: string, providerId: string) => {
    const t = tiers.find((x) => x.id === id)
    if (!t) return
    await upsert({ ...t, providerId })
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">模型档位</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          为模型起语义化别名（如「快型」「强力」），对话页可直接选档位名切换。
          省钱用快型，要质量用强力。档位只是快捷切换，不会自动判定该用哪个。
        </p>
      </div>

      <div className="space-y-3 rounded-md border bg-card p-4">
        {/* 已有档位列表 */}
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : tiers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有档位。在下方添加（如名称填「快型」，选一个便宜模型）。
          </p>
        ) : (
          <div className="space-y-2">
            {tiers.map((t) => {
              const provider = providers.find((p) => p.id === t.providerId)
              return (
                <div key={t.id} className="flex items-center gap-2">
                  <input
                    className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                    value={t.name}
                    onChange={(e) => handleChangeName(t.id, e.target.value)}
                    placeholder="档位名（如 快型）"
                  />
                  <select
                    className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                    value={t.providerId}
                    onChange={(e) => handleChangeProvider(t.id, e.target.value)}
                  >
                    {!provider && <option value="">（模型已删除）</option>}
                    {enabledProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.model}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(t.id)}
                    title="删除档位"
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              )
            })}
          </div>
        )}

        {/* 添加新档位 */}
        <div className="flex items-center gap-2 border-t pt-3">
          <input
            className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="新档位名（如 快型 / 标准 / 强力）"
            disabled={enabledProviders.length === 0}
          />
          <Button onClick={handleAdd} disabled={!newName.trim() || enabledProviders.length === 0}>
            <Plus size={16} />
            <span className="ml-1">添加</span>
          </Button>
        </div>
        {enabledProviders.length === 0 && (
          <p className="text-xs text-warning">请先在上方配置并启用至少一个模型 Provider。</p>
        )}
      </div>
    </div>
  )
}
