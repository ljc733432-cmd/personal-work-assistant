import type OpenAI from 'openai'
import type { ChatMessage, ProviderType } from '../../types'

/**
 * Provider 抽象层（见 CONTEXT.md「Provider 抽象层」）。
 * 每家模型一份适配器，对外暴露统一的流式 chat。
 * 底层都走 OpenAI SDK，靠 baseURL+apiKey 切换。
 */

/** OpenAI tools 参数格式（与 chat.completions 的 tools 一致）。 */
export type ToolDef = OpenAI.Chat.ChatCompletionTool

/** 工具执行结果。分两种：
 *  - result：直接回灌给模型。
 *  - confirm：需要用户确认（如 write_file 覆盖），FC 循环会挂起弹窗。
 */
export type ToolHandlerResult =
  | { kind: 'result'; value: string }
  | { kind: 'confirm'; prompt: string; action: () => Promise<string> }

/** 工具执行器：本地执行 FC。返回 result 或 confirm（需挂起等用户）。
 *  第二个参数 confirm：用于工具内部需要"子确认"的场景（如访问新目录），可选。 */
export type ToolHandler = (
  args: Record<string, unknown>,
  confirm?: (prompt: string) => Promise<boolean>,
) => Promise<ToolHandlerResult | string> | ToolHandlerResult | string

export interface ToolRegistration {
  def: ToolDef
  handler: ToolHandler
}

/** 确认回调：FC 循环遇到 confirm 结果时调，传入 prompt，返回用户是否同意。 */
export type ConfirmCallback = (prompt: string) => Promise<boolean>

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
