import { describe, expect, it } from 'vitest'
import { appendFailedNameHint, buildFailedNameHint } from '@/components/credentials/bulkSummary'

describe('buildFailedNameHint', () => {
  it('无失败项时返回空串', () => {
    expect(buildFailedNameHint([], 0)).toBe('')
    expect(buildFailedNameHint(['a.json'], 0)).toBe('')
  })

  it('失败项少量时返回明确列表', () => {
    expect(buildFailedNameHint(['a.json', 'b.json'], 2)).toBe('失败项：a.json，b.json')
  })

  it('失败项较多时返回示例 + 总数', () => {
    expect(buildFailedNameHint(['a.json', 'b.json', 'c.json', 'd.json'], 4)).toBe('失败示例：a.json，b.json，c.json 等 4 项')
  })

  it('失败名重复时应去重展示', () => {
    expect(buildFailedNameHint(['dup.json', 'dup.json', 'ok.json'], 3)).toBe('失败示例：dup.json，ok.json 等 3 项')
  })
})

describe('appendFailedNameHint', () => {
  it('有失败提示时拼接到原文后', () => {
    expect(appendFailedNameHint('禁用完成', ['a.json', 'b.json'], 2)).toBe('禁用完成；失败项：a.json，b.json')
  })

  it('无失败提示时保持原文', () => {
    expect(appendFailedNameHint('禁用完成', [], 0)).toBe('禁用完成')
  })
})
