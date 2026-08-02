import type { IpcResult } from '@/types'

/**
 * IPC 薄封装：把 window.api.invoke 的 unknown 收敛成带类型的 Promise。
 * 失败时抛错，让调用方走 try/catch。
 */
export async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await window.api.invoke(channel, ...args)) as IpcResult<T>
  if (!res.ok) throw new Error(res.error)
  return res.data
}

export function send(channel: string, ...args: unknown[]): void {
  window.api.send(channel, ...args)
}

/** 订阅主进程推送事件，返回取消订阅函数。 */
export function on(channel: string, listener: (...args: unknown[]) => void): () => void {
  return window.api.on(channel, listener)
}
