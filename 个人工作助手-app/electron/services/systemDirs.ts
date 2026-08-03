import { app } from 'electron'

/**
 * 系统标准位置（M5.1）。
 *
 * 开箱即用的可读目录：文档 / 桌面 / 下载。
 * 通过 app.getPath() 获取，**只读**（不可写）。
 *
 * 这是用户不用配置就能用的"默认读取范围"——
 * 用户说"读某天的文件"，AI 默认在这些地方找。
 */

export interface AccessibleDir {
  label: string
  path: string
  source: 'system' | 'workdir' | 'session'
  mode: 'read' | 'readwrite'
}

/** 获取系统标准位置（文档/桌面/下载），均为只读。 */
export function getSystemDirs(): AccessibleDir[] {
  const out: AccessibleDir[] = []
  for (const name of ['documents', 'downloads', 'desktop'] as const) {
    try {
      const p = app.getPath(name)
      out.push({
        label: labelOf(name),
        path: p,
        source: 'system',
        mode: 'read',
      })
    } catch {
      // 某些环境可能取不到，跳过
    }
  }
  return out
}

function labelOf(name: string): string {
  return name === 'documents' ? '文档' : name === 'downloads' ? '下载' : name === 'desktop' ? '桌面' : name
}
