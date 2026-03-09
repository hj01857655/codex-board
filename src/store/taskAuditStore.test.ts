import { beforeEach, describe, expect, it } from 'vitest'
import { useTaskAuditStore } from '@/store/taskAuditStore'

class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

beforeEach(() => {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })

  useTaskAuditStore.setState({ endpoint: null, records: [] })
})

describe('useTaskAuditStore', () => {
  it('应按端点持久化并可重新加载', () => {
    const store = useTaskAuditStore.getState()

    store.bindEndpoint('https://a.example.com')
    const taskId = store.startTask({
      type: 'bulk',
      source: 'manual',
      label: '批量禁用',
      total: 2,
    })

    store.finishTask(taskId, {
      status: 'success',
      done: 2,
      success: 2,
      failed: 0,
    })

    expect(useTaskAuditStore.getState().records.length).toBe(1)

    store.bindEndpoint('https://b.example.com')
    expect(useTaskAuditStore.getState().records.length).toBe(0)

    store.bindEndpoint('https://a.example.com')
    const records = useTaskAuditStore.getState().records
    expect(records.length).toBe(1)
    expect(records[0].taskId).toBe(taskId)
    expect(records[0].status).toBe('success')
  })

  it('应限制记录上限为120条', () => {
    const store = useTaskAuditStore.getState()
    store.bindEndpoint('https://limit.example.com')

    for (let i = 0; i < 130; i += 1) {
      store.startTask({
        type: 'test',
        source: 'manual',
        label: `测试-${i}`,
        total: 1,
      })
    }

    expect(useTaskAuditStore.getState().records.length).toBe(120)
  })
})
