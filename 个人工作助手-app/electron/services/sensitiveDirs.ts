import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'

/**
 * 敏感目录黑名单（M5.2）。
 *
 * 即便开启「全盘可读」，这些目录也绝不读——防止密钥/凭证/隐私泄露：
 *  - SSH/GPG 密钥
 *  - AppData（浏览器 profile、Electron 应用数据、凭据管理器等）
 *  - 系统目录（Windows、$RECYCLE.BIN、System Volume Information）
 *  - node_modules / .git（噪音巨大，项目里也不该 AI 扫）
 *
 * 「全盘可读」的边界 = 全盘 − 黑名单。
 */

/** 判断一个绝对路径是否落在黑名单内。 */
export function isSensitive(targetAbs: string): boolean {
  const full = path.resolve(targetAbs).toLowerCase()
  const home = os.homedir().toLowerCase()

  // 1. 用户主目录下的敏感子目录
  const homeSensitive = [
    '.ssh',
    '.gnupg',
    '.config',
    '.aws',
    '.docker',
    'appdata', // 整个 AppData（Roaming + Local + LocalLow）
  ]
  for (const s of homeSensitive) {
    const prefix = path.join(home, s).toLowerCase()
    if (full === prefix || full.startsWith(prefix + path.sep)) return true
  }

  // AppData 可能不在 home 下（如果 home 被改），再用 APPDATA/LOCALAPPDATA 环境变量兜底
  for (const env of ['APPDATA', 'LOCALAPPDATA']) {
    const v = process.env[env]
    if (v) {
      const lv = path.resolve(v).toLowerCase()
      if (full === lv || full.startsWith(lv + path.sep)) return true
    }
  }

  // 2. Windows 系统目录
  const sysRoot = process.env.SystemRoot?.toLowerCase() ?? 'c:\\windows'
  if (full === sysRoot || full.startsWith(sysRoot + path.sep)) return true

  // 3. 盘根下的系统目录（任意盘）
  //   D:\$RECYCLE.BIN, D:\System Volume Information, D:\Windows 等
  const parts = full.split(path.sep).filter(Boolean)
  if (parts.length >= 2) {
    const second = parts[1]
    if (
      second === '$recycle.bin' ||
      second === 'system volume information' ||
      second === 'windows'
    ) {
      return true
    }
  }

  // 4. 任意位置的 node_modules / .git（项目内也不扫，避免噪音）
  if (full.includes(path.sep + 'node_modules' + path.sep) || full.endsWith(path.sep + 'node_modules')) return true
  if (full.includes(path.sep + '.git' + path.sep) || full.endsWith(path.sep + '.git')) return true

  // 5. 本应用自己的 userData（含 app.db、secrets、fileTrash）
  const userData = app.getPath('userData').toLowerCase()
  if (full === userData || full.startsWith(userData + path.sep)) return true

  return false
}

/** 黑名单提示文案（给 AI 看的）。 */
export const SENSITIVE_HINT =
  '出于安全，以下区域永不读取：SSH/GPG 密钥、AppData（浏览器/应用数据）、Windows 系统目录、$RECYCLE.BIN、System Volume Information、node_modules、.git。'
