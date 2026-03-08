import type { ApiClient } from './api'
import { patchAuthFileStatus } from './management'
import type { AuthFile, TestResult } from '@/types/api'

type UpdateFileFn = (name: string, updated: Partial<AuthFile>) => void

// 测试结果判定为超额时自动禁用，避免手动重复操作。
export async function autoDisableIfQuota(
  client: ApiClient,
  file: AuthFile,
  result: TestResult,
  updateFile: UpdateFileFn,
  options?: { optimistic?: boolean }
): Promise<boolean> {
  const shouldDisable = result.status === 'quota'
    || (result.status === 'expired' && (result.statusCode === 401 || result.statusCode === 403))
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
