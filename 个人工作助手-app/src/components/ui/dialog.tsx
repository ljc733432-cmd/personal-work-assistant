import * as React from 'react'
import { Button } from './button'
import { cn } from '@/lib/utils'

/** 极简模态框（确认弹窗用）。 */
export function ConfirmDialog({
  open,
  title,
  prompt,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title?: string
  prompt: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className={cn(
          'mx-4 w-full max-w-md rounded-lg border bg-card p-5 shadow-lg',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="mb-2 text-base font-semibold">{title}</div>}
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{prompt}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button size="sm" onClick={onConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}
