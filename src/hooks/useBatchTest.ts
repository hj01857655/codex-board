import { useMemo } from 'react'
import { useCredStore } from '@/store/credStore'
import { fetchAuthFiles, testAuthFile } from '@/lib/management'
import { autoDisableIfQuota } from '@/lib/autoDisable'
import { useBatchTestStore, type BatchTestStats } from '@/store/batchTestStore'
import type { AuthFile, TestResult } from '@/types/api'

const PAGE_SIZE_STORAGE_KEY = 'cliproxy_page_size'
const CONCURRENCY_OVERRIDE_STORAGE_KEY = 'cliproxy_concurrency_override'
const DEFAULT_CONCURRENCY = 20
const AUTO_CONCURRENCY_MAX = 64
const RESULT_FLUSH_SIZE = 100
const MAX_PROGRESS_UPDATES = 500
const LARGE_BATCH_THRESHOLD = 5000
const HUGE_BATCH_THRESHOLD = 20000
const HUGE_RESULT_FLUSH_SIZE = 3000
const HUGE_MAX_PROGRESS_UPDATES = 300
const UI_YIELD_EVERY = 200
const RESULT_FLUSH_INTERVAL_MS = 300
const PROGRESS_UPDATE_INTERVAL_MS = 250
const COMPLETED_STATUSES: Array<TestResult['status']> = ['valid', 'quota', 'expired', 'error']

export type BatchTestMode = 'untested' | 'all' | 'error' | 'expired' | 'quota'

interface BatchTestOptions {
  mode?: BatchTestMode
}

function getManualConcurrencyOverride(): number | null {
  if (typeof window !== 'undefined') {
    const overrideRaw = window.localStorage.getItem(CONCURRENCY_OVERRIDE_STORAGE_KEY)
    const override = Number(overrideRaw)
    if (Number.isFinite(override) && override > 0) {
      return Math.max(1, Math.min(96, Math.floor(override)))
    }
  }
  return null
}

function getStoredPageSize(): number | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY)
  const pageSize = Number(raw)
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  return Math.floor(pageSize)
}

function getAutoConcurrencyByPageSize(pageSize: number | null): number {
  if (pageSize === null) return DEFAULT_CONCURRENCY
  if (pageSize <= 50) return 8
  if (pageSize <= 100) return 10
  if (pageSize <= 200) return 12
  if (pageSize <= 500) return 16
  if (pageSize <= 1000) return 24
  if (pageSize <= 2000) return 28
  return 32
}

function getAutoConcurrencyByTargetCount(total: number): number {
  if (total >= 50000) return 64
  if (total >= 20000) return 56
  if (total >= 10000) return 48
  if (total >= 5000) return 40
  if (total >= 2000) return 36
  if (total >= 1000) return 32
  if (total >= 500) return 24
  return DEFAULT_CONCURRENCY
}

function resolveWorkerCount(total: number): number {
  const manual = getManualConcurrencyOverride()
  if (manual !== null) {
    return Math.max(1, Math.min(manual, Math.max(1, total)))
  }

  const pageSize = getStoredPageSize()
  const byPageSize = getAutoConcurrencyByPageSize(pageSize)
  const byTargetCount = getAutoConcurrencyByTargetCount(total)
  const auto = Math.min(AUTO_CONCURRENCY_MAX, Math.max(byPageSize, byTargetCount))
  return Math.max(1, Math.min(auto, Math.max(1, total)))
}

