/**
 * 迷你折线图（Sparkline，v1.5）。
 *
 * 纯 SVG 实现，零依赖。用于 StatCard 内嵌的最近趋势缩略图。
 * 依据 ui-ux-pro-max：sparkline 适合「一眼看趋势走向」，不需坐标轴/tooltip。
 *
 * 设计：
 *  - 固定 48×16 viewBox，描边电光蓝 + 透明填充渐变
 *  - 数据点归一化到 viewBox（自动 min/max 缩放）
 *  - 无数据或全 0 时不渲染（返回 null）
 */
export function Sparkline({
  data,
  width = 48,
  height = 16,
  className,
}: {
  data: number[]
  width?: number
  height?: number
  className?: string
}) {
  // 过滤无效值
  const valid = data.filter((n) => Number.isFinite(n))
  if (valid.length < 2) return null
  const max = Math.max(...valid)
  const min = Math.min(...valid)
  // 全 0 或全相等（无趋势信息）不画——平线是视觉噪音
  if (max === min) return null
  // 非零点少于 2 个不画（单点尖峰也是噪音，看不出趋势）
  const nonZero = valid.filter((n) => n > 0).length
  if (nonZero < 2) return null

  const range = max - min || 1
  const stepX = width / (valid.length - 1)
  const pad = 2 // 上下留 2px，避免线贴边

  const points = valid.map((v, i) => {
    const x = i * stepX
    const y = pad + (height - pad * 2) * (1 - (v - min) / range)
    return [x, y] as const
  })

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`
  const gradId = `spark-${Math.round(points[0][1] + points[points.length - 1][1])}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      fill="none"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.25} />
          <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={linePath}
        stroke="hsl(var(--accent))"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
