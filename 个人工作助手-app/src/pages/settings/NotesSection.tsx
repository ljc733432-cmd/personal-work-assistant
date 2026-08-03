import { useEffect, useState } from 'react'
import { FolderOpen } from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { invoke } from '@/lib/ipc'

/**
 * 笔记库目录配置区（M12.8 设置页分区）。
 * PRD §13.2：笔记根目录可改（默认 userData/notes/），自动入文件白名单。
 */
export function NotesSection() {
  const [dir, setDir] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const d = await invoke<string>('note:getDir')
        setDir(d)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const handlePick = async () => {
    try {
      const picked = await invoke<string | null>('workdir:pick')
      if (!picked) return
      const saved = await invoke<string>('note:setDir', picked)
      setDir(saved)
    } catch (e) {
      console.error('[notes] 设置目录失败', e)
    }
  }

  const handleReset = async () => {
    try {
      const saved = await invoke<string>('note:setDir', '')
      setDir(saved)
    } catch (e) {
      console.error('[notes] 重置目录失败', e)
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">笔记</h2>
      <p className="text-sm text-muted-foreground">
        笔记存为本地 Markdown 文件。该目录会自动加入 AI 文件工具白名单，AI 可直接读写你的笔记。
      </p>

      {!loading && (
        <div className="flex items-center gap-2 pt-1">
          <code className="flex-1 truncate rounded border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground">
            {dir}
          </code>
          <Button variant="outline" size="sm" onClick={handlePick} className="gap-1.5">
            <FolderOpen size={14} />
            选择目录
          </Button>
          <Button variant="ghost" size="sm" onClick={handleReset}>
            恢复默认
          </Button>
        </div>
      )}
    </div>
  )
}
