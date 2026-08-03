import { useEffect, useState } from 'react'
import { Plus } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useProvidersStore } from '@/stores/providers'
import { invoke } from '@/lib/ipc'
import type { Provider, ProviderInput, ProviderType } from '@/types'
import { WorkDirSection } from './WorkDirSection'
import { SearchProviderSection } from './SearchProviderSection'
import { ExtractSection } from './ExtractSection'
import { FollowupSection } from './FollowupSection'
import { RouterSection } from './RouterSection'
import { AppearanceSection } from './AppearanceSection'
import { NotesSection } from './NotesSection'

const PRESETS: Record<ProviderType, { baseURL: string; model: string }> = {
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
  custom: { baseURL: '', model: '' },
}

export function SettingsPage() {
  const { providers, refresh, upsert, remove } = useProvidersStore()
  const [testing, setTesting] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; msg: string }>>({})

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleTest = async (id: string) => {
    setTesting(id)
    setTestMsg((s) => ({ ...s, [id]: { ok: false, msg: '测试中…' } }))
    try {
      const msg = await invoke<string>('provider:test', id)
      setTestMsg((s) => ({ ...s, [id]: { ok: true, msg } }))
    } catch (e) {
      setTestMsg((s) => ({ ...s, [id]: { ok: false, msg: String(e) } }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold">设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            配置模型 Provider。API Key 经操作系统级 safeStorage 加密保存，不明文落库。
          </p>
        </div>

      {providers.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            还没有配置任何模型。在下方添加一个开始对话。
          </CardContent>
        </Card>
      )}

      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          testing={testing === p.id}
          testResult={testMsg[p.id]}
          onTest={() => handleTest(p.id)}
          onSave={(input) => upsert(input)}
          onDelete={() => remove(p.id)}
        />
      ))}

      <AddProviderCard onAdd={(input) => upsert(input)} />

        <div className="!mt-10 border-t pt-2">
          <AppearanceSection />
        </div>

        <div className="!mt-10 border-t pt-2">
          <NotesSection />
        </div>

        <div className="!mt-10 border-t pt-2">
          <WorkDirSection />
        </div>

        <div className="!mt-10 border-t pt-2">
          <SearchProviderSection />
        </div>

        <div className="!mt-10 border-t pt-2">
          <RouterSection />
        </div>

        <div className="!mt-10 border-t pt-2">
          <ExtractSection />
        </div>

        <div className="!mt-10 border-t pt-2">
          <FollowupSection />
        </div>
      </div>
    </div>
  )
}

// ---------- 单个 Provider 卡片 ----------
function ProviderCard({
  provider,
  testing,
  testResult,
  onTest,
  onSave,
  onDelete,
}: {
  provider: Provider
  testing: boolean
  testResult?: { ok: boolean; msg: string }
  onTest: () => void
  onSave: (input: ProviderInput) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(provider.name)
  const [baseURL, setBaseURL] = useState(provider.baseURL)
  const [model, setModel] = useState(provider.model)
  const [apiKey, setApiKey] = useState('') // 编辑时不回显，留空表示不改
  const [enabled, setEnabled] = useState(provider.enabled)

  const dirty =
    name !== provider.name ||
    baseURL !== provider.baseURL ||
    model !== provider.model ||
    apiKey !== '' ||
    enabled !== provider.enabled

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{name || '(未命名)'}</span>
          <span className="text-xs font-normal uppercase tracking-wider text-muted-foreground">
            {provider.type}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="模型 ID">
            <Input value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
        </div>
        <Field label="Base URL">
          <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        </Field>
        <Field label="API Key（留空表示不修改）">
          <Input
            type="password"
            value={apiKey}
            placeholder={provider.apiKeyRef ? '••••（已加密保存）' : 'sk-...'}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用
        </label>

        {testResult && (
          <div
            className={`rounded-md px-3 py-2 text-sm ${
              testResult.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
            }`}
          >
            {testResult.msg}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button size="sm" variant="outline" onClick={onTest} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onSave({ id: provider.id, name, type: provider.type, baseURL, model, apiKey: apiKey || undefined, enabled })
            }
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

// ---------- 添加 Provider ----------
function AddProviderCard({ onAdd }: { onAdd: (input: ProviderInput) => void }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ProviderType>('deepseek')
  const [name, setName] = useState('DeepSeek')
  const [baseURL, setBaseURL] = useState(PRESETS.deepseek.baseURL)
  const [model, setModel] = useState(PRESETS.deepseek.model)
  const [apiKey, setApiKey] = useState('')

  if (!open) {
    return (
      <Button variant="outline" className="w-full gap-1.5 border-dashed" onClick={() => setOpen(true)}>
        <Plus size={14} /> 添加模型 Provider
      </Button>
    )
  }

  const switchType = (t: ProviderType) => {
    setType(t)
    setBaseURL(PRESETS[t].baseURL)
    setModel(PRESETS[t].model)
    setName(t === 'deepseek' ? 'DeepSeek' : t === 'zhipu' ? '智谱 GLM' : '自定义')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>添加 Provider</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="类型">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={type}
            onChange={(e) => switchType(e.target.value as ProviderType)}
          >
            <option value="deepseek">DeepSeek</option>
            <option value="zhipu">智谱 GLM</option>
            <option value="custom">自定义（OpenAI 兼容）</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="模型 ID">
            <Input value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
        </div>
        <Field label="Base URL">
          <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        </Field>
        <Field label="API Key">
          <Input type="password" value={apiKey} placeholder="sk-..." onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2 pt-2">
          <Button
            onClick={() => {
              onAdd({ type, name, baseURL, model, apiKey, enabled: true })
              setOpen(false)
              setApiKey('')
            }}
            disabled={!apiKey || !baseURL}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
