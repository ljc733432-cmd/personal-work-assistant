import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Screenshot,
  FrameCorners,
  ArrowUp,
  TextT,
  PaintBrush,
  Eraser,
  ArrowLeft,
  CopySimple,
  ChatTeardropDots,
  CheckCircle2,
  AlertCircle,
  Loader2,
  MousePointer,
} from '@/components/ui/icons'
import { Button } from '@/components/ui/button'
import { invoke } from '@/lib/ipc'
import { useNavigate } from '@/pages/overview/nav'
import { useScreenshotStore } from '@/stores/screenshot'
import { BackHeader } from './ToolsPage'
import { cn } from '@/lib/utils'

/**
 * 截图标注（v1.19，PRD §15.4⑧ 收官）。
 *
 * 形态：工具页内嵌（不做全屏遮罩/快捷键）。
 *  1. 点「截取屏幕」→ 主进程 desktopCapturer 截整屏 → 返 dataUrl
 *  2. canvas 标注（矩形框/箭头/文字/画笔 + 撤销 + Ctrl+滚轮缩放）—— 原生 2D API，零依赖
 *  3. 「选择」工具：选中任意已画标注 → 拖移 / 拖角缩放 / Delete 删除 / 双击文字改内容
 *  4. 三去向：复制剪贴板 / 保存到笔记库 images/ / 插入当前对话（跨页 store 中转）
 *
 * 已知限制（写进 UI）：多显示器无法整屏（Chromium 限制），仅截主屏。
 */

/** 选择工具 + 四种绘制工具。select 工具下点已有 shape 是选中编辑，其他工具是画新。 */
type Tool = 'select' | 'rect' | 'arrow' | 'text' | 'pen'
const WIDTHS = [2, 4, 6] as const

/** 标注 shape（统一电光蓝 accent，坐标存 canvas 内部坐标系=缩放后原图尺寸）。 */
type Shape =
  | { type: 'rect'; x1: number; y1: number; x2: number; y2: number; width: number }
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number; width: number }
  | { type: 'pen'; points: { x: number; y: number }[]; width: number }
  | { type: 'text'; x: number; y: number; text: string; fontSize: number }

/** 正在绘制中的 shape（text 不进 drawing，走 input 浮层）。 */
type DrawingShape = Extract<Shape, { type: 'rect' | 'arrow' | 'pen' }>

type Status =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'feedback'; message: string }

/** 包围盒（选中框 + 命中测试 + 缩放基准）。 */
interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 4 个角（缩放手柄定位用）。 */
type Corner = 'nw' | 'ne' | 'sw' | 'se'

/** 读 CSS 变量 --accent（电光蓝）。 */
function getAccentColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  return v || '#3b82f6'
}

// ============ 模块级纯函数：bboxOf / hitTest / moveShape / resizeShape ============

/** 算 shape 的包围盒（含描边宽度容差）。 */
function bboxOf(s: Shape): BBox {
  const pad = ('width' in s ? s.width : 4) + 6
  switch (s.type) {
    case 'rect':
    case 'arrow':
      return {
        minX: Math.min(s.x1, s.x2) - pad,
        minY: Math.min(s.y1, s.y2) - pad,
        maxX: Math.max(s.x1, s.x2) + pad,
        maxY: Math.max(s.y1, s.y2) + pad,
      }
    case 'pen': {
      if (s.points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of s.points) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
      return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
    }
    case 'text': {
      // 文字宽度估算：每字符 ≈ fontSize * 0.6；高度 = 行数 × fontSize × 1.2
      const lines = s.text.split('\n')
      const w = Math.max(...lines.map((l) => l.length)) * s.fontSize * 0.6
      const h = lines.length * s.fontSize * 1.2
      return { minX: s.x - 4, minY: s.y - 4, maxX: s.x + w + 4, maxY: s.y + h + 4 }
    }
  }
}

