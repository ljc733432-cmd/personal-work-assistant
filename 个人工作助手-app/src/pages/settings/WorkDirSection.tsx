import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useWorkDirsStore } from '@/stores/workDirs'
import type { WorkDir, WorkDirInput, WorkDirMode } from '@/types'

export function WorkDirSection() {
  const { workDirs, refresh, upsert, remove, pick } = useWorkDirsStore()

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">常用目录（可选）</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <strong>默认全盘可读</strong>（密钥/系统目录受保护）。一旦在这里添加目录，
          AI 的读取范围就<strong>锁定到这些目录</strong>——不再全盘，只读你指定的。
          留空 = 全盘可读；填了 = 锁定范围。按需选择。
        </p>
      </div>

      {workDirs.length === 0 && (
        <Card className="border-dashed bg-muted/30">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            当前是<strong>全盘可读</strong>模式。添加目录后会锁定到指定范围。
          </CardContent>
        </Card>
      )}

      {workDirs.map((wd) => (
        <WorkDirCard key={wd.id} wd={wd} onSave={upsert} onDelete={() => remove(wd.id)} onPick={pick} />
      ))}

      <AddWorkDirCard onAdd={upsert} onPick={pick} />
    </div>
  )
}

function WorkDirCard({
  wd,
  onSave,
  onDelete,
  onPick,
}: {
  wd: WorkDir
  onSave: (input: WorkDirInput) => void
  onDelete: () => void
  onPick: () => Promise<string | null>
}) {
  const [label, setLabel] = useState(wd.label)
  const [dirPath, setDirPath] = useState(wd.path)
  const [mode, setMode] = useState<WorkDirMode>(wd.mode)
  const [enabled, setEnabled] = useState(wd.enabled)

  const dirty = label !== wd.label || dirPath !== wd.path || mode !== wd.mode || enabled !== wd.enabled

  const pickDir = async () => {
    const p = await onPick()
    if (p) setDirPath(p)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{label || '(未命名)'}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
              mode === 'readwrite'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-blue-100 text-blue-700'
            }`}
          >
            {mode === 'readwrite' ? '读写' : '只读'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>名称</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：我的笔记" />
        </div>
        <div className="space-y-1.5">
          <Label>目录路径</Label>
          <div className="flex gap-2">
            <Input value={dirPath} onChange={(e) => setDirPath(e.target.value)} className="font-mono text-xs" />
            <Button variant="outline" size="sm" onClick={pickDir}>
              浏览
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Label>权限</Label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={mode === 'read'} onChange={() => setMode('read')} />
            只读
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={mode === 'readwrite'} onChange={() => setMode('readwrite')} />
            读写
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            disabled={!dirty}
            onClick={() => onSave({ id: wd.id, label, path: dirPath, mode, enabled })}
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

function AddWorkDirCard({
  onAdd,
  onPick,
}: {
  onAdd: (input: WorkDirInput) => void
  onPick: () => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [mode, setMode] = useState<WorkDirMode>('read')

  if (!open) {
    return (
      <Button variant="outline" className="w-full gap-1.5 border-dashed" onClick={() => setOpen(true)}>
        <Plus size={14} strokeWidth={2} /> 添加工作目录
      </Button>
    )
  }

  const pickDir = async () => {
    const p = await onPick()
    if (p) {
      setDirPath(p)
      if (!label) {
        // 默认用目录名作 label
        const name = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
        setLabel(name)
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">添加工作目录</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>名称</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：我的报告" />
        </div>
        <div className="space-y-1.5">
          <Label>目录路径</Label>
          <div className="flex gap-2">
            <Input value={dirPath} onChange={(e) => setDirPath(e.target.value)} className="font-mono text-xs" placeholder="点浏览选择，或手动填" />
            <Button variant="outline" size="sm" onClick={pickDir}>
              浏览
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Label>权限</Label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={mode === 'read'} onChange={() => setMode('read')} />
            只读
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={mode === 'readwrite'} onChange={() => setMode('readwrite')} />
            读写
          </label>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            disabled={!label || !dirPath}
            onClick={() => {
              onAdd({ label, path: dirPath, mode, enabled: true })
              setOpen(false)
              setLabel('')
              setDirPath('')
              setMode('read')
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
