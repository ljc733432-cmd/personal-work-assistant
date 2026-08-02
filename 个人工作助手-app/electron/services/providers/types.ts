import type OpenAI from 'openai'
import type { ChatMessage, ProviderType } from '../../types'

/**
 * Provider 抽象层（见 CONTEXT.md「Provider 抽象层」）。
 * 每家模型一份适配器，对外暴露统一的流式 chat。
 * 底层都走 OpenAI SDK，靠 baseURL+apiKey 切换。
 */

/** OpenAI tools 参数格式（与 chat.completions 的 tools 一致）。 */
export type ToolDef = OpenAI.Chat.ChatCompletionTool

/** 工具执行器：主进程本地执行 FC，返回结果字符串回灌给模型。 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string

export interface ToolRegistration {
  def: ToolDef
  handler: ToolHandler
}

/** 一次 chat 请求的入参。 */
export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolRegistration[]
  signal?: AbortSignal
}

/** 流式回调：每收到一段文本 token 调一次。 */
export type OnToken = (text: string) => void

/**
 * 每家 Provider 的工厂：给定 apiKey 和 model，返回一个 OpenAI client。
 * 这里只返回工厂签名，具体见 providers/ 目录下各适配器。
 */
export type ProviderClientFactory = (opts: {
  apiKey: string
  baseURL: string
}) => OpenAI

/** 各 ProviderType 的默认配置（写死在代码里，新增/更新走设置页）。 */
export interface ProviderPreset {
  type: ProviderType
  defaultBaseURL: string
  defaultModel: string
  displayName: string
}

export const PROVIDER_PRESETS: Record<ProviderType, ProviderPreset> = {
  deepseek: {
    type: 'deepseek',
    defaultBaseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    displayName: 'DeepSeek',
  },
  zhipu: {
    type: 'zhipu',
    // 智谱 OpenAI 兼容端点（见 ADR-003 / TV-1）
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5-air',
    displayName: '智谱 GLM',
  },
  custom: {
    type: 'custom',
    defaultBaseURL: '',
    defaultModel: '',
    displayName: '自定义',
  },
}
