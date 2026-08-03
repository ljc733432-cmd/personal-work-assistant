import { useEffect, useState } from 'react'
import { Plus, Trash2, Bell, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useRemindersStore } from '@/stores/reminders'
import { BackHeader } from './ToolsPage'
import type { Reminder } from '@/types'

/**
 * 提醒列表（M12.5 B 轨）。
 * 双轨制：用户在此手动增删；AI 通过 FC set_reminder（A 轨）写入同一表，
 * 切到本页 refresh 即可看到（共享 reminders 表，PRD §13.1 关键约束）。
 */
export function ReminderSection({ onBack }: { onBack: () => void }) {
  const { reminders, refresh, upsert, remove } = useRemindersStore()
  const [content, setContent] = useState('')
  // datetime-local 默认值：当前时间 + 10 分钟（最常见场景「N 分钟后提醒」）
  const [when, setWhen] = useState(() => defaultWhen())
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = async () => {
    const text = content.trim()
    if (!text || !when) return
    const time = Math.floor(new Date(when).getTime() / 1000)
    if (Number.isNaN(time)) return
    setAdding(true)
    try {
      await upsert({ time, content: text, source: 'manual' })
      setContent('')
      setWhen(defaultWhen())
    } finally {
      setAdding(false)
    }
  }

  // 拆未触发 / 已触发两组
  const pending = reminders.filter((r) => !r.done).sort((a, b) => a.time - b.time)
  const done = reminders.filter((r) => r.done).sort((a, b) => b.time - a.time)

  return (
    <div className="flex h-full flex-col">
      <BackHeader title="提醒" onBack={onBack} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
          {/* 新建 */}
          <div className="space-y-3 border border-border bg-card p-4">
            <div className="space-y-1.5">
              <Label>提醒内容</Label>
              <Input
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="如：站起来活动一下"
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>触发时间</Label>
                <Input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </div>
              <Button onClick={handleAdd} disabled={adding || !content.trim()} className="gap-1.5">
                <Plus size={14} strokeWidth={2} />
                添加
              </Button>
            </div>
          </div>

          {/* 待触发 */}
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              待触发（{pending.length}）
            </div>
            {pending.length === 0 ? (
              <EmptyHint text="暂无待触发提醒。也可在对话里说「10 分钟后提醒我开会」让 AI 帮你设。" />
            ) : (
              pending.map((r) => (
                <ReminderItem key={r.id} reminder={r} onDelete={() => remove(r.id)} />
              ))
            )}
          </div>

          {/* 已触发 */}
          {done.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                已触发（{done.length}）
              </div>
              {done.map((r) => (
                <ReminderItem key={r.id} reminder={r} onDelete={() => remove(r.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReminderItem({ reminder, onDelete }: { reminder: Reminder; onDelete: () => void }) {
  const triggerDate = new Date(reminder.time * 1000)
  const now = Date.now()
  const diffMs = reminder.time * 1000 - now
  const isPast = diffMs <= 0

  return (
    <div
      className={`flex items-start gap-3 border border-border bg-card p-3 ${
        reminder.done ? 'opacity-50' : ''
      }`}
    >
      <div className="mt-0.5 flex-shrink-0 text-muted-foreground">
        {reminder.done ? (
          <CheckCircle2 size={16} strokeWidth={2} />
        ) : (
          <Bell size={16} strokeWidth={2} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${reminder.done ? 'line-through' : ''}`}>{reminder.content}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {triggerDate.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
          {!reminder.done && !isPast && ` · ${relativeCountdown(diffMs)}`}
          {!reminder.done && isPast && ' · 即将触发'}
          {reminder.source === 'from_chat' && ' · 来自对话'}
        </div>
      </div>
      <button
        onClick={onDelete}
        title="删除"
        className="flex-shrink-0 text-muted-foreground transition-colors hover:text-danger"
      >
        <Trash2 size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

/** 默认时间：当前 + 10 分钟，格式化为 datetime-local 接受的 yyyy-MM-ddTHH:mm。 */
function defaultWhen(): string {
  const d = new Date(Date.now() + 10 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}

/** 毫秒差 → 相对倒计时文案（"3 分钟后"/"2 小时后"/"1 天后"）。 */
function relativeCountdown(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min < 1) return '不到 1 分钟后'
  if (min < 60) return `${min} 分钟后`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时后`
  return `${Math.floor(hr / 24)} 天后`
}
