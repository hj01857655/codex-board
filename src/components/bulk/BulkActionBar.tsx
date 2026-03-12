import { useState } from 'react'
import { useCredStore } from '@/store/credStore'
import { disableAuthFiles, deleteAuthFiles, fetchAuthFiles } from '@/lib/management'
import { useBatchTest } from '@/hooks/useBatchTest'

export default function BulkActionBar() {
  const { selected, files, client, clearSelection, updateFile, removeFile, setFiles } = useCredStore()
  const { testBatch, isRunning: isTesting } = useBatchTest()
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedCount = selected.size

  if (selectedCount === 0) return null

  const selectedFiles = files.filter((f) => selected.has(f.name))

  async function handleBulkDisable() {
    if (!client || selectedFiles.length === 0 || processing) return

    setProcessing(true)
    setError(null)

    // 过滤掉已经不存在的文件（可能被自动删除）
    const currentFiles = useCredStore.getState().files
    const currentFileNames = new Set(currentFiles.map((f) => f.name))
    const existingFiles = selectedFiles.filter((f) => currentFileNames.has(f.name))
    
    if (existingFiles.length === 0) {
      clearSelection()
      setProcessing(false)
      return
    }

    const names = existingFiles.map((f) => f.name)
    // 保存原始状态用于回滚
    const originalStates = new Map(
      existingFiles.map((f) => [f.name, { disabled: f.disabled, status: f.status }])
    )

    try {
      // 乐观更新
      for (const name of names) {
        updateFile(name, { disabled: true, status: 'disabled' })
      }

      await disableAuthFiles(client, names)
      clearSelection()
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量禁用失败')
      // 回滚到原始状态
      for (const [name, original] of originalStates) {
        updateFile(name, original)
      }
    } finally {
      setProcessing(false)
    }
  }

  async function handleBulkTest() {
    if (!client || selectedFiles.length === 0 || isTesting || processing) return

    setError(null)
    try {
      await testBatch(selectedFiles, { mode: 'all' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量测试失败')
    }
  }

  async function handleBulkDelete() {
    if (!client || selectedFiles.length === 0 || processing) return

    const confirmed = window.confirm(
      `确定要删除 ${selectedFiles.length} 个认证文件吗？此操作不可撤销。`
    )
    if (!confirmed) return

    setProcessing(true)
    setError(null)

    try {
      // 过滤掉已经不存在的文件（可能被自动删除）
      const currentFiles = useCredStore.getState().files
      const currentFileNames = new Set(currentFiles.map((f) => f.name))
      const names = selectedFiles
        .map((f) => f.name)
        .filter((name) => currentFileNames.has(name))
      
      if (names.length === 0) {
        clearSelection()
        setProcessing(false)
        return
      }

      await deleteAuthFiles(client, names)

      // 乐观更新
      for (const name of names) {
        removeFile(name)
      }

      clearSelection()
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量删除失败')
      // 回滚
      const refreshedFiles = await fetchAuthFiles(client)
      setFiles(refreshedFiles)
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
      <div className="bg-canvas border border-border rounded-lg shadow-lg px-4 py-3 flex items-center gap-4">
        <div className="text-sm text-ink">
          已选中 <span className="font-semibold tabular-nums">{selectedCount}</span> 项
        </div>

        <div className="h-4 w-px bg-border" />

        <div className="flex items-center gap-2">
          <button
            onClick={handleBulkTest}
            disabled={isTesting || processing}
            className="h-8 px-3 rounded-md bg-blue-500/10 border border-blue-500/30 text-sm text-blue-600 hover:bg-blue-500/20 hover:border-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isTesting ? '测试中...' : '批量测试'}
          </button>

          <button
            onClick={handleBulkDisable}
            disabled={processing}
            className="h-8 px-3 rounded-md bg-surface border border-border text-sm text-ink hover:bg-canvas hover:border-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {processing ? '处理中...' : '批量禁用'}
          </button>

          <button
            onClick={handleBulkDelete}
            disabled={processing}
            className="h-8 px-3 rounded-md bg-red-500/10 border border-red-500/30 text-sm text-red-600 hover:bg-red-500/20 hover:border-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {processing ? '处理中...' : '批量删除'}
          </button>

          <button
            onClick={clearSelection}
            disabled={false}
            className="h-8 px-3 rounded-md border border-border text-sm text-subtle hover:text-ink hover:border-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            取消选择
          </button>
        </div>

        {error && (
          <>
            <div className="h-4 w-px bg-border" />
            <div className="text-xs text-red-600 max-w-xs truncate" title={error}>
              {error}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
