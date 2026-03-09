import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useCredStore } from '@/store/credStore'
import { useConnection } from '@/hooks/useConnection'
import { useBatchTest, type BatchTestMode } from '@/hooks/useBatchTest'
import { useBatchTestStore } from '@/store/batchTestStore'
import { getProviderColor } from '@/utils/keyUtils'
import { getEffectiveStatus, isExpiredStatus } from '@/utils/statusUtils'
import { deleteAuthFile, patchAuthFileStatus } from '@/lib/management'
import { runOperationInPool, type OperationPoolResult, type OperationProgressSnapshot } from '@/lib/operationOrchestrator'
import { useTaskAuditStore, type TaskAuditStatus } from '@/store/taskAuditStore'
import { appendFailedNameHint, buildFailedNameHint } from '@/components/credentials/bulkSummary'
import CredentialTable, { type SortMode } from './CredentialTable'
import UploadModal from './UploadModal'
import type { AuthFile } from '@/types/api'

type TaskFinishedStatus = Exclude<TaskAuditStatus, 'running'>
type QuickFilter = 'all' | 'expired' | 'quota' | 'has-quota' | 'disabled' | 'other' | 'error' | 'can-enable'
type TestScope = 'page' | 'filtered' | 'provider'
const SORT_MODE_KEY = 'cliproxy_sort_mode'
const PAGE_SIZE_KEY = 'cliproxy_page_size'
const TEST_MODE_KEY = 'cliproxy_test_mode'
const CONCURRENCY_OVERRIDE_KEY = 'cliproxy_concurrency_override'
const DEFAULT_PAGE_SIZE = 200
const VALID_PAGE_SIZES = [50, 100, 200, 500, 1000] as const
type PageSize = (typeof VALID_PAGE_SIZES)[number]
const VALID_TEST_MODES: BatchTestMode[] = ['untested', 'all', 'error', 'expired', 'quota']
const VALID_CONCURRENCY_VALUES = [8, 12, 16, 20, 24, 32, 40, 48] as const
type ConcurrencyOverride = 'auto' | `${(typeof VALID_CONCURRENCY_VALUES)[number]}`
const AUTO_SCAN_ENABLED_KEY = 'cliproxy_auto_scan_enabled'
const AUDIT_PANEL_EXPANDED_KEY = 'cliproxy_audit_panel_expanded'
const AUTO_REENABLE_STALE_MS = 30 * 60 * 1000
const AUTO_REENABLE_MAX_TARGETS = 300
const AUTO_REENABLE_MIN_GAP_MS = 8_000
const AUTO_SCAN_DUE_DELAY_MS = 5_000
const AUTO_SCAN_MIN_DELAY_MS = 15_000
const AUTO_SCAN_MAX_DELAY_MS = 5 * 60_000
const AUTO_SCAN_IDLE_DELAY_MS = 90_000
const AUTO_SCAN_BLOCKED_DELAY_MS = 20_000
const LARGE_TEST_WARN_THRESHOLD = 1_000
const LARGE_TEST_STRONG_CONFIRM_THRESHOLD = 5_000
const BULK_ACTION_CONCURRENCY = 8
const BULK_PROGRESS_UPDATE_INTERVAL_MS = 120

type AutoScanReason = 'idle' | 'due' | 'scheduled' | 'blocked' | 'off'
type BulkSummary = { label: string; success: number; failed: number; detail?: string }
type BulkOperationRunResult = OperationPoolResult & { failedNames: string[] }
type BulkOperationProgress = Pick<OperationProgressSnapshot, 'done' | 'total' | 'success' | 'failed'>
type BulkOperationRunOptions = {
  showSummary?: boolean
  clearSelectionAfter?: boolean
  closeMenu?: boolean
  onProgress?: (progress: BulkOperationProgress) => void
}
const VALID_SORT_MODES: SortMode[] = [
  'default', 'quota-first', 'status-first',
  'name-asc', 'name-desc',
  'quota-asc', 'quota-desc',
  'status-asc', 'status-desc',
  'reset-asc', 'reset-desc',
  'refresh-asc', 'refresh-desc',
]

function loadSortMode(): SortMode {
  if (typeof window === 'undefined') return 'default'
  const value = window.localStorage.getItem(SORT_MODE_KEY)
  if (value && (VALID_SORT_MODES as string[]).includes(value)) {
    return value as SortMode
  }
  return 'default'
}

function loadPageSize(): PageSize {
  if (typeof window === 'undefined') return DEFAULT_PAGE_SIZE
  const raw = window.localStorage.getItem(PAGE_SIZE_KEY)
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && VALID_PAGE_SIZES.includes(parsed as PageSize)) {
    return parsed as PageSize
  }
  return DEFAULT_PAGE_SIZE
}

function loadTestMode(): BatchTestMode {
  if (typeof window === 'undefined') return 'untested'
  const raw = window.localStorage.getItem(TEST_MODE_KEY)
  if (raw && VALID_TEST_MODES.includes(raw as BatchTestMode)) {
    return raw as BatchTestMode
  }
  return 'untested'
}

function loadConcurrencyOverride(): ConcurrencyOverride {
  if (typeof window === 'undefined') return 'auto'
  const raw = window.localStorage.getItem(CONCURRENCY_OVERRIDE_KEY)
  if (!raw || raw === 'auto') return 'auto'
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && VALID_CONCURRENCY_VALUES.includes(parsed as (typeof VALID_CONCURRENCY_VALUES)[number])) {
    return String(parsed) as ConcurrencyOverride
  }
  return 'auto'
}

function loadAutoScanEnabled(): boolean {
  if (typeof window === 'undefined') return true
  const raw = window.localStorage.getItem(AUTO_SCAN_ENABLED_KEY)
  if (raw == null) return true
  return raw !== '0' && raw.toLowerCase() !== 'false'
}

function loadAuditPanelExpanded(): boolean {
  if (typeof window === 'undefined') return false
  const raw = window.localStorage.getItem(AUDIT_PANEL_EXPANDED_KEY)
  if (!raw) return false
  return raw === '1' || raw.toLowerCase() === 'true'
}

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

function resolveTaskOutcomeStatus(success: number, failed: number): TaskFinishedStatus {
  if (failed <= 0) return 'success'
  if (success > 0) return 'partial'
  return 'failed'
}

function getTaskStatusText(status: TaskAuditStatus): string {
  if (status === 'running') return '执行中'
  if (status === 'success') return '成功'
  if (status === 'partial') return '部分成功'
  if (status === 'failed') return '失败'
  return '已取消'
}

function getTaskStatusClass(status: TaskAuditStatus): string {
  if (status === 'running') return 'bg-[#FFF7ED] text-[#9A6B1E]'
  if (status === 'success') return 'bg-[#F6FBF7] text-[#2D7A3F]'
  if (status === 'partial') return 'bg-[#FFF7ED] text-[#9A6B1E]'
  if (status === 'failed') return 'bg-[#FFF0F0] text-[#B94040]'
  return 'bg-[#F3F3F3] text-[#6B6560]'
}

function shortTaskId(taskId: string): string {
  return taskId.length > 24 ? taskId.slice(0, 24) + '...' : taskId
}

function mergeFailedNames(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat().filter((name) => name.length > 0)))
}

