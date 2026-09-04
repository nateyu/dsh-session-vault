/** Client-side page size. */
export const PAGE_SIZE = 20

/**
 * Inclusive local-day bounds for a `YYYY-MM-DD` date input.
 * @param {string} fromDate
 * @param {string} toDate
 * @returns {{ fromMs?: number, toMs?: number }}
 */
export function dateRangeMs(fromDate, toDate) {
  const range = {}
  if (fromDate) {
    const from = new Date(`${fromDate}T00:00:00`)
    if (!Number.isNaN(from.getTime())) range.fromMs = from.getTime()
  }
  if (toDate) {
    const to = new Date(`${toDate}T23:59:59.999`)
    if (!Number.isNaN(to.getTime())) range.toMs = to.getTime()
  }
  return range
}

/**
 * @param {readonly { createdAt: number, archived?: boolean, blank?: boolean }[]} rows
 * @param {{ kind?: 'all' | 'archived' | 'blank', fromMs?: number, toMs?: number }} filters
 */
export function filterRows(rows, filters = {}) {
  const kind = filters.kind ?? 'all'
  return rows.filter((row) => {
    if (kind === 'archived' && !row.archived) return false
    if (kind === 'blank' && !row.blank) return false
    if (filters.fromMs !== undefined && row.createdAt < filters.fromMs) return false
    if (filters.toMs !== undefined && row.createdAt > filters.toMs) return false
    return true
  })
}

/**
 * @template T
 * @param {readonly T[]} rows
 * @param {number} page
 * @param {number} [pageSize]
 */
export function paginate(rows, page, pageSize = PAGE_SIZE) {
  const size = Math.max(1, pageSize)
  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, page), pageCount)
  const start = (current - 1) * size
  return {
    items: rows.slice(start, start + size),
    page: current,
    pageCount,
    total,
  }
}
