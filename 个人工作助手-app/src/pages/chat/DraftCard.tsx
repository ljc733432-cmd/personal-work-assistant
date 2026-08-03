import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TaskDraft, TaskPriority } from '@/types'

/**
 * 任务草稿卡片（M4）。
 * 与 TasksPage 的任务卡片视觉对齐，但：
 *  - amber 边框区分草稿态（未入库）
 *  - 标题/描述/优先级可编辑（草稿要能改）
 *  - "加入任务"（入库）/"忽略"（丢弃）两按钮
 */

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

export function DraftCard({
  draft,
  index,
  onUpdate,
  onAccept,
  onDismiss,
}: {
  draft: TaskDraft
  index: number
  onUpdate: (patch: Partial<TaskDraft>) => void
  onAccept: () => void
  onDismiss: () => void
}) {
  return (
    <Card className="border-amber-300 bg-amber-50/40">
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-700">
          <span>草稿</span>
        </div>
        <Input
          value={draft.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          placeholder="任务标题"
          className="h-8 text-sm font-medium"
        />
        {draft.description && (
          <Input
            value={draft.description}
            onChange={(e) => onUpdate({ description: e.target.value || null })}
            placeholder="补充说明（可选）"
            className="h-7 text-xs text-muted-foreground"
          />
        )}
        <div className="flex items-center gap-2">
          <select
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            value={draft.priority}
            onChange={(e) => onUpdate({ priority: e.target.value as TaskPriority })}
          >
            {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          {draft.dueDate && (
            <span className="text-xs text-muted-foreground">
              截止 {new Date(draft.dueDate * 1000).toLocaleDateString('zh-CN')}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={onDismiss} className="h-7 text-xs">
              忽略
            </Button>
            <Button
              size="sm"
              onClick={onAccept}
              disabled={!draft.title.trim()}
              className="h-7 text-xs"
            >
              加入任务
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
