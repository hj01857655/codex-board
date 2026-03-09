import type { TaskAuditRecord } from '@/store/taskAuditStore'

const TASK_AUDIT_KEY_PREFIX = 'cliproxy_task_audit_'

function taskAuditKey(endpoint: string): string {
  return `${TASK_AUDIT_KEY_PREFIX}${endpoint}`
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

function parseStatus(value: unknown): TaskAuditRecord['status'] {
  if (value === 'running') return 'running'
  if (value === 'success') return 'success'
  if (value === 'partial') return 'partial'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  return 'failed'
}

function parseType(value: unknown): TaskAuditRecord['type'] {
  if (value === 'test') return 'test'
  if (value === 'scan') return 'scan'
  if (value === 'bulk') return 'bulk'
  if (value === 'smart') return 'smart'
  return 'bulk'
}

function parseSource(value: unknown): TaskAuditRecord['source'] {
  if (value === 'auto') return 'auto'
  return 'manual'
}

function normalizeRecord(value: unknown): TaskAuditRecord | null {
  if (!isObject(value)) return null
  if (typeof value.taskId !== 'string' || !value.taskId) return null
  if (typeof value.label !== 'string' || !value.label) return null

  return {
    taskId: value.taskId,
    type: parseType(value.type),
    source: parseSource(value.source),
    label: value.label,
    scope: typeof value.scope === 'string' && value.scope ? value.scope : '默认',
    status: parseStatus(value.status),
    total: Math.max(0, parseNumber(value.total, 0)),
    done: Math.max(0, parseNumber(value.done, 0)),
    success: Math.max(0, parseNumber(value.success, 0)),
    failed: Math.max(0, parseNumber(value.failed, 0)),
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    startedAt: parseNumber(value.startedAt, Date.now()),
    finishedAt:
      value.finishedAt == null
        ? null
        : parseNumber(value.finishedAt, Date.now()),
  }
}

export function loadTaskAuditRecords(endpoint: string): TaskAuditRecord[] {
  if (!endpoint || !canUseStorage()) return []
  try {
    const raw = window.localStorage.getItem(taskAuditKey(endpoint))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => normalizeRecord(item))
      .filter((item): item is TaskAuditRecord => !!item)
  } catch {
    return []
  }
}

export function saveTaskAuditRecords(endpoint: string, records: TaskAuditRecord[]): void {
  if (!endpoint || !canUseStorage()) return
  try {
    window.localStorage.setItem(taskAuditKey(endpoint), JSON.stringify(records))
  } catch {
  }
}

export function clearTaskAuditRecords(endpoint: string): void {
  if (!endpoint || !canUseStorage()) return
  try {
    window.localStorage.removeItem(taskAuditKey(endpoint))
  } catch {
  }
}
