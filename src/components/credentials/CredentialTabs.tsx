import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useCredStore } from '@/store/credStore'
import { useConnection } from '@/hooks/useConnection'
import { useBatchTest, type BatchTestMode } from '@/hooks/useBatchTest'
import { getProviderColor } from '@/utils/keyUtils'
import { getEffectiveStatus, isExpiredStatus } from '@/utils/statusUtils'
import { deleteAuthFile, patchAuthFileStatus } from '@/lib/management'
import CredentialTable, { type SortMode } from './CredentialTable'
import UploadModal from './UploadModal'
import type { AuthFile } from '@/types/api'
type QuickFilter = 'all' | 'expired' | 'quota' | 'has-quota' | 'disabled' | 'other' | 'error' | 'can-enable'
const SORT_MODE_KEY = 'cliproxy_sort_mode'
const PAGE_SIZE_KEY = 'cliproxy_page_size'
const TEST_MODE_KEY = 'cliproxy_test_mode'
const CONCURRENCY_OVERRIDE_KEY = 'cliproxy_concurrency_override'
const DEFAULT_PAGE_SIZE = 200
const VALID_PAGE_SIZES = [50, 100, 200, 500, 1000] as const
type PageSize = (typeof VALID_PAGE_SIZES)[number]
const VALID_TEST_MODES: BatchTestMode[] = ['untested', 'all', 'error', 'expired', 'quota']
const VALID_CONCURRENCY_VALUES = [4, 6, 8, 10, 12, 16, 20] as const
type ConcurrencyOverride = 'auto' | `${(typeof VALID_CONCURRENCY_VALUES)[number]}`
const AUTO_REENABLE_SCAN_INTERVAL_MS = 90_000
const AUTO_REENABLE_SCAN_COOLDOWN_MS = 90_000
const AUTO_REENABLE_STALE_MS = 30 * 60 * 1000
const AUTO_REENABLE_MAX_TARGETS = 300
const BULK_ACTION_CONCURRENCY = 8
const BULK_PROGRESS_UPDATE_INTERVAL_MS = 120

