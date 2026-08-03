import { getTierById } from './tiers'

/**
 * 路由解析层（v1.6 M15 预留挂钩）。
 *
 * 当前实现（手动分层）：requested 是档位 id 则解析成 providerId，否则原样返回。
 * 渲染层 select 选档位时 value 已是 providerId（档位的），所以当前 chat:send 不强制调用此函数。
 *
 * 预留设计（未来自动路由 ADR-022 扩展点）：
 *  - 若 requested 是约定哨兵（如 'auto'），则根据 ctx（lastUserMessage/enableTools 等）
 *    用规则或分类器决定走哪个档位/providerId。
 *  - 当前函数签名已留 ctx 参数，现在不用，未来填充。
 *
 * 见 ADR-022：手动分层是第一步，自动判定是 v2 后续方向。
 */
export interface RouteContext {
  /** 最后一条 user 消息（未来自动路由的分类特征）。 */
  lastUserMessage?: string
  /** 是否启用 FC 工具（带工具的请求可能需要更强模型）。 */
  enableTools?: boolean
}

/**
 * 把请求的 providerId（可能是档位 id 或具体 provider id）解析成实际 providerId。
 * 当前：档位 id → 查档位表返回 providerId；其他原样返回。
 */
export function resolveProviderId(requested: string, _ctx?: RouteContext): string {
  // 先尝试当档位 id 查（档位 id 是 uuid，不会和 provider id 冲突）
  const tier = getTierById(requested)
  if (tier) return tier.providerId
  // 不是档位 id，当作具体 provider id 原样返回
  return requested
}
