import { useEffect, useRef } from 'react'
import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'
import { Graph } from '@/components/ui/icons'

/**
 * markmap 思维导图渲染组件（v1.12，公共复用）。
 *
 * MindmapToolbox（工具页）和 NotesPage（笔记页思维导图预览）共用。
 * 独立子组件 + 父组件传 key 强制重建：卸载时 destroy markmap 实例，
 * 彻底清理 d3 zoom 事件，避免残留劫持全局鼠标事件（导致输入框点不了）。
 *
 * 布局：横向树状展开，层次分明（间距/宽度/颜色/线宽）。
 */
export function MindmapView({
  markdown,
  height = 400,
  showHeader = true,
}: {
  markdown: string
  height?: number
  showHeader?: boolean
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const mmRef = useRef<Markmap | null>(null)

  useEffect(() => {
    if (!svgRef.current) return
    const transformer = new Transformer()
    const { root } = transformer.transform(markdown)
    const accentColors = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981']
    mmRef.current = new Markmap(svgRef.current, {
      zoom: true,
      pan: true,
      initialExpandLevel: -1,
      duration: 400,
      spacingHorizontal: 100,
      spacingVertical: 22,
      maxWidth: 320,
      nodeMinHeight: 16,
      paddingX: 8,
      color: (node: { state: { depth: number } }) =>
        accentColors[node.state.depth % accentColors.length],
      lineWidth: (node: { state: { depth: number } }) =>
        Math.max(1, 2.5 - node.state.depth * 0.5),
    })
    mmRef.current.setData(root).then(() => {
      mmRef.current?.fit()
    })
    return () => {
      if (mmRef.current) {
        try {
          mmRef.current.destroy()
        } catch {
          // 忽略 destroy 异常
        }
        mmRef.current = null
      }
    }
  }, [markdown])

  return (
    <div className="rounded-md border bg-card p-3">
      {showHeader && (
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Graph size={13} weight="duotone" className="text-accent" />
          思维导图预览（可拖拽缩放，点击节点折叠/展开）
        </div>
      )}
      <svg ref={svgRef} style={{ height }} className="w-full" />
    </div>
  )
}
