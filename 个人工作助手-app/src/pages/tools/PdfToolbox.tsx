import { useState } from 'react'
import { FileText, Plus, Trash2, Loader2, CheckCircle2, AlertCircle } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { invoke } from '@/lib/ipc'
import { BackHeader } from './ToolsPage'
import type { PdfInfo, PdfResult, PdfSplitResult } from '@/types'
import { cn } from '@/lib/utils'

/**
 * PDF 工具箱（v1.7 M16，PRD §15.4⑥）。
 *
 * 三个纯客户端操作（pdf-lib）：合并 / 提取 / 拆分。
 * 路径安全在主进程 pdfToolbox 服务内经 resolveSafePath（白名单/笔记库）。
 *
 * 不做（PRD 砍 v2）：压缩（按钮灰掉标注 v2）、预览（pdfjs worker 坑，后续增强）。
 */

type Mode = 'merge' | 'extract' | 'split'
const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'merge', label: '合并' },
  { value: 'extract', label: '提取' },
  { value: 'split', label: '拆分' },
]

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

export function PdfToolbox({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('merge')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  return (
    <div className="flex h-full flex-col">
      <BackHeader title="PDF 工具箱" onBack={onBack} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
          {/* 模式切换 */}
          <div className="flex justify-center">
            <div className="flex items-center gap-1 rounded-lg bg-surface-3 p-1">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    setMode(opt.value)
                    setStatus({ kind: 'idle' })
                  }}
                  className={cn(
                    'rounded-md px-4 py-1.5 text-xs font-medium transition-colors',
                    mode === opt.value
                      ? 'bg-accent/10 text-accent shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {mode === 'merge' && <MergePanel onStatus={setStatus} status={status} />}
          {mode === 'extract' && <ExtractPanel onStatus={setStatus} status={status} />}
          {mode === 'split' && <SplitPanel onStatus={setStatus} status={status} />}

          {/* 压缩（v2 占位）*/}
          <div className="rounded-md border border-dashed border-border p-4 text-center">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">压缩</span> ——{' '}
              <span className="text-warning">v2 计划</span>（pdf-lib 无真压缩能力，需 Ghostscript WASM）
            </p>
          </div>

          <StatusBlock status={status} />
        </div>
      </div>
    </div>
  )
}

// ---------- 合并面板 ----------
function MergePanel({
  status,
  onStatus,
}: {
  status: Status
  onStatus: (s: Status) => void
}) {
  const [paths, setPaths] = useState<string[]>([])
  const [outputName, setOutputName] = useState('merged')

  const pick = async () => {
    const p = await invoke<string | null>('pdf:pickFile')
    if (p) setPaths((prev) => [...prev, p])
  }
  const remove = (i: number) => setPaths((prev) => prev.filter((_, idx) => idx !== i))

  const run = async () => {
    if (paths.length < 2) {
      onStatus({ kind: 'error', message: '合并至少需要 2 个 PDF' })
      return
    }
    onStatus({ kind: 'working' })
    try {
      // 输出路径：第一个文件同目录 + 用户填的文件名
      const dir = paths[0].split(/[\\/]/).slice(0, -1).join(/[\\/]/.test(paths[0]) ? '\\' : '/')
      const outputPath = `${dir}${/[\\/]/.test(paths[0]) ? '\\' : '/'}${outputName || 'merged'}.pdf`
      const r = await invoke<PdfResult>('pdf:merge', paths, outputPath)
      onStatus({ kind: 'done', message: `已合并 ${paths.length} 个 PDF → ${r.outputPath}` })
    } catch (e) {
      onStatus({ kind: 'error', message: String(e) })
    }
  }

  return (
    <div className="space-y-4 rounded-md border bg-card p-5">
      <div>
        <h3 className="text-sm font-medium">合并多个 PDF</h3>
        <p className="mt-1 text-xs text-muted-foreground">按添加顺序合并成一个文件</p>
      </div>

      <div className="space-y-2">
        {paths.map((p, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
            <FileText size={14} className="flex-shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-xs">{p.split(/[\\/]/).pop()}</span>
            <span className="text-[10px] text-muted-foreground">#{i + 1}</span>
            <button onClick={() => remove(i)} className="text-muted-foreground hover:text-destructive">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={pick} className="w-full justify-center gap-1.5">
          <Plus size={14} /> 添加 PDF
        </Button>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">输出文件名（不含扩展名）</label>
        <input
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={outputName}
          onChange={(e) => setOutputName(e.target.value)}
          placeholder="merged"
        />
        <p className="text-[10px] text-muted-foreground">输出到第一个文件所在目录</p>
      </div>

      <Button onClick={run} disabled={status.kind === 'working' || paths.length < 2} className="w-full">
        {status.kind === 'working' ? <Loader2 size={14} className="animate-spin" /> : null}
        合并 {paths.length > 0 ? `(${paths.length})` : ''}
      </Button>
    </div>
  )
}

// ---------- 提取面板 ----------
function ExtractPanel({
  status,
  onStatus,
}: {
  status: Status
  onStatus: (s: Status) => void
}) {
  const [inputPath, setInputPath] = useState('')
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [pagesInput, setPagesInput] = useState('')
  const [outputName, setOutputName] = useState('extracted')

  const pick = async () => {
    const p = await invoke<string | null>('pdf:pickFile')
    if (!p) return
    setInputPath(p)
    setPageCount(null)
    try {
      const info = await invoke<PdfInfo>('pdf:info', p)
      setPageCount(info.pageCount)
    } catch {
      // 忽略，用户可手动输页码
    }
  }

  const run = async () => {
    if (!inputPath) {
      onStatus({ kind: 'error', message: '请先选择 PDF' })
      return
    }
    onStatus({ kind: 'working' })
    try {
      const dir = inputPath.split(/[\\/]/).slice(0, -1).join(/[\\/]/.test(inputPath) ? '\\' : '/')
      const outputPath = `${dir}${/[\\/]/.test(inputPath) ? '\\' : '/'}${outputName || 'extracted'}.pdf`
      const r = await invoke<PdfResult>('pdf:extract', inputPath, pagesInput, outputPath)
      onStatus({ kind: 'done', message: `已提取 → ${r.outputPath}` })
    } catch (e) {
      onStatus({ kind: 'error', message: String(e) })
    }
  }

  return (
    <div className="space-y-4 rounded-md border bg-card p-5">
      <div>
        <h3 className="text-sm font-medium">提取指定页</h3>
        <p className="mt-1 text-xs text-muted-foreground">从 PDF 中提取部分页面生成新文件</p>
      </div>

      <FilePicker path={inputPath} onPick={pick} />

      {pageCount !== null && (
        <p className="text-xs text-muted-foreground">共 {pageCount} 页</p>
      )}

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">
          页码（如 1,3,5-7，用逗号或横杠）{pageCount !== null && `，范围 1-${pageCount}`}
        </label>
        <input
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={pagesInput}
          onChange={(e) => setPagesInput(e.target.value)}
          placeholder="1,3,5-7"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">输出文件名（不含扩展名）</label>
        <input
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={outputName}
          onChange={(e) => setOutputName(e.target.value)}
          placeholder="extracted"
        />
      </div>

      <Button
        onClick={run}
        disabled={status.kind === 'working' || !inputPath || !pagesInput}
        className="w-full"
      >
        {status.kind === 'working' ? <Loader2 size={14} className="animate-spin" /> : null}
        提取
      </Button>
    </div>
  )
}

// ---------- 拆分面板 ----------
function SplitPanel({
  status,
  onStatus,
}: {
  status: Status
  onStatus: (s: Status) => void
}) {
  const [inputPath, setInputPath] = useState('')
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [perChunk, setPerChunk] = useState(1)

  const pick = async () => {
    const p = await invoke<string | null>('pdf:pickFile')
    if (!p) return
    setInputPath(p)
    setPageCount(null)
    try {
      const info = await invoke<PdfInfo>('pdf:info', p)
      setPageCount(info.pageCount)
    } catch {
      // 忽略
    }
  }

  const run = async () => {
    if (!inputPath) {
      onStatus({ kind: 'error', message: '请先选择 PDF' })
      return
    }
    onStatus({ kind: 'working' })
    try {
      const dir = inputPath.split(/[\\/]/).slice(0, -1).join(/[\\/]/.test(inputPath) ? '\\' : '/')
      const r = await invoke<PdfSplitResult>('pdf:split', inputPath, perChunk, dir)
      onStatus({ kind: 'done', message: `已拆分为 ${r.outputs.length} 份 → ${dir}` })
    } catch (e) {
      onStatus({ kind: 'error', message: String(e) })
    }
  }

  return (
    <div className="space-y-4 rounded-md border bg-card p-5">
      <div>
        <h3 className="text-sm font-medium">拆分 PDF</h3>
        <p className="mt-1 text-xs text-muted-foreground">按每份页数拆分成多个文件</p>
      </div>

      <FilePicker path={inputPath} onPick={pick} />

      {pageCount !== null && (
        <p className="text-xs text-muted-foreground">
          共 {pageCount} 页，每 {perChunk} 页一份 = {Math.ceil(pageCount / perChunk)} 份
        </p>
      )}

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">每份页数</label>
        <input
          type="number"
          min={1}
          max={pageCount ?? 999}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={perChunk}
          onChange={(e) => setPerChunk(Math.max(1, parseInt(e.target.value, 10) || 1))}
        />
        <p className="text-[10px] text-muted-foreground">输出到源文件所在目录，文件名加 _part1/_part2...</p>
      </div>

      <Button
        onClick={run}
        disabled={status.kind === 'working' || !inputPath}
        className="w-full"
      >
        {status.kind === 'working' ? <Loader2 size={14} className="animate-spin" /> : null}
        拆分
      </Button>
    </div>
  )
}

// ---------- 通用子组件 ----------
function FilePicker({ path, onPick }: { path: string; onPick: () => void }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">PDF 文件</label>
      <button
        onClick={onPick}
        className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm hover:border-accent/30"
      >
        <FileText size={14} className="flex-shrink-0 text-muted-foreground" />
        <span className={cn('flex-1 truncate', !path && 'text-muted-foreground')}>
          {path ? path.split(/[\\/]/).pop() : '点击选择 PDF 文件'}
        </span>
      </button>
    </div>
  )
}

function StatusBlock({ status }: { status: Status }) {
  if (status.kind === 'idle' || status.kind === 'working') return null
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md p-3 text-xs',
        status.kind === 'done' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
      )}
    >
      {status.kind === 'done' ? <CheckCircle2 size={14} className="mt-0.5" /> : <AlertCircle size={14} className="mt-0.5" />}
      <span className="break-all">{status.message}</span>
    </div>
  )
}
