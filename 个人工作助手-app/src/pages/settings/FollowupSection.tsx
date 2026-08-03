import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { useProvidersStore } from '@/stores/providers'
import { invoke } from '@/lib/ipc'

/**
 * 跟进配置区（M6）。
 *
 * 三个 KV 配置（存 settings 表，value 是字符串）：
 *  - followup.providerId：跟进用哪个 Provider（独立于抽取模型）
 *  - followup.cron：定时表达式（默认 '0 9,14 * * *' = 每天 9:00 和 14:00）
 *  - followup.paused："true"/"false" 暂停开关
 *
 * 注意：cron 改了要重启应用生效（调度器在 app.whenReady 时启动一次）。
 */
export function FollowupSection() {
  const { providers, refresh } = useProvidersStore()
  const [followupProviderId, setFollowupProviderId] = useState<string>('')
  const [cron, setCron] = useState('0 9,14 * * *')
  const [paused, setPaused] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    refresh()
    ;(async () => {
      try {
        const p = await invoke<string | null>('settings:get', 'followup.providerId')
        const c = await invoke<string | null>('settings:get', 'followup.cron')
        const pa = await invoke<string | null>('settings:get', 'followup.paused')
        setFollowupProviderId(p ?? '')
        setCron(c ?? '0 9,14 * * *')
        setPaused(pa === 'true')
      } finally {
        setLoading(false)
      }
    })()
  }, [refresh])

  const enabledProviders = providers.filter((p) => p.enabled)

  const changeProvider = async (id: string) => {
    setFollowupProviderId(id)
    await invoke<true>('settings:set', 'followup.providerId', id)
  }

  const changeCron = async (val: string) => {
    setCron(val)
    await invoke<true>('settings:set', 'followup.cron', val)
  }

  const togglePaused = async (next: boolean) => {
    setPaused(next)
    await invoke<true>('settings:set', 'followup.paused', String(next))
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">定时跟进</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          应用常驻系统托盘。到点自动检查待办任务，有候选则 AI 主动发起跟进会话并弹通知。
          建议用便宜的模型（如智谱 Flash 档）做跟进。
        </p>
      </div>

      <div className="space-y-3 rounded-md border bg-card p-4">
        <div className="space-y-1.5">
          <Label>跟进模型</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={followupProviderId}
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
        </div>

        <div className="space-y-1.5">
          <Label>定时表达式（cron）</Label>
          <Input
            value={cron}
            onChange={(e) => changeCron(e.target.value)}
            placeholder="0 9,14 * * *"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            格式：分 时 日 月 周。默认「0 9,14 * * *」= 每天 9:00 和 14:00。改了需重启应用生效。
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={paused}
            onChange={(e) => togglePaused(e.target.checked)}
            disabled={loading}
          />
          <span>暂停定时跟进</span>
          <span className="text-xs text-muted-foreground">
            （暂停后托盘菜单可手动「立即检查」）
          </span>
        </label>
      </div>
    </div>
  )
}
