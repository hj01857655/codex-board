import { describe, expect, it } from 'vitest'
import { runOperationInPool } from '@/lib/operationOrchestrator'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('runOperationInPool', () => {
  it('应限制并发并给出正确统计', async () => {
    const items = [1, 2, 3, 4, 5, 6]
    let active = 0
    let peakActive = 0
    const progressDone: number[] = []

    const result = await runOperationInPool({
      items,
      maxConcurrency: 3,
      progressIntervalMs: 0,
      onProgress: (snapshot) => {
        progressDone.push(snapshot.done)
      },
      worker: async (item) => {
        active += 1
        peakActive = Math.max(peakActive, active)
        await sleep(10)
        active -= 1
        return item % 2 === 0
      },
    })

    expect(peakActive).toBeLessThanOrEqual(3)
    expect(result.total).toBe(6)
    expect(result.success).toBe(3)
    expect(result.failed).toBe(3)
    expect(progressDone[progressDone.length - 1]).toBe(6)
  })

  it('空任务应立即返回', async () => {
    const result = await runOperationInPool({
      items: [],
      maxConcurrency: 8,
      worker: async () => true,
    })

    expect(result).toEqual({ success: 0, failed: 0, total: 0 })
  })
})
