import { useEffect, useState, useCallback, useRef } from 'react'
import {
  ClipboardText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
} from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { invoke } from '@/lib/ipc'
import { BackHeader } from './ToolsPage'
import { useNotesStore } from '@/stores/notes'
import { useNavigate } from '@/pages/overview/nav'
import type { ReportResult, ReportPreviewResult, ReportRange } from '@/types'
import { cn } from '@/lib/utils'

/**
 * AI 日报/周报工具页（v1.8 M17，PRD §15.3④ + v1.8.1 打磨）。
 *
 * 照搬 PdfToolbox 骨架（mode 切换 + Status 判别联合）。
 * 生成走非流式（report:generate IPC，主进程聚合数据 + 调模型 + 写笔记库）。
 *
 * v1.8.1 打磨：
 *  - 生成后刷新历史列表（修 bug：原 run 成功后 notes 不更新）
 *  - 实时数据清单（report:preview IPC，模式/日期切换自动拉计数）
 *  - 日期范围自选（custom 模式 + 两个 date input）
 *  - 生成中可取消（reqId + report:cancel IPC + AbortController）
 */

type Mode = ReportRange // 'daily' | 'weekly' | 'custom'
const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'daily', label: '日报' },
  { value: 'weekly', label: '周报' },
  { value: 'custom', label: '自定义' },
]

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; reqId: string }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

