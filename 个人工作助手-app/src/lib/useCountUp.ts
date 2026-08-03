import { useEffect, useRef, useState } from 'react'

/**
 * 数字 count-up 动画 hook（v1.5）。
 *
 * 依据 ui-ux-pro-max skill：数字从 0 滚动到目标值，300-600ms ease-out。
 * 用 requestAnimationFrame + easeOutCubic 实现（不引 gsap，Electron 体积考量）。
 *
 * 特性：
 *  - target 变化时自动重新滚动（如切换时间范围后数字更新）
 *  - 尊重 prefers-reduced-motion：直接返回 target，不动画
 *  - target 为 0 时不动画（直接显示 0，避免空数据闪烁）
 *
 * 用法：const display = useCountUp(value); <span>{display}</span>
 */
export function useCountUp(target: number, duration = 600): number {
  const [display, setDisplay] = useState(0)
  const fromRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    // 尊重系统减少动效设置：直接到目标值
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setDisplay(target)
      return
    }

    // target 为 0 直接显示（避免空数据 0→0 的无意义动画）
    if (target === 0) {
      setDisplay(0)
      fromRef.current = 0
      return
    }

    const from = fromRef.current
    const start = performance.now()
    const delta = target - from

    // delta 为 0（目标未变）不动画
    if (delta === 0) {
      setDisplay(target)
      return
    }

    const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

    const tick = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = easeOutCubic(progress)
      const current = Math.round(from + delta * eased)
      setDisplay(current)

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [target, duration])

  return display
}
