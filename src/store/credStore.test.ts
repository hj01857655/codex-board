import { describe, expect, it } from 'vitest'
import { buildRenameMatches } from '@/store/credStore'
import type { AuthFile } from '@/types/api'

function makeFile(overrides: Partial<AuthFile>): AuthFile {
  return {
    id: overrides.id ?? '',
    auth_index: overrides.auth_index ?? '',
    name: overrides.name ?? 'unknown.json',
    type: overrides.type ?? 'codex',
    provider: overrides.provider ?? 'codex',
    status: overrides.status ?? 'active',
    disabled: overrides.disabled ?? false,
    unavailable: overrides.unavailable ?? false,
    runtime_only: overrides.runtime_only ?? false,
    source: overrides.source ?? 'file',
    size: overrides.size ?? 1,
    path: overrides.path,
    label: overrides.label,
    status_message: overrides.status_message,
    email: overrides.email,
    account_type: overrides.account_type,
    account: overrides.account,
    created_at: overrides.created_at,
    modtime: overrides.modtime,
    updated_at: overrides.updated_at,
    last_refresh: overrides.last_refresh,
    next_retry_after: overrides.next_retry_after,
    id_token: overrides.id_token,
  }
}

describe('buildRenameMatches', () => {
  it('同 auth_index 且旧文件名消失时，识别为重命名', () => {
    const prev = [
      makeFile({ id: 'a1', auth_index: '42', name: 'old-name.json' }),
    ]
    const next = [
      makeFile({ id: 'a1', auth_index: '42', name: 'new-name.json' }),
    ]

    expect(buildRenameMatches(prev, next)).toEqual([
      { fromName: 'old-name.json', toName: 'new-name.json' },
    ])
  })

  it('路径比较大小写不敏感，可用于识别重命名', () => {
    const prev = [
      makeFile({ id: '', auth_index: '', name: 'before.json', path: 'C:/AUTH/Token.JSON' }),
    ]
    const next = [
      makeFile({ id: '', auth_index: '', name: 'after.json', path: 'c:/auth/token.json' }),
    ]

    expect(buildRenameMatches(prev, next)).toEqual([
      { fromName: 'before.json', toName: 'after.json' },
    ])
  })

  it('旧文件名仍存在时，不应误判重命名', () => {
    const prev = [
      makeFile({ id: 'same', auth_index: 'same', name: 'keep.json' }),
    ]
    const next = [
      makeFile({ id: 'same', auth_index: 'same', name: 'keep.json' }),
      makeFile({ id: 'same', auth_index: 'same', name: 'copy.json' }),
    ]

    expect(buildRenameMatches(prev, next)).toEqual([])
  })

  it('单个旧文件不会被重复匹配到多个新文件', () => {
    const prev = [
      makeFile({ id: 'dup', auth_index: 'dup', name: 'once.json' }),
    ]
    const next = [
      makeFile({ id: 'dup', auth_index: 'dup', name: 'first.json' }),
      makeFile({ id: 'dup', auth_index: 'dup', name: 'second.json' }),
    ]

    expect(buildRenameMatches(prev, next)).toEqual([
      { fromName: 'once.json', toName: 'first.json' },
    ])
  })
})
