import type { ToolRegistration } from './providers/types'

/**
 * 内置工具集（FC）。
 * M1：只注册一个 get_current_time 用于 TV-1 实测。
 * M4+ 会加 task/web_search/read_file/write_file 等。
 */

/** 当前时间工具：让模型验证整条 FC 链路（AGENTS.md §4）。 */
export const getCurrentTimeTool: ToolRegistration = {
  def: {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前的本地日期和时间。当用户询问现在几点、今天日期时调用。',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: '可选时区提示，如 Asia/Shanghai',
          },
        },
        required: [],
      },
    },
  },
  handler: () => {
    const now = new Date()
    return JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      weekday: now.toLocaleDateString('zh-CN', { weekday: 'long' }),
    })
  },
}

/** M1 实测用的工具集合。 */
export const builtinTools: ToolRegistration[] = [getCurrentTimeTool]
