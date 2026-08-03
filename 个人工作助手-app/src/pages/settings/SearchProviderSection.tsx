import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useSearchProvidersStore } from '@/stores/searchProviders'
import type { SearchProvider, SearchProviderInput, SearchProviderType } from '@/types'

// 当前支持的搜索 provider 显示名（本轮只 Tavily，Bing 规划中——见 ADR-002）
const TYPE_LABEL: Record<SearchProviderType, string> = {
  tavily: 'Tavily',
}

export function SearchProviderSection() {
  const { searchProviders, refresh, upsert, remove, test } = useSearchProvidersStore()
  const [testing, setTesting] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; msg: string }>>({})

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleTest = async (id: string) => {
    setTesting(id)
    setTestMsg((s) => ({ ...s, [id]: { ok: false, msg: '测试中…' } }))
    try {
      const msg = await test(id)
      setTestMsg((s) => ({ ...s, [id]: { ok: true, msg } }))
    } catch (e) {
      setTestMsg((s) => ({ ...s, [id]: { ok: false, msg: String(e) } }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">联网搜索</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          配置后，AI 在对话中可调 <code className="rounded bg-muted px-1 py-0.5 text-xs">web_search</code>{' '}
          查最新信息，并把来源链接标注进回答。API Key 经 safeStorage 加密保存，不明文落库。
          当前支持 <strong>Tavily</strong>（Bing 规划中）。
        </p>
      </div>

      {searchProviders.length === 0 && (
        <Card className="border-dashed bg-muted/30">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            未配置联网搜索。AI 调 web_search 时会返回降级提示。在下方添加一个启用。
          </CardContent>
        </Card>
      )}

      {searchProviders.map((sp) => (
        <SearchProviderCard
          key={sp.id}
          sp={sp}
          testing={testing === sp.id}
          testResult={testMsg[sp.id]}
          onTest={() => handleTest(sp.id)}
          onSave={(input) => upsert(input)}
          onDelete={() => remove(sp.id)}
        />
      ))}

      <AddSearchProviderCard onAdd={(input) => upsert(input)} />
    </div>
  )
}

// ---------- 单个搜索 Provider 卡片 ----------
function SearchProviderCard({
  sp,
  testing,
  testResult,
  onTest,
  onSave,
  onDelete,
}: {
  sp: SearchProvider
  testing: boolean
  testResult?: { ok: boolean; msg: string }
  onTest: () => void
  onSave: (input: SearchProviderInput) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(sp.name)
  const [apiKey, setApiKey] = useState('') // 编辑时不回显，留空表示不改
  const [enabled, setEnabled] = useState(sp.enabled)

  const dirty = name !== sp.name || apiKey !== '' || enabled !== sp.enabled

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{name || '(未命名)'}</span>
          <span className="text-xs font-normal uppercase tracking-wider text-muted-foreground">
            {TYPE_LABEL[sp.type]}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>API Key（留空表示不修改）</Label>
          <Input
            type="password"
            value={apiKey}
            placeholder={sp.apiKeyRef ? '••••（已加密保存）' : 'tvly-...'}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>

        {testResult && (
          <div
            className={`rounded-md px-3 py-2 text-sm ${
              testResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}
          >
            {testResult.msg}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={onTest} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          <Button
            size="sm"
            onClick={() => onSave({ id: sp.id, name, type: sp.type, apiKey: apiKey || undefined, enabled })}
            disabled={!dirty}
          >
            保存
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
            删除
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------- 添加搜索 Provider ----------
function AddSearchProviderCard({ onAdd }: { onAdd: (input: SearchProviderInput) => void }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<SearchProviderType>('tavily')
  const [name, setName] = useState('Tavily')
  const [apiKey, setApiKey] = useState('')

  const switchType = (t: SearchProviderType) => {
    setType(t)
    setName(TYPE_LABEL[t])
  }

  if (!open) {
    return (
      <Button variant="outline" className="w-full border-dashed" onClick={() => setOpen(true)}>
        + 添加搜索 Provider
      </Button>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">添加搜索 Provider</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>类型</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={type}
            onChange={(e) => switchType(e.target.value as SearchProviderType)}
          >
            <option value="tavily">Tavily</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>API Key</Label>
          <Input
            type="password"
            value={apiKey}
            placeholder="tvly-..."
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            disabled={!apiKey}
            onClick={() => {
              onAdd({ type, name, apiKey, enabled: true })
              setOpen(false)
              setApiKey('')
            }}
          >
            添加
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
