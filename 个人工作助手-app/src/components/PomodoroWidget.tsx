import { useEffect, useRef, useState } from 'react'
import { Timer, Play, Pause, RotateCcw } from '@/components/ui/icons'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'

/**
 * 番茄钟小部件（M12.6 纯 B 轨，PRD §13.2 工具 2）。
 *
 * 常驻侧栏底部（PRD §12.3「顶栏/任意页常驻小部件」——侧栏更简单，单一挂载点）。
 * 前端 setInterval 计时（不耗主进程）；结束 IPC 落库 + 系统通知。
 *
 * 状态机：idle → running → （25:00 到）done
 *   - idle：显示 25:00，点 ▶ 开始
 *   - running：倒计时，点 ⏸ 暂停（停表不记录），点 ⟲ 复位回 idle
 *   - done：自动落库 + 弹通知，回到 idle（v1.2 不做「休息 5 分钟」自动衔接）
 *
 * 时长固定 25 分钟（PRD §13.2：25/5/15 三档可配置，v1.2 先做 25）。
 */
const FOCUS_MIN = 25
const FOCUS_SEC = FOCUS_MIN * 60

type Phase = 'idle' | 'running' | 'paused'

export function PomodoroWidget() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [remaining, setRemaining] = useState(FOCUS_SEC)
  const startedAtRef = useRef<number | null>(null) // 记录开始 Unix 秒，落库用
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 计时器：running 时每秒 -1
  useEffect(() => {
    if (phase !== 'running') return
    timerRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          // 到点
          handleComplete()
          return 0
        }
        return r - 1
      })
    }, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const handleStart = () => {
    if (phase === 'idle') {
      startedAtRef.current = Math.floor(Date.now() / 1000)
      setRemaining(FOCUS_SEC)
    }
    setPhase('running')
  }

  const handlePause = () => setPhase('paused')

  const handleReset = () => {
    setPhase('idle')
    setRemaining(FOCUS_SEC)
    startedAtRef.current = null
  }

  const handleComplete = async () => {
    setPhase('idle')
    setRemaining(FOCUS_SEC)
    // 落库 + 通知
    const startedAt = startedAtRef.current ?? Math.floor(Date.now() / 1000) - FOCUS_SEC
    startedAtRef.current = null
    try {
      await invoke('pomodoro:record', { startedAt, durationMin: FOCUS_MIN, completed: true })
    } catch {
      // 落库失败不影响通知
    }
    try {
      // 渲染层 Notification（Web API）：构造即显示，无需 .show()
      new Notification('番茄钟完成', { body: `专注了 ${FOCUS_MIN} 分钟，休息一下吧` })
    } catch {
      // Notification 不可用或被禁用时忽略
    }
  }

  const mm = String(Math.floor(remaining / 60)).padStart(2, '0')
  const ss = String(remaining % 60).padStart(2, '0')

  return (
    <div className="flex flex-col items-center gap-1 px-1">
      {/* 计时显示 */}
      <div
        className={cn(
          'flex items-center gap-1 text-xs font-mono tabular-nums',
          phase === 'running' ? 'text-accent' : 'text-muted-foreground',
        )}
        title={phase === 'idle' ? '番茄钟' : phase === 'running' ? '专注中' : '已暂停'}
      >
        <Timer size={12} />
        <span>{mm}:{ss}</span>
      </div>
      {/* 控制按钮：紧凑单行 */}
      <div className="flex items-center gap-0.5">
        {phase === 'running' ? (
          <button onClick={handlePause} title="暂停" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
            <Pause size={14} />
          </button>
        ) : (
          <button onClick={handleStart} title={phase === 'paused' ? '继续' : '开始专注'} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
            <Play size={14} />
          </button>
        )}
        {phase !== 'idle' && (
          <button onClick={handleReset} title="复位" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
