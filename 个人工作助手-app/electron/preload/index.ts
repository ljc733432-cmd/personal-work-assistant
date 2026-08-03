import { contextBridge, ipcRenderer } from 'electron'

/**
 * 预加载脚本：用 contextBridge 向渲染进程暴露【白名单】API。
 *
 * 红线（见 AGENTS.md §6）：
 *  - 绝不暴露 ipcRenderer 全量，不暴露 require / node API。
 *  - 渲染进程只能调这里显式列出的 channel。
 *
 * 所有 IPC channel 在此集中声明，主进程 handler 必须与之对齐。
 */

// ---------- 受信任的 IPC channel 清单 ----------
const ALLOWED_INVOKE = [
  'provider:list',          // 列出所有 Provider 配置
  'provider:upsert',        // 新增/更新 Provider
  'provider:delete',        // 删除 Provider
  'provider:test',          // 测试连接（发 ping）
  'chat:send',              // 发起一次对话（含历史 + 工具）
  'settings:get',           // 读 KV 设置
  'settings:set',           // 写 KV 设置
  'db:health',              // 数据库健康检查（M1 验证落库用）
  'meta:provider-presets',  // 取 Provider 预设（设置页填默认值用）
  'workdir:list',           // 列工作目录白名单（M5）
  'workdir:upsert',         // 新增/更新工作目录
  'workdir:delete',         // 删除工作目录
  'workdir:pick',           // 弹目录选择对话框（M5）
] as const

const ALLOWED_SEND = [
  'chat:cancel',            // 取消对话
  'chat:confirm_response',  // 工具确认结果回传（write_file 覆盖确认，M5）
] as const

// 主进程主动推给渲染层的 channel（流式 token、状态变更确认等）
const ALLOWED_ON = [
  'chat:token',             // 流式增量 token
  'chat:first_token',       // 首字到达（含延迟毫秒，诊断回复慢）
  'chat:done',              // 一轮对话结束
  'chat:error',             // 出错
  'chat:tool_call',         // 模型发起 FC（用于二次确认类操作，M6 用）
  'chat:confirm_request',   // 工具需要用户确认（write_file 覆盖，M5）
] as const

function isAllowed(value: string, list: readonly string[]): boolean {
  return (list as readonly string[]).includes(value)
}

const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!isAllowed(channel, ALLOWED_INVOKE)) {
      throw new Error(`IPC invoke blocked: ${channel}（未在白名单）`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  send: (channel: string, ...args: unknown[]) => {
    if (!isAllowed(channel, ALLOWED_SEND)) {
      throw new Error(`IPC send blocked: ${channel}（未在白名单）`)
    }
    ipcRenderer.send(channel, ...args)
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!isAllowed(channel, ALLOWED_ON)) {
      throw new Error(`IPC on blocked: ${channel}（未在白名单）`)
    }
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, handler)
    // 返回取消订阅函数，避免内存泄漏
    return () => ipcRenderer.removeListener(channel, handler)
  },
}

export type ExposedAPI = typeof api

// 通过 contextBridge 暴露为 window.api
contextBridge.exposeInMainWorld('api', api)
