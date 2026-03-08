import { create } from 'zustand'
import { createClient, type ApiClient } from '@/lib/api'
import { loadTestResults } from '@/lib/storage'
import {
  deleteEndpointResultsByNamesFromDb,
  loadEndpointResultsFromDb,
  saveEndpointResultsBatchToDb,
} from '@/lib/resultsDb'
import type { AuthFile, ConnectionConfig, TestResult, TestStatus } from '@/types/api'

function mergeResultsByLatest(
  base: Record<string, TestResult>,
  incoming: Record<string, TestResult>
): Record<string, TestResult> {
  const merged: Record<string, TestResult> = { ...base }
  for (const [name, next] of Object.entries(incoming)) {
    const prev = merged[name]
    if (!prev || (next.testedAt ?? 0) >= (prev.testedAt ?? 0)) {
      merged[name] = next
    }
  }
  return merged
}

function persistResultsBatch(endpoint: string | undefined, updates: Record<string, TestResult>): void {
  if (!endpoint) return
  void saveEndpointResultsBatchToDb(endpoint, updates).catch(() => {})
}

function removeResultsBatch(endpoint: string | undefined, names: string[]): void {
  if (!endpoint || names.length === 0) return
  void deleteEndpointResultsByNamesFromDb(endpoint, names).catch(() => {})
}

interface CredStore {
  connection: ConnectionConfig | null
  connected: boolean
  client: ApiClient | null

  files: AuthFile[]
  loading: boolean
  refreshing: boolean

  testResults: Record<string, TestResult>

  selected: Set<string>

  setConnection: (config: ConnectionConfig) => void
  disconnect: () => void
  setFiles: (files: AuthFile[]) => void
  updateFile: (name: string, updated: Partial<AuthFile>) => void
  removeFile: (name: string) => void
  setTestResult: (name: string, result: TestResult) => void
  setTestResultsBatch: (updates: Record<string, TestResult>, persist?: boolean) => void
  setTestStatus: (name: string, status: TestStatus) => void
  toggleSelect: (name: string) => void
  selectAll: (names: string[]) => void
  deselectNames: (names: string[]) => void
  clearSelection: () => void
  setLoading: (v: boolean) => void
  setRefreshing: (v: boolean) => void
}

export const useCredStore = create<CredStore>((set) => ({
  connection: null,
  connected: false,
  client: null,

  files: [],
  loading: false,
  refreshing: false,

  testResults: {},
  selected: new Set<string>(),

  setConnection: (config) => {
    const client = createClient(config.endpoint, config.managementKey, config.useProxy)
    const legacyResults = loadTestResults(config.endpoint)
    set({ connection: config, connected: true, client, testResults: legacyResults })

    void loadEndpointResultsFromDb(config.endpoint)
      .then((dbResults) => {
        const hasDbData = Object.keys(dbResults).length > 0
        if (!hasDbData && Object.keys(legacyResults).length > 0) {
          persistResultsBatch(config.endpoint, legacyResults)
        }
        const merged = hasDbData ? mergeResultsByLatest(legacyResults, dbResults) : legacyResults
        const current = useCredStore.getState()
        if (current.connection?.endpoint !== config.endpoint) return
        set((state) => ({ testResults: mergeResultsByLatest(state.testResults, merged) }))
      })
      .catch(() => {})
  },

  disconnect: () =>
    set({
      connection: null,
      connected: false,
      client: null,
      files: [],
      testResults: {},
      selected: new Set<string>(),
    }),

  setFiles: (files) =>
    set((state) => {
      const existingNames = new Set(files.map((f) => f.name))

      const nextSelected = new Set<string>()
      for (const name of state.selected) {
        if (existingNames.has(name)) {
          nextSelected.add(name)
        }
      }

      const nextTestResults: Record<string, TestResult> = {}
      const removedNames: string[] = []
      for (const [name, result] of Object.entries(state.testResults)) {
        if (existingNames.has(name)) {
          nextTestResults[name] = result
        } else {
          removedNames.push(name)
        }
      }

      removeResultsBatch(state.connection?.endpoint, removedNames)

      return {
        files,
        selected: nextSelected,
        testResults: nextTestResults,
      }
    }),

  updateFile: (name, updated) =>
    set((state) => {
      const files = state.files.map((f) => (f.name === name ? { ...f, ...updated } : f))
      return { files }
    }),

  removeFile: (name) =>
    set((state) => {
      const nextSelected = new Set(state.selected)
      nextSelected.delete(name)
      const nextTestResults = { ...state.testResults }
      delete nextTestResults[name]
      removeResultsBatch(state.connection?.endpoint, [name])
      return {
        files: state.files.filter((f) => f.name !== name),
        selected: nextSelected,
        testResults: nextTestResults,
      }
    }),

  setTestResult: (name, result) =>
    set((state) => {
      const testResults = { ...state.testResults, [name]: result }
      persistResultsBatch(state.connection?.endpoint, { [name]: result })
      return { testResults }
    }),

  setTestResultsBatch: (updates, persist = true) =>
    set((state) => {
      const keys = Object.keys(updates)
      if (keys.length === 0) return {}
      const testResults = { ...state.testResults, ...updates }
      if (persist && state.connection?.endpoint) {
        persistResultsBatch(state.connection.endpoint, updates)
      }
      return { testResults }
    }),

  setTestStatus: (name, status) =>
    set((state) => ({
      testResults: {
        ...state.testResults,
        [name]: {
          status,
          testedAt: Date.now(),
        },
      },
    })),

  toggleSelect: (name) =>
    set((state) => {
      const next = new Set(state.selected)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { selected: next }
    }),

  selectAll: (names) =>
    set((state) => {
      const next = new Set(state.selected)
      names.forEach((n) => next.add(n))
      return { selected: next }
    }),

  deselectNames: (names) =>
    set((state) => {
      if (names.length === 0) return {}
      const next = new Set(state.selected)
      names.forEach((n) => next.delete(n))
      return { selected: next }
    }),

  clearSelection: () => set({ selected: new Set<string>() }),

  setLoading: (v) => set({ loading: v }),

  setRefreshing: (v) => set({ refreshing: v }),
}))