/** 点到线段距离（命中测试用）。 */
function pointToSegmentDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/** 点是否命中 shape。 */
function hitTest(s: Shape, x: number, y: number): boolean {
  const tol = 6
  switch (s.type) {
    case 'rect': {
      const minX = Math.min(s.x1, s.x2), maxX = Math.max(s.x1, s.x2)
      const minY = Math.min(s.y1, s.y2), maxY = Math.max(s.y1, s.y2)
      return x >= minX - tol && x <= maxX + tol && y >= minY - tol && y <= maxY + tol
    }
    case 'arrow':
      return pointToSegmentDist(x, y, s.x1, s.y1, s.x2, s.y2) < tol + s.width
    case 'pen':
      if (s.points.length === 1) return Math.hypot(x - s.points[0].x, y - s.points[0].y) < s.width + tol
      for (let i = 1; i < s.points.length; i++) {
        if (pointToSegmentDist(x, y, s.points[i - 1].x, s.points[i - 1].y, s.points[i].x, s.points[i].y) < s.width + tol) return true
      }
      return false
    case 'text': {
      const b = bboxOf(s)
      return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY
    }
  }
}

/** 拖移 shape（返回新 shape）。 */
function moveShape(s: Shape, dx: number, dy: number): Shape {
  switch (s.type) {
    case 'rect':
    case 'arrow':
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy }
    case 'pen':
      return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
    case 'text':
      return { ...s, x: s.x + dx, y: s.y + dy }
  }
}

/**
 * 缩放 shape 到新包围盒（拖角时）。把 shape 从原 bbox 等比映射到新 bbox。
 * pen 的 points + width 按比例，text 的 fontSize + 位置按比例。
 */
function resizeShape(s: Shape, oldBBox: BBox, newBBox: BBox): Shape {
  const sx = (newBBox.maxX - newBBox.minX) / (oldBBox.maxX - oldBBox.minX || 1)
  const sy = (newBBox.maxY - newBBox.minY) / (oldBBox.maxY - oldBBox.minY || 1)
  // 统一用最小比例（等比缩放，不变形）
  const scale = Math.min(Math.abs(sx), Math.abs(sy)) * (sx < 0 || sy < 0 ? -1 : 1)
  const mapX = (x: number) => newBBox.minX + (x - oldBBox.minX) * scale
  const mapY = (y: number) => newBBox.minY + (y - oldBBox.minY) * scale
  switch (s.type) {
    case 'rect':
    case 'arrow':
      return { ...s, x1: mapX(s.x1), y1: mapY(s.y1), x2: mapX(s.x2), y2: mapY(s.y2), width: Math.max(1, s.width * scale) }
    case 'pen':
      return { ...s, points: s.points.map((p) => ({ x: mapX(p.x), y: mapY(p.y) })), width: Math.max(1, s.width * scale) }
    case 'text':
      return { ...s, x: mapX(s.x), y: mapY(s.y), fontSize: Math.max(8, Math.round(s.fontSize * scale)) }
  }
}

// ============ 主组件 ============

const HANDLE_SIZE = 10 // 选中框角手柄大小

