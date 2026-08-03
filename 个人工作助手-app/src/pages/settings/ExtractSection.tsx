import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { useProvidersStore } from '@/stores/providers'
import { invoke } from '@/lib/ipc'

/**
 * 任务抽取配置区（M4）。
 *
 * 两个 KV 配置（存 settings 表，value 是字符串）：
 *  - extract.enabled："true"/"false" —— 自动抽取开关（默认关）
 *  - extract.providerId：抽取用哪个 Provider（用「最便宜的模型」省成本）
 *
 * 手动抽取（✨ 按钮）恒可用，不依赖这里的开关。
 */
export function ExtractSection() {
  const { providers, refresh } = useProvidersStore()
  const [autoExtract, setAutoExtract] = useState(false)
  const [extractProviderId, setExtractProviderId] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    refresh()
    ;(async () => {
      try {
        const enabledVal = await invoke<string | null>('settings:get', 'extract.enabled')
        setAutoExtract(enabledVal === 'true')
        const providerVal = await invoke<string | null>('settings:get', 'extract.providerId')
        setExtractProviderId(providerVal ?? '')
      } finally {
        setLoading(false)
      }
    })()
  }, [refresh])

  const enabledProviders = providers.filter((p) => p.enabled)

  const toggleAutoExtract = async (next: boolean) => {
    setAutoExtract(next)
    await invoke<true>('settings:set', 'extract.enabled', String(next))
  }

  const changeProvider = async (id: string) => {
    setExtractProviderId(id)
    await invoke<true>('settings:set', 'extract.providerId', id)
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">任务抽取</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          AI 从对话中识别待办任务。抽取只产草稿，需你确认「加入任务」才入库。
          建议用最便宜的模型（如智谱 Flash 档）做抽取，省成本。
        </p>
      </div>

      <div className="space-y-3 rounded-md border bg-card p-4">
        <div className="space-y-1.5">
          <Label>抽取模型</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={extractProviderId}
            onChange={(e) => changeProvider(e.target.value)}
            disabled={loading}
          >
            <option value="">{loading ? '加载中…' : '未选择'}</option>
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.model}
              </option>
            ))}
          </select>
          {enabledProviders.length === 0 && !loading && (
            <p className="text-xs text-muted-foreground">请先在上方配置并启用一个模型 Provider。</p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoExtract}
            onChange={(e) => toggleAutoExtract(e.target.checked)}
            disabled={loading || !extractProviderId}
          />
          <span>自动抽取</span>
          <span className="text-xs text-muted-foreground">
            （开：每轮对话结束后自动抽取草稿；关：仅手动点「抽取任务」按钮）
          </span>
        </label>
        {autoExtract && !extractProviderId && (
          <p className="text-xs text-warning">开启自动抽取需先选择抽取模型。</p>
        )}
      </div>
    </div>
  )
}
