import { create } from 'zustand'

export type TaskAuditType = 'test' | 'scan' | 'bulk' | 'smart'
export type TaskAuditSource = 'manual' | 'auto'
export type TaskAuditStatus = 'running' | 'success' | 'partial' | 'failed' | 'cancelled'

export interface TaskAuditRecord {
  taskId: string
  type: TaskAuditType
  source: TaskAuditSource
  label: string
  scope: string
  status: TaskAuditStatus
  total: number
  done: number
  success: number
  failed: number
  detail?: string
  startedAt: number
  finishedAt: number | null
}

interface StartTaskInput {
  type: TaskAuditType
  source: TaskAuditSource
  label: string
  scope?: string
  total: number
  detail?: string
}

interface UpdateTaskInput {
  done?: number
  success?: number
  failed?: number
  detail?: string
  status?: TaskAuditStatus
}

interface FinishTaskInput {
  status: Exclude<TaskAuditStatus, 'running'>
  done?: number
  success?: number
  failed?: number
  detail?: string
}

interface TaskAuditStore {
  records: TaskAuditRecord[]
  startTask: (input: StartTaskInput) => string
  updateTask: (taskId: string, input: UpdateTaskInput) => void
  finishTask: (taskId: string, input: FinishTaskInput) => void
  clear: () => void
}

const MAX_RECORDS = 120

function makeTaskId(type: TaskAuditType): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${type}-${stamp}-${rand}`
}

function upsertRecord(
  records: TaskAuditRecord[],
  taskId: string,
  updater: (record: TaskAuditRecord) => TaskAuditRecord
): TaskAuditRecord[] {
  const index = records.findIndex((record) => record.taskId === taskId)
  if (index === -1) return records
  const next = [...records]
  next[index] = updater(next[index])
  return next
}

export const useTaskAuditStore = create<TaskAuditStore>((set) => ({
  records: [],

  startTask: (input) => {
    const taskId = makeTaskId(input.type)
    const now = Date.now()

    const nextRecord: TaskAuditRecord = {
      taskId,
      type: input.type,
      source: input.source,
      label: input.label,
      scope: input.scope ?? '默认',
      status: 'running',
      total: Math.max(0, input.total),
      done: 0,
      success: 0,
      failed: 0,
      detail: input.detail,
      startedAt: now,
      finishedAt: null,
    }

    set((state) => ({
      records: [nextRecord, ...state.records].slice(0, MAX_RECORDS),
    }))

    return taskId
  },

  updateTask: (taskId, input) => {
    set((state) => ({
      records: upsertRecord(state.records, taskId, (record) => ({
        ...record,
        done: input.done ?? record.done,
        success: input.success ?? record.success,
        failed: input.failed ?? record.failed,
        detail: input.detail ?? record.detail,
        status: input.status ?? record.status,
      })),
    }))
  },

  finishTask: (taskId, input) => {
    set((state) => ({
      records: upsertRecord(state.records, taskId, (record) => ({
        ...record,
        status: input.status,
        done: input.done ?? record.done,
        success: input.success ?? record.success,
        failed: input.failed ?? record.failed,
        detail: input.detail ?? record.detail,
        finishedAt: Date.now(),
      })),
    }))
  },

  clear: () => set({ records: [] }),
}))