export function ScreenshotToolbox({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [capture, setCapture] = useState<{ dataUrl: string; width: number; height: number } | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [lineWidth, setLineWidth] = useState<(typeof WIDTHS)[number]>(4)
  const [shapes, setShapes] = useState<Shape[]>([])
  // 选中的 shape index（选择工具下点中已有 shape）。null = 未选中
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  // Ctrl+滚轮缩放（1 = 适配容器宽度，>1 放大出滚动条精细标注）
  const [zoom, setZoom] = useState(1)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef<DrawingShape | null>(null)
  const rafRef = useRef<number | null>(null)

  // 文字 input 浮层（可拖拽移动 + 可拖角调整大小）。editIdx 非 null = 编辑已有文字而非新建
  const [textDraft, setTextDraft] = useState<{
    x: number
    y: number
    displayX: number
    displayY: number
    width: number
    height: number
  } | null>(null)
  const [textValue, setTextValue] = useState('')
  const [textEditIdx, setTextEditIdx] = useState<number | null>(null) // 双击文字编辑：替换该 index 的 shape
  const textDragRef = useRef<{ mode: 'move' | 'resize'; startClientX: number; startClientY: number; startDisplayX: number; startDisplayY: number; startWidth: number; startHeight: number } | null>(null)

  // 拖移/缩放选中 shape 的临时状态（选择工具下）
  const editActionRef = useRef<
    | { mode: 'move'; startInternal: { x: number; y: number }; startShape: Shape }
    | { mode: 'resize'; corner: Corner; startInternal: { x: number; y: number }; startBBox: BBox; oppositeCorner: { x: number; y: number }; startShape: Shape }
    | null
  >(null)

  const goto = useNavigate()
  const pushForChat = useScreenshotStore((s) => s.pushForChat)

  /** canvas 内部尺寸（最长边上限 1920，防 4K 全量重绘崩）。 */
  const MAX_INTERNAL = 1920
  const internalSize = (() => {
    if (!capture) return { w: 0, h: 0 }
    const longest = Math.max(capture.width, capture.height)
    if (longest <= MAX_INTERNAL) return { w: capture.width, h: capture.height }
    const scale = MAX_INTERNAL / longest
    return { w: Math.round(capture.width * scale), h: Math.round(capture.height * scale) }
  })()

  /** 鼠标坐标 → canvas 内部坐标（按显示/内部比例换算，含 zoom + 滚动偏移自动处理）。 */
  const toInternal = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    }
  }

  /** 重绘：清屏 → 底图 → 所有 shape → 选中框 → 临时绘制 shape。 */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const bg = bgCanvasRef.current
    if (!canvas || !capture) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    try {
      const color = getAccentColor()
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (bg) ctx.drawImage(bg, 0, 0)
      // 拖移/缩放进行中时，被拖 shape 用预览态画（不在原位置画，否则视觉上有两个 + 选中框不跟随 → 闪烁）
      const action = editActionRef.current
      const isDraggingSelected = action != null && selectedIdx != null
      // 实时算预览 shape + 预览 bbox（选中框画在预览位置，跟随拖动）
      let previewShape: Shape | null = null
      let previewBBox: BBox | null = null
      if (isDraggingSelected && action && selectedIdx != null) {
        const cur = toInternalFromEvent(action)
        if (action.mode === 'move') {
          const dx = cur.x - action.startInternal.x
          const dy = cur.y - action.startInternal.y
          previewShape = moveShape(action.startShape, dx, dy)
        } else {
          previewBBox = computeResizedBBox(action, cur)
          previewShape = resizeShape(action.startShape, action.startBBox, previewBBox)
        }
      }

      // 正序画所有 shapes（拖移中的选中项跳过原位置，改画预览态）
      for (let i = 0; i < shapes.length; i++) {
        const s = shapes[i]
        if (!s) continue
        if (isDraggingSelected && i === selectedIdx) continue // 拖移中不在原位置画
        drawShape(ctx, s, color)
      }
      // 拖移/缩放预览态 shape（画在新位置）
      if (previewShape) drawShape(ctx, previewShape, color)
      // 临时绘制中的 shape（画新工具拖拽中）
      if (drawingRef.current) drawShape(ctx, drawingRef.current, color)

      // 选中框（虚线 bbox + 4 角手柄）。拖移中画在预览 bbox 上跟随
      if (selectedIdx != null && shapes[selectedIdx]) {
        const b = isDraggingSelected && previewShape ? bboxOf(previewShape) : bboxOf(shapes[selectedIdx])
        ctx.save()
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.lineWidth = 1
        ctx.setLineDash([6, 4])
        ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY)
        ctx.setLineDash([])
        // 4 角实心手柄
        const corners: [number, number][] = [
          [b.minX, b.minY],
          [b.maxX, b.minY],
          [b.minX, b.maxY],
          [b.maxX, b.maxY],
        ]
        for (const [hx, hy] of corners) {
          ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
        }
        ctx.restore()
      }
    } catch (e) {
      setStatus({ kind: 'error', message: `绘制出错：${String(e)}` })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, shapes, selectedIdx])

  /** RAF 节流重绘。 */
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      redraw()
    })
  }, [redraw])

  // 截图变化：加载底图 → 预渲染到 offscreen canvas → 首次重绘
  useEffect(() => {
    if (!capture) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const bg = document.createElement('canvas')
      bg.width = internalSize.w
      bg.height = internalSize.h
      const bctx = bg.getContext('2d')
      if (bctx) bctx.drawImage(img, 0, 0, bg.width, bg.height)
      bgCanvasRef.current = bg
      redraw()
    }
    img.src = capture.dataUrl
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, redraw])

  useEffect(() => {
    redraw()
  }, [redraw])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  /** 截屏 */
  const handleCapture = async () => {
    setStatus({ kind: 'capturing' })
    try {
      const result = await invoke<{ dataUrl: string; width: number; height: number }>('screen:capture')
      setCapture(result)
      setShapes([])
      setSelectedIdx(null)
      setZoom(1)
      setStatus({ kind: 'ready' })
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) })
    }
  }

  /** 判断内部坐标是否落在选中 shape 的某个角手柄上（resize 模式入口）。 */
  const hitCorner = (x: number, y: number, idx: number): Corner | null => {
    if (idx == null || !shapes[idx]) return null
    const b = bboxOf(shapes[idx])
    const corners: [Corner, number, number][] = [
      ['nw', b.minX, b.minY],
      ['ne', b.maxX, b.minY],
      ['sw', b.minX, b.maxY],
      ['se', b.maxX, b.maxY],
    ]
    for (const [c, hx, hy] of corners) {
      if (Math.abs(x - hx) <= HANDLE_SIZE && Math.abs(y - hy) <= HANDLE_SIZE) return c
    }
    return null
  }

  // ============ canvas 鼠标交互 ============

  const onMouseDown = (e: React.MouseEvent) => {
    if (!capture || textDraft) return
    const internal = toInternal(e)

    // ---- 选择工具：选中 / 拖移 / 缩放 ----
    if (tool === 'select') {
      // 1. 先看是否点中选中 shape 的角手柄（resize）
      if (selectedIdx != null) {
        const corner = hitCorner(internal.x, internal.y, selectedIdx)
        if (corner && shapes[selectedIdx]) {
          const b = bboxOf(shapes[selectedIdx])
          // 对角点固定，拖角改 bbox
          const opp = { x: corner === 'nw' || corner === 'sw' ? b.maxX : b.minX, y: corner === 'nw' || corner === 'ne' ? b.maxY : b.minY }
          editActionRef.current = { mode: 'resize', corner, startInternal: internal, startBBox: b, oppositeCorner: opp, startShape: shapes[selectedIdx] }
          return
        }
      }
      // 2. 从后往前找第一个命中的 shape（后画的在上）
      let hit: number | null = null
      for (let i = shapes.length - 1; i >= 0; i--) {
        if (shapes[i] && hitTest(shapes[i], internal.x, internal.y)) {
          hit = i
          break
        }
      }
      if (hit != null) {
        setSelectedIdx(hit)
        editActionRef.current = { mode: 'move', startInternal: internal, startShape: shapes[hit] }
      } else {
        setSelectedIdx(null)
      }
      return
    }

    // ---- 绘制工具：画新 shape ----
    if (tool === 'text') {
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      setSelectedIdx(null)
      setTextEditIdx(null)
      setTextDraft({
        x: internal.x,
        y: internal.y,
        displayX: e.clientX - rect.left,
        displayY: e.clientY - rect.top,
        width: 200,
        height: 44,
      })
      setTextValue('')
      return
    }
    setSelectedIdx(null)
    if (tool === 'pen') {
      drawingRef.current = { type: 'pen', points: [{ x: internal.x, y: internal.y }], width: lineWidth }
    } else {
      drawingRef.current = { type: tool, x1: internal.x, y1: internal.y, x2: internal.x, y2: internal.y, width: lineWidth }
    }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!capture || textDraft) return
    const internal = toInternal(e)
    // 缓存最新鼠标内部坐标（redraw 预览拖移/缩放用，闭包拿不到最新 event）
    _lastMouseInternal = internal

    // 选择工具：拖移/缩放进行中 → 直接同步重绘（不走 RAF，拖动要即时反馈无帧延迟）
    if (tool === 'select' && editActionRef.current) {
      redraw()
      return
    }
    // 绘制工具：更新临时 shape
    if (!drawingRef.current) return
    const d = drawingRef.current
    if (d.type === 'pen') {
      d.points.push({ x: internal.x, y: internal.y })
    } else {
      d.x2 = internal.x
      d.y2 = internal.y
    }
    scheduleRedraw()
  }

  const onMouseUp = (e: React.MouseEvent) => {
    // 选择工具：结束拖移/缩放，把结果写回 shapes
    if (tool === 'select' && editActionRef.current) {
      const action = editActionRef.current
      const internal = toInternal(e)
      if (action.mode === 'move') {
        const dx = internal.x - action.startInternal.x
        const dy = internal.y - action.startInternal.y
        if (selectedIdx != null && (dx !== 0 || dy !== 0)) {
          setShapes((ss) => ss.map((s, i) => (i === selectedIdx ? moveShape(action.startShape, dx, dy) : s)))
        }
      } else {
        const newBBox = computeResizedBBox(action, internal)
        if (selectedIdx != null) {
          setShapes((ss) => ss.map((s, i) => (i === selectedIdx ? resizeShape(action.startShape, action.startBBox, newBBox) : s)))
        }
      }
      editActionRef.current = null
      return
    }
    // 绘制工具：commit 临时 shape
    const snap = drawingRef.current
    if (!snap) return
    drawingRef.current = null
    setShapes((s) => [...s, snap])
  }

  /** 双击：选择工具下双击文字 shape → 进入文字编辑模式（复用 textDraft 浮层）。 */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select' || !capture) return
    const internal = toInternal(e)
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i]
      if (s && s.type === 'text' && hitTest(s, internal.x, internal.y)) {
        const canvas = canvasRef.current!
        const rect = canvas.getBoundingClientRect()
        const displayX = (s.x / canvas.width) * rect.width
        const displayY = (s.y / canvas.height) * rect.height
        const lines = s.text.split('\n')
        setTextEditIdx(i)
        setSelectedIdx(null)
        setTextDraft({
          x: s.x,
          y: s.y,
          displayX,
          displayY,
          width: Math.max(200, Math.max(...lines.map((l) => l.length)) * s.fontSize * 0.6),
          height: Math.max(44, lines.length * s.fontSize * 1.2 + 20),
        })
        setTextValue(s.text)
        return
      }
    }
  }

  /** 键盘：Delete 删选中 / Esc 取消选中或关文字框。 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (textDraft) return // 文字编辑中不拦截（textarea 自己处理）
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdx != null) {
      e.preventDefault()
      setShapes((ss) => ss.filter((_, i) => i !== selectedIdx))
      setSelectedIdx(null)
    }
    if (e.key === 'Escape') {
      setSelectedIdx(null)
    }
  }

  // ============ 文字浮层 ============

  /** 文字确认。editingIdx 非 null = 替换原 shape，否则新增。 */
  const commitText = () => {
    if (textDraft && textValue.trim()) {
      const lineCount = Math.max(1, textValue.split('\n').length)
      const fontSize = Math.max(12, Math.round((textDraft.height - 20) / lineCount))
      const newShape: Shape = { type: 'text', x: textDraft.x, y: textDraft.y, text: textValue, fontSize }
      if (textEditIdx != null) {
        setShapes((ss) => ss.map((s, i) => (i === textEditIdx ? newShape : s)))
      } else {
        setShapes((ss) => [...ss, newShape])
      }
    }
    setTextDraft(null)
    setTextValue('')
    setTextEditIdx(null)
  }

  /** 文字框拖拽/resize（window 原生监听，鼠标可移出框）。 */
  const onTextDragStart = (e: React.MouseEvent, mode: 'move' | 'resize') => {
    e.stopPropagation()
    e.preventDefault()
    if (!textDraft) return
    const start = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startDisplayX: textDraft.displayX,
      startDisplayY: textDraft.displayY,
      startWidth: textDraft.width,
      startHeight: textDraft.height,
    }
    textDragRef.current = start
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - start.startClientX
      const dy = ev.clientY - start.startClientY
      setTextDraft((d) => {
        if (!d) return d
        if (mode === 'move') return { ...d, displayX: start.startDisplayX + dx, displayY: start.startDisplayY + dy }
        return { ...d, width: Math.max(80, start.startWidth + dx), height: Math.max(28, start.startHeight + dy) }
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      textDragRef.current = null
      setTextDraft((d) => {
        if (!d) return d
        const canvas = canvasRef.current
        if (!canvas) return d
        const rect = canvas.getBoundingClientRect()
        return { ...d, x: (d.displayX * canvas.width) / rect.width, y: (d.displayY * canvas.height) / rect.height }
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ============ Ctrl+滚轮缩放 ============

  useEffect(() => {
    const wrap = canvasWrapRef.current
    if (!wrap) return
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.2 : 0.2
      setZoom((z) => Math.min(8, Math.max(1, +(z + delta).toFixed(2))))
    }
    wrap.addEventListener('wheel', handler, { passive: false })
    return () => wrap.removeEventListener('wheel', handler)
  }, [capture])

  // ============ 输出 ============

  const exportDataUrl = (): string | null => {
    // 导出前临时取消选中（避免选中框被导出），用一次 redraw 后导出再恢复
    const canvas = canvasRef.current
    if (!canvas) return null
    return canvas.toDataURL('image/png')
  }

  const handleCopyClipboard = async () => {
    const dataUrl = exportDataUrl()
    if (!dataUrl) return
    // 临时取消选中重绘再导出（选中框不入图）
    const prev = selectedIdx
    setSelectedIdx(null)
    requestAnimationFrame(async () => {
      try {
        const url = canvasRef.current?.toDataURL('image/png') ?? dataUrl
        await invoke('screen:copy_clipboard', { dataUrl: url })
        setStatus({ kind: 'feedback', message: '已复制到剪贴板' })
      } catch (e) {
        setStatus({ kind: 'error', message: String(e) })
      }
      setSelectedIdx(prev)
    })
  }

  const handleSaveToNotes = async () => {
    const prev = selectedIdx
    setSelectedIdx(null)
    requestAnimationFrame(async () => {
      try {
        const url = canvasRef.current?.toDataURL('image/png')
        if (!url) {
          setSelectedIdx(prev)
          return
        }
        const result = await invoke<{ relPath: string }>('screen:save', { dataUrl: url })
        setStatus({ kind: 'feedback', message: `已保存到笔记库：${result.relPath}` })
      } catch (e) {
        setStatus({ kind: 'error', message: String(e) })
      }
      setSelectedIdx(prev)
    })
  }

  const handleInsertToChat = () => {
    const prev = selectedIdx
    setSelectedIdx(null)
    requestAnimationFrame(() => {
      const url = canvasRef.current?.toDataURL('image/png')
      if (url) {
        pushForChat({ name: `截图标注-${Date.now()}.png`, dataUrl: url })
        goto('chat')
      }
      setSelectedIdx(prev)
    })
  }

  const handleUndo = () => {
    setShapes((s) => s.slice(0, -1))
    setSelectedIdx(null)
  }
  const handleClear = () => {
    setShapes([])
    setSelectedIdx(null)
  }

  return (
    <div className="flex h-full flex-col">
      <BackHeader title="截图标注" onBack={onBack} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {/* 步骤 1：截屏 */}
          <div className="space-y-2 border border-border bg-card p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              第 1 步 · 截取屏幕
            </div>
            <Button onClick={handleCapture} disabled={status.kind === 'capturing'} className="gap-1.5">
              {status.kind === 'capturing' ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  截取中…
                </>
              ) : (
                <>
                  <Screenshot size={16} />
                  {capture ? '重新截取' : '截取屏幕'}
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              截取当前主屏整屏画面。已知限制：多显示器无法整屏拼接（Chromium 限制），仅截主屏。
            </p>
          </div>

          {/* 步骤 2：标注（截图后显示） */}
          {capture && (
            <div className="space-y-3 border border-border bg-card p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                第 2 步 · 标注
              </div>

              {/* 工具栏 */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1">
                  <ToolBtn icon={MousePointer} active={tool === 'select'} onClick={() => { setTool('select'); setSelectedIdx(null) }} label="选择/编辑" />
                  <ToolBtn icon={FrameCorners} active={tool === 'rect'} onClick={() => setTool('rect')} label="矩形框" />
                  <ToolBtn icon={ArrowUp} active={tool === 'arrow'} onClick={() => setTool('arrow')} label="箭头" />
                  <ToolBtn icon={TextT} active={tool === 'text'} onClick={() => setTool('text')} label="文字" />
                  <ToolBtn icon={PaintBrush} active={tool === 'pen'} onClick={() => setTool('pen')} label="画笔" />
                </div>
                <div className="mx-1 h-6 w-px bg-border" />
                <div className="flex items-center gap-1">
                  {WIDTHS.map((w) => (
                    <button
                      key={w}
                      onClick={() => setLineWidth(w)}
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
                        lineWidth === w ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted-foreground hover:bg-accent/5',
                      )}
                      title={`粗细 ${w}px`}
                    >
                      <span className="block rounded-full bg-current" style={{ width: w + 2, height: w + 2 }} />
                    </button>
                  ))}
                </div>
                <div className="mx-1 h-6 w-px bg-border" />
                <Button variant="ghost" size="sm" onClick={handleUndo} disabled={shapes.length === 0} className="gap-1">
                  <ArrowLeft size={14} />
                  撤销
                </Button>
                <Button variant="ghost" size="sm" onClick={handleClear} disabled={shapes.length === 0} className="gap-1">
                  <Eraser size={14} />
                  清空
                </Button>
              </div>

              {/* canvas 画布容器：overflow-auto 支持 Ctrl+滚轮放大后滚动平移 */}
              <div
                ref={canvasWrapRef}
                className="max-h-[60vh] overflow-auto rounded-md border border-border bg-black"
              >
                {/* 锚点容器：紧贴 canvas，文字浮层 absolute 相对它定位 */}
                <div className="relative inline-block">
                  <canvas
                    ref={canvasRef}
                    width={internalSize.w}
                    height={internalSize.h}
                    tabIndex={0}
                    onMouseDown={onMouseDown}
                    onMouseMove={onMouseMove}
                    onMouseUp={onMouseUp}
                    onMouseLeave={onMouseUp}
                    onDoubleClick={onDoubleClick}
                    onKeyDown={onKeyDown}
                    className={cn(
                      'block outline-none',
                      tool === 'select' ? (selectedIdx != null ? 'cursor-move' : 'cursor-default') : tool === 'text' ? 'cursor-text' : 'cursor-crosshair',
                    )}
                    style={{ width: `${100 * zoom}%`, height: 'auto' }}
                  />
                  {/* 文字输入浮层：可拖拽移动 + 可拖角调整大小 */}
                  {textDraft && (
                    <div
                      className="absolute z-20 flex flex-col overflow-hidden rounded-sm border-2 border-accent bg-white shadow-lg"
                      style={{ left: textDraft.displayX, top: textDraft.displayY, width: textDraft.width, height: textDraft.height }}
                    >
                      <div
                        onMouseDown={(e) => onTextDragStart(e, 'move')}
                        className="flex h-5 flex-shrink-0 cursor-move items-center justify-between bg-accent px-1 text-white"
                      >
                        <span className="text-[10px] font-medium leading-5">⠿ 拖动</span>
                        <button onClick={commitText} className="flex h-4 w-4 items-center justify-center rounded bg-white/20 text-[10px] hover:bg-white/40" title="确认（Ctrl+Enter）">✓</button>
                      </div>
                      <textarea
                        autoFocus
                        value={textValue}
                        onChange={(e) => setTextValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText() }
                          if (e.key === 'Escape') { setTextDraft(null); setTextValue(''); setTextEditIdx(null) }
                        }}
                        placeholder="输入文字，Ctrl+Enter 确认…"
                        style={{ fontSize: Math.max(12, Math.round((textDraft.height - 20) * 0.5)) }}
                        className="flex-1 resize-none border-0 px-1 py-0.5 text-black outline-none"
                      />
                      <div onMouseDown={(e) => onTextDragStart(e, 'resize')} className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize bg-accent" title="拖动调整大小" />
                    </div>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                标注颜色统一为电光蓝。
                <span className="ml-1 text-accent/80">「选择」工具下点标注可拖移/缩放/Delete 删除，双击文字改内容。</span>
                矩形框/箭头/画笔：拖拽绘制；文字：点击出现输入框，Ctrl+Enter 确认。
                <span className="ml-2 text-accent/80">Ctrl+滚轮放大画布精细标注。</span>
                {zoom > 1 && <span className="ml-2 font-medium text-accent">当前 {zoom}x</span>}
              </p>
            </div>
          )}

          {/* 步骤 3：输出（截图后显示） */}
          {capture && (
            <div className="space-y-3 border border-border bg-card p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">第 3 步 · 输出</div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={handleCopyClipboard} className="gap-1.5">
                  <CopySimple size={16} />
                  复制到剪贴板
                </Button>
                <Button variant="outline" onClick={handleSaveToNotes} className="gap-1.5">
                  <Screenshot size={16} />
                  保存到笔记库
                </Button>
                <Button variant="outline" onClick={handleInsertToChat} className="gap-1.5">
                  <ChatTeardropDots size={16} />
                  插入当前对话
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                保存到笔记库 images/ 后可在笔记里用 <code className="rounded bg-muted px-1">![](images/xxx.png)</code> 引用；
                插入对话会跳转到对话页待发送。
              </p>
            </div>
          )}

          {/* 反馈条 */}
          {status.kind === 'feedback' && (
            <div className="flex items-start gap-2 border border-success/40 bg-success/5 p-3">
              <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-success">操作成功</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{status.message}</div>
              </div>
            </div>
          )}
          {status.kind === 'error' && (
            <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 p-3">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-danger">操作失败</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{status.message}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ============ 辅助：redraw 里读 editAction 的当前鼠标位置（需重新算，闭包拿不到最新 event） ============
// editActionRef 的 startInternal 是按下时的坐标，redraw 预览需要「当前」坐标。
// 因 mousemove 已 scheduleRedraw，但 redraw 闭包拿不到最新 event，故用模块级最近坐标缓存。
let _lastMouseInternal = { x: 0, y: 0 }

function toInternalFromEvent(_action: { startInternal: { x: number; y: number } }): { x: number; y: number } {
  // 用模块级缓存（onMouseMove 时更新）。简单可靠，避免 redraw 依赖 event。
  return _lastMouseInternal
}

function computeResizedBBox(action: { oppositeCorner: { x: number; y: number }; startBBox: BBox }, cur: { x: number; y: number }): BBox {
  const opp = action.oppositeCorner
  return {
    minX: Math.min(opp.x, cur.x),
    minY: Math.min(opp.y, cur.y),
    maxX: Math.max(opp.x, cur.x),
    maxY: Math.max(opp.y, cur.y),
  }
}

// ============ drawShape ============

/** 画一个 shape 到 ctx。 */
function drawShape(ctx: CanvasRenderingContext2D, s: Shape, color: string) {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  switch (s.type) {
    case 'rect': {
      ctx.lineWidth = s.width
      ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1)
      break
    }
    case 'arrow': {
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(s.x1, s.y1)
      ctx.lineTo(s.x2, s.y2)
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
      const headLen = 12 + s.width * 2
      ctx.moveTo(s.x2, s.y2)
      ctx.lineTo(s.x2 - headLen * Math.cos(angle - Math.PI / 6), s.y2 - headLen * Math.sin(angle - Math.PI / 6))
      ctx.moveTo(s.x2, s.y2)
      ctx.lineTo(s.x2 - headLen * Math.cos(angle + Math.PI / 6), s.y2 - headLen * Math.sin(angle + Math.PI / 6))
      ctx.stroke()
      break
    }
    case 'pen': {
      if (s.points.length === 0) break
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(s.points[0].x, s.points[0].y)
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y)
      ctx.stroke()
      break
    }
    case 'text': {
      ctx.font = `${s.fontSize}px "DM Sans", sans-serif`
      ctx.textBaseline = 'top'
      const lines = s.text.split('\n')
      lines.forEach((line, i) => {
        ctx.fillText(line, s.x, s.y + i * s.fontSize * 1.2)
      })
      break
    }
  }
}

/** 工具按钮（图标 + active 态）。 */
function ToolBtn({ icon: Icon, active, onClick, label }: { icon: typeof FrameCorners; active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
        active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted-foreground hover:bg-accent/5',
      )}
    >
      <Icon size={16} />
    </button>
  )
}
