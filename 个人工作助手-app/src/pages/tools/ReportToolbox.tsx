import { useEffect, useState } from 'react'
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
import type { ReportResult } from '@/types'
import { cn } from '@/lib/utils'

/**
 * AI 日报/周报工具页（v1.8 M17，PRD §15.3④）。
 *
 * 照搬 PdfToolbox 骨架（mode 切换 + Status 判别联合）。
 * 生成走非流式（report:generate IPC，主进程聚合数据 + 调模型 + 写笔记库）。
 *
 * PRD §15.8 风险对策：生成前先展示「将基于以下数据」清单，让用户确认范围合理。
 * 报告存为笔记（tag=日报/周报），历史报告用 notes store 过滤 tag 倒序列最近 5 条。
 */

type Mode = 'daily' | 'weekly'
const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'daily', label: '日报' },
  { value: 'weekly', label: '周报' },
]

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

export function ReportToolbox({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('daily')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const { notes, refresh } = useNotesStore()
  const goto = useNavigate()

  useEffect(() => {
    refresh()
  }, [refresh])

  // 历史报告：按当前 mode 的 tag 过滤，倒序取最近 5 条
  const tag = mode === 'daily' ? '日报' : '周报'
  const history = notes
    .filter((n) => n.tags.includes(tag))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)

  const openNotes = () => goto('notes')

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

          <GeneratePanel mode={mode} status={status} onStatus={setStatus} onOpenNotes={openNotes} />

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
                  <li key={n.id} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
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

// ---------- 生成面板 ----------
function GeneratePanel({
  mode,
  status,
  onStatus,
  onOpenNotes,
}: {
  mode: Mode
  status: Status
  onStatus: (s: Status) => void
  onOpenNotes: () => void
}) {
  const rangeLabel = mode === 'daily' ? '今日' : '本周（周一到今天）'

  const run = async () => {
    onStatus({ kind: 'working' })
    try {
      const r = await invoke<ReportResult>('report:generate', { range: mode })
      onStatus({
        kind: 'done',
        message: `已生成${mode === 'daily' ? '日报' : '周报'}笔记：${r.note.title}`,
      })
    } catch (e) {
      onStatus({ kind: 'error', message: String(e) })
    }
  }

  return (
    <div className="space-y-4 rounded-md border bg-card p-5">
      <div>
        <h3 className="text-sm font-medium">生成{mode === 'daily' ? '日报' : '周报'}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          汇总{rangeLabel}的完成任务、对话、番茄钟、提醒，AI 生成 Markdown 报告并存入笔记库。
        </p>
      </div>

      {/* 数据清单（PRD §15.8：生成前告知用户基于哪些数据）*/}
      <div className="rounded-md bg-background p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">将基于以下数据：</p>
        <ul className="mt-1.5 space-y-0.5">
          <li>• {rangeLabel}标记完成的任务（按完成时间）</li>
          <li>• {rangeLabel}的对话记录（最多 50 条，每条截取前 200 字）</li>
          <li>• {rangeLabel}的番茄钟专注记录</li>
          <li>• {rangeLabel}触发的提醒</li>
        </ul>
        <p className="mt-1.5 text-[10px]">
          若全部为空将提示无法生成（避免浪费 API）。建议先在设置页「报告模型」选择一个便宜的模型。
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={run}
          disabled={status.kind === 'working'}
          className="flex-1"
        >
          {status.kind === 'working' ? <Loader2 size={14} className="animate-spin" /> : null}
          生成{mode === 'daily' ? '日报' : '周报'}
        </Button>
        {status.kind === 'done' && (
          <Button variant="outline" onClick={onOpenNotes}>
            打开笔记
          </Button>
        )}
      </div>
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
