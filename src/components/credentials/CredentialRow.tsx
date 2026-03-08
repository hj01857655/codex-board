import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCredStore } from '@/store/credStore'
import { deleteAuthFile, patchAuthFileStatus, testAuthFile } from '@/lib/management'
import { autoDisableIfQuota } from '@/lib/autoDisable'
import { formatRelativeTime, getProviderColor } from '@/utils/keyUtils'
import { getEffectiveStatus } from '@/utils/statusUtils'
import StatusBadge from './StatusBadge'
import type { AuthFile } from '@/types/api'

interface CredentialRowProps {
  file: AuthFile
  isSelected: boolean
  onToggleSelect?: (shiftKey: boolean) => void
}

export default function CredentialRow({ file, isSelected, onToggleSelect }: CredentialRowProps) {
  const store = useCredStore.getState()
  const client = useCredStore((s) => s.client)
  const testResult = useCredStore((s) => s.testResults[file.name])
  const [responseOpen, setResponseOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [rowBusy, setRowBusy] = useState<'testing' | 'toggle' | 'delete' | null>(null)

  const displayStatus = getEffectiveStatus(file, testResult)
  const hasResponseBody = testResult?.responseJson !== undefined
  const responseJsonText = useMemo(() => {
    if (!responseOpen || testResult?.responseJson === undefined) return ''
    try {
      return JSON.stringify(testResult.responseJson, null, 2)
    } catch {
      return String(testResult.responseJson)
    }
  }, [responseOpen, testResult?.responseJson])

  useEffect(() => {
    if (!responseOpen) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setResponseOpen(false)
      }
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [responseOpen])

  useEffect(() => {
    if (!responseOpen) {
      setCopyState('idle')
    }
  }, [responseOpen])

  async function handleTest() {
    if (!client || rowBusy) return
    setRowBusy('testing')
    try {
      store.setTestStatus(file.name, 'testing')
      const result = await testAuthFile(client, file)
      store.setTestResult(file.name, result)
      await autoDisableIfQuota(client, file, result, store.updateFile)
    } finally {
      setRowBusy(null)
    }
  }

  async function handleToggleDisable() {
    if (!client || rowBusy) return
    setRowBusy('toggle')
    const newDisabled = !file.disabled
    store.updateFile(file.name, { disabled: newDisabled, status: newDisabled ? 'disabled' : 'active' })
    try {
      await patchAuthFileStatus(client, file.name, newDisabled)
    } catch {
      store.updateFile(file.name, { disabled: file.disabled, status: file.status })
    } finally {
      setRowBusy(null)
    }
  }

  async function handleDelete() {
    if (!client || rowBusy) return
    if (!window.confirm(`确定要删除认证文件 "${file.name}"？此操作不可撤销。`)) return
    setRowBusy('delete')
    const snapshot = useCredStore.getState().files
    const snapshotIndex = snapshot.findIndex((item) => item.name === file.name)
    try {
      store.removeFile(file.name)
      try {
        await deleteAuthFile(client, file.name)
      } catch {
        const current = useCredStore.getState().files
        if (current.some((item) => item.name === file.name)) return
        const insertAt = snapshotIndex >= 0 ? Math.min(snapshotIndex, current.length) : current.length
        const restored = [...current]
        restored.splice(insertAt, 0, file)
        store.setFiles(restored)
      }
    } finally {
      setRowBusy(null)
    }
  }

  const providerColor = getProviderColor(file.provider)
  const providerLabel = (file.provider || file.type || '未知').toLowerCase()
  const availabilityColor = file.disabled ? '#9A948C' : '#10A37F'
  const availabilityTitle = file.disabled ? '已禁用' : '已启用'
  const quotaResetLabel = getQuotaResetLabel(testResult)
  const rowSelectedClass = isSelected
    ? 'bg-coral/10 ring-1 ring-inset ring-coral/35'
    : 'hover:bg-surface/70'

  function handleRowSelectToggle(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, textarea, select, [data-no-row-select]')) {
      return
    }
    if (onToggleSelect) {
      onToggleSelect(e.shiftKey)
      return
    }
    store.toggleSelect(file.name)
  }

  function handleCheckboxToggle(e: React.ChangeEvent<HTMLInputElement>) {
    const shiftKey = !!((e.nativeEvent as { shiftKey?: boolean } | undefined)?.shiftKey)
    if (onToggleSelect) {
      onToggleSelect(shiftKey)
      return
    }
    store.toggleSelect(file.name)
  }

  async function handleCopyResponse() {
    if (!responseJsonText) return
    try {
      await navigator.clipboard.writeText(responseJsonText)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 1500)
  }

  const responseModal = responseOpen && hasResponseBody && typeof document !== 'undefined'
    ? createPortal(
      <div
        className="fixed inset-0 z-[90] bg-black/55 backdrop-blur-[1px] flex items-center justify-center p-4"
        onClick={() => setResponseOpen(false)}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`响应体详情 ${file.name}`}
          className="w-[min(1024px,96vw)] max-h-[90vh] bg-canvas border border-border rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-surface">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink truncate">
                响应体详情
              </div>
              <div className="text-xs text-subtle truncate mt-0.5">{file.name}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyResponse}
                className="h-8 px-3 rounded-md border border-border bg-canvas text-xs font-medium text-ink hover:border-ink transition-colors"
              >
                {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制内容'}
              </button>
              <button
                type="button"
                onClick={() => setResponseOpen(false)}
                className="h-8 px-3 rounded-md border border-border bg-canvas text-xs font-medium text-ink hover:border-ink transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
          <div className="px-5 py-2.5 border-b border-border text-sm text-subtle bg-canvas/80">
            响应码：<span className="font-semibold text-ink tabular-nums">{typeof testResult?.statusCode === 'number' ? testResult.statusCode : '未知'}</span>
          </div>
          <div className="p-5 overflow-auto max-h-[68vh] bg-surface/45">
            <pre className="text-sm leading-6 text-ink whitespace-pre-wrap break-all font-mono-key">
              {responseJsonText}
            </pre>
          </div>
        </div>
      </div>,
      document.body
    )
    : null

  return (
    <>
    <div
      className={`flex items-center transition-colors group border-b border-border last:border-0 cursor-pointer ${rowSelectedClass}`}
      onClick={handleRowSelectToggle}
    >
      <div className="pl-4 pr-2 py-3 w-12 flex-shrink-0 flex items-center">
        <input
          type="checkbox"
          checked={isSelected}
          onClick={(e) => e.stopPropagation()}
          onChange={handleCheckboxToggle}
          className="checkbox-ui"
          aria-label={`选择 ${file.name}`}
        />
      </div>

      <div className="px-3 py-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: availabilityColor }}
            title={availabilityTitle}
          />
          <div className="min-w-0">
            <div className="text-sm text-ink font-medium leading-tight truncate">{file.name}</div>
            {file.email && (
              <div className="text-xs text-subtle mt-0.5 truncate">{file.email}</div>
            )}
          </div>
        </div>
      </div>

      <div className="px-3 py-3 w-24 flex-shrink-0">
        <span
          className="inline-block text-xs font-semibold px-2 py-0.5 rounded whitespace-nowrap"
          style={{ backgroundColor: `${providerColor}18`, color: providerColor }}
        >
          {providerLabel}
        </span>
      </div>

      <div className="px-3 py-3 w-56 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={displayStatus} />
          {typeof testResult?.statusCode === 'number' && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded border border-border text-subtle bg-canvas tabular-nums">
              HTTP {testResult.statusCode}
            </span>
          )}
          {hasResponseBody && (
            <button
              type="button"
              onClick={() => setResponseOpen(true)}
              className="text-[11px] font-medium px-2 py-0.5 rounded border border-coral/50 text-coral bg-coral/12 hover:bg-coral/18 transition-colors"
              title="查看响应体"
            >
              响应体
            </button>
          )}
          {testResult?.quota && (
            <QuotaBar usedPercent={testResult.quota.rate_limit.primary_window?.used_percent ?? 0} resetAfterSeconds={testResult.quota.rate_limit.primary_window?.reset_after_seconds} />
          )}
          {testResult?.copilotQuota && (
            <CopilotQuotaBar quota={testResult.copilotQuota} />
          )}
        </div>
        {testResult?.message && !testResult.quota && !testResult.copilotQuota && (
          <div className="text-xs text-subtle mt-0.5 truncate" title={testResult.message}>
            {testResult.message}
          </div>
        )}
      </div>

      <div className="px-3 py-3 w-28 flex-shrink-0 text-xs text-subtle tabular-nums" title={quotaResetLabel.full}> 
        {quotaResetLabel.short}
      </div>

      <div className="px-3 py-3 w-24 flex-shrink-0 text-xs text-subtle">
        {formatRelativeTime(file.last_refresh)}
      </div>

      <div className="px-3 pr-4 py-3 w-24 flex-shrink-0">
        <div className="flex items-center justify-end gap-1 opacity-100">
          <ActionButton title="测试" onClick={handleTest} disabled={rowBusy !== null}>
            {rowBusy === 'testing' ? <SpinIcon /> : <PlayIcon />}
          </ActionButton>

          {file.disabled && (
            <ActionButton
              title="启用"
              onClick={handleToggleDisable}
              disabled={rowBusy !== null}
            >
              {rowBusy === 'toggle' ? <SpinIcon /> : <EnableIcon />}
            </ActionButton>
          )}

          <ActionButton
            title="删除"
            onClick={handleDelete}
            disabled={rowBusy !== null}
            className="hover:text-[#B94040]"
          >
            {rowBusy === 'delete' ? <SpinIcon /> : <TrashIcon />}
          </ActionButton>
        </div>
      </div>

    </div>
    {responseModal}
    </>
  )
}

