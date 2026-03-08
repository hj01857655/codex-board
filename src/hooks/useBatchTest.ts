import { useCredStore } from '@/store/credStore'
import { testAuthFile } from '@/lib/management'
import type { AuthFile } from '@/types/api'

const CONCURRENCY = 20
let cancelled = false

export function useBatchTest() {
  const isRunning = useCredStore((s) => s.batchTestRunning)
  const progress = useCredStore((s) => s.batchTestProgress)

  async function testBatch(authFiles: AuthFile[]): Promise<void> {
    const {
      client,
      batchTestRunning,
      setTestStatus,
      setTestResult,
      setBatchTestRunning,
      setBatchTestProgress,
    } = useCredStore.getState()

    if (!client || batchTestRunning || authFiles.length === 0) return
    const apiClient = client

    cancelled = false
    setBatchTestRunning(true)
    setBatchTestProgress({ done: 0, total: authFiles.length })

    authFiles.forEach((f) => setTestStatus(f.name, 'queued'))

    let done = 0
    let index = 0

    async function runNext(): Promise<void> {
      while (index < authFiles.length && !cancelled) {
        const current = index++
        const f = authFiles[current]
        try {
          setTestStatus(f.name, 'testing')
          const result = await testAuthFile(apiClient, f)
          setTestResult(f.name, result)
        } catch {
          setTestResult(f.name, { status: 'error', message: 'Unexpected error', testedAt: Date.now() })
        }
        done++
        setBatchTestProgress({ done, total: authFiles.length })
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, runNext))
    } finally {
      setBatchTestRunning(false)
    }
  }

  function cancel(): void {
    cancelled = true
  }

  return { testBatch, isRunning, progress, cancel }
}