export function ReportToolbox({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('daily')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const // 自定义日期（YYYY-MM-DD，date input 原生格式）
    [customFrom, setCustomFrom] = useState(() => todayStr()),
    [customTo, setCustomTo] = useState(() => todayStr())
  const [preview, setPreview] = useState<ReportPreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const { notes, refresh } = useNotesStore()
  const goto = useNavigate()
  const reqIdRef = useRef(0)

  // 模式对应的 generate 入参（custom 模式把日期字符串转 Unix 秒）
  const buildParams = useCallback(() => {
    if (mode === 'custom') {
      return {
        range: 'custom' as const,
        fromSec: strToSec(customFrom, true),
        toSec: strToSec(customTo, false),
      }
    }
    return { range: mode }
  }, [mode, customFrom, customTo])

  // 预览：模式或自定义日期变化时拉计数（防抖 300ms，避免快速切模式连发）
  useEffect(() => {
    setPreviewLoading(true)
    const timer = setTimeout(async () => {
      try {
        const p = await invoke<ReportPreviewResult>('report:preview', buildParams())
        setPreview(p)
      } catch (e) {
        // 预览失败不阻塞（生成时会再报错），静默清空
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [buildParams])

  // 历史报告：日报 tag 含 daily+custom，周报 tag 含 weekly
  const tag = mode === 'weekly' ? '周报' : '日报'
  const history = notes
    .filter((n) => n.tags.includes(tag))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)

  const openNotes = () => goto('notes')

  const run = async () => {
    // 生成前校验 custom 日期（preview 可能因防抖还没回来，这里再兜底）
    if (mode === 'custom') {
      const from = strToSec(customFrom, true)
      const to = strToSec(customTo, false)
      if (from > to) {
        setStatus({ kind: 'error', message: '起始日期不能晚于结束日期' })
        return
      }
    }
    const reqId = `report-${Date.now()}-${++reqIdRef.current}`
    setStatus({ kind: 'working', reqId })
    try {
      const r = await invoke<ReportResult>('report:generate', { ...buildParams(), reqId })
      setStatus({
        kind: 'done',
        message: `已生成报告笔记：${r.note.title}`,
      })
      await refresh() // v1.8.1 打磨：生成后刷新历史列表
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) })
    }
  }

  const cancel = async () => {
    if (status.kind !== 'working') return
    try {
      await invoke<true>('report:cancel', status.reqId)
    } catch {
      // 忽略：取消失败就让请求自然完成
    }
    setStatus({ kind: 'idle' })
  }

  return (
    <div className="flex h-full flex-col">
      <BackHeader title="AI 日报/周报" onBack={onBack} />
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

          {/* 自定义日期选择（仅 custom 模式显示）*/}
          {mode === 'custom' && (
            <div className="flex items-center justify-center gap-2 text-xs">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => {
                  setCustomFrom(e.target.value)
                  setStatus({ kind: 'idle' })
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
              <span className="text-muted-foreground">至</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => {
                  setCustomTo(e.target.value)
                  setStatus({ kind: 'idle' })
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </div>
          )}

          {/* 数据清单（v1.8.1：实时计数，PRD §15.8 精确意图）*/}
          <DataPreview preview={preview} loading={previewLoading} />

          {/* 生成按钮 + 取消按钮 */}
          <div className="flex gap-2">
            {status.kind === 'working' ? (
              <Button variant="outline" onClick={cancel} className="flex-1">
                取消生成
              </Button>
            ) : (
              <Button
                onClick={run}
                disabled={preview?.empty === true}
                className="flex-1"
              >
                {mode === 'daily' ? '生成日报' : mode === 'weekly' ? '生成周报' : '生成报告'}
              </Button>
            )}
            {status.kind === 'done' && (
              <Button variant="outline" onClick={openNotes}>
                打开笔记
              </Button>
            )}
          </div>

          {/* 历史报告 */}
          <div className="space-y-3 rounded-md border bg-card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">历史{tag}</h3>
              <button
                onClick={openNotes}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                查看全部 <ArrowRight size={12} />
              </button>
            </div>
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无历史{tag}，生成后会显示在这里。</p>
            ) : (
              <ul className="space-y-1.5">
                {history.map((n) => (
                  <li
                    key={n.id}
                    className="flex items-center gap-2 rounded-md border bg-background px-3 py-2"
                  >
                    <ClipboardText size={14} className="flex-shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-xs">{n.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(n.updatedAt * 1000).toLocaleDateString('zh-CN')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <StatusBlock status={status} />
        </div>
      </div>
    </div>
  )
}

// ---------- 数据清单（v1.8.1 实时计数）----------
function DataPreview({
  preview,
  loading,
}: {
  preview: ReportPreviewResult | null
  loading: boolean
}) {
  return (
    <div className="rounded-md bg-background p-3 text-xs text-muted-foreground">
      <div className="flex items-center justify-between">
        <p className="font-medium text-foreground">将基于以下数据</p>
        {preview && (
          <span className="text-[10px] text-muted-foreground">{preview.rangeLabel}</span>
        )}
      </div>
      {loading || !preview ? (
        <p className="mt-1.5">加载中…</p>
      ) : preview.empty ? (
        <p className="mt-1.5 text-warning">所选范围内暂无工作数据，无法生成报告。</p>
      ) : (
        <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
          <li>• 任务：{preview.taskCount} 个</li>
          <li>• 对话：{preview.messageCount} 条</li>
          <li>• 专注：{preview.pomoMinutes} 分钟（{preview.pomoCount} 次）</li>
          <li>• 提醒：{preview.reminderCount} 条</li>
        </ul>
      )}
      <p className="mt-1.5 text-[10px]">
        建议先在设置页「报告模型」选择一个便宜的模型。
      </p>
    </div>
  )
}

// ---------- 状态反馈（照搬 PdfToolbox）----------
function StatusBlock({ status }: { status: Status }) {
  if (status.kind === 'idle' || status.kind === 'working') return null
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md p-3 text-xs',
        status.kind === 'done' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
      )}
    >
      {status.kind === 'done' ? (
        <CheckCircle2 size={14} className="mt-0.5" />
      ) : (
        <AlertCircle size={14} className="mt-0.5" />
      )}
      <span className="break-all">{status.message}</span>
    </div>
  )
}

// ---------- 日期工具 ----------
/** 今天日期字符串（YYYY-MM-DD，date input 原生格式）。 */
function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** YYYY-MM-DD → Unix 秒。
 *  startOfDay=true 返回当日 0:00:00；false 返回当日 23:59:59（闭区间尾）。 */
function strToSec(str: string, startOfDay: boolean): number {
  // new Date('YYYY-MM-DD') 解析为 UTC 0:00，需手动加本地时区偏移
  const [y, m, d] = str.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (!startOfDay) date.setHours(23, 59, 59, 999)
  else date.setHours(0, 0, 0, 0)
  return Math.floor(date.getTime() / 1000)
}
