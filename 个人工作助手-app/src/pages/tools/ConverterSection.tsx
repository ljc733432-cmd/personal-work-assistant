import { useEffect, useState } from 'react'
import { FileText, ArrowRight, Loader2, CheckCircle2, AlertCircle } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { invoke } from '@/lib/ipc'
import { BackHeader } from './ToolsPage'
import type { ConvertResultData, ConvertTarget } from '@/types'
import { cn } from '@/lib/utils'

/**
 * 文档转换器（M12.9 B 轨，PRD §13.2 工具 3）。
 * 选输入文件 → 选目标格式 → 转换。A 轨 FC convert_document 共享同一 converter 服务。
 *
 * 安全：输入路径经 convert:pickFile（dialog 选，天然在用户可访问范围）；
 * converter 服务内部再走 resolveSafePath（白名单/笔记库）兜底校验。
 */
const ALL_TARGETS: { value: ConvertTarget; label: string }[] = [
  { value: 'md', label: 'Markdown' },
  { value: 'txt', label: '纯文本' },
  { value: 'html', label: 'HTML' },
  { value: 'docx', label: 'Word' },
  { value: 'pdf', label: 'PDF' },
]

type Status =
  | { kind: 'idle' }
  | { kind: 'converting' }
  | { kind: 'done'; path: string; bytes: number }
  | { kind: 'error'; message: string }

export function ConverterSection({ onBack }: { onBack: () => void }) {
  const [inputPath, setInputPath] = useState('')
  const [targets, setTargets] = useState<ConvertTarget[]>([])
  const [target, setTarget] = useState<ConvertTarget | ''>('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  // 输入文件扩展名变化 → 查支持的目标格式
  useEffect(() => {
    const ext = inputPath.split('.').pop() ?? ''
    if (!ext) {
      setTargets([])
      setTarget('')
      return
    }
    invoke<ConvertTarget[]>('convert:targets', ext)
      .then((list) => {
        setTargets(list)
        // 默认选第一个
        setTarget(list[0] ?? '')
      })
      .catch(() => {
        setTargets([])
        setTarget('')
      })
  }, [inputPath])

  const handlePick = async () => {
    try {
      const picked = await invoke<string | null>('convert:pickFile')
      if (picked) {
        setInputPath(picked)
        setStatus({ kind: 'idle' })
      }
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) })
    }
  }

  const handleConvert = async () => {
    if (!inputPath || !target) return
    setStatus({ kind: 'converting' })
    try {
      const result = await invoke<ConvertResultData>('convert:run', { inputPath, targetFormat: target })
      if (result.ok) {
        setStatus({ kind: 'done', path: result.outputPath, bytes: result.bytes })
      } else {
        setStatus({ kind: 'error', message: result.error ?? '转换失败' })
      }
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) })
    }
  }

  const fileName = inputPath ? inputPath.split(/[\\/]/).pop() : ''

  return (
    <div className="flex h-full flex-col">
      <BackHeader title="文档转换" onBack={onBack} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
          {/* 步骤 1：选文件 */}
          <div className="space-y-2 border border-border bg-card p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">第 1 步 · 选择文件</div>
            {inputPath ? (
              <div className="flex items-center gap-2">
                <FileText size={16} className="flex-shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{fileName}</div>
                  <div className="truncate text-xs text-muted-foreground">{inputPath}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={handlePick}>
                  更换
                </Button>
              </div>
            ) : (
              <Button variant="outline" onClick={handlePick} className="w-full gap-1.5 border-dashed">
                <FileText size={14} />
                选择要转换的文件（md / txt / docx）
              </Button>
            )}
          </div>

          {/* 步骤 2：选目标格式 */}
          {inputPath && (
            <div className="space-y-2 border border-border bg-card p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                第 2 步 · 选择目标格式
              </div>
              {targets.length === 0 ? (
                <div className="text-sm text-warning">此文件格式不支持转换（支持 md / txt / docx 输入）</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {ALL_TARGETS.filter((t) => targets.includes(t.value)).map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setTarget(t.value)}
                      className={cn(
                        'border px-3 py-1.5 text-sm transition-colors',
                        target === t.value
                          ? 'border-accent bg-accent/5 text-accent'
                          : 'border-border text-muted-foreground hover:bg-accent/5',
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 步骤 3：转换 */}
          {inputPath && target && (
            <div className="space-y-2 border border-border bg-card p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">第 3 步 · 执行</div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="truncate">{fileName}</span>
                <ArrowRight size={14} />
                <span className="font-medium text-foreground">{target.toUpperCase()}</span>
              </div>
              <Button onClick={handleConvert} disabled={status.kind === 'converting'} className="gap-1.5">
                {status.kind === 'converting' ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    转换中…
                  </>
                ) : (
                  '开始转换'
                )}
              </Button>

              {/* 输出位置说明 */}
              <p className="text-xs text-muted-foreground">
                输出到输入文件同目录，扩展名换为 .{target}（如已存在会覆盖）。
              </p>
            </div>
          )}

          {/* 结果反馈 */}
          {status.kind === 'done' && (
            <div className="flex items-start gap-2 border border-success/40 bg-success/5 p-3">
              <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-success">转换成功</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{status.path}</div>
                <div className="text-xs text-muted-foreground">{(status.bytes / 1024).toFixed(1)} KB</div>
              </div>
            </div>
          )}
          {status.kind === 'error' && (
            <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 p-3">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-danger">转换失败</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{status.message}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
