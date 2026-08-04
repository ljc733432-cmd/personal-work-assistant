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
  'search-provider:list',   // 列联网搜索 Provider（M5 搜索半）
  'search-provider:upsert', // 新增/更新搜索 Provider
  'search-provider:delete', // 删除搜索 Provider
  'search-provider:test',   // 测试搜索连接（发最小 query）
  'task:list',              // 列任务（M3）
  'task:upsert',            // 新增/更新任务
  'task:delete',            // 删除任务
  'task:extract',           // 抽取任务草稿（M4，不直接入库）
  'task:create_from_draft', // 草稿确认入库（M4，source=from_chat）
  'task:create_from_note',  // 笔记转任务（v1.9.1，source=from_note + sourceNotePath 溯源）
  'task:create_subtask',    // 子任务（v1.10，两级层级，parentId 关联父任务）
  'task:promote_subtask',   // 子任务转根任务（v1.10.1，清 parentId）
  'reminder:list',          // 列提醒（M12.5 v1.2）
  'reminder:upsert',        // 新增/更新提醒
  'reminder:delete',        // 删除提醒
  'pomodoro:record',        // 记录一次番茄钟（M12.6 v1.2）
  'pomodoro:list',          // 列番茄钟历史
  'note:list',              // 列笔记（M12.7 v1.2）
  'note:get',               // 读单条笔记
  'note:create',            // 新建笔记
  'note:update',            // 更新笔记
  'note:delete',            // 删除笔记
  'note:search',            // 全文搜笔记
  'note:getDir',            // 读笔记库目录
  'note:setDir',            // 设笔记库目录
  'convert:targets',        // 查转换支持的目标格式（M12.9 v1.2）
  'convert:run',            // 执行文档转换
  'convert:pickFile',       // 选输入文件（dialog）
  'pdf:info',               // PDF 工具箱：查页数（v1.7 M16）
  'pdf:merge',              // PDF 工具箱：合并
  'pdf:extract',            // PDF 工具箱：提取页
  'pdf:split',              // PDF 工具箱：拆分
  'pdf:pickFile',           // PDF 工具箱：选 PDF 文件（dialog）
  'conversation:list',      // 列会话（侧栏，M2）
  'conversation:create',    // 新建会话
  'conversation:rename',    // 重命名会话
  'conversation:setProvider', // 设置会话默认 provider（M15 档位记忆）
  'conversation:delete',    // 删除会话（级联删消息）
  'message:list',           // 列某会话全部消息（历史 hydrate，M2）
  'message:insert',         // 写单条消息（chat:send 落库用，M2）
  'dashboard:activity',     // 看板：按天聚合消息数（v1.4 M14）
  'report:generate',        // AI 日报/周报：聚合任务/对话/番茄/提醒生成报告笔记（v1.8 M17）
  'report:preview',         // 报告数据预览：返各类计数，不调模型（v1.8.1 打磨）
  'report:cancel',          // 取消进行中的报告生成（v1.8.1 打磨）
  'note:ai',                // AI 笔记助手：摘要/待办/提问/续写（v1.9 M18）
  'note:ai_cancel',         // 取消进行中的笔记 AI 操作（v1.9 M18）
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
  'chat:truncated',         // 上下文截断提示（M2-Step7：已省略较早的 X 条）
  'followup:open',          // M6：跟进通知点击，通知渲染层跳转跟进会话
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
