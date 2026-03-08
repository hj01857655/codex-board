import { useCredStore } from '@/store/credStore'
import { testAuthFile } from '@/lib/management'
import type { AuthFile } from '@/types/api'

const CONCURRENCY = 20

export function useBatchTest() {
  const isRunning = useCredStore((s) => s.batchTestRunning)
  const progress = useCredStore((s) => s.batchTestProgress)

  async function testBatch(authFiles: AuthFile[]): Promise<void> {
    const {
      client,
      setTestStatus,
      setTestResult,
      startBatchTest,
      finishBatchTest,
      setBatchTestProgress,
    } = useCredStore.getState()

    if (!client || authFiles.length === 0) return
    const apiClient = client
    const runId = startBatchTest(authFiles.length)
    if (runId === null) return
    const activeRunId = runId

    const shouldStop = () => {
      const state = useCredStore.getState()
      return !state.batchTestRunning || state.batchTestRunId !== activeRunId
    }

    authFiles.forEach((f) => setTestStatus(f.name, 'queued'))

    let done = 0
    let index = 0

    async function runNext(): Promise<void> {
      while (index < authFiles.length && !shouldStop()) {
        const current = index++
        const f = authFiles[current]
        try {
          setTestStatus(f.name, 'testing')
          const result = await testAuthFile(apiClient, f, (status) => {
            if (!shouldStop()) {
              setTestStatus(f.name, status)
            }
          })
          if (!shouldStop()) {
            setTestResult(f.name, result)
          }
        } catch {
          if (!shouldStop()) {
            setTestResult(f.name, { status: 'error', message: 'Unexpected error', testedAt: Date.now() })
          }
        }
        done++
        if (!shouldStop()) {
          setBatchTestProgress(activeRunId, { done, total: authFiles.length })
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, runNext))
    } finally {
      finishBatchTest(activeRunId)
    }
  }

  function cancel(): void {
    useCredStore.getState().cancelBatchTest()
  }

  return { testBatch, isRunning, progress, cancel }
}
