import { create } from 'zustand'

/**
 * 截图标注跨页中转 store（v1.19，PRD §15.4⑧）。
 *
 * 用途：截图页（ScreenshotToolbox）标注完后「插入当前对话」→ 把图片塞进这里 →
 * ChatPage 订阅 pendingForChat，变化时 merge 进自己的本地 pendingImages 并 consume 清空。
 *
 * 为什么用 store 而非 props/IPC：截图页和对话页都在渲染进程，跨页 state 走 zustand
 * 是项目既有模式（nav.ts 就是范本）。ChatPage 常驻挂载（v1.17.1，只切 hidden 不 unmount），
 * 所以必须订阅式，不能 mount-once 读。
 *
 * 复刻自 App.tsx 的 followup:open 跨页跳转范式。
 */

/** 与 ChatPage pendingImages 项格式一致，零适配。 */
export interface PendingChatImage {
  name: string
  dataUrl: string
}

/** 空态模块级常量，保证 selector 引用稳定（照搬 chat.ts IDLE_META 范式，避免无限重渲染）。 */
const EMPTY: PendingChatImage[] = []

interface ScreenshotState {
  pendingForChat: PendingChatImage[]
  /** 截图页调：push 一张待发送图。 */
  pushForChat: (img: PendingChatImage) => void
  /** ChatPage 调：取出全部待发送图并清空 store。 */
  consumeForChat: () => PendingChatImage[]
}

export const useScreenshotStore = create<ScreenshotState>((set, get) => ({
  pendingForChat: EMPTY,
  pushForChat: (img) =>
    set((s) => ({
      // push 时若是 EMPTY 引用需新建数组（不能 mutate 常量）
      pendingForChat: s.pendingForChat === EMPTY ? [img] : [...s.pendingForChat, img],
    })),
  consumeForChat: () => {
    const items = get().pendingForChat
    if (items.length > 0) set({ pendingForChat: EMPTY })
    return items
  },
}))