type BulkSummary = { label: string; success: number; failed: number; detail?: string }
type BulkOperationRunResult = { success: number; failed: number; total: number }
type BulkOperationRunOptions = {
  showSummary?: boolean
  clearSelectionAfter?: boolean
  closeMenu?: boolean
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
  const [concurrencyOverride, setConcurrencyOverride] = useState<ConcurrencyOverride>(() => loadConcurrencyOverride())
  const [scanRunning, setScanRunning] = useState(false)
  const [scanSummary, setScanSummary] = useState<string | null>(null)
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
  const { updateFile, removeFile, clearSelection } = useCredStore.getState()
  const { refresh } = useConnection()
  const { testBatch, isRunning } = useBatchTest()
  const [currentPage, setCurrentPage] = useState(1)

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

  const runReenableScan = useCallback(async (reason: 'auto' | 'manual') => {
    if (!client || isRunning || scanRunning || bulkDisabling) return

    const now = Date.now()
    if (reason === 'auto' && now - lastAutoScanAtRef.current < AUTO_REENABLE_SCAN_COOLDOWN_MS) {
      return
    }

    const targets = pickReenableScanTargets(files)
    if (targets.length === 0) {
      if (reason === 'manual') {
        setScanSummary('暂无需要扫描的已禁用项')
      }
      return
    }

    setScanRunning(true)
    if (reason === 'manual') {
      setScanSummary(`可启用扫描中：${targets.length} 项`)
    }

    try {
      await testBatch(targets, { mode: 'all' })

      const latestState = useCredStore.getState()
      const latestMap = new Map(latestState.files.map((file) => [file.name, file] as const))
      const canEnableTargets = targets
        .map((file) => latestMap.get(file.name))
        .filter((file): file is AuthFile => !!file)
        .filter((file) => file.disabled && hasAvailableQuotaByResult(file, latestState.testResults[file.name]))

      if (canEnableTargets.length === 0) {
        if (reason === 'manual') {
          setScanSummary('扫描完成：暂无可自动启用项')
        }
      } else {
        const enableResult = await runBulkOperationInPool(
          canEnableTargets,
          reason === 'auto' ? '自动扫描：启用可用凭据' : '扫描后自动启用',
          runEnableWorker,
          { showSummary: false, clearSelectionAfter: false, closeMenu: false }
        )
        setScanSummary(
          reason === 'auto'
            ? `自动启用完成：成功 ${enableResult.success}，失败 ${enableResult.failed}`
            : `扫描并自动启用完成：成功 ${enableResult.success}，失败 ${enableResult.failed}`
        )
      }

      lastAutoScanAtRef.current = Date.now()
    } finally {
      setScanRunning(false)
    }
  }, [
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
    if (!client || isRunning || scanRunning) return
    const timer = window.setTimeout(() => {
      void runReenableScan('auto')
    }, AUTO_REENABLE_SCAN_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [client, isRunning, runReenableScan, scanRunning])

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

  async function handleTestCurrentCategory() {
    if (isRunning || displayFiles.length === 0) return
    try {
      await testBatch(displayFiles, { mode: testMode })
    } catch {
    } finally {
      clearSelection()
    }
  }

  async function runBulkOperationInPool(
    targets: AuthFile[],
    label: string,
    worker: (file: AuthFile) => Promise<boolean>,
    options: BulkOperationRunOptions = {}
  ): Promise<BulkOperationRunResult> {
    if (targets.length === 0) {
      return { success: 0, failed: 0, total: 0 }
    }

    const {
      showSummary = true,
      clearSelectionAfter = true,
      closeMenu = true,
    } = options

    setBulkDisabling(true)
    if (closeMenu) {
      setBulkMenuOpen(false)
    }
    if (showSummary) {
      setBulkSummary(null)
    }
    setBulkProgress({ label, done: 0, total: targets.length })

    const total = targets.length
    const poolSize = Math.min(BULK_ACTION_CONCURRENCY, total)
    let index = 0
    let done = 0
    let success = 0
    let failed = 0
    let lastProgressAt = Date.now()

    function pushProgress(force = false): void {
      const now = Date.now()
      if (!force && done < total && now - lastProgressAt < BULK_PROGRESS_UPDATE_INTERVAL_MS) {
        return
      }
      setBulkProgress({ label, done, total })
      lastProgressAt = now
    }

    async function runNext(): Promise<void> {
      while (true) {
        const current = index++
        if (current >= total) return
        const file = targets[current]
        let ok = false
        try {
          ok = await worker(file)
        } catch {
        } finally {
          if (ok) success += 1
          else failed += 1
          done += 1
          pushProgress(false)
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: poolSize }, runNext))
      pushProgress(true)
      const result: BulkOperationRunResult = { success, failed, total }
      if (showSummary) {
        setBulkSummary({ label, success, failed })
      }
      return result
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
    if (totalCandidates === 0) {
      setBulkSummary({ label: '智能一键处理', success: 0, failed: 0, detail: '当前没有可处理项' })
      return
    }

    setBulkSummary(null)

    if (initial.errorTargets.length > 0) {
      try {
        await testBatch(initial.errorTargets, { mode: 'all' })
      } catch {
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

    setBulkSummary({
      label: '智能一键处理',
      success: disableResult.success + enableResult.success,
      failed: disableResult.failed + enableResult.failed,
      detail: `重试错误 ${initial.errorTargets.length} 项，禁用成功 ${disableResult.success}/${disableResult.total}，启用成功 ${enableResult.success}/${enableResult.total}`,
    })
  }

  async function handleBulkDisable(targets: AuthFile[], label: string) {
    if (!client || targets.length === 0) return
    await runBulkOperationInPool(targets, label, runDisableWorker)
  }

  async function handleBulkDeleteExpired(targets: AuthFile[]) {
    if (!client || targets.length === 0) return
    const confirmed = window.confirm(`确定要删除 ${targets.length} 个已过期凭据？此操作不可撤销。`)
    if (!confirmed) return

    await runBulkOperationInPool(targets, '删除已过期', async (file) => {
      try {
        await deleteAuthFile(client, file.name)
        removeFile(file.name)
        return true
      } catch {
        return false
      }
    })
  }

  async function handleBulkEnable(targets: AuthFile[], label: string) {
    if (!client || targets.length === 0) return
    await runBulkOperationInPool(targets, label, runEnableWorker)
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
            onClick={refresh}
            disabled={refreshing}
            className="h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border border-border bg-canvas text-subtle rounded-md hover:text-ink hover:border-ink disabled:opacity-50 transition-colors"
          >
            <RefreshIcon spinning={refreshing} />
            刷新
          </button>

          <button
            onClick={() => void handleTestCurrentCategory()}
            disabled={isRunning || displayFiles.length === 0}
            className="h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border border-coral/45 bg-coral/10 text-coral rounded-md hover:bg-coral/15 disabled:opacity-50 transition-colors"
          >
            测试当前类别
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

          <button
            onClick={() => void runReenableScan('manual')}
            disabled={isRunning || scanRunning}
            className="h-8 inline-flex items-center gap-1.5 px-3 text-xs font-semibold border border-[#BDD9C2] bg-[#EDF9F0] text-[#2D7A3F] rounded-md hover:bg-[#E2F4E7] disabled:opacity-50 transition-colors"
            title="扫描已禁用账号并自动启用可用项"
          >
            {scanRunning ? '扫描中...' : '扫描并自动启用'}
          </button>

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


