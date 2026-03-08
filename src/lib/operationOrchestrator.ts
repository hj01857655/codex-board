export interface OperationProgressSnapshot {
  done: number
  total: number
  success: number
  failed: number
  inFlight: number
  workerCount: number
}

export interface OperationPoolResult {
  success: number
  failed: number
  total: number
}

export interface RunOperationInPoolOptions<T> {
  items: T[]
  maxConcurrency: number
  worker: (item: T, index: number) => Promise<boolean>
  onProgress?: (snapshot: OperationProgressSnapshot) => void
  progressIntervalMs?: number
}

const DEFAULT_PROGRESS_INTERVAL_MS = 120

export async function runOperationInPool<T>(
  options: RunOperationInPoolOptions<T>
): Promise<OperationPoolResult> {
  const {
    items,
    maxConcurrency,
    worker,
    onProgress,
    progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
  } = options

  const total = items.length
  if (total === 0) {
    return { success: 0, failed: 0, total: 0 }
  }

  const workerCount = Math.max(1, Math.min(Math.floor(maxConcurrency), total))
  let index = 0
  let done = 0
  let success = 0
  let failed = 0
  let inFlight = 0
  let lastProgressAt = Date.now()

  function pushProgress(force = false): void {
    if (!onProgress) return
    const now = Date.now()
    if (!force && done < total && now - lastProgressAt < progressIntervalMs) {
      return
    }
    onProgress({
      done,
      total,
      success,
      failed,
      inFlight,
      workerCount,
    })
    lastProgressAt = now
  }

  async function runNext(): Promise<void> {
    while (true) {
      const current = index++
      if (current >= total) return
      inFlight += 1
      pushProgress(false)
      let ok = false
      try {
        ok = await worker(items[current], current)
      } catch {
      } finally {
        inFlight = Math.max(0, inFlight - 1)
      }

      if (ok) {
        success += 1
      } else {
        failed += 1
      }
      done += 1
      pushProgress(false)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runNext))
  pushProgress(true)

  return {
    success,
    failed,
    total,
  }
}
