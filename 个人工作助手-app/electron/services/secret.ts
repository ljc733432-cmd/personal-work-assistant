import { safeStorage } from 'electron'

/**
 * API Key 加密存储封装（见 CONTEXT.md「safeStorage」）。
 *
 * 策略：
 *  - 明文 Key 永不落库。库里只存 apiKeyRef（一个引用名，如 "provider_<id>"）。
 *  - 加密后的密文以文件形式存于 userData/secrets/<ref>。
 *  - safeStorage 在 Win 上走 DPAPI，与当前用户绑定。
 *
 * 注意：safeStorage 必须在 app ready 后才可用。调用方确保此时序。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

function secretsDir(): string {
  const dir = path.join(app.getPath('userData'), 'secrets')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function secretPath(ref: string): string {
  // ref 只允许字母数字下划线，防路径注入
  if (!/^[\w-]+$/.test(ref)) throw new Error(`非法 secret ref: ${ref}`)
  return path.join(secretsDir(), ref)
}

/** 是否可用（操作系统支持加密）。 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** 写入加密的 Key。明文经 safeStorage 加密后落盘。 */
export function setSecret(ref: string, plaintext: string): void {
  if (!isEncryptionAvailable()) {
    throw new Error('当前系统不支持 safeStorage 加密，无法安全保存 Key')
  }
  const buf = safeStorage.encryptString(plaintext)
  fs.writeFileSync(secretPath(ref), buf)
}

/** 读取并解密 Key。不存在返回 null。 */
export function getSecret(ref: string): string | null {
  const p = secretPath(ref)
  if (!fs.existsSync(p)) return null
  const buf = fs.readFileSync(p)
  try {
    return safeStorage.decryptString(buf)
  } catch {
    return null // 密文损坏或跨用户
  }
}

/** 删除 Key。 */
export function deleteSecret(ref: string): void {
  const p = secretPath(ref)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
