import OpenAI from 'openai'
import { eq, desc, and, or, ne, lte, asc, isNotNull } from 'drizzle-orm'
import { getDb } from '../db'
import { providers, workDirs, tasks, reminders } from '../db/schema'
import { getSecret } from '../secret'
import type { Provider, WorkDir, Task, Reminder } from '../../types'

/**
 * Provider 加载 + OpenAI client 工厂。
 *
 * 业务模型：库里存 Provider 配置（含 apiKeyRef），明文 Key 在 safeStorage。
 * 运行时按 providerId 查库 → 取明文 Key → 构造 OpenAI client。
 */

/** 按 id 读 Provider 行（drizzle 行 → 对外 Provider 类型）。 */
export function getProvider(providerId: string): Provider | null {
  const row = getDb().select().from(providers).where(eq(providers.id, providerId)).get()
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseURL: row.baseURL,
    model: row.model,
    apiKeyRef: row.apiKeyRef,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 列出全部 Provider。 */
export function listProviders(): Provider[] {
  return getDb()
    .select()
    .from(providers)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      baseURL: row.baseURL,
      model: row.model,
      apiKeyRef: row.apiKeyRef,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
}

/**
 * 为某个 Provider 构造 OpenAI client。
 * 明文 Key 从 safeStorage 解密读取，不落变量以外的地方。
 */
export function createClientForProvider(providerId: string): {
  client: OpenAI
  model: string
} {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Provider 不存在: ${providerId}`)
  if (!provider.enabled) throw new Error(`Provider 已禁用: ${provider.name}`)

  const apiKey = getSecret(provider.apiKeyRef)
  if (!apiKey) throw new Error(`Provider「${provider.name}」未配置 API Key（或 Key 已损坏）`)

  const client = new OpenAI({
    apiKey,
    baseURL: provider.baseURL,
  })
  return { client, model: provider.model }
}

// ---------- WorkDir CRUD ----------

/** 列出全部启用的 WorkDir（文件工具运行时用）。 */
export function listEnabledWorkDirs(): WorkDir[] {
  return getDb()
    .select()
    .from(workDirs)
    .where(eq(workDirs.enabled, true))
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      path: r.path,
      mode: r.mode,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
}

/** 列出全部 WorkDir（含禁用，设置页用）。 */
export function listAllWorkDirs(): WorkDir[] {
  return getDb()
    .select()
    .from(workDirs)
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      path: r.path,
      mode: r.mode,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
}

// ---------- Task CRUD（只读放这里，写操作在 ipc） ----------

/** drizzle Task 行 → 对外 Task 类型（listTasks/listFollowupCandidates 共用）。 */
function rowToTask(r: typeof tasks.$inferSelect): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    dueDate: r.dueDate,
    source: r.source,
    sourceConversationId: r.sourceConversationId,
    sourceNotePath: r.sourceNotePath,
    parentId: r.parentId,
    followupLog: r.followupLog,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** 列出全部 Task（任务页用）。按更新时间倒序（最近改的在前）。 */
export function listTasks(): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .orderBy(desc(tasks.updatedAt))
    .all()
    .map(rowToTask)
}

/**
 * 列出跟进候选任务（M6 调度器用，见 CONTEXT.md「到点流程」）。
 * 条件：未完成 AND（今天到期/逾期 OR 高优先级）。
 *   - status != 'done'
 *   - (dueDate <= 今天 23:59:59) OR (priority = 'high')
 * 按 dueDate 升序（最紧的在前；无 dueDate 的 high 优先级排后）。
 */
export function listFollowupCandidates(): Task[] {
  // 今天 23:59:59 的 Unix 秒
  const endOfToday = Math.floor(new Date().setHours(23, 59, 59, 999) / 1000)
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        ne(tasks.status, 'done'),
        or(
          // 今天到期 + 逾期（dueDate 非空且 <= 今天末）
          and(isNotNull(tasks.dueDate), lte(tasks.dueDate, endOfToday)),
          // 高优先级未完成（即使无 dueDate 也跟）
          eq(tasks.priority, 'high'),
        ),
      ),
    )
    .orderBy(asc(tasks.dueDate))
    .all()
    .map(rowToTask)
}

// ---------- Reminder 查询（M12.5 v1.2 工具扩展，只读放这里，写在 ipc） ----------

/** drizzle Reminder 行 → 对外 Reminder 类型。 */
function rowToReminder(r: typeof reminders.$inferSelect): Reminder {
  return {
    id: r.id,
    time: r.time,
    content: r.content,
    done: r.done,
    source: r.source,
    createdAt: r.createdAt,
  }
}

/** 列出全部提醒（工具页用）。未触发的按时间升序在前，已触发的排后。 */
export function listReminders(): Reminder[] {
  return getDb()
    .select()
    .from(reminders)
    .orderBy(asc(reminders.done), asc(reminders.time))
    .all()
    .map(rowToReminder)
}

/**
 * 列出已到期但未触发的提醒（M12.5 调度器轮询用）。
 * 条件：done=0 AND time<=now。按时间升序（最早的先触发）。
 */
export function listDueReminders(): Reminder[] {
  const now = Math.floor(Date.now() / 1000)
  return getDb()
    .select()
    .from(reminders)
    .where(and(eq(reminders.done, false), lte(reminders.time, now)))
    .orderBy(asc(reminders.time))
    .all()
    .map(rowToReminder)
}
