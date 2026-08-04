import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { useProvidersStore } from '@/stores/providers'
import { invoke } from '@/lib/ipc'

/**
 * 报告模型配置区（v1.8 M17，PRD §15.3④）。
 *
 * 一个 KV 配置（存 settings 表，value 是字符串）：
 *  - report.providerId：生成日报/周报用哪个 Provider
 *
 * 照抄 ExtractSection 范式（单选 + settings:get/set）。
 * 建议用便宜模型——报告是聚合 + 文案润色，不需强推理。
 */
export function ReportSection() {
  const { providers, refresh } = useProvidersStore()
  const [reportProviderId, setReportProviderId] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    refresh()
    ;(async () => {
      try {
        const val = await invoke<string | null>('settings:get', 'report.providerId')
        setReportProviderId(val ?? '')
      } finally {
        setLoading(false)
      }
    })()
  }, [refresh])

  const enabledProviders = providers.filter((p) => p.enabled)

  const changeProvider = async (id: string) => {
    setReportProviderId(id)
    await invoke<true>('settings:set', 'report.providerId', id)
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">报告模型</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          AI 日报/周报生成用的模型。报告是基于已有数据的聚合 + 文案润色，不需强推理，
          建议选便宜的模型（如智谱 Flash 档）省成本。
        </p>
      </div>

      <div className="space-y-3 rounded-md border bg-card p-4">
        <div className="space-y-1.5">
          <Label>报告模型</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={reportProviderId}
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
      </div>
    </div>
  )
}
