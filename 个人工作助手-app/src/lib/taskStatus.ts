/**
 * 任务「逻辑完成」判定（v1.10.8）。
 *
 * 背景：原 status==='done' 只反映单条任务自身状态。但用户心智里
 * 「一个任务完成」= 它和它的子任务都做完。否则会出现：
 *  - 概览「待办任务」数字对不上（根 done 但子任务 todo，子任务被算成 pending）
 *  - 任务分组时根任务进了「已完成」组但子任务还没做完，违反直觉
 *
 * 规则：根任务有子任务时，自身 status==='done' **且** 所有子任务 status==='done'
 * 才算逻辑完成；无子任务时只看自身 status。子任务只看自身 status。
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
 * 判定一条任务是否「逻辑完成」。
 * @param task 待判定的任务
 * @param subs 该任务的子任务数组（无子任务传 []）
 */
export function isLogicallyDone(task: Task, subs: Task[]): boolean {
  if (task.status !== 'done') return false
  // 根任务：所有子任务也要 done
  if (subs.length > 0) {
    return subs.every((s) => s.status === 'done')
  }
  return true
}

/**
 * 批量判定：给定全量任务列表，返回「逻辑完成」的任务 id 集合。
 * 给概览页/看板用（它们只有 tasks 数组，需自行建子任务索引）。
 */
export function computeLogicallyDoneIds(tasks: Task[]): Set<string> {
  const index = buildSubtaskIndex(tasks)
  const done = new Set<string>()
  for (const t of tasks) {
    const subs = t.parentId ? [] : index.get(t.id) ?? []
    // 子任务（parentId 非空）只看自身；根任务看自身+子任务
    if (t.parentId) {
      if (t.status === 'done') done.add(t.id)
    } else if (isLogicallyDone(t, subs)) {
      done.add(t.id)
    }
  }
  return done
}
