export function buildFailedNameHint(names: string[], failedTotal: number): string {
  if (failedTotal <= 0 || names.length === 0) return ''
  const uniqueNames = Array.from(new Set(names)).filter((name) => name.length > 0)
  if (uniqueNames.length === 0) return ''

  const preview = uniqueNames.slice(0, 3)
  const previewText = preview.join('，')
  if (failedTotal > preview.length) {
    return '失败示例：' + previewText + ' 等 ' + failedTotal + ' 项'
  }
  return '失败项：' + previewText
}

export function appendFailedNameHint(baseText: string, names: string[], failedTotal: number): string {
  const hint = buildFailedNameHint(names, failedTotal)
  if (!hint) return baseText
  return baseText + '；' + hint
}
