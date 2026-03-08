import { create } from 'zustand'
import { createClient, type ApiClient } from '@/lib/api'
import { loadTestResults, saveTestResults } from '@/lib/storage'
import type { AuthFile, ConnectionConfig, TestResult, TestStatus } from '@/types/api'

export interface RemovedFileSnapshot {
  file: AuthFile
  index: number
  wasSelected: boolean
  testResult?: TestResult
}

interface CredStore {
  connection: ConnectionConfig | null
  connected: boolean
  client: ApiClient | null

  files: AuthFile[]
  loading: boolean
  refreshing: boolean

  batchTestRunning: boolean
  batchTestProgress: { done: number; total: number }
  batchTestRunId: number

  testResults: Record<string, TestResult>

  selected: Set<string>

  setConnection: (config: ConnectionConfig) => void
  connectWithClient: (config: ConnectionConfig, client: ApiClient) => void
  disconnect: () => void
  setFiles: (files: AuthFile[]) => void
  updateFile: (name: string, updated: Partial<AuthFile>) => void
  removeFile: (name: string) => void
  removeFileOptimistic: (name: string) => RemovedFileSnapshot | null
  restoreRemovedFile: (snapshot: RemovedFileSnapshot) => void
  setTestResult: (name: string, result: TestResult) => void
  setTestStatus: (name: string, status: TestStatus) => void
  toggleSelect: (name: string) => void
  selectAll: (names: string[]) => void
  clearSelection: () => void
  setLoading: (v: boolean) => void
  setRefreshing: (v: boolean) => void
  startBatchTest: (total: number) => number | null
  finishBatchTest: (runId: number) => void
  cancelBatchTest: () => void
  setBatchTestProgress: (runId: number, progress: { done: number; total: number }) => void
}

export const useCredStore = create<CredStore>((set, get) => ({
  connection: null,
  connected: false,
  client: null,

  files: [],
  loading: false,
  refreshing: false,

  batchTestRunning: false,
  batchTestProgress: { done: 0, total: 0 },
  batchTestRunId: 0,

  testResults: {},
  selected: new Set<string>(),

  setConnection: (config) => {
    const client = createClient(config.endpoint, config.managementKey, config.useProxy)
    const testResults = loadTestResults(config.endpoint)
    set({ connection: config, connected: true, client, testResults })
  },

  connectWithClient: (config: ConnectionConfig, client: ApiClient) => {
    const testResults = loadTestResults(config.endpoint)
    set({ connection: config, connected: true, client, testResults })
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

  setFiles: (files) => set({ files }),

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
      if (state.connection?.endpoint) {
        saveTestResults(state.connection.endpoint, nextTestResults)
      }
      return {
        files: state.files.filter((f) => f.name !== name),
        selected: nextSelected,
        testResults: nextTestResults,
      }
    }),

  removeFileOptimistic: (name) => {
    let snapshot: RemovedFileSnapshot | null = null
    set((state) => {
      const index = state.files.findIndex((f) => f.name === name)
      if (index === -1) return state

      const file = state.files[index]
      const nextSelected = new Set(state.selected)
      const wasSelected = nextSelected.has(name)
      nextSelected.delete(name)

      const nextTestResults = { ...state.testResults }
      const previousResult = nextTestResults[name]
      delete nextTestResults[name]

      if (state.connection?.endpoint) {
        saveTestResults(state.connection.endpoint, nextTestResults)
      }

      snapshot = {
        file,
        index,
        wasSelected,
        testResult: previousResult,
      }

      return {
        files: state.files.filter((f) => f.name !== name),
        selected: nextSelected,
        testResults: nextTestResults,
      }
    })

    return snapshot
  },

  restoreRemovedFile: (snapshot) =>
    set((state) => {
      if (state.files.some((f) => f.name === snapshot.file.name)) {
        return state
      }

      const files = [...state.files]
      const insertAt = Math.max(0, Math.min(snapshot.index, files.length))
      files.splice(insertAt, 0, snapshot.file)

      const selected = new Set(state.selected)
      if (snapshot.wasSelected) {
        selected.add(snapshot.file.name)
      }

      const testResults = { ...state.testResults }
      if (snapshot.testResult) {
        testResults[snapshot.file.name] = snapshot.testResult
      }

      if (state.connection?.endpoint) {
        saveTestResults(state.connection.endpoint, testResults)
      }

      return { files, selected, testResults }
    }),

  setTestResult: (name, result) =>
    set((state) => {
      const testResults = { ...state.testResults, [name]: result }
      if (state.connection?.endpoint) {
        saveTestResults(state.connection.endpoint, testResults)
      }
      return { testResults }
    }),

  setTestStatus: (name, status) =>
    set((state) => ({
      testResults: {
        ...state.testResults,
        [name]: {
          ...(state.testResults[name] ?? {}),
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

  clearSelection: () => set({ selected: new Set<string>() }),

  setLoading: (v) => set({ loading: v }),

  setRefreshing: (v) => set({ refreshing: v }),

  startBatchTest: (total) => {
    const state = get()
    if (state.batchTestRunning || total <= 0) {
      return null
    }

    const nextRunId = state.batchTestRunId + 1
    set({
      batchTestRunning: true,
      batchTestProgress: { done: 0, total },
      batchTestRunId: nextRunId,
    })
    return nextRunId
  },

  finishBatchTest: (runId) =>
    set((state) => {
      if (state.batchTestRunId !== runId) {
        return state
      }

      return { batchTestRunning: false }
    }),

  cancelBatchTest: () =>
    set((state) => {
      if (!state.batchTestRunning) {
        return state
      }

      return {
        batchTestRunning: false,
        batchTestRunId: state.batchTestRunId + 1,
      }
    }),

  setBatchTestProgress: (runId, progress) =>
    set((state) => {
      if (state.batchTestRunId !== runId) {
        return state
      }

      return { batchTestProgress: progress }
    }),
}))