function getQuotaResetLabel(testResult: ReturnType<typeof useCredStore.getState>['testResults'][string] | undefined): { short: string; full: string } {
  if (!testResult) return { short: '—', full: '暂无测试结果' }

  const codexResetSeconds = testResult.quota?.rate_limit.primary_window?.reset_after_seconds
  if (typeof codexResetSeconds === 'number' && codexResetSeconds >= 0) {
    const resetAt = new Date(Date.now() + codexResetSeconds * 1000)
    const short = formatResetDate(resetAt)
    const full = `约 ${Math.max(0, Math.round(codexResetSeconds / 60))} 分钟后重置（${resetAt.toLocaleString('zh-CN', { hour12: false })}）`
    return { short, full }
  }

  const copilotReset = testResult.copilotQuota?.quota_reset_date
  if (copilotReset) {
    const parsed = new Date(copilotReset)
    if (!isNaN(parsed.getTime())) {
      const short = formatResetDate(parsed)
      const full = `重置于 ${parsed.toLocaleString('zh-CN', { hour12: false })}`
      return { short, full }
    }
    return { short: copilotReset, full: copilotReset }
  }

  return { short: '—', full: '暂无重置时间' }
}

function formatResetDate(date: Date): string {
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function ActionButton({
  title,
  onClick,
  disabled = false,
  children,
  className = '',
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      data-no-row-select
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-canvas text-subtle hover:text-ink hover:border-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {children}
    </button>
  )
}

function PlayIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
      <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
    </svg>
  )
}

function EnableIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
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

function QuotaBar({ usedPercent, resetAfterSeconds }: { usedPercent: number; resetAfterSeconds?: number }) {
  const remaining = 100 - usedPercent
  const barColor = usedPercent >= 90 ? '#B94040' : usedPercent >= 70 ? '#C4933A' : '#4CAF50'
  const resetLabel = resetAfterSeconds == null ? null
    : resetAfterSeconds < 3600 ? `${Math.round(resetAfterSeconds / 60)}m`
    : `${Math.round(resetAfterSeconds / 3600)}h`

  return (
    <div
      className="flex items-center gap-1.5 text-2xs flex-shrink-0"
      title={resetLabel ? `已用 ${usedPercent}%，${resetLabel}后重置` : `已用 ${usedPercent}%`}
    >
      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden flex-shrink-0">
        <div className="h-full rounded-full" style={{ width: `${remaining}%`, backgroundColor: barColor }} />
      </div>
      <span style={{ color: barColor }} className="tabular-nums">{remaining}%</span>
    </div>
  )
}

function CopilotQuotaBar({ quota }: { quota: import('@/types/api').CopilotQuota }) {
  const snap = quota.quota_snapshots?.premium_interactions
  if (!snap || snap.unlimited) return null
  const entitlement = snap.entitlement ?? 0
  const remaining = snap.remaining ?? snap.quota_remaining ?? 0
  if (entitlement === 0) return null
  const usedPercent = Math.round(((entitlement - remaining) / entitlement) * 100)
  const barColor = usedPercent >= 90 ? '#B94040' : usedPercent >= 70 ? '#C4933A' : '#4CAF50'
  const resetDate = quota.quota_reset_date ?? ''

  return (
    <div
      className="flex items-center gap-1.5 text-2xs flex-shrink-0"
      title={`Premium 剩余 ${remaining}/${entitlement}${resetDate ? `，重置于 ${resetDate}` : ''}`}
    >
      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden flex-shrink-0">
        <div className="h-full rounded-full" style={{ width: `${(remaining / entitlement) * 100}%`, backgroundColor: barColor }} />
      </div>
      <span style={{ color: barColor }} className="tabular-nums">{remaining}</span>
    </div>
  )
}
