import { create } from 'zustand'

export interface BatchTestStats {
  valid: number
  quota: number
  expired: number
  error: number
  other: number
}

function emptyStats(): BatchTestStats {
  return { valid: 0, quota: 0, expired: 0, error: 0, other: 0 }
}

interface BatchTestState {
  isRunning: boolean
  cancelRequested: boolean
  wasCancelled: boolean
  done: number
  dispatched: number
  total: number
  startedAt: number | null
  updatedAt: number | null
  workerCount: number
  inFlight: number
  peakInFlight: number
  stats: BatchTestStats
  start: (total: number, workerCount: number) => void
  updateSnapshot: (
    done: number,
    stats: BatchTestStats,
    dispatched: number,
    inFlight: number,
    peakInFlight: number
  ) => void
  requestCancel: () => void
  finish: (
    cancelled: boolean,
    done: number,
    stats: BatchTestStats,
    peakInFlight: number
  ) => void
}

export const useBatchTestStore = create<BatchTestState>((set) => ({
  isRunning: false,
  cancelRequested: false,
  wasCancelled: false,
  done: 0,
  dispatched: 0,
  total: 0,
  startedAt: null,
  updatedAt: null,
  workerCount: 0,
  inFlight: 0,
  peakInFlight: 0,
  stats: emptyStats(),

  start: (total, workerCount) =>
    set({
      isRunning: true,
      cancelRequested: false,
      wasCancelled: false,
      done: 0,
      dispatched: 0,
      total,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      workerCount,
      inFlight: 0,
      peakInFlight: 0,
      stats: emptyStats(),
    }),

  updateSnapshot: (done, stats, dispatched, inFlight, peakInFlight) =>
    set((state) => ({
      done,
      dispatched: Math.max(state.dispatched, dispatched),
      total: state.total,
      updatedAt: Date.now(),
      inFlight,
      peakInFlight: Math.max(state.peakInFlight, peakInFlight),
      stats: { ...stats },
    })),

  requestCancel: () => set({ cancelRequested: true }),

  finish: (cancelled, done, stats, peakInFlight) =>
    set((state) => ({
      isRunning: false,
      cancelRequested: false,
      wasCancelled: cancelled,
      done,
      dispatched: Math.max(state.dispatched, done),
      total: state.total,
      updatedAt: Date.now(),
      inFlight: 0,
      peakInFlight: Math.max(state.peakInFlight, peakInFlight),
      stats: { ...stats },
    })),
}))
