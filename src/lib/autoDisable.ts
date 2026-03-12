import type { ApiClient } from './api'
import { patchAuthFileStatus, deleteAuthFile } from './management'
import type { AuthFile, TestResult } from '@/types/api'

type UpdateFileFn = (name: string, updated: Partial<AuthFile>) => void
type RemoveFileFn = (name: string) => void

// 测试结果判定为超额时自动禁用
export async function autoDisableIfQuota(
  client: ApiClient,
  file: AuthFile,
  result: TestResult,
  updateFile: UpdateFileFn,
  options?: { optimistic?: boolean }
): Promise<boolean> {
  const shouldDisable = result.status === 'quota'
  if (!shouldDisable || file.disabled) return false

  const optimistic = options?.optimistic ?? true

  if (optimistic) {
    updateFile(file.name, { disabled: true, status: 'disabled' })
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await patchAuthFileStatus(client, file.name, true)
      return true
    } catch {
      if (attempt === 1 && optimistic) {
        updateFile(file.name, { disabled: file.disabled, status: file.status })
      }
    }
  }
  return false
}

// 测试结果判定为过期时自动删除（仅限 401 状态码）
export async function autoDeleteIfExpired(
  client: ApiClient,
  file: AuthFile,
  result: TestResult,
  removeFile: RemoveFileFn,
  options?: { optimistic?: boolean }
): Promise<boolean> {
  // 只删除 401 状态码的过期文件，403 可能是临时错误需要重试
  const shouldDelete = result.status === 'expired' && result.statusCode === 401
  if (!shouldDelete) return false

  const optimistic = options?.optimistic ?? true

  if (optimistic) {
    removeFile(file.name)
  }
  
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deleteAuthFile(client, file.name)
      return true
    } catch {
      // 删除失败时不回滚，因为文件可能已经不存在
      if (attempt === 1) {
        return false
      }
    }
  }
  return false
}
