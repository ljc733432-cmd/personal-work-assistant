/**
 * 联网搜索适配层（见 CONTEXT.md「联网搜索」、ADR-002、PRD §4.4）。
 *
 * 设计：对外统一返回归一化的 SearchResult[]，内部按 provider type 路由。
 * 本轮实现 Tavily（ADR-002 终态双家的第一半，Bing 留扩展位）。
 *
 * 关键约束（与全项目一致）：
 *  - 所有函数返回 JSON 字符串（成功 {query,count,results} / 失败 {error}）。
 *  - 内部硬控结果数与摘要长度（token 预算），不暴露给模型。
 *  - 失败走友好降级（返回 error 字段），不抛错打断 FC 循环。
 *  - 主进程执行（PRD §6.2），不碰渲染层。
 */

import { logInfo, logError } from './logger'

/** 单条搜索结果归一化结构（必须含 url，供模型标注来源链接——PRD §7.1 V-I）。 */
export interface SearchResult {
  title: string
  url: string
  content: string
  score?: number
  publishedDate?: string
  truncated?: boolean // 摘要超长被截断时标记
}

/** 归一化后的活跃搜索配置（web_search 工具运行时从 ctx 读取）。 */
export interface ActiveSearchConfig {
  provider: 'tavily'
  apiKey: string
}

/** 工具入参（来自模型 FC 调用）。 */
export interface WebSearchParams {
  query: string
  maxResults?: number
  timeRange?: 'day' | 'week' | 'month' | 'year'
  topic?: 'general' | 'news' | 'finance'
}

// ---------- 内部硬控常量（token 预算，不暴露给模型） ----------
const MAX_RESULTS = 5
const MAX_SNIPPET_CHARS = 1000
const REQUEST_TIMEOUT_MS = 20000
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

/** web_search 工具主入口：取配置 → 路由到具体 provider → 返回 JSON 字符串。 */
export async function webSearch(
  params: WebSearchParams,
  getCfg: (() => ActiveSearchConfig | null) | undefined,
): Promise<string> {
  const query = (params.query ?? '').trim()
  if (!query) {
    return JSON.stringify({ error: 'query 不能为空' })
  }

  // 无配置 → 友好降级（工具始终注册，让模型知道能力；运行时降级）
  const cfg = getCfg?.()
  if (!cfg) {
    return JSON.stringify({
      error: '未配置联网搜索 Provider。请在「设置 → 联网搜索」添加（当前支持 Tavily）。',
    })
  }

  // 内部硬控 maxResults（不暴露给模型的上限，防要太多撑爆上下文）
  const maxResults = clampMaxResults(params.maxResults)
  const timeRange = params.timeRange
  const topic = params.topic ?? 'general'

  try {
    const results =
      cfg.provider === 'tavily'
        ? await searchWithTavily(cfg.apiKey, { query, maxResults, timeRange, topic })
        : []
    logInfo('[search] 成功：', query, `→ ${results.length} 条`)
    return JSON.stringify({
      query,
      provider: cfg.provider,
      count: results.length,
      results,
      hint: '请在回答里标注来源链接（用每条结果的 url）。',
    })
  } catch (e) {
    logError('[search] 失败：', query, String(e))
    return JSON.stringify({
      error: `搜索失败：${toFriendlyError(e)}`,
      hint: '可能是网络不可达或 API Key 无效。请检查「设置 → 联网搜索」配置。',
    })
  }
}

/** 设置页"测试连接"用：发一个最小 query，返回结果条数（验证 Key 可用 + 网络可达）。 */
export async function pingTavily(apiKey: string): Promise<number> {
  const results = await searchWithTavily(apiKey, {
    query: 'hello',
    maxResults: 1,
    topic: 'general',
  })
  return results.length
}

// ---------- Tavily 适配器 ----------
// API 规范（context7 最新版，2026-08 确认）：
//  POST https://api.tavily.com/search
//  headers: Authorization: Bearer <apiKey> + Content-Type: application/json
//  body: { query, search_depth, max_results, topic, time_range }
async function searchWithTavily(
  apiKey: string,
  opts: { query: string; maxResults: number; timeRange?: string; topic: string },
): Promise<SearchResult[]> {
  const body = {
    query: opts.query,
    search_depth: 'basic',
    max_results: opts.maxResults,
    topic: opts.topic,
    ...(opts.timeRange ? { time_range: normalizeTimeRange(opts.timeRange) } : {}),
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    if (!res.ok) {
      const detail = await safeReadText(res)
      throw new Error(`Tavily HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }

    const data = (await res.json()) as TavilyResponse
    const raw = Array.isArray(data?.results) ? data.results : []
    return raw.map(normalizeTavilyResult).filter((r) => r.url) as SearchResult[]
  } finally {
    clearTimeout(timer)
  }
}

/** Tavily 单条结果归一化（字段名 → 项目统一结构）。 */
function normalizeTavilyResult(r: TavilyResult): SearchResult {
  const content = typeof r.content === 'string' ? r.content : ''
  const truncated = content.length > MAX_SNIPPET_CHARS
  return {
    title: typeof r.title === 'string' ? r.title : '',
    url: typeof r.url === 'string' ? r.url : '',
    content: truncated ? content.slice(0, MAX_SNIPPET_CHARS) : content,
    truncated: truncated || undefined,
    ...(typeof r.score === 'number' ? { score: r.score } : {}),
    ...(typeof r.published_date === 'string' && r.published_date
      ? { publishedDate: r.published_date }
      : {}),
  }
}

// ---------- 辅助 ----------
function clampMaxResults(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : MAX_RESULTS
  if (v < 1) return 1
  if (v > MAX_RESULTS) return MAX_RESULTS
  return v
}

/** Tavily time_range 接受全称与首字母，统一用全称。 */
function normalizeTimeRange(r: string): string {
  const map: Record<string, string> = { d: 'day', w: 'week', m: 'month', y: 'year' }
  return map[r] ?? r
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** 把异常转成对用户/模型友好的中文提示。 */
function toFriendlyError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(e.message)) {
      return '网络不可达（可能需代理或断网）'
    }
    return e.message
  }
  return String(e)
}

// ---------- Tavily 响应类型（仅取用到的字段） ----------
interface TavilyResult {
  title?: string
  url?: string
  content?: string
  score?: number
  published_date?: string
}
interface TavilyResponse {
  results?: TavilyResult[]
}