function parseFileTimestamp(file: AuthFile): number | null {
  const value = file.last_refresh ?? file.updated_at ?? file.modtime
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function hasFreshResult(file: AuthFile, result: TestResult | undefined): boolean {
  if (!result) return false
  if (!COMPLETED_STATUSES.includes(result.status)) return false
  const fileTime = parseFileTimestamp(file)
  if (fileTime !== null && result.testedAt < fileTime) return false
  return true
}

function shouldTestByMode(file: AuthFile, result: TestResult | undefined, mode: BatchTestMode): boolean {
  if (mode === 'all') return true
  if (!hasFreshResult(file, result)) return mode === 'untested'
  if (mode === 'untested') return false
  if (mode === 'error') return result?.status === 'error'
  if (mode === 'expired') return result?.status === 'expired'
  if (mode === 'quota') return result?.status === 'quota'
  return true
}

export function useBatchTest() {
  const client = useCredStore((s) => s.client)
  const isRunning = useBatchTestStore((s) => s.isRunning)
  const done = useBatchTestStore((s) => s.done)
  const dispatched = useBatchTestStore((s) => s.dispatched)
  const total = useBatchTestStore((s) => s.total)
  const startedAt = useBatchTestStore((s) => s.startedAt)
  const updatedAt = useBatchTestStore((s) => s.updatedAt)
  const workerCount = useBatchTestStore((s) => s.workerCount)
  const inFlight = useBatchTestStore((s) => s.inFlight)
  const peakInFlight = useBatchTestStore((s) => s.peakInFlight)
  const stats = useBatchTestStore((s) => s.stats)
  const cancelRequested = useBatchTestStore((s) => s.cancelRequested)
  const wasCancelled = useBatchTestStore((s) => s.wasCancelled)
  const { setTestResultsBatch, updateFile, setFiles } = useCredStore.getState()

  async function testBatch(authFiles: AuthFile[], options?: BatchTestOptions): Promise<void> {
    if (!client || useBatchTestStore.getState().isRunning || authFiles.length === 0) return
    const mode = options?.mode ?? 'untested'
    const currentResults = useCredStore.getState().testResults
    const targets = authFiles.filter((file) => shouldTestByMode(file, currentResults[file.name], mode))
    if (targets.length === 0) return

    let doneCount = 0
    let index = 0
    let dispatchedCount = 0
    let inFlightCount = 0
    let localPeakInFlight = 0
    let autoDisabledCount = 0
    const autoDisabledNames = new Set<string>()
    const localStats: BatchTestStats = {
      valid: 0,
      quota: 0,
      expired: 0,
      error: 0,
      other: 0,
    }
    const isHugeBatch = targets.length >= HUGE_BATCH_THRESHOLD
    const workerCount = resolveWorkerCount(targets.length)
    const flushSize = isHugeBatch
      ? HUGE_RESULT_FLUSH_SIZE
      : targets.length > LARGE_BATCH_THRESHOLD
        ? 600
        : RESULT_FLUSH_SIZE
    const progressBudget = isHugeBatch ? HUGE_MAX_PROGRESS_UPDATES : MAX_PROGRESS_UPDATES
    const progressStep = Math.max(1, Math.ceil(targets.length / progressBudget))

    useBatchTestStore.getState().start(targets.length, workerCount)

    let pendingResults: Record<string, TestResult> = {}
    let pendingCount = 0
    let lastFlushAt = Date.now()
    let lastProgressAt = Date.now()

    function flushPendingResults(persist: boolean, force = false): void {
      if (pendingCount === 0) return
      const now = Date.now()
      if (!persist && !force && pendingCount < flushSize && now - lastFlushAt < RESULT_FLUSH_INTERVAL_MS) {
        return
      }
      setTestResultsBatch(pendingResults, persist)
      pendingResults = {}
      pendingCount = 0
      lastFlushAt = now
    }

    function updateStats(result: TestResult): void {
      if (result.status === 'valid') {
        localStats.valid += 1
        return
      }
      if (result.status === 'quota') {
        localStats.quota += 1
        return
      }
      if (result.status === 'expired') {
        localStats.expired += 1
        return
      }
      if (result.status === 'error') {
        localStats.error += 1
        return
      }
      localStats.other += 1
    }

    function flushProgress(force = false, reason: 'dispatch' | 'complete' = 'complete'): void {
      const now = Date.now()
      const shouldUpdateByStep = doneCount % progressStep === 0 || doneCount === targets.length
      const shouldUpdateByTime = now - lastProgressAt >= PROGRESS_UPDATE_INTERVAL_MS
      const shouldUpdateByDispatchBurst = reason === 'dispatch' && doneCount === 0 && dispatchedCount <= workerCount
      const shouldUpdateByDispatchTail = reason === 'dispatch' && dispatchedCount === targets.length
      if (!force && !shouldUpdateByStep && !shouldUpdateByTime && !shouldUpdateByDispatchBurst && !shouldUpdateByDispatchTail) {
        return
      }
      useBatchTestStore.getState().updateSnapshot(
        doneCount,
        localStats,
        dispatchedCount,
        inFlightCount,
        localPeakInFlight
      )
      lastProgressAt = now
    }

    async function runNext(): Promise<void> {
      while (index < targets.length && !useBatchTestStore.getState().cancelRequested) {
        const current = index++
        const f = targets[current]
        dispatchedCount = Math.max(dispatchedCount, current + 1)
        inFlightCount += 1
        if (inFlightCount > localPeakInFlight) {
          localPeakInFlight = inFlightCount
        }
        flushProgress(false, 'dispatch')
        try {
          const result = await testAuthFile(client!, f)
          pendingResults[f.name] = result
          updateStats(result)
          pendingCount += 1
          flushPendingResults(false)
          const disabled = await autoDisableIfQuota(client!, f, result, updateFile, {
            optimistic: false,
          })
          if (disabled) {
            autoDisabledCount += 1
            autoDisabledNames.add(f.name)
          }
        } catch {
          const errorResult: TestResult = {
            status: 'error',
            message: 'Unexpected error',
            testedAt: Date.now(),
          }
          pendingResults[f.name] = errorResult
          updateStats(errorResult)
          pendingCount += 1
          flushPendingResults(false)
        } finally {
          inFlightCount = Math.max(0, inFlightCount - 1)
        }
        doneCount += 1
        flushProgress(false, 'complete')
        if (doneCount % UI_YIELD_EVERY === 0) {
          await Promise.resolve()
        }
      }
    }

    try {
      try {
        await Promise.all(Array.from({ length: workerCount }, runNext))
      } catch {
        localStats.error += 1
      } finally {
        flushPendingResults(true, true)
        flushProgress(true)
        if (autoDisabledCount > 0) {
          try {
            const files = await fetchAuthFiles(client)
            setFiles(files)
          } catch {
            const currentFiles = useCredStore.getState().files
            if (currentFiles.length > 0 && autoDisabledNames.size > 0) {
              const nextFiles = currentFiles.map((file) => {
                if (!autoDisabledNames.has(file.name)) return file
                return { ...file, disabled: true, status: 'disabled' as const }
              })
              setFiles(nextFiles)
            }
          }
        }
        const cancelRequested = useBatchTestStore.getState().cancelRequested
        const cancelled = cancelRequested && doneCount < targets.length
        useBatchTestStore.getState().finish(cancelled, doneCount, localStats, localPeakInFlight)
      }
    } catch {
      useBatchTestStore.getState().finish(false, doneCount, localStats, localPeakInFlight)
    }
  }

  function cancel(): void {
    if (!useBatchTestStore.getState().isRunning) return
    useBatchTestStore.getState().requestCancel()
  }

  const progress = useMemo(() => ({ done, total }), [done, total])

  return {
    testBatch,
    isRunning,
    progress,
    dispatched,
    cancel,
    startedAt,
    updatedAt,
    workerCount,
    inFlight,
    peakInFlight,
    stats,
    cancelRequested,
    wasCancelled,
  }
}



