/**
 * 截屏服务（v1.19，PRD §15.4⑧ 收官）。
 *
 * 用 Electron desktopCapturer 截整屏。主进程调（sandbox:true 渲染层用不了 desktopCapturer），
 * 经 IPC 返 dataUrl 给渲染层在 canvas 上标注。
 *
 * 设计：
 *  - 纯函数无单例（desktopCapturer 无状态资源），无需 will-quit 清理。
 *  - 多显示器限制（PRD §15.5 / §15.8 已知风险）：Chromium 无法整屏拼接多屏，
 *    取 display_id 对应主屏的那张 source；取不到则回退第一个 source。UI 文字提示限制。
 *  - thumbnailSize 设成屏幕物理尺寸，保证清晰度（默认 thumbnail 太小）。
 */

import { desktopCapturer, screen } from 'electron'

export interface ScreenCaptureResult {
  /** 形如 data:image/png;base64,xxxx */
  dataUrl: string
  /** 原图像素宽（canvas 内部坐标用） */
  width: number
  /** 原图像素高 */
  height: number
}

/**
 * 截取整屏。取主屏（screen.getPrimaryDisplay）；若 desktopCapturer 返回的 sources
 * 里有 display_id 匹配主屏的就用它，否则回退第一个 source。
 */
export async function captureScreen(): Promise<ScreenCaptureResult> {
  const primary = screen.getPrimaryDisplay()
  const { width, height } = primary.size
  // 物理像素（高 DPI 屏要乘 scaleFactor 才不糊）
  const scaleFactor = primary.scaleFactor || 1
  const physWidth = Math.floor(width * scaleFactor)
  const physHeight = Math.floor(height * scaleFactor)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physWidth, height: physHeight },
    fetchWindowIcons: false,
  })

  if (sources.length === 0) {
    throw new Error('未找到可截取的屏幕（desktopCapturer 返回空）')
  }

  // 优先匹配主屏 display_id；desktopCapturer 的 source.name 形如 "Entire Screen" / "Screen 1"，
  // display_id 可能空字符串，匹配不到就回退第 0 个。
  const primaryId = String(primary.id)
  const matched =
    sources.find((s) => s.display_id && s.display_id === primaryId) ?? sources[0]

  const pngBuf = matched.thumbnail.toPNG()
  const dataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`

  // 用 thumbnail 实际尺寸（可能因系统差异与请求略有出入）
  const size = matched.thumbnail.getSize()
  return {
    dataUrl,
    width: size.width || physWidth,
    height: size.height || physHeight,
  }
}
