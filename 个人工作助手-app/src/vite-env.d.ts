/// <reference types="vite/client" />

// window.api 由 electron/preload/index.ts 通过 contextBridge 暴露。
// 这里只声明类型，让渲染层有自动补全。
interface Window {
  api: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    send: (channel: string, ...args: unknown[]) => void
    on: (channel: string, listener: (...args: unknown[]) => void) => () => void
  }
}
