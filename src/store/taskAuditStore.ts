import { create } from 'zustand'
import { loadTaskAuditRecords, saveTaskAuditRecords } from '@/lib/taskAuditStorage'

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
  endpoint: string | null
  records: TaskAuditRecord[]
  bindEndpoint: (endpoint: string | null | undefined) => void
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

function normalizeEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null
  const trimmed = endpoint.trim()
  return trimmed.length > 0 ? trimmed : null
}

function trimRecords(records: TaskAuditRecord[]): TaskAuditRecord[] {
  if (records.length <= MAX_RECORDS) return records
  return records.slice(0, MAX_RECORDS)
}

export const useTaskAuditStore = create<TaskAuditStore>((set, get) => {
  function persistCurrentRecords(): void {
    const state = get()
    if (!state.endpoint) return
    saveTaskAuditRecords(state.endpoint, state.records)
  }

  return {
    endpoint: null,
    records: [],

    bindEndpoint: (endpoint) => {
      const normalized = normalizeEndpoint(endpoint)
      if (!normalized) {
        set({ endpoint: null, records: [] })
        return
      }

      const loaded = trimRecords(loadTaskAuditRecords(normalized))
      set({ endpoint: normalized, records: loaded })
    },

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
        records: trimRecords([nextRecord, ...state.records]),
      }))

      persistCurrentRecords()
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

      persistCurrentRecords()
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

      persistCurrentRecords()
    },

    clear: () => {
      set({ records: [] })
      persistCurrentRecords()
    },
  }
})
