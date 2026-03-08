import { useEffect, useMemo, useState } from 'react'
import { useCredStore } from '@/store/credStore'
import { deleteAuthFile, patchAuthFileStatus } from '@/lib/management'
import { useBatchTest } from '@/hooks/useBatchTest'

type BusyAction = 'test' | 'enable' | 'disable' | 'delete' | null
type BatchOutcome = { success: number; failed: number }
const ACTION_CONCURRENCY = 8
const PROGRESS_TEXT_UPDATE_INTERVAL_MS = 120

export default function BulkActionBar() {
  const selected = useCredStore((s) => s.selected)
  const files = useCredStore((s) => s.files)
  const client = useCredStore((s) => s.client)
  const { clearSelection, removeFile, updateFile } = useCredStore.getState()
  const { testBatch, isRunning } = useBatchTest()

  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [busyText, setBusyText] = useState<string | null>(null)
  const [lastSummary, setLastSummary] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const selectedFiles = useMemo(
    () => files.filter((f) => selected.has(f.name)),
    [files, selected]
  )

  const count = selectedFiles.length
  const actionDisabled = isRunning || busyAction !== null

  const subtitle = useMemo(() => {
    if (isRunning) return '批量测试运行中'
    if (busyText) return busyText
    if (lastSummary) return lastSummary
    return '先测试，再按结果启用/禁用/删除'
  }, [isRunning, busyText, lastSummary])

  const subtitleTone = useMemo(() => {
    if (busyText) return 'text-[#9A6B1E]'
    if (lastSummary?.includes('失败')) return 'text-[#B94040]'
    if (lastSummary) return 'text-[#2D7A3F]'
    if (isRunning) return 'text-coral'
    return 'text-subtle'
  }, [busyText, isRunning, lastSummary])

  useEffect(() => {
    if (count === 0) {
      setBusyText(null)
      setBusyAction(null)
      setLastSummary(null)
      setExpanded(false)
    }
  }, [count])

  useEffect(() => {
    if (busyAction || isRunning) {
      setExpanded(true)
    }
  }, [busyAction, isRunning])

  async function runInPool<T>(
    items: T[],
    worker: (item: T, index: number) => Promise<boolean>,
    onProgress: (done: number, total: number) => void
  ): Promise<BatchOutcome> {
    if (items.length === 0) return { success: 0, failed: 0 }

    const total = items.length
    let index = 0
    let done = 0
    let success = 0
    let lastProgressAt = Date.now()
    const workerCount = Math.min(ACTION_CONCURRENCY, total)

    function pushProgress(force = false): void {
      const now = Date.now()
      if (!force && done < total && now - lastProgressAt < PROGRESS_TEXT_UPDATE_INTERVAL_MS) {
        return
      }
      onProgress(done, total)
      lastProgressAt = now
    }

    async function runNext(): Promise<void> {
      while (true) {
        const current = index++
        if (current >= total) return
        let ok = false
        try {
          ok = await worker(items[current], current)
        } catch {
        }
        if (ok) success += 1
        done += 1
        pushProgress(false)
      }
    }

    await Promise.all(Array.from({ length: workerCount }, runNext))
    pushProgress(true)
    return { success, failed: total - success }
  }

  if (count === 0) return null

  const hiddenByBatchProgress = isRunning || busyAction === 'test'

  async function handleBulkTest() {
    if (selectedFiles.length === 0 || actionDisabled) return
    setLastSummary(null)
    setBusyAction('test')
    setBusyText('正在批量测试...')
    try {
      await testBatch(selectedFiles, { mode: 'all' })
      setLastSummary(`测试完成：共 ${selectedFiles.length} 项`)
    } catch {
      setLastSummary('测试中断：请重试')
    } finally {
      clearSelection()
      setBusyAction(null)
      setBusyText(null)
    }
  }

  async function handleBulkDisable(disable: boolean) {
    if (!client || selectedFiles.length === 0 || actionDisabled) return

    setLastSummary(null)
    const actionLabel = disable ? '禁用' : '启用'
    setBusyAction(disable ? 'disable' : 'enable')
    try {
      const outcome = await runInPool(
        selectedFiles,
        async (file) => {
          updateFile(file.name, {
            disabled: disable,
            status: disable ? 'disabled' : 'active',
          })
          try {
            await patchAuthFileStatus(client, file.name, disable)
            return true
          } catch {
            updateFile(file.name, { disabled: file.disabled, status: file.status })
            return false
          }
        },
        (done, max) => setBusyText(`${actionLabel}中 ${done}/${max}`)
      )
      setLastSummary(`${actionLabel}完成：成功 ${outcome.success}，失败 ${outcome.failed}`)
    } finally {
      clearSelection()
      setBusyAction(null)
      setBusyText(null)
    }
  }

  async function handleBulkDelete() {
    if (!client || selectedFiles.length === 0 || actionDisabled) return
    if (!window.confirm(`确定要删除选中的 ${count} 个认证文件？此操作不可撤销。`)) return

    setLastSummary(null)
    setBusyAction('delete')
    try {
      const outcome = await runInPool(
        selectedFiles,
        async (file) => {
          try {
            await deleteAuthFile(client, file.name)
            removeFile(file.name)
            return true
          } catch {
            return false
          }
        },
        (done, max) => setBusyText(`删除中 ${done}/${max}`)
      )
      setLastSummary(`删除完成：成功 ${outcome.success}，失败 ${outcome.failed}`)
    } finally {
      clearSelection()
      setBusyAction(null)
      setBusyText(null)
    }
  }

  const actionBase = 'h-10 px-3 rounded-lg text-sm font-semibold transition-colors disabled:opacity-45 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 border'

  return (
    <div
      className={`fixed bottom-2 sm:bottom-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none px-2 sm:px-0 w-full sm:w-auto ${hiddenByBatchProgress ? 'hidden' : ''}`}
      style={{ paddingBottom: 'max(0px, env(safe-area-inset-bottom))' }}
    >
      <div className="pointer-events-auto w-full sm:w-[min(96vw,880px)] rounded-2xl border border-border bg-canvas/96 backdrop-blur shadow-[0_16px_42px_rgba(26,26,26,0.24)] overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border bg-surface/90 flex items-start sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">批量操作控制台</div>
            <div className={`text-xs mt-0.5 truncate ${subtitleTone}`}>{subtitle}</div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="h-8 px-3 inline-flex items-center rounded-full border border-border bg-canvas text-xs tabular-nums text-ink">
              已选 {count} 项
            </div>
            <button
              onClick={() => setExpanded((v) => !v)}
              disabled={actionDisabled}
              className="h-8 px-3 rounded-md border border-border bg-canvas text-xs font-semibold text-subtle hover:text-ink hover:border-ink disabled:opacity-50"
              title={expanded ? '收起高级操作' : '展开高级操作'}
            >
              {expanded ? '收起' : '展开'}
            </button>
          </div>
        </div>

        {!expanded && (
          <div className="p-3 sm:p-4 flex items-center gap-2.5">
            <button
              onClick={handleBulkTest}
              disabled={actionDisabled || selectedFiles.length === 0}
              className={`${actionBase} flex-1 border-coral bg-coral text-white hover:bg-coral-dark`}
            >
              {busyAction === 'test' || isRunning ? <SpinIcon /> : <TestIcon />}
              {busyAction === 'test' || isRunning ? '测试中' : '测试选中项'}
            </button>

            <button
              onClick={() => setExpanded(true)}
              disabled={actionDisabled}
              className={`${actionBase} border-border bg-canvas text-subtle hover:text-ink hover:border-ink`}
            >
              <ExpandIcon />
              更多操作
            </button>
          </div>
        )}

        {expanded && (
          <>
            <div className="px-4 sm:px-5 py-2 border-b border-border/70 bg-canvas/75 text-xs text-subtle flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">建议顺序：测试 → 启用/禁用 → 删除</span>
              {actionDisabled && <span className="text-[#9A6B1E]">执行中，请稍候...</span>}
            </div>

            <div className="p-3 sm:p-4 grid grid-cols-2 sm:grid-cols-5 gap-2.5">
              <button
                onClick={handleBulkTest}
                disabled={actionDisabled || selectedFiles.length === 0}
                className={`${actionBase} border-coral bg-coral text-white hover:bg-coral-dark`}
              >
                {busyAction === 'test' || isRunning ? <SpinIcon /> : <TestIcon />}
                {busyAction === 'test' || isRunning ? '测试中' : '测试'}
              </button>

              <button
                onClick={() => handleBulkDisable(false)}
                disabled={actionDisabled || !client || selectedFiles.length === 0}
                className={`${actionBase} border-[#BDD9C2] bg-[#EDF9F0] text-[#2D7A3F] hover:bg-[#E2F4E7]`}
              >
                {busyAction === 'enable' ? <SpinIcon /> : <EnableIcon />}
                启用
              </button>

              <button
                onClick={() => handleBulkDisable(true)}
                disabled={actionDisabled || !client || selectedFiles.length === 0}
                className={`${actionBase} border-[#D7B27A] bg-[#FFF7E8] text-[#9A6B1E] hover:bg-[#FFF1D6]`}
              >
                {busyAction === 'disable' ? <SpinIcon /> : <DisableIcon />}
                禁用
              </button>

              <button
                onClick={handleBulkDelete}
                disabled={actionDisabled || !client || selectedFiles.length === 0}
                className={`${actionBase} border-[#E9C7C7] bg-[#FFF3F3] text-[#B94040] hover:bg-[#FDE8E8]`}
              >
                {busyAction === 'delete' ? <SpinIcon /> : <DeleteIcon />}
                删除
              </button>

              <button
                onClick={clearSelection}
                disabled={actionDisabled}
                className={`${actionBase} border-border bg-canvas text-subtle hover:text-ink hover:border-ink`}
              >
                <ClearIcon />
                清空
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SpinIcon() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-30" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function TestIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
      <path d="M6.3 2.84A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.27l9.34-5.89a1.5 1.5 0 000-2.54L6.3 2.84z" />
    </svg>
  )
}

function EnableIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function DisableIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.35 9m-4.78 0L9.26 9m9.97-3.21c.34.05.68.11 1.02.17m-1.02-.17L18.16 19.67a2.25 2.25 0 01-2.24 2.08H8.08a2.25 2.25 0 01-2.24-2.08L4.77 5.79m14.46 0a48.1 48.1 0 00-3.48-.4m-12 .57c.34-.06.68-.11 1.02-.17m0 0a48.1 48.1 0 013.48-.4m7.5 0v-.91c0-1.18-.91-2.17-2.09-2.2a51.9 51.9 0 00-3.32 0c-1.18.03-2.09 1.02-2.09 2.2v.91m7.5 0a48.7 48.7 0 00-7.5 0" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 14L14 6M6 6l8 8" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  )
}



