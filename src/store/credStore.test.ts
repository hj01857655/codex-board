import { beforeEach, describe, expect, it } from 'vitest'
import { buildRenameMatches, useCredStore } from '@/store/credStore'
import type { AuthFile, TestResult } from '@/types/api'

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

function makeResult(status: TestResult['status'], testedAt: number): TestResult {
  return { status, testedAt }
}

beforeEach(() => {
  useCredStore.setState({
    connection: null,
    connected: false,
    client: null,
    files: [],
    loading: false,
    refreshing: false,
    testResults: {},
    selected: new Set<string>(),
  })
})

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

describe('useCredStore.setFiles', () => {
  it('重命名后应迁移选中状态和测试结果', () => {
    const oldFile = makeFile({ id: 'rename-1', auth_index: '101', name: 'old.json' })
    const newFile = makeFile({ id: 'rename-1', auth_index: '101', name: 'new.json' })

    useCredStore.setState({
      files: [oldFile],
      selected: new Set(['old.json']),
      testResults: {
        'old.json': makeResult('valid', 1000),
      },
    })

    useCredStore.getState().setFiles([newFile])

    const state = useCredStore.getState()
    expect(state.selected.has('new.json')).toBe(true)
    expect(state.selected.has('old.json')).toBe(false)
    expect(state.testResults['new.json']).toEqual(makeResult('valid', 1000))
    expect(state.testResults['old.json']).toBeUndefined()
  })

  it('文件被移除时应清理选中与结果', () => {
    const keepFile = makeFile({ id: 'keep-1', name: 'keep.json' })
    const dropFile = makeFile({ id: 'drop-1', name: 'drop.json' })

    useCredStore.setState({
      files: [keepFile, dropFile],
      selected: new Set(['keep.json', 'drop.json']),
      testResults: {
        'keep.json': makeResult('quota', 2000),
        'drop.json': makeResult('expired', 1500),
      },
    })

    useCredStore.getState().setFiles([keepFile])

    const state = useCredStore.getState()
    expect(Array.from(state.selected)).toEqual(['keep.json'])
    expect(state.testResults['keep.json']).toEqual(makeResult('quota', 2000))
    expect(state.testResults['drop.json']).toBeUndefined()
  })

  it('新文件名已有结果时，不应被旧结果覆盖', () => {
    const oldFile = makeFile({ id: 'same-id', name: 'old-name.json' })
    const newFile = makeFile({ id: 'same-id', name: 'new-name.json' })

    useCredStore.setState({
      files: [oldFile],
      testResults: {
        'old-name.json': makeResult('expired', 1000),
        'new-name.json': makeResult('valid', 3000),
      },
    })

    useCredStore.getState().setFiles([newFile])

    const state = useCredStore.getState()
    expect(state.testResults['new-name.json']).toEqual(makeResult('valid', 3000))
    expect(state.testResults['old-name.json']).toBeUndefined()
  })
})