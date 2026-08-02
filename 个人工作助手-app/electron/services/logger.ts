import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 轻量日志：同时输出到控制台和 UTF-8 日志文件。
 *
 * 解决 Windows 终端 GBK 解码 UTF-8 中文乱码问题：
 *  - 控制台可能乱码（终端编码所致，无碍）；
 *  - 文件始终 UTF-8，可读。路径：userData/app.log
 *
 * M1 用；M7 会换成分级 + 轮转。
 */

let _stream: fs.WriteStream | null = null

function stream(): fs.WriteStream {
  if (_stream) return _stream
  const dir = app.getPath('userData')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  _stream = fs.createWriteStream(path.join(dir, 'app.log'), { flags: 'a', encoding: 'utf-8' })
  return _stream
}

function ts(): string {
  return new Date().toLocaleString('sv-SE') // ISO-ish，稳定 ASCII
}

export function logInfo(msg: string, ...rest: unknown[]): void {
  const line = `[${ts()}] [INFO] ${msg}${rest.length ? ' ' + rest.map(String).join(' ') : ''}`
  console.log(line)
  try {
    stream().write(line + '\n')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function logError(msg: string, ...rest: unknown[]): void {
  const line = `[${ts()}] [ERROR] ${msg}${rest.length ? ' ' + rest.map(String).join(' ') : ''}`
  console.error(line)
  try {
    stream().write(line + '\n')
  } catch {
    /* ignore */
  }
}

/** 取日志文件路径（设置页/调试用）。 */
export function getLogPath(): string {
  return path.join(app.getPath('userData'), 'app.log')
}