export default function CredentialTabs() {
  const [activeProvider, setActiveProvider] = useState<string>('全部')
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const [bulkDisabling, setBulkDisabling] = useState(false)
  const [bulkSummary, setBulkSummary] = useState<BulkSummary | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(() => loadSortMode())
  const [searchQuery, setSearchQuery] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [bulkProgress, setBulkProgress] = useState<{ label: string; done: number; total: number } | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [pageSize, setPageSize] = useState<PageSize>(() => loadPageSize())
  const [testMode, setTestMode] = useState<BatchTestMode>(() => loadTestMode())
  const [testScope, setTestScope] = useState<TestScope>('filtered')
  const [concurrencyOverride, setConcurrencyOverride] = useState<ConcurrencyOverride>(() => loadConcurrencyOverride())
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(() => loadAutoScanEnabled())
  const [auditPanelExpanded, setAuditPanelExpanded] = useState<boolean>(() => loadAuditPanelExpanded())
  const [scanRunning, setScanRunning] = useState(false)
  const [scanSummary, setScanSummary] = useState<string | null>(null)
  const [autoScanNextAt, setAutoScanNextAt] = useState<number | null>(null)
  const [autoScanDueCount, setAutoScanDueCount] = useState(0)
  const [autoScanReason, setAutoScanReason] = useState<AutoScanReason>('idle')
  const [pageJumpInput, setPageJumpInput] = useState('1')
  const menuRef = useRef<HTMLDivElement>(null)
  const lastAutoScanAtRef = useRef(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SORT_MODE_KEY, sortMode)
  }, [sortMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(PAGE_SIZE_KEY, String(pageSize))
  }, [pageSize])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(TEST_MODE_KEY, testMode)
  }, [testMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (concurrencyOverride === 'auto') {
      window.localStorage.removeItem(CONCURRENCY_OVERRIDE_KEY)
      return
    }
    window.localStorage.setItem(CONCURRENCY_OVERRIDE_KEY, concurrencyOverride)
  }, [concurrencyOverride])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(AUTO_SCAN_ENABLED_KEY, autoScanEnabled ? '1' : '0')
  }, [autoScanEnabled])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(AUDIT_PANEL_EXPANDED_KEY, auditPanelExpanded ? '1' : '0')
  }, [auditPanelExpanded])


  useEffect(() => {
    if (!bulkMenuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setBulkMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [bulkMenuOpen])

  useEffect(() => {
    if (!scanSummary) return
    const timer = window.setTimeout(() => setScanSummary(null), 5000)
    return () => window.clearTimeout(timer)
  }, [scanSummary])

  useEffect(() => {
    if (!bulkSummary) return
    const timer = window.setTimeout(() => setBulkSummary(null), 5000)
    return () => window.clearTimeout(timer)
  }, [bulkSummary])

  const files = useCredStore((s) => s.files)
  const testResults = useCredStore((s) => s.testResults)
  const client = useCredStore((s) => s.client)
  const loading = useCredStore((s) => s.loading)
  const refreshing = useCredStore((s) => s.refreshing)
  const connectionEndpoint = useCredStore((s) => s.connection?.endpoint ?? null)
  const { updateFile, removeFile, clearSelection } = useCredStore.getState()
  const { refresh } = useConnection()
  const { testBatch, isRunning } = useBatchTest()
  const bindAuditEndpoint = useTaskAuditStore((s) => s.bindEndpoint)
  const auditRecords = useTaskAuditStore((s) => s.records)
  const recentAuditTasks = useMemo(() => auditRecords.slice(0, 3), [auditRecords])
  const runningAuditCount = useMemo(
    () => auditRecords.filter((record) => record.status === 'running').length,
    [auditRecords]
  )
  const latestAuditTask = recentAuditTasks[0] ?? null
  const [currentPage, setCurrentPage] = useState(1)

  useEffect(() => {
    bindAuditEndpoint(connectionEndpoint)
  }, [bindAuditEndpoint, connectionEndpoint])

  const providers = useMemo(() => {
    const set = new Set(files.map((f) => f.provider || f.type || '未知'))
    return ['全部', ...Array.from(set).sort()]
  }, [files])

  function getQuotaRemainingPercent(file: AuthFile): number | null {
    const result = testResults[file.name]
    if (result?.quota?.rate_limit.primary_window) {
      const usedPercent = result.quota.rate_limit.primary_window.used_percent ?? 100
      return Math.max(0, Math.min(100, 100 - usedPercent))
    }

    const snap = result?.copilotQuota?.quota_snapshots?.premium_interactions
    if (snap?.unlimited) return 100
    const entitlement = snap?.entitlement ?? 0
    const remaining = snap?.remaining ?? snap?.quota_remaining ?? 0
    if (entitlement > 0) {
      return Math.max(0, Math.min(100, Math.round((remaining / entitlement) * 100)))
    }

    const status = getEffectiveStatus(file, testResults[file.name])
    if (status === 'valid') return 100
    if (status === 'quota') return 0
    return null
  }

  function getStatusRank(file: AuthFile): number {
    if (file.disabled) return 99
    const status = getEffectiveStatus(file, testResults[file.name])
    if (status === 'valid') return 0
    if (status === 'testing') return 1
    if (status === 'quota') return 3
    if (status === 'expired' || status === 'error') return 4
    return 2
  }

  function hasAvailableQuotaByResult(file: AuthFile, result: typeof testResults[string] | undefined): boolean {
    const codexRateLimit = result?.quota?.rate_limit
    if (codexRateLimit) {
      return codexRateLimit.allowed && !codexRateLimit.limit_reached
    }

    const copilotSnapshot = result?.copilotQuota?.quota_snapshots?.premium_interactions
    if (copilotSnapshot) {
      if (copilotSnapshot.unlimited) return true
      const remaining = copilotSnapshot.remaining ?? copilotSnapshot.quota_remaining ?? 0
      const entitlement = copilotSnapshot.entitlement ?? 0
      if (entitlement > 0) return remaining > 0
      return remaining > 0
    }

    const status = getEffectiveStatus(file, result)
    return status === 'valid'
  }

  function hasAvailableQuota(file: AuthFile): boolean {
    return hasAvailableQuotaByResult(file, testResults[file.name])
  }

  function getQuotaResetTimestamp(file: AuthFile): number | null {
    const result = testResults[file.name]

    const codexWindow = result?.quota?.rate_limit.primary_window
    if (codexWindow) {
      if (typeof codexWindow.reset_at === 'number' && Number.isFinite(codexWindow.reset_at) && codexWindow.reset_at > 0) {
        return codexWindow.reset_at > 1_000_000_000_000
          ? codexWindow.reset_at
          : codexWindow.reset_at * 1000
      }
      if (
        typeof codexWindow.reset_after_seconds === 'number'
        && Number.isFinite(codexWindow.reset_after_seconds)
        && codexWindow.reset_after_seconds >= 0
        && Number.isFinite(result?.testedAt)
      ) {
        return result.testedAt + codexWindow.reset_after_seconds * 1000
      }
    }

    const copilotReset = result?.copilotQuota?.quota_reset_date
    if (copilotReset) {
      const parsed = new Date(copilotReset).getTime()
      if (Number.isFinite(parsed)) return parsed
    }

    if (file.next_retry_after) {
      const parsed = new Date(file.next_retry_after).getTime()
      if (Number.isFinite(parsed)) return parsed
    }

    return null
  }

  function isHiddenTestingStatus(file: AuthFile): boolean {
    const status = getEffectiveStatus(file, testResults[file.name])
    return status === 'queued' || status === 'testing' || status === 'retrying'
  }

  function pickReenableScanTargets(source: AuthFile[]): AuthFile[] {
    const now = Date.now()
    const candidates = source.filter((file) => {
      if (!file.disabled) return false
      if (isHiddenTestingStatus(file)) return false

      const result = testResults[file.name]
      const resetAt = getQuotaResetTimestamp(file)
      if (resetAt !== null) {
        return resetAt <= now
      }
      if (!result) return false
      return now - result.testedAt >= AUTO_REENABLE_STALE_MS
    })

    candidates.sort((a, b) => {
      const aReset = getQuotaResetTimestamp(a) ?? Number.POSITIVE_INFINITY
      const bReset = getQuotaResetTimestamp(b) ?? Number.POSITIVE_INFINITY
      if (aReset !== bReset) return aReset - bReset
      const aTestedAt = testResults[a.name]?.testedAt ?? 0
      const bTestedAt = testResults[b.name]?.testedAt ?? 0
      return aTestedAt - bTestedAt
    })

    return candidates.slice(0, AUTO_REENABLE_MAX_TARGETS)
  }

  function buildAutoReenableScanPlan(source: AuthFile[]): { delayMs: number; dueCount: number; reason: Exclude<AutoScanReason, 'off' | 'blocked'> } {
    const now = Date.now()
    let dueCount = 0
    let minWaitMs = Number.POSITIVE_INFINITY
    let hasDisabledCandidate = false

    for (const file of source) {
      if (!file.disabled) continue
      if (isHiddenTestingStatus(file)) continue
      hasDisabledCandidate = true

      const resetAt = getQuotaResetTimestamp(file)
      if (resetAt !== null) {
        const waitMs = resetAt - now
        if (waitMs <= 0) {
          dueCount += 1
        } else if (waitMs < minWaitMs) {
          minWaitMs = waitMs
        }
        continue
      }

      const result = testResults[file.name]
      if (!result) continue
      const staleAt = result.testedAt + AUTO_REENABLE_STALE_MS
      const waitMs = staleAt - now
      if (waitMs <= 0) {
        dueCount += 1
      } else if (waitMs < minWaitMs) {
        minWaitMs = waitMs
      }
    }

    if (dueCount > 0) {
      return { delayMs: AUTO_SCAN_DUE_DELAY_MS, dueCount, reason: 'due' }
    }

    if (Number.isFinite(minWaitMs)) {
      const boundedDelay = Math.max(AUTO_SCAN_MIN_DELAY_MS, Math.min(AUTO_SCAN_MAX_DELAY_MS, Math.round(minWaitMs)))
      return { delayMs: boundedDelay, dueCount: 0, reason: 'scheduled' }
    }

    return {
      delayMs: AUTO_SCAN_IDLE_DELAY_MS,
      dueCount: 0,
      reason: hasDisabledCandidate ? 'scheduled' : 'idle',
    }
  }

  const runReenableScan = useCallback(async (reason: 'auto' | 'manual') => {
    if (!client || isRunning || scanRunning || bulkDisabling) return

    const now = Date.now()
    if (reason === 'auto' && now - lastAutoScanAtRef.current < AUTO_REENABLE_MIN_GAP_MS) {
      return
    }

    const targets = pickReenableScanTargets(files)
    if (targets.length === 0) {
      if (reason === 'manual') {
        setScanSummary('暂无需要扫描的已禁用项')
      }
      return
    }

    const taskId = useTaskAuditStore.getState().startTask({
      type: 'scan',
      source: reason === 'auto' ? 'auto' : 'manual',
      label: reason === 'auto' ? '自动扫描可启用项' : '手动扫描可启用项',
      scope: activeProvider === '全部' ? '全部' : activeProvider,
      total: targets.length,
    })

    setScanRunning(true)
    if (reason === 'manual') {
      setScanSummary('可启用扫描中：' + targets.length + ' 项')
    }

    try {
      await testBatch(targets, { mode: 'all' })

      const scanSnapshot = useBatchTestStore.getState()
      const scanFailed = scanSnapshot.stats.error + scanSnapshot.stats.other
      const scanSuccess = Math.max(0, scanSnapshot.done - scanFailed)

      const latestState = useCredStore.getState()
      const latestMap = new Map(latestState.files.map((file) => [file.name, file] as const))
      const canEnableTargets = targets
        .map((file) => latestMap.get(file.name))
        .filter((file): file is AuthFile => !!file)
        .filter((file) => file.disabled && hasAvailableQuotaByResult(file, latestState.testResults[file.name]))

      let enableResult: BulkOperationRunResult = { success: 0, failed: 0, total: 0, failedNames: [] }
      if (canEnableTargets.length > 0) {
        enableResult = await runBulkOperationInPool(
          canEnableTargets,
          reason === 'auto' ? '自动扫描：启用可用凭据' : '扫描后自动启用',
          runEnableWorker,
          { showSummary: false, clearSelectionAfter: false, closeMenu: false }
        )
      }

      const status: TaskFinishedStatus = scanSnapshot.wasCancelled
        ? 'cancelled'
        : enableResult.failed > 0
          ? 'partial'
          : resolveTaskOutcomeStatus(scanSuccess, scanFailed)

      useTaskAuditStore.getState().finishTask(taskId, {
        status,
        done: scanSnapshot.done,
        success: scanSuccess,
        failed: scanFailed,
        detail: appendFailedNameHint(
          '扫描完成：' + scanSnapshot.done + '/' + scanSnapshot.total +
          '，自动启用成功 ' + enableResult.success +
          '，失败 ' + enableResult.failed,
          enableResult.failedNames,
          enableResult.failed
        ),
      })

      if (canEnableTargets.length === 0) {
        if (reason === 'manual') {
          setScanSummary('扫描完成：暂无可自动启用项')
        }
      } else {
        setScanSummary(
          reason === 'auto'
            ? '自动启用完成：成功 ' + enableResult.success + '，失败 ' + enableResult.failed
            : '扫描并自动启用完成：成功 ' + enableResult.success + '，失败 ' + enableResult.failed
        )
      }

      lastAutoScanAtRef.current = Date.now()
    } catch {
      useTaskAuditStore.getState().finishTask(taskId, {
        status: 'failed',
        done: 0,
        success: 0,
        failed: targets.length,
        detail: '扫描任务异常中断',
      })
      if (reason === 'manual') {
        setScanSummary('扫描任务异常中断，请重试')
      }
    } finally {
      setScanRunning(false)
    }
  }, [
    activeProvider,
    bulkDisabling,
    client,
    files,
    hasAvailableQuotaByResult,
    isRunning,
    runBulkOperationInPool,
    runEnableWorker,
    scanRunning,
    testBatch,
  ])

  const runReenableScanRef = useRef(runReenableScan)
  useEffect(() => {
    runReenableScanRef.current = runReenableScan
  }, [runReenableScan])

  const dispatchReenableScan = useCallback((reason: 'auto' | 'manual') => {
    void runReenableScanRef.current(reason)
  }, [])

  const filesInProviderScope = useMemo(() => {
    const byProvider = activeProvider === '全部'
      ? files
      : files.filter((f) => (f.provider || f.type || '未知') === activeProvider)

    const keyword = searchQuery.trim().toLowerCase()
    if (!keyword) return byProvider

    return byProvider.filter((f) => {
      const targets = [f.name, f.email ?? '', f.provider ?? '', f.type ?? '']
      return targets.some((item) => item.toLowerCase().includes(keyword))
    })
  }, [files, activeProvider, searchQuery])

  const filteredFiles = useMemo(() => {
    return filesInProviderScope.filter((f) => {
      const status = getEffectiveStatus(f, testResults[f.name])
      if (status === 'queued' || status === 'testing' || status === 'retrying') return false
      if (quickFilter === 'all') return true
      if (quickFilter === 'expired') return isExpiredStatus(status)
      if (quickFilter === 'quota') return status === 'quota'
      if (quickFilter === 'has-quota') return hasAvailableQuota(f)
      if (quickFilter === 'disabled') return status === 'disabled'
      if (quickFilter === 'error') return status === 'error'
      if (quickFilter === 'other') {
        return !f.disabled && !isExpiredStatus(status) && status !== 'quota' && status !== 'error' && !hasAvailableQuota(f)
      }
      if (quickFilter === 'can-enable') return f.disabled && hasAvailableQuota(f)
      return true
    })
  }, [filesInProviderScope, quickFilter, testResults])

  const displayFiles = useMemo(() => {
    const list = [...filteredFiles]

    if (sortMode === 'default') return list

    if (sortMode === 'name-asc') {
      return list.sort((a, b) => a.name.localeCompare(b.name))
    }
    if (sortMode === 'name-desc') {
      return list.sort((a, b) => b.name.localeCompare(a.name))
    }

    if (sortMode === 'status-asc' || sortMode === 'status-first') {
      return list.sort((a, b) => {
        const rankDiff = getStatusRank(a) - getStatusRank(b)
        if (rankDiff !== 0) return rankDiff
        const bScore = getQuotaRemainingPercent(b) ?? -1
        const aScore = getQuotaRemainingPercent(a) ?? -1
        if (bScore !== aScore) return bScore - aScore
        return a.name.localeCompare(b.name)
      })
    }
    if (sortMode === 'status-desc') {
      return list.sort((a, b) => {
        const rankDiff = getStatusRank(b) - getStatusRank(a)
        if (rankDiff !== 0) return rankDiff
        const aScore = getQuotaRemainingPercent(a) ?? -1
        const bScore = getQuotaRemainingPercent(b) ?? -1
        if (aScore !== bScore) return aScore - bScore
        return a.name.localeCompare(b.name)
      })
    }

    if (sortMode === 'quota-first' || sortMode === 'quota-desc') {
      return list.sort((a, b) => {
        const aScore = getQuotaRemainingPercent(a) ?? -1
        const bScore = getQuotaRemainingPercent(b) ?? -1
        if (bScore !== aScore) return bScore - aScore
        return a.name.localeCompare(b.name)
      })
    }
    if (sortMode === 'quota-asc') {
      return list.sort((a, b) => {
        const aScore = getQuotaRemainingPercent(a) ?? 101
        const bScore = getQuotaRemainingPercent(b) ?? 101
        if (aScore !== bScore) return aScore - bScore
        return a.name.localeCompare(b.name)
      })
    }

    if (sortMode === 'reset-asc') {
      return list.sort((a, b) => {
        const aTime = getQuotaResetTimestamp(a) ?? Infinity
        const bTime = getQuotaResetTimestamp(b) ?? Infinity
        if (aTime !== bTime) return aTime - bTime
        return a.name.localeCompare(b.name)
      })
    }
    if (sortMode === 'reset-desc') {
      return list.sort((a, b) => {
        const aTime = getQuotaResetTimestamp(a) ?? -Infinity
        const bTime = getQuotaResetTimestamp(b) ?? -Infinity
        if (aTime !== bTime) return bTime - aTime
        return a.name.localeCompare(b.name)
      })
    }

    if (sortMode === 'refresh-asc') {
      return list.sort((a, b) => {
        const aTime = a.last_refresh ? new Date(a.last_refresh).getTime() : Infinity
        const bTime = b.last_refresh ? new Date(b.last_refresh).getTime() : Infinity
        return aTime - bTime
      })
    }
    if (sortMode === 'refresh-desc') {
      return list.sort((a, b) => {
        const aTime = a.last_refresh ? new Date(a.last_refresh).getTime() : -Infinity
        const bTime = b.last_refresh ? new Date(b.last_refresh).getTime() : -Infinity
        return bTime - aTime
      })
    }

    return list
  }, [filteredFiles, sortMode, testResults])

  const totalPages = Math.max(1, Math.ceil(displayFiles.length / pageSize))
  const pagedFiles = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return displayFiles.slice(start, start + pageSize)
  }, [displayFiles, currentPage, pageSize])
  const pageTokens = useMemo(
    () => buildPageTokens(currentPage, totalPages),
    [currentPage, totalPages]
  )

  const plannedTestTargets = useMemo(() => {
    if (testScope === 'page') return pagedFiles
    if (testScope === 'provider') return filesInProviderScope
    return displayFiles
  }, [displayFiles, filesInProviderScope, pagedFiles, testScope])

  const testScopeLabel = useMemo(() => {
    if (testScope === 'page') return '当前页'
    if (testScope === 'provider') return '当前提供商'
    return '当前筛选'
  }, [testScope])

  const testPlanText = useMemo(() => {
    const modeText = testMode === 'all' ? '全部重测' : testMode === 'untested' ? '只测未测' : ''
    return modeText
      ? '计划 ' + testScopeLabel + ' ' + plannedTestTargets.length + ' 项 · ' + modeText
      : '计划 ' + testScopeLabel + ' ' + plannedTestTargets.length + ' 项'
  }, [plannedTestTargets.length, testMode, testScopeLabel])

  const expiredFiles = useMemo(
    () => displayFiles.filter((f) => {
      const s = getEffectiveStatus(f, testResults[f.name])
      return !f.disabled && isExpiredStatus(s)
    }),
    [displayFiles, testResults]
  )

  const allQuotaFiles = useMemo(
    () => filesInProviderScope.filter((f) => {
      if (isHiddenTestingStatus(f)) return false
      const s = getEffectiveStatus(f, testResults[f.name])
      return s === 'quota'
    }),
    [filesInProviderScope, testResults]
  )

  const allErrorFiles = useMemo(
    () => filesInProviderScope.filter((f) => {
      if (isHiddenTestingStatus(f)) return false
      const s = getEffectiveStatus(f, testResults[f.name])
      return s === 'error'
    }),
    [filesInProviderScope, testResults]
  )

  async function handleBulkRetest(targets: AuthFile[]) {
    if (targets.length === 0 || isRunning) return
    setBulkMenuOpen(false)
    try {
      await testBatch(targets, { mode: 'all' })
    } finally {
      clearSelection()
      triggerReenableScanAfterAction()
    }
  }

  const reenableQuotaRecoveredFiles = useMemo(
    () => filesInProviderScope.filter((f) => {
      if (isHiddenTestingStatus(f)) return false
      return f.disabled && hasAvailableQuota(f)
    }),
    [filesInProviderScope, testResults]
  )

  const allHasQuotaFiles = useMemo(
    () => filesInProviderScope.filter((f) => {
      if (isHiddenTestingStatus(f)) return false
      return !f.disabled && hasAvailableQuota(f)
    }),
    [filesInProviderScope, testResults]
  )

  const allDisabledFiles = useMemo(
    () => filesInProviderScope.filter((f) => {
      if (isHiddenTestingStatus(f)) return false
      const s = getEffectiveStatus(f, testResults[f.name])
      return s === 'disabled'
    }),
    [filesInProviderScope, testResults]
  )

  const allOtherFiles = useMemo(
    () => filesInProviderScope.filter((f) => {
      if (isHiddenTestingStatus(f)) return false
      const s = getEffectiveStatus(f, testResults[f.name])
      const isExpired = isExpiredStatus(s)
      const isQuota = s === 'quota'
      const isError = s === 'error'
      const isDisabled = s === 'disabled'
      const isHasQuota = !f.disabled && hasAvailableQuota(f)
      return !isExpired && !isQuota && !isError && !isDisabled && !isHasQuota
    }),
    [filesInProviderScope, testResults]
  )

  const allExpiredFiles = useMemo(
    () => filesInProviderScope.filter((f) => {
      if (isHiddenTestingStatus(f)) return false
      const s = getEffectiveStatus(f, testResults[f.name])
      return isExpiredStatus(s)
    }),
    [filesInProviderScope, testResults]
  )

  useEffect(() => {
    if (!autoScanEnabled || !client) {
      setAutoScanNextAt(null)
      setAutoScanDueCount(0)
      setAutoScanReason(autoScanEnabled ? 'idle' : 'off')
      return
    }

    if (isRunning || scanRunning || bulkDisabling) {
      const delay = AUTO_SCAN_BLOCKED_DELAY_MS
      setAutoScanDueCount(0)
      setAutoScanReason('blocked')
      setAutoScanNextAt(Date.now() + delay)
      const timer = window.setTimeout(() => {
        dispatchReenableScan('auto')
      }, delay)
      return () => window.clearTimeout(timer)
    }

    const plan = buildAutoReenableScanPlan(files)
    const delay = Math.max(AUTO_SCAN_MIN_DELAY_MS, plan.delayMs)
    setAutoScanDueCount(plan.dueCount)
    setAutoScanReason(plan.reason)
    setAutoScanNextAt(Date.now() + delay)

    const timer = window.setTimeout(() => {
      dispatchReenableScan('auto')
    }, delay)
    return () => window.clearTimeout(timer)
  }, [autoScanEnabled, bulkDisabling, client, dispatchReenableScan, files, isRunning, scanRunning, testResults])

  useEffect(() => {
    if (isRunning) return
    if (quickFilter === 'all') return

    const hasEntriesByFilter: Record<Exclude<QuickFilter, 'all'>, boolean> = {
      expired: allExpiredFiles.length > 0,
      quota: allQuotaFiles.length > 0,
      'has-quota': allHasQuotaFiles.length > 0,
      disabled: allDisabledFiles.length > 0,
      other: allOtherFiles.length > 0,
      error: allErrorFiles.length > 0,
      'can-enable': reenableQuotaRecoveredFiles.length > 0,
    }

    if (!hasEntriesByFilter[quickFilter]) {
      setQuickFilter('all')
    }
  }, [
    isRunning,
    quickFilter,
    allExpiredFiles.length,
    allQuotaFiles.length,
    allHasQuotaFiles.length,
    allDisabledFiles.length,
    allOtherFiles.length,
    allErrorFiles.length,
    reenableQuotaRecoveredFiles.length,
  ])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  useEffect(() => {
    setPageJumpInput(String(currentPage))
  }, [currentPage])

  useEffect(() => {
    setCurrentPage(1)
  }, [activeProvider, quickFilter, searchQuery, sortMode, pageSize])

  useEffect(() => {
    clearSelection()
  }, [activeProvider, quickFilter, searchQuery, sortMode, currentPage, pageSize, clearSelection])

  const triggerReenableScanAfterAction = useCallback(() => {
    if (!client || !autoScanEnabled) return
    // 事件触发扫描需要立即生效，不走轮询冷却窗口
    lastAutoScanAtRef.current = 0
    dispatchReenableScan('auto')
  }, [autoScanEnabled, client, dispatchReenableScan])

  async function handleRefreshAndScan() {
    if (refreshing) return
    await refresh()
    triggerReenableScanAfterAction()
  }

  async function handleTestCurrentCategory() {
    const targets = plannedTestTargets
    if (isRunning || targets.length === 0) return

    if (targets.length >= LARGE_TEST_STRONG_CONFIRM_THRESHOLD) {
      const confirmText = window.prompt(
        '本次将测试 ' + targets.length + ' 项（' + testScopeLabel + '），请输入 TEST 确认执行：'
      )
      if (confirmText?.trim().toUpperCase() !== 'TEST') return
    } else if (targets.length >= LARGE_TEST_WARN_THRESHOLD) {
      const confirmed = window.confirm(
        '即将测试 ' + targets.length + ' 项（' + testScopeLabel + '）。该任务可能持续较久，是否继续？'
      )
      if (!confirmed) return
    }

    setBulkMenuOpen(false)
    setBulkSummary(null)

    const taskLabel = '测试任务（' + testScopeLabel + '）'
    const taskId = useTaskAuditStore.getState().startTask({
      type: 'test',
      source: 'manual',
      label: taskLabel,
      scope: testScopeLabel,
      total: targets.length,
    })

    try {
      await testBatch(targets, { mode: testMode })
      const snapshot = useBatchTestStore.getState()
      const stats = snapshot.stats
      const success = stats.valid + stats.quota + stats.expired
      const failed = stats.error + stats.other
      const statusText = snapshot.wasCancelled ? '任务已取消' : '任务完成'
      const status: TaskFinishedStatus = snapshot.wasCancelled
        ? 'cancelled'
        : resolveTaskOutcomeStatus(success, failed)

      useTaskAuditStore.getState().finishTask(taskId, {
        status,
        done: snapshot.done,
        success,
        failed,
        detail:
          statusText +
          '：执行 ' + snapshot.done + '/' + snapshot.total +
          '，有效 ' + stats.valid +
          '，超额 ' + stats.quota +
          '，过期 ' + stats.expired +
          '，错误 ' + stats.error,
      })

      setBulkSummary({
        label: taskLabel,
        success,
        failed,
        detail:
          statusText +
          '：执行 ' + snapshot.done + '/' + snapshot.total +
          '，有效 ' + stats.valid +
          '，超额 ' + stats.quota +
          '，过期 ' + stats.expired +
          '，错误 ' + stats.error +
          ' · 任务 ' + taskId,
      })
    } catch {
      useTaskAuditStore.getState().finishTask(taskId, {
        status: 'failed',
        done: 0,
        success: 0,
        failed: targets.length,
        detail: '任务异常中断，请重试',
      })

      setBulkSummary({
        label: taskLabel,
        success: 0,
        failed: 1,
        detail: '任务异常中断，请重试 · 任务 ' + taskId,
      })
    } finally {
      clearSelection()
      triggerReenableScanAfterAction()
    }
  }

  async function runBulkOperationInPool(
    targets: AuthFile[],
    label: string,
    worker: (file: AuthFile) => Promise<boolean>,
    options: BulkOperationRunOptions = {}
  ): Promise<BulkOperationRunResult> {
    if (targets.length === 0) {
      return { success: 0, failed: 0, total: 0, failedNames: [] }
    }

    const {
      showSummary = true,
      clearSelectionAfter = true,
      closeMenu = true,
      onProgress,
    } = options

    setBulkDisabling(true)
    if (closeMenu) {
      setBulkMenuOpen(false)
    }
    if (showSummary) {
      setBulkSummary(null)
    }
    setBulkProgress({ label, done: 0, total: targets.length })
    onProgress?.({ done: 0, total: targets.length, success: 0, failed: 0 })

    const failedNames: string[] = []

    try {
      const result = await runOperationInPool({
        items: targets,
        maxConcurrency: BULK_ACTION_CONCURRENCY,
        progressIntervalMs: BULK_PROGRESS_UPDATE_INTERVAL_MS,
        worker: async (file) => {
          try {
            const ok = await worker(file)
            if (!ok) {
              failedNames.push(file.name)
            }
            return ok
          } catch {
            failedNames.push(file.name)
            return false
          }
        },
        onProgress: (snapshot) => {
          setBulkProgress({ label, done: snapshot.done, total: snapshot.total })
          onProgress?.({
            done: snapshot.done,
            total: snapshot.total,
            success: snapshot.success,
            failed: snapshot.failed,
          })
        },
      })

      const mergedFailedNames = mergeFailedNames(failedNames)
      if (showSummary) {
        setBulkSummary({
          label,
          success: result.success,
          failed: result.failed,
          detail: buildFailedNameHint(mergedFailedNames, result.failed) || undefined,
        })
      }
      return {
        ...result,
        failedNames: mergedFailedNames,
      }
    } finally {
      if (clearSelectionAfter) {
        clearSelection()
      }
      setBulkDisabling(false)
      setBulkProgress(null)
    }
  }

  async function runDisableWorker(file: AuthFile): Promise<boolean> {
    if (!client) return false
    updateFile(file.name, { disabled: true, status: 'disabled' })
    try {
      await patchAuthFileStatus(client, file.name, true)
      return true
    } catch {
      updateFile(file.name, { disabled: file.disabled, status: file.status })
      return false
    }
  }

  async function runEnableWorker(file: AuthFile): Promise<boolean> {
    if (!client) return false
    updateFile(file.name, { disabled: false, status: 'active' })
    try {
      await patchAuthFileStatus(client, file.name, false)
      return true
    } catch {
      updateFile(file.name, { disabled: file.disabled, status: file.status })
      return false
    }
  }

  function collectOneClickTargetsFromStore(): {
    errorTargets: AuthFile[]
    expiredTargets: AuthFile[]
    canEnableTargets: AuthFile[]
  } {
    const latestState = useCredStore.getState()
    const scopedFiles = activeProvider === '全部'
      ? latestState.files
      : latestState.files.filter((f) => (f.provider || f.type || '未知') === activeProvider)

    const visibleFiles = scopedFiles.filter((file) => {
      const status = getEffectiveStatus(file, latestState.testResults[file.name])
      return status !== 'queued' && status !== 'testing' && status !== 'retrying'
    })

    const errorTargets = visibleFiles.filter((file) => {
      const status = getEffectiveStatus(file, latestState.testResults[file.name])
      return status === 'error'
    })

    const expiredTargets = visibleFiles.filter((file) => {
      const status = getEffectiveStatus(file, latestState.testResults[file.name])
      return !file.disabled && isExpiredStatus(status)
    })

    const canEnableTargets = visibleFiles.filter((file) => {
      return file.disabled && hasAvailableQuotaByResult(file, latestState.testResults[file.name])
    })

    return { errorTargets, expiredTargets, canEnableTargets }
  }

  async function handleSmartOneClick() {
    if (!client || bulkDisabling || isRunning) return

    const initial = collectOneClickTargetsFromStore()
    const totalCandidates = initial.errorTargets.length + initial.expiredTargets.length + initial.canEnableTargets.length

    setBulkMenuOpen(false)

    const taskId = useTaskAuditStore.getState().startTask({
      type: 'smart',
      source: 'manual',
      label: '智能一键处理',
      scope: activeProvider === '全部' ? '全部' : activeProvider,
      total: totalCandidates,
    })

    if (totalCandidates === 0) {
      useTaskAuditStore.getState().finishTask(taskId, {
        status: 'success',
        done: 0,
        success: 0,
        failed: 0,
        detail: '当前没有可处理项',
      })
      setBulkSummary({ label: '智能一键处理', success: 0, failed: 0, detail: '当前没有可处理项 · 任务 ' + taskId })
      return
    }

    setBulkSummary(null)

    let retestFailed = 0
    if (initial.errorTargets.length > 0) {
      try {
        await testBatch(initial.errorTargets, { mode: 'all' })
        const snapshot = useBatchTestStore.getState()
        retestFailed = snapshot.stats.error + snapshot.stats.other
      } catch {
        retestFailed = initial.errorTargets.length
      }
    }

    const afterRetest = collectOneClickTargetsFromStore()
    const disableResult = await runBulkOperationInPool(
      afterRetest.expiredTargets,
      '智能一键：禁用已过期',
      runDisableWorker,
      { showSummary: false, clearSelectionAfter: false, closeMenu: false }
    )

    const afterDisable = collectOneClickTargetsFromStore()
    const enableResult = await runBulkOperationInPool(
      afterDisable.canEnableTargets,
      '智能一键：启用有配额',
      runEnableWorker,
      { showSummary: false, clearSelectionAfter: false, closeMenu: false }
    )

    clearSelection()

    const retestSuccess = Math.max(0, initial.errorTargets.length - retestFailed)
    const success = retestSuccess + disableResult.success + enableResult.success
    const failed = retestFailed + disableResult.failed + enableResult.failed
    const actionFailedNames = mergeFailedNames(disableResult.failedNames, enableResult.failedNames)

    const smartDetailBase =
      '重试错误 ' + initial.errorTargets.length +
      '（失败 ' + retestFailed + '），禁用成功 ' + disableResult.success + '/' + disableResult.total +
      '，启用成功 ' + enableResult.success + '/' + enableResult.total
    const smartDetail = appendFailedNameHint(
      smartDetailBase,
      actionFailedNames,
      disableResult.failed + enableResult.failed
    )

    useTaskAuditStore.getState().finishTask(taskId, {
      status: resolveTaskOutcomeStatus(success, failed),
      done: totalCandidates,
      success,
      failed,
      detail: smartDetail,
    })

    setBulkSummary({
      label: '智能一键处理',
      success,
      failed,
      detail: smartDetail + ' · 任务 ' + taskId,
    })
  }

  async function handleBulkDisable(targets: AuthFile[], label: string) {
    if (!client || targets.length === 0) return

    const taskId = useTaskAuditStore.getState().startTask({
      type: 'bulk',
      source: 'manual',
      label,
      scope: activeProvider === '全部' ? '全部' : activeProvider,
      total: targets.length,
    })

    try {
      const result = await runBulkOperationInPool(targets, label, runDisableWorker, {
        onProgress: (progress) => {
          useTaskAuditStore.getState().updateTask(taskId, {
            done: progress.done,
            success: progress.success,
            failed: progress.failed,
          })
        },
      })

      useTaskAuditStore.getState().finishTask(taskId, {
        status: resolveTaskOutcomeStatus(result.success, result.failed),
        done: result.total,
        success: result.success,
        failed: result.failed,
        detail: buildFailedNameHint(result.failedNames, result.failed) || undefined,
      })
    } catch {
      useTaskAuditStore.getState().finishTask(taskId, {
        status: 'failed',
        done: 0,
        success: 0,
        failed: targets.length,
        detail: label + '异常中断',
      })
    }

    triggerReenableScanAfterAction()
  }

  async function handleBulkDeleteExpired(targets: AuthFile[]) {
    if (!client || targets.length === 0) return
    const confirmed = window.confirm('确定要删除 ' + targets.length + ' 个已过期凭据？此操作不可撤销。')
    if (!confirmed) return

    const taskId = useTaskAuditStore.getState().startTask({
      type: 'bulk',
      source: 'manual',
      label: '删除已过期',
      scope: activeProvider === '全部' ? '全部' : activeProvider,
      total: targets.length,
    })

    try {
      const result = await runBulkOperationInPool(targets, '删除已过期', async (file) => {
        try {
          await deleteAuthFile(client, file.name)
          removeFile(file.name)
          return true
        } catch {
          return false
        }
      }, {
        onProgress: (progress) => {
          useTaskAuditStore.getState().updateTask(taskId, {
            done: progress.done,
            success: progress.success,
            failed: progress.failed,
          })
        },
      })

      useTaskAuditStore.getState().finishTask(taskId, {
        status: resolveTaskOutcomeStatus(result.success, result.failed),
        done: result.total,
        success: result.success,
        failed: result.failed,
        detail: buildFailedNameHint(result.failedNames, result.failed) || undefined,
      })
    } catch {
      useTaskAuditStore.getState().finishTask(taskId, {
        status: 'failed',
        done: 0,
        success: 0,
        failed: targets.length,
        detail: '删除已过期异常中断',
      })
    }
  }

  async function handleBulkEnable(targets: AuthFile[], label: string) {
    if (!client || targets.length === 0) return

    const taskId = useTaskAuditStore.getState().startTask({
      type: 'bulk',
      source: 'manual',
      label,
      scope: activeProvider === '全部' ? '全部' : activeProvider,
      total: targets.length,
    })

    try {
      const result = await runBulkOperationInPool(targets, label, runEnableWorker, {
        onProgress: (progress) => {
          useTaskAuditStore.getState().updateTask(taskId, {
            done: progress.done,
            success: progress.success,
            failed: progress.failed,
          })
        },
      })

      useTaskAuditStore.getState().finishTask(taskId, {
        status: resolveTaskOutcomeStatus(result.success, result.failed),
        done: result.total,
        success: result.success,
        failed: result.failed,
        detail: buildFailedNameHint(result.failedNames, result.failed) || undefined,
      })
    } catch {
      useTaskAuditStore.getState().finishTask(taskId, {
        status: 'failed',
        done: 0,
        success: 0,
        failed: targets.length,
        detail: label + '异常中断',
      })
    }
  }

  function handleExportAuditRecords(): void {
    if (auditRecords.length === 0 || typeof window === 'undefined') return

    const exportedAt = new Date()
    const endpointSlug = (connectionEndpoint ?? 'disconnected')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'endpoint'
    const stamp = exportedAt.toISOString().replace(/[:.]/g, '-')

    const payload = {
      exportedAt: exportedAt.toISOString(),
      endpoint: connectionEndpoint,
      total: auditRecords.length,
      records: auditRecords,
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const url = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `task-audit_${endpointSlug}_${stamp}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.URL.revokeObjectURL(url)
  }

  function commitPageJump(): void {
    const parsed = Number(pageJumpInput)
    if (!Number.isFinite(parsed)) {
      setPageJumpInput(String(currentPage))
      return
    }
    const nextPage = Math.max(1, Math.min(totalPages, Math.floor(parsed)))
    setCurrentPage(nextPage)
    setPageJumpInput(String(nextPage))
  }

  const progressLabel = bulkProgress?.label ?? '批量操作'
  const progressDone = bulkProgress?.done ?? 0
  const progressTotal = bulkProgress?.total ?? 0
  const showProgress = !!bulkProgress && bulkProgress.total > 0
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 0
  const autoScanReasonText = useMemo(() => {
    if (autoScanReason === 'off') return '已关闭'
    if (autoScanReason === 'blocked') return '等待批量任务空闲'
    if (autoScanReason === 'due') return '有到期项待扫描'
    if (autoScanReason === 'scheduled') return '按到期时间调度'
    return '空闲巡检'
  }, [autoScanReason])
  const autoScanStatusText = useMemo(() => {
    if (!autoScanEnabled) return '自动扫描：已关闭'
    if (scanRunning) return '自动扫描：执行中'
    const nextText = autoScanNextAt ? formatClockTime(autoScanNextAt) : '待定'
    return '自动扫描：' + autoScanReasonText + ' · 下次 ' + nextText + ' · 候选 ' + autoScanDueCount
  }, [autoScanDueCount, autoScanEnabled, autoScanNextAt, autoScanReasonText, scanRunning])
  const smartActionTotal = allErrorFiles.length + expiredFiles.length + reenableQuotaRecoveredFiles.length

  return (
    <div className="rounded-lg border border-border shadow-card overflow-hidden">
      <div className="border-b border-border bg-surface">
        <div className="flex gap-0 overflow-x-auto no-scrollbar px-1 sm:px-0">
          {providers.map((provider) => {
            const count = provider === '全部'
              ? files.length
              : files.filter((f) => (f.provider || f.type || '未知') === provider).length
            const isActive = provider === activeProvider
            const color = provider === '全部' ? undefined : getProviderColor(provider)

            return (
              <button
                key={provider}
                onClick={() => setActiveProvider(provider)}
                className={`flex-shrink-0 px-4 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
                  isActive ? '-mb-px' : 'text-subtle hover:text-ink'
                }`}
                style={isActive ? {
                  color: color ?? '#C96442',
                  borderBottom: `2px solid ${color ?? '#C96442'}`,
                } : {}}
              >
                {provider}
                <span
                  className="ml-2 rounded-full px-1.5 text-xs font-medium"
                  style={isActive
                    ? { backgroundColor: `${color ?? '#C96442'}18`, color: color ?? '#C96442' }
                    : { backgroundColor: '#E8E6E1', color: '#6B6560' }
                  }
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 py-2 px-3 sm:px-4 border-t border-border/70">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索文件名 / 邮箱"
            className="w-full sm:w-56 lg:w-64 h-8 text-xs text-ink bg-canvas border border-border rounded-md px-2.5 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-coral/35"
          />

          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="text-xs text-subtle bg-canvas border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-coral/35 sr-only"
            title="排序方式"
            aria-hidden="true"
          >
            <option value="default">默认排序</option>
            <option value="status-first">状态优先</option>
            <option value="quota-first">额度剩余优先</option>
          </select>

          <button
            onClick={() => setUploadOpen(true)}
            className="h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border border-border bg-canvas text-subtle rounded-md hover:text-ink hover:border-ink transition-colors"
            title="上传凭证文件"
          >
            <UploadIcon />
            上传
          </button>

          <button
            onClick={() => void handleRefreshAndScan()}
            disabled={refreshing}
            className="h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border border-border bg-canvas text-subtle rounded-md hover:text-ink hover:border-ink disabled:opacity-50 transition-colors"
          >
            <RefreshIcon spinning={refreshing} />
            刷新
          </button>

          <select
            value={testScope}
            onChange={(e) => setTestScope(e.target.value as TestScope)}
            className="h-8 text-xs text-subtle bg-canvas border border-border rounded-md px-2.5 focus:outline-none focus:ring-2 focus:ring-coral/35"
            title="测试目标范围"
          >
            <option value="page">当前页</option>
            <option value="filtered">当前筛选</option>
            <option value="provider">当前提供商</option>
          </select>

          <button
            onClick={() => void handleTestCurrentCategory()}
            disabled={isRunning || plannedTestTargets.length === 0}
            className="h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border border-coral/45 bg-coral/10 text-coral rounded-md hover:bg-coral/15 disabled:opacity-50 transition-colors"
          >
            执行测试
          </button>

          <select
            value={testMode}
            onChange={(e) => setTestMode(e.target.value as BatchTestMode)}
            className="h-8 text-xs text-subtle bg-canvas border border-border rounded-md px-2.5 focus:outline-none focus:ring-2 focus:ring-coral/35"
            title="测试范围"
          >
            <option value="untested">只测未测</option>
            <option value="all">全部重测</option>
            <option value="error">只测错误</option>
            <option value="expired">只测过期</option>
            <option value="quota">只测超额</option>
          </select>

          <span className="text-xs text-subtle whitespace-nowrap">
            {testPlanText}
          </span>

          <button
            onClick={() => setAutoScanEnabled((v) => !v)}
            className={
              'h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border rounded-md transition-colors ' +
              (autoScanEnabled
                ? 'border-[#A9D9BF] bg-[#EEF9F2] text-[#2D7A3F] hover:bg-[#E5F5EB]'
                : 'border-border bg-canvas text-subtle hover:text-ink hover:border-ink')
            }
            title={autoScanEnabled ? '关闭自动扫描' : '开启自动扫描'}
          >
            {autoScanEnabled ? '自动扫描:开' : '自动扫描:关'}
          </button>

          <button
            onClick={() => dispatchReenableScan('manual')}
            disabled={isRunning || scanRunning}
            className="h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border border-[#BDD9C2] bg-[#EDF9F0] text-[#2D7A3F] rounded-md hover:bg-[#E2F4E7] disabled:opacity-50 transition-colors"
            title="扫描已禁用账号并自动启用可用项"
          >
            {scanRunning ? '扫描中...' : '扫描并自动启用'}
          </button>

          <span className="text-xs text-subtle whitespace-nowrap">
            {autoScanStatusText}
          </span>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setBulkMenuOpen((v) => !v)}
              disabled={bulkDisabling || isRunning || (expiredFiles.length === 0 && allErrorFiles.length === 0 && allExpiredFiles.length === 0 && reenableQuotaRecoveredFiles.length === 0)}
              className="h-8 inline-flex items-center gap-1 px-3 text-xs font-semibold border border-border bg-canvas text-subtle rounded-md hover:text-ink hover:border-ink disabled:opacity-50 transition-colors"
              title="一键处理"
            >
              {bulkDisabling ? <SpinIcon /> : <BanIcon />}
              一键处理
              <ChevronIcon />
            </button>

            {bulkMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-[272px] bg-canvas border border-border rounded-lg shadow-card z-20 overflow-hidden">
                <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-subtle tracking-[0.04em] uppercase">推荐操作</div>
                <button
                  onClick={() => void handleSmartOneClick()}
                  disabled={smartActionTotal === 0 || isRunning || bulkDisabling}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ink font-semibold">智能一键处理（推荐）</span>
                    <span className="text-subtle tabular-nums">{smartActionTotal}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-subtle">
                    重试错误 {allErrorFiles.length} → 禁用已过期 {expiredFiles.length} → 启用有配额 {reenableQuotaRecoveredFiles.length}
                  </div>
                </button>

                <div className="border-t border-border" />
                <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-subtle tracking-[0.04em] uppercase">单项操作</div>
                <button
                  onClick={() => void handleBulkRetest(allErrorFiles)}
                  disabled={allErrorFiles.length === 0 || isRunning}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="text-ink font-medium">重试错误</span>
                  <span className="ml-1.5 text-subtle">({allErrorFiles.length})</span>
                </button>
                <button
                  onClick={() => handleBulkDisable(expiredFiles, '禁用已过期')}
                  disabled={expiredFiles.length === 0}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="text-ink font-medium">禁用已过期</span>
                  <span className="ml-1.5 text-subtle">({expiredFiles.length})</span>
                </button>
                <button
                  onClick={() => handleBulkEnable(reenableQuotaRecoveredFiles, '启用有配额')}
                  disabled={reenableQuotaRecoveredFiles.length === 0}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="text-ink font-medium">启用有配额</span>
                  <span className="ml-1.5 text-subtle">({reenableQuotaRecoveredFiles.length})</span>
                </button>

                <div className="border-t border-border mt-1" />
                <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-[#B94040] tracking-[0.04em] uppercase">危险操作</div>
                <button
                  onClick={() => handleBulkDeleteExpired(allExpiredFiles)}
                  disabled={allExpiredFiles.length === 0}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[#FFF6F6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="text-[#B94040] font-medium">删除全部过期</span>
                  <span className="ml-1.5 text-subtle">({allExpiredFiles.length})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showProgress && (
        <div className="px-4 py-2 border-b border-border bg-canvas">
          <div className="flex items-center justify-between text-xs text-subtle mb-1">
            <span>{progressLabel}</span>
            <span className="tabular-nums">{progressDone}/{progressTotal}</span>
          </div>
          <div className="h-1.5 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-coral rounded-full transition-all" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      )}

      {scanSummary && (
        <div className="px-4 py-2 border-b border-border bg-[#F6FBF7] text-xs text-[#2D7A3F]">
          {scanSummary}
        </div>
      )}

      {bulkSummary && (
        <div
          className={`px-4 py-2 border-b border-border text-xs ${
            bulkSummary.failed > 0 ? 'bg-[#FFF7ED] text-[#9A6B1E]' : 'bg-[#F6FBF7] text-[#2D7A3F]'
          }`}
        >
          <div>{bulkSummary.label}完成：成功 {bulkSummary.success}，失败 {bulkSummary.failed}</div>
          {bulkSummary.detail && (
            <div className="mt-0.5 text-[11px] opacity-90">{bulkSummary.detail}</div>
          )}
        </div>
      )}

      {recentAuditTasks.length > 0 && (
        <div className="px-4 py-2 border-b border-border bg-canvas">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-[11px] font-semibold text-subtle tracking-[0.04em] uppercase">最近任务审计</div>
              <span className="px-2 py-0.5 rounded-full text-[11px] bg-surface text-subtle tabular-nums">
                {auditRecords.length} 条
              </span>
              {runningAuditCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[11px] bg-[#FFF7ED] text-[#9A6B1E] tabular-nums">
                  运行中 {runningAuditCount}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleExportAuditRecords}
                className="h-7 px-2.5 rounded-md border border-border bg-canvas text-[11px] font-semibold text-subtle hover:text-ink hover:border-ink transition-colors"
                title="导出当前端点任务审计"
              >
                导出JSON
              </button>
              <button
                onClick={() => setAuditPanelExpanded((v) => !v)}
                className="h-7 px-2.5 rounded-md border border-border bg-canvas text-[11px] font-semibold text-subtle hover:text-ink hover:border-ink transition-colors inline-flex items-center gap-1"
                title={auditPanelExpanded ? '收起任务审计' : '展开任务审计'}
              >
                {auditPanelExpanded ? '收起' : '展开'}
                <span className={`transition-transform ${auditPanelExpanded ? 'rotate-180' : ''}`}>
                  <ChevronIcon />
                </span>
              </button>
            </div>
          </div>

          <div className="mt-1 text-[11px] text-subtle truncate">
            当前端点：{connectionEndpoint ?? '未连接'}
            {!auditPanelExpanded && latestAuditTask && (
              <span className="ml-2">
                · 最新：{latestAuditTask.label}（{getTaskStatusText(latestAuditTask.status)}）
              </span>
            )}
          </div>

          {auditPanelExpanded && (
            <div className="mt-1.5 space-y-1">
              {recentAuditTasks.map((task) => (
                <div key={task.taskId} className="flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="text-ink truncate">{task.label}</div>
                    <div className="text-[11px] text-subtle truncate">
                      {shortTaskId(task.taskId)} · {task.scope} · {task.source === 'auto' ? '自动' : '手动'} · {formatClockTime(task.startedAt)}
                    </div>
                  </div>
                  <div className={`px-2 py-0.5 rounded-full text-[11px] whitespace-nowrap ${getTaskStatusClass(task.status)}`}>
                    {getTaskStatusText(task.status)}
                  </div>
                  <div className="tabular-nums text-subtle whitespace-nowrap">
                    {task.success}/{task.total}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="px-4 py-2 border-b border-border bg-surface/65">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="h-8 px-2.5 rounded-md border border-border bg-canvas text-xs text-ink/90 hover:border-ink hover:text-ink disabled:opacity-50 transition-colors"
          >
            上一页
          </button>

          {pageTokens.map((token, idx) =>
            token.type === 'ellipsis' ? (
              <span key={`ellipsis-${idx}`} className="px-1.5 text-xs text-subtle">
                ...
              </span>
            ) : (
              <button
                key={token.page}
                onClick={() => setCurrentPage(token.page)}
                className={`h-8 min-w-8 px-2.5 rounded-md border text-xs tabular-nums transition-colors ${
                  token.page === currentPage
                    ? 'border-coral bg-coral text-white'
                    : 'border-border bg-canvas text-ink/90 hover:border-ink hover:text-ink'
                }`}
              >
                {token.page}
              </button>
            )
          )}

          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="h-8 px-2.5 rounded-md border border-border bg-canvas text-xs text-ink/90 hover:border-ink hover:text-ink disabled:opacity-50 transition-colors"
          >
            下一页
          </button>

          <label className="ml-1 inline-flex items-center gap-1 text-xs text-subtle whitespace-nowrap">
            <span>跳转</span>
            <input
              value={pageJumpInput}
              onChange={(e) => {
                const digitsOnly = e.target.value.replace(/\D/g, '')
                setPageJumpInput(digitsOnly)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitPageJump()
                }
              }}
              onBlur={commitPageJump}
              className="h-8 w-14 rounded-md border border-border bg-canvas px-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-coral/35"
              inputMode="numeric"
            />
            <span>页</span>
          </label>

          <label className="ml-2 inline-flex items-center gap-1 text-xs text-subtle whitespace-nowrap">
            <span>每页</span>
            <select
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (VALID_PAGE_SIZES.includes(next as PageSize)) {
                  setPageSize(next as PageSize)
                }
              }}
              className="h-8 rounded-md border border-border bg-canvas px-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-coral/35"
            >
              {VALID_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span>条</span>
          </label>

          <label className="ml-1 inline-flex items-center gap-1 text-xs text-subtle whitespace-nowrap">
            <span>并发</span>
            <select
              value={concurrencyOverride}
              onChange={(e) => setConcurrencyOverride(e.target.value as ConcurrencyOverride)}
              className="h-8 rounded-md border border-border bg-canvas px-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-coral/35"
              title="测试并发上限"
            >
              <option value="auto">自动</option>
              {VALID_CONCURRENCY_VALUES.map((value) => (
                <option key={value} value={String(value)}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <span className="ml-2 text-xs text-subtle whitespace-nowrap">
            共 <span className="tabular-nums text-ink">{displayFiles.length}</span> 条，
            <span className="tabular-nums text-ink"> {totalPages} </span>页，
            每页 <span className="tabular-nums text-ink">{pageSize}</span> 条，
            并发 <span className="tabular-nums text-ink">{concurrencyOverride === 'auto' ? '自动' : concurrencyOverride}</span>
          </span>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-border bg-canvas">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <QuickFilterButton
            active={quickFilter === 'all'}
            onClick={() => setQuickFilter('all')}
            label="全部"
          />
          {allExpiredFiles.length > 0 && (
            <QuickFilterButton
              active={quickFilter === 'expired'}
              onClick={() => setQuickFilter('expired')}
              label={`已过期 (${allExpiredFiles.length})`}
            />
          )}
          {allQuotaFiles.length > 0 && (
            <QuickFilterButton
              active={quickFilter === 'quota'}
              onClick={() => setQuickFilter('quota')}
              label={`已超额 (${allQuotaFiles.length})`}
            />
          )}
          {allHasQuotaFiles.length > 0 && (
            <QuickFilterButton
              active={quickFilter === 'has-quota'}
              onClick={() => setQuickFilter('has-quota')}
              label={`有配额 (${allHasQuotaFiles.length})`}
            />
          )}
          {allDisabledFiles.length > 0 && (
            <QuickFilterButton
              active={quickFilter === 'disabled'}
              onClick={() => setQuickFilter('disabled')}
              label={`已禁用 (${allDisabledFiles.length})`}
            />
          )}
          {allOtherFiles.length > 0 && (
            <QuickFilterButton
              active={quickFilter === 'other'}
              onClick={() => setQuickFilter('other')}
              label={`其他 (${allOtherFiles.length})`}
            />
          )}
          {reenableQuotaRecoveredFiles.length > 0 && (
            <QuickFilterButton
              active={quickFilter === 'can-enable'}
              onClick={() => setQuickFilter('can-enable')}
              label={`可启用 (${reenableQuotaRecoveredFiles.length})`}
            />
          )}

          {allErrorFiles.length > 0 && (
            <QuickFilterButton
              active={quickFilter === 'error'}
              onClick={() => setQuickFilter('error')}
              label={`错误 (${allErrorFiles.length})`}
              tone="danger"
            />
          )}
        </div>
      </div>

      <CredentialTable files={pagedFiles} loading={loading} sortMode={sortMode} onSortChange={setSortMode} />

      {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}
    </div>
  )
}

type PageToken = { type: 'page'; page: number } | { type: 'ellipsis' }

function buildPageTokens(currentPage: number, totalPages: number): PageToken[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => ({
      type: 'page',
      page: i + 1,
    }))
  }

  const pages = new Set<number>([1, totalPages, currentPage - 1, currentPage, currentPage + 1])
  if (currentPage <= 4) {
    ;[2, 3, 4, 5].forEach((p) => pages.add(p))
  }
  if (currentPage >= totalPages - 3) {
    ;[totalPages - 1, totalPages - 2, totalPages - 3, totalPages - 4].forEach((p) => pages.add(p))
  }

  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b)

  const tokens: PageToken[] = []
  for (let i = 0; i < sorted.length; i++) {
    const page = sorted[i]
    if (i > 0 && page - sorted[i - 1] > 1) {
      tokens.push({ type: 'ellipsis' })
    }
    tokens.push({ type: 'page', page })
  }
  return tokens
}

function QuickFilterButton({
  active,
  onClick,
  label,
  tone = 'default',
}: {
  active: boolean
  onClick: () => void
  label: string
  tone?: 'default' | 'danger'
}) {
  const isDanger = tone === 'danger'

  return (
    <button
      onClick={onClick}
      className={`h-8 px-3 rounded-md text-xs font-semibold tracking-[0.01em] border whitespace-nowrap flex-shrink-0 transition-colors ${
        isDanger
          ? active
            ? 'border-[#D55353] text-[#B94040] bg-[#FCEAEA] dark:border-[#A34B4B] dark:text-[#FFD6D6] dark:bg-[#4A2424]'
            : 'border-[#EBC4C4] text-[#B94040] bg-[#FFF7F7] hover:border-[#D55353] hover:bg-[#FCEAEA] dark:border-[#6E3A3A] dark:text-[#F3C2C2] dark:bg-[#2A1A1A] dark:hover:border-[#A34B4B] dark:hover:bg-[#402121]'
          : active
            ? 'border-coral text-coral bg-coral/12 shadow-[inset_0_0_0_1px_rgba(201,100,66,0.08)]'
            : 'border-border bg-canvas text-ink/90 hover:text-ink hover:border-ink'
      }`}
    >
      {label}
    </button>
  )
}

function UploadIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={`w-3 h-3 ${spinning ? 'animate-spin' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
      />
    </svg>
  )
}

function BanIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
    </svg>
  )
}

function SpinIcon() {
  return (
    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  )
}





















