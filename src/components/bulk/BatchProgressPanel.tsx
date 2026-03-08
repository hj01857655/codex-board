import { useEffect, useState } from 'react'
import { useBatchTest } from '@/hooks/useBatchTest'

export default function BatchProgressPanel() {
  const {
    isRunning,
    progress,
    dispatched,
    cancel,
    startedAt,
    workerCount,
    inFlight,
    peakInFlight,
    stats,
    cancelRequested,
  } = useBatchTest()

  const [now, setNow] = useState<number>(() => Date.now())
  const [collapsed, setCollapsed] = useState(false)
  const [minimized, setMinimized] = useState(false)

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  useEffect(() => {
    if (!isRunning) {
      setCollapsed(false)
      setMinimized(false)
    }
  }, [isRunning])

  if (!isRunning || progress.total === 0) return null

  const completedPercent = Math.min(100, Math.round((progress.done / progress.total) * 100))
  const dispatchedPercent = Math.min(100, Math.round((dispatched / progress.total) * 100))
  const elapsedSeconds = startedAt ? Math.max(1, Math.floor((now - startedAt) / 1000)) : 1
  const completeSpeed = progress.done / elapsedSeconds
  const dispatchSpeed = dispatched / elapsedSeconds
  const remain = Math.max(0, progress.total - progress.done)
  const etaSeconds = completeSpeed > 0 ? Math.round(remain / completeSpeed) : null

  const etaText = etaSeconds == null ? '计算中' : formatDuration(etaSeconds)
  const finishAtText = etaSeconds == null
    ? '计算中'
    : new Date(now + etaSeconds * 1000).toLocaleTimeString('zh-CN', { hour12: false })
  const elapsedText = formatDuration(elapsedSeconds)
  const successRate = progress.done > 0 ? Math.round((stats.valid / progress.done) * 100) : 0

  const summary = [
    { label: '有效', value: stats.valid, tone: 'text-[#2D7A3F]' },
    { label: '超额', value: stats.quota, tone: 'text-[#9A6B1E]' },
    { label: '过期', value: stats.expired, tone: 'text-[#B94040]' },
    { label: '错误', value: stats.error, tone: 'text-[#B94040]' },
    { label: '其他', value: stats.other, tone: 'text-subtle' },
  ]

  if (minimized) {
    return (
      <div className="fixed right-4 bottom-4 z-50 w-[min(92vw,360px)] rounded-xl border border-border bg-canvas/95 backdrop-blur shadow-[0_12px_28px_rgba(26,26,26,0.22)] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-border bg-surface/85 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-ink truncate">测试进行中</div>
            <div className="text-[11px] text-subtle tabular-nums mt-0.5">
              {progress.done}/{progress.total} ({completedPercent}%) · 在途 {inFlight}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setMinimized(false)}
              className="h-7 px-2.5 rounded-md border border-border bg-canvas text-[11px] font-semibold text-subtle hover:text-ink hover:border-ink"
            >
              展开
            </button>
            <button
              onClick={cancel}
              disabled={cancelRequested}
              className="h-7 px-2.5 rounded-md border border-[#E9C7C7] bg-[#FFF3F3] text-[11px] font-semibold text-[#B94040] hover:bg-[#FDE8E8] disabled:opacity-60"
            >
              {cancelRequested ? '取消中' : '取消'}
            </button>
          </div>
        </div>
        <div className="px-3 py-2 bg-canvas">
          <div className="h-2 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-coral rounded-full transition-all" style={{ width: `${completedPercent}%` }} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-4 z-50 w-[min(96vw,760px)] rounded-2xl border border-border bg-canvas/96 backdrop-blur shadow-[0_14px_34px_rgba(26,26,26,0.22)] overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-surface/85 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink">测试进度面板</div>
          <div className="text-xs text-subtle mt-0.5">
            并发上限 {workerCount} · 已派发 {dispatched}/{progress.total} · 已完成 {progress.done}/{progress.total} · 当前在途 {inFlight} · 峰值在途 {peakInFlight} · 已用时 {elapsedText} · 预计剩余 {etaText} · 预计完成 {finishAtText} · 成功率 {successRate}%
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="h-8 px-3 rounded-md border border-border bg-canvas text-xs font-semibold text-subtle hover:text-ink hover:border-ink"
          >
            {collapsed ? '展开详情' : '收起详情'}
          </button>
          <button
            onClick={() => setMinimized(true)}
            className="h-8 px-3 rounded-md border border-border bg-canvas text-xs font-semibold text-subtle hover:text-ink hover:border-ink"
          >
            悬浮
          </button>
          <button
            onClick={cancel}
            disabled={cancelRequested}
            className="h-8 px-3 rounded-md border border-[#E9C7C7] bg-[#FFF3F3] text-xs font-semibold text-[#B94040] hover:bg-[#FDE8E8] disabled:opacity-60"
          >
            {cancelRequested ? '取消中...' : '取消测试'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="px-4 py-3 border-b border-border bg-canvas space-y-3">
            <div>
              <div className="flex items-center justify-between text-xs text-subtle mb-1">
                <span>派发进度</span>
                <span className="tabular-nums">
                  {dispatched}/{progress.total} ({dispatchedPercent}%)
                </span>
              </div>
              <div className="h-2 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-[#6B87D8] rounded-full transition-all" style={{ width: `${dispatchedPercent}%` }} />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs text-subtle mb-1">
                <span>完成进度</span>
                <span className="tabular-nums">
                  {progress.done}/{progress.total} ({completedPercent}%)
                </span>
              </div>
              <div className="h-2 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-coral rounded-full transition-all" style={{ width: `${completedPercent}%` }} />
              </div>
            </div>

            <div className="text-xs text-subtle">
              派发速度：<span className="tabular-nums text-ink">{dispatchSpeed.toFixed(1)}</span> 项/秒
              <span className="mx-2 text-muted">|</span>
              完成速度：<span className="tabular-nums text-ink">{completeSpeed.toFixed(1)}</span> 项/秒
            </div>
          </div>

          <div className="px-4 py-3 grid grid-cols-5 gap-1.5">
            {summary.map((item) => (
              <div key={item.label} className="rounded-md border border-border bg-surface px-2 py-1.5 text-center">
                <div className="text-[11px] text-subtle">{item.label}</div>
                <div className={`text-sm font-semibold tabular-nums ${item.tone}`}>{item.value}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {collapsed && (
        <div className="px-4 py-2 bg-canvas space-y-1.5">
          <div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-[#6B87D8] rounded-full transition-all" style={{ width: `${dispatchedPercent}%` }} />
            </div>
            <div className="mt-1 text-xs text-subtle tabular-nums">
              派发 {dispatched}/{progress.total} ({dispatchedPercent}%)
            </div>
          </div>
          <div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-coral rounded-full transition-all" style={{ width: `${completedPercent}%` }} />
            </div>
            <div className="mt-1 text-xs text-subtle tabular-nums">
              完成 {progress.done}/{progress.total} ({completedPercent}%)
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60

  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
