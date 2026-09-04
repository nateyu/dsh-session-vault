import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dateRangeMs, filterRows, paginate } from '../client/paging.js'

test('dateRangeMs turns local calendar days into inclusive bounds', () => {
  const range = dateRangeMs('2026-01-02', '2026-01-02')
  assert.equal(new Date(range.fromMs).getHours(), 0)
  assert.equal(new Date(range.toMs).getDate(), 2)
  assert.deepEqual(dateRangeMs('', ''), {})
})

test('filterRows applies kind and date window', () => {
  const rows = [
    { sessionId: 'a', archived: true, blank: false, createdAt: Date.parse('2026-01-01T12:00:00') },
    { sessionId: 'b', archived: false, blank: true, createdAt: Date.parse('2026-03-01T12:00:00') },
    { sessionId: 'c', archived: true, blank: true, createdAt: Date.parse('2026-02-01T12:00:00') },
  ]
  assert.deepEqual(filterRows(rows, { kind: 'blank' }).map((row) => row.sessionId), ['b', 'c'])
  const march = dateRangeMs('2026-03-01', '2026-03-31')
  assert.deepEqual(filterRows(rows, march).map((row) => row.sessionId), ['b'])
})

test('paginate clamps the page and slices a fixed page size', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i)
  const first = paginate(rows, 1, 10)
  assert.deepEqual(first.items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(first.pageCount, 3)
  const last = paginate(rows, 99, 10)
  assert.equal(last.page, 3)
  assert.deepEqual(last.items, [20, 21, 22, 23, 24])
  const empty = paginate([], 3, 10)
  assert.equal(empty.page, 1)
  assert.equal(empty.pageCount, 1)
})
