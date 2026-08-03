import { randomUUID } from 'node:crypto'
import { eq, desc, and, gte } from 'drizzle-orm'
import { getDb } from '../db'
import { conversations, messages, settings, reminders } from '../db/schema'
import { createClientForProvider, listFollowupCandidates, listDueReminders } from '../providers/factory'
import { FOLLOWUP_SYSTEM_PROMPT, buildCandidatesContext } from './prompts'
import { logInfo } from '../logger'
import type { ScheduledTask } from 'node-cron'

/**
 * 跟进调度器（M6）。
 *
 * 见 CONTEXT.md §C「定时调度」「到点流程」、AGENTS.md §4。
 *
 * 设计（ADR-011：跟进会话主进程内部 insert，不走 IPC）：
 *  - 调度器跑在主进程，不依赖前端（到点时窗口可能关着）
 *  - 首条 AI 消息用非流式调用（照搬 taskExtractor 范式），落库后等用户点通知进来再看
 *  - 用户回复时走现有 chat:send（复用 confirmMap 二次确认机制）
 *  - 无候选任务 → 不调模型、不发通知（省 API，CONTEXT.md §C）
 *  - 未配置跟进模型 → 不调（托盘显示提示）
 */

export interface FollowupTickResult {
  conversationId: string
  count: number
  greeting: string
}

/** 从 settings 读跟进模型 id。 */
function getFollowupProviderId(): string | null {
  const row = getDb().select().from(settings).where(eq(settings.key, 'followup.providerId')).get()
  return row?.value ?? null
}

/**
 * 执行一次跟进检查（到点或手动触发都调这个）。
 * 无候选 / 未配模型 → 返回 null（调用方据此不发通知）。
 */
export async function runFollowupTick(): Promise<FollowupTickResult | null> {
  // 1. 读跟进模型配置
  const providerId = getFollowupProviderId()
  if (!providerId) {
    logInfo('[followup] 未配置跟进模型，跳过')
    return null
  }

  // 2. 查候选任务
  const candidates = listFollowupCandidates()
  if (candidates.length === 0) {
    logInfo('[followup] 无候选任务，跳过（省 API）')
    return null
  }

  // 3. 非流式调模型生成问候（照搬 taskExtractor 范式）
  const { client, model } = createClientForProvider(providerId)
  const res = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: FOLLOWUP_SYSTEM_PROMPT },
        { role: 'user', content: buildCandidatesContext(candidates) },
      ],
      stream: false,
      temperature: 0.7, // 跟进问候要自然，给点温度
      max_tokens: 1000,
    },
    { timeout: 30000 },
  )
  const greeting = res.choices?.[0]?.message?.content ?? '你好，来跟进一下任务进展吧。'

  // 4. 去重：今天已有 followup 会话则复用（在原会话追加问候），不新建。
  //    避免重复点"立即检查"/cron 多次触发产生一堆相似跟进会话。
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const startOfToday = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)
  const dateStr = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })

  const existing = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.type, 'followup'), gte(conversations.createdAt, startOfToday)))
    .orderBy(desc(conversations.createdAt))
    .all()[0]

  let conversationId: string
  if (existing) {
    // 复用今天的跟进会话
    conversationId = existing.id
    logInfo(`[followup] 复用今天的跟进会话 ${conversationId}`)
  } else {
    // 新建跟进会话
    conversationId = randomUUID()
    db.insert(conversations)
      .values({
        id: conversationId,
        title: `跟进 · ${dateStr}`,
        type: 'followup',
      })
      .run()
  }

  db.insert(messages)
    .values({
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      content: greeting,
      providerId,
    })
    .run()

  // 刷新会话 updatedAt（侧栏排序）
  db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversationId)).run()

  logInfo(`[followup] 跟进会话 ${conversationId}，候选 ${candidates.length} 个任务`)
  return { conversationId, count: candidates.length, greeting }
}

// ---------- cron 调度 ----------

let cronTask: ScheduledTask | null = null

/**
 * 启动 cron 调度。
 * @param cronExpression cron 表达式（默认 '0 9,14 * * *' = 每天 9:00 和 14:00）
 * @param onTick 到点回调（收到 FollowupTickResult 后弹通知等，由 main/index.ts 传入）
 */
export async function startFollowupScheduler(
  cronExpression: string,
  onTick: (result: FollowupTickResult | null) => void,
): Promise<void> {
  // 先停掉旧的（重新配置时）
  stopFollowupScheduler()

  const cron = await import('node-cron')
  if (!cron.validate(cronExpression)) {
    logInfo(`[followup] cron 表达式非法: ${cronExpression}，不启动调度`)
    return
  }

  cronTask = cron.schedule(cronExpression, async () => {
    logInfo('[followup] cron 到点，执行跟进检查')
    try {
      const result = await runFollowupTick()
      onTick(result)
    } catch (e) {
      logInfo('[followup] 跟进检查出错:', String(e))
    }
  })
  logInfo(`[followup] 调度器已启动: ${cronExpression}`)
}

/** 停止调度器（重配 / 退出时调）。 */
export function stopFollowupScheduler(): void {
  if (cronTask) {
    cronTask.stop()
    cronTask = null
  }
}

// ---------- Reminder 轮询（M12.5 v1.2 提醒功能） ----------
// 与 followup cron 并存的独立调度。followup 是定点（9:00/14:00）扫任务，
// reminder 是每分钟轮询 reminders 表里 time<=now && done=0 的行。
// 选 setInterval 而非 cron：提醒时间任意（精确到分），cron 表达式难以覆盖
// 「用户随时设的 N 分钟后」，轮询 60s 精度足够且实现简单（ADR-012 node-cron
// 是为定点语义选的；提醒是轮询语义，setInterval 更贴切）。

let reminderTimer: ReturnType<typeof setInterval> | null = null

/**
 * 启动提醒轮询。每分钟扫到期提醒，逐个触发 onDue 回调（main 弹通知）后标记 done。
 * @param onDue 到期回调（收到 Reminder 后弹通知等，由 main/index.ts 传入）
 */
export function startReminderPoller(
  onDue: (reminder: { id: string; content: string; time: number }) => void,
): void {
  stopReminderPoller()
  const POLL_INTERVAL_MS = 60 * 1000 // 每分钟扫一次

  const tick = () => {
    try {
      const due = listDueReminders()
      if (due.length === 0) return
      const db = getDb()
      for (const r of due) {
        onDue({ id: r.id, content: r.content, time: r.time })
        // 标记已触发，避免下轮重复
        db.update(reminders).set({ done: true }).where(eq(reminders.id, r.id)).run()
      }
      logInfo(`[reminder] 触发 ${due.length} 条到期提醒`)
    } catch (e) {
      logInfo('[reminder] 轮询出错:', String(e))
    }
  }

  // 启动后立即跑一次（处理应用关闭期间错过的提醒——但只弹当前到期的，
  // 过去很久的也会触发；如不希望补触发可在此加 time > now - 3600 守卫）
  tick()
  reminderTimer = setInterval(tick, POLL_INTERVAL_MS)
  logInfo('[reminder] 轮询已启动（每分钟）')
}

/** 停止提醒轮询（退出时调）。 */
export function stopReminderPoller(): void {
  if (reminderTimer) {
    clearInterval(reminderTimer)
    reminderTimer = null
  }
}
