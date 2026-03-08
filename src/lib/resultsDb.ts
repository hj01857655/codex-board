import type { TestResult } from '@/types/api'

const DB_NAME = 'cliproxy_results_db'
const DB_VERSION = 1
const STORE_RESULTS = 'results'
const INDEX_ENDPOINT = 'by_endpoint'

interface ResultRow {
  endpoint: string
  name: string
  result: TestResult
  updatedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB is not available'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_RESULTS)) {
        const store = db.createObjectStore(STORE_RESULTS, {
          keyPath: ['endpoint', 'name'],
        })
        store.createIndex(INDEX_ENDPOINT, 'endpoint', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('failed to open indexedDB'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, tx: IDBTransaction) => void | Promise<T>
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_RESULTS, mode)
    const store = tx.objectStore(STORE_RESULTS)
    let resolved = false
    let value: T | undefined

    tx.oncomplete = () => {
      db.close()
      if (!resolved) {
        resolve(value as T)
      }
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('indexedDB transaction aborted'))
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error ?? new Error('indexedDB transaction failed'))
    }

    Promise.resolve(work(store, tx))
      .then((result) => {
        if (result !== undefined) {
          value = result as T
        }
      })
      .catch((error) => {
        try {
          tx.abort()
        } catch {
        }
        reject(error)
      })
  })
}

export async function loadEndpointResultsFromDb(endpoint: string): Promise<Record<string, TestResult>> {
  if (!endpoint) return {}

  return withStore<Record<string, TestResult>>('readonly', (store) => {
    return new Promise<Record<string, TestResult>>((resolve, reject) => {
      const result: Record<string, TestResult> = {}
      const index = store.index(INDEX_ENDPOINT)
      const request = index.openCursor(IDBKeyRange.only(endpoint))

      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve(result)
          return
        }
        const row = cursor.value as ResultRow
        result[row.name] = row.result
        cursor.continue()
      }
      request.onerror = () => reject(request.error ?? new Error('failed to read results'))
    })
  })
}

export async function saveEndpointResultsBatchToDb(
  endpoint: string,
  updates: Record<string, TestResult>
): Promise<void> {
  if (!endpoint) return
  const entries = Object.entries(updates)
  if (entries.length === 0) return

  await withStore<void>('readwrite', (store) => {
    const now = Date.now()
    for (const [name, result] of entries) {
      const row: ResultRow = {
        endpoint,
        name,
        result,
        updatedAt: now,
      }
      store.put(row)
    }
  })
}

export async function deleteEndpointResultsByNamesFromDb(endpoint: string, names: string[]): Promise<void> {
  if (!endpoint || names.length === 0) return

  await withStore<void>('readwrite', (store) => {
    for (const name of names) {
      store.delete([endpoint, name])
    }
  })
}

