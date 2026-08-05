/**
 * 任务「逻辑完成」判定（v1.10.8，v1.14 改递归支持无限层级）。
 *
 * 背景：原 status==='done' 只反映单条任务自身状态。但用户心智里
 * 「一个任务完成」= 它和它的所有后代都做完。否则会出现：
 *  - 概览「待办任务」数字对不上（根 done 但后代 todo，后代被算成 pending）
 *  - 任务分组时根任务进了「已完成」组但后代还没做完，违反直觉
 *
 * v1.14 规则（递归）：一个节点逻辑完成 = 自身 status==='done'
 * **且** 所有后代递归逻辑完成。无后代时只看自身 status。
 *
 * 纯函数 + 依赖注入 subtasksByParent，跨 TasksPage/Overview/Dashboard 复用。
 */
import type { Task } from '@/types'

/** 按 parentId 建子任务索引（与 TasksPage 的 subtasksByParent 同构，跨页复用）。 */
export function buildSubtaskIndex(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>()
  for (const t of tasks) {
    if (t.parentId) {
      const arr = map.get(t.parentId) ?? []
      arr.push(t)
      map.set(t.parentId, arr)
    }
  }
  return map
}

/**
 * 判定一条任务是否「逻辑完成」（递归，v1.14）。
 * @param task 待判定的任务
 * @param subs 该任务的直接子任务数组（无子任务传 []）
 * @param index 可选的全量子任务索引（递归判定孙子用）。不传则只看一层。
 */
export function isLogicallyDone(task: Task, subs: Task[], index?: Map<string, Task[]>): boolean {
  if (task.status !== 'done') return false
  if (subs.length === 0) return true
  // 递归：所有子任务也要逻辑完成（含它们的后代）
  return subs.every((s) => {
    const grandChildren = index?.get(s.id) ?? []
    return isLogicallyDone(s, grandChildren, index)
  })
}

/**
 * 批量判定：给定全量任务列表，返回「逻辑完成」的任务 id 集合（v1.14 递归）。
 * 给概览页/看板用（它们只有 tasks 数组，需自行建子任务索引）。
 *
 * 一个节点逻辑完成 = 自身 done 且所有后代递归 done。
 * 用记忆化避免重复递归（一个节点被判定一次）。
 */
export function computeLogicallyDoneIds(tasks: Task[]): Set<string> {
  const index = buildSubtaskIndex(tasks)
  const taskById = new Map<string, Task>()
  for (const t of tasks) taskById.set(t.id, t)

  const memo = new Map<string, boolean>()
  // 递归判定一个节点是否逻辑完成（含所有后代）
  function checkDone(id: string): boolean {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const task = taskById.get(id)
    if (!task) {
      memo.set(id, false)
      return false
    }
    if (task.status !== 'done') {
      memo.set(id, false)
      return false
    }
    const subs = index.get(id) ?? []
    const result = subs.length === 0 ? true : subs.every((s) => checkDone(s.id))
    memo.set(id, result)
    return result
  }

  const done = new Set<string>()
  for (const t of tasks) {
    if (checkDone(t.id)) done.add(t.id)
  }
  return done
}
