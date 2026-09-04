import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../lib/config.js'
import {
  eventsAreBlank, isHiddenFromSidebar, mapPool, titleMapFromObservations,
  sessionIsBlank, listVaultSessions,
} from '../lib/list.js'

test('Config accepts an empty object', () => {
  assert.deepEqual(Config['~standard'].validate(), { value: {} })
})

test('eventsAreBlank is true until turn/start', () => {
  assert.equal(eventsAreBlank([]), true)
  assert.equal(eventsAreBlank([{ type: 'session/title' }, { type: 'command/done' }]), true)
  assert.equal(eventsAreBlank([{ type: 'user/message' }, { type: 'turn/start' }]), false)
})

test('isHiddenFromSidebar matches the workspace sidebar hide rule', () => {
  assert.equal(isHiddenFromSidebar({ origin: 'subagent', archived: true, blank: true }), false)
  assert.equal(isHiddenFromSidebar({ archived: true, blank: false }), true)
  assert.equal(isHiddenFromSidebar({ archived: false, blank: true }), true)
  assert.equal(isHiddenFromSidebar({ archived: false, blank: false }), false)
})

test('mapPool preserves order at a capped concurrency', async () => {
  const seen = []
  const result = await mapPool([1, 2, 3, 4], 2, async (n) => {
    seen.push(n)
    return n * 10
  })
  assert.deepEqual(result, [10, 20, 30, 40])
  assert.deepEqual(seen.sort(), [1, 2, 3, 4])
})

test('titleMapFromObservations keeps fulfilled titles only', () => {
  const titles = titleMapFromObservations([
    { status: 'fulfilled', value: { session: { id: 'a' }, title: { title: 'Alpha' } } },
    { status: 'rejected', sessionId: 'b', reason: new Error('missing') },
    { session: { id: 'c' }, title: { title: 'Gamma' } },
  ])
  assert.equal(titles.get('a'), 'Alpha')
  assert.equal(titles.has('b'), false)
  assert.equal(titles.get('c'), 'Gamma')
})

test('sessionIsBlank uses live events without inspect', async () => {
  const ctx = {
    sessions: {
      get(id) {
        return id === 'live' ? { events: [{ type: 'session/title' }] } : undefined
      },
    },
  }
  assert.equal(await sessionIsBlank(ctx, { header: { id: 'live' } }, undefined), true)
})

test('listVaultSessions lists sidebar-hidden sessions and skips subagents and visible chats', async () => {
  const ctx = {
    workspaceRegistry: { archivedSessionIds: ['arch-1'] },
    sessions: {
      get(id) {
        if (id === 'blank-1') return { events: [] }
        if (id === 'arch-1') return { events: [{ type: 'turn/start' }] }
        if (id === 'open-1') return { events: [{ type: 'turn/start' }] }
        return undefined
      },
    },
    sessionQuery: {
      async listSessions() {
        return [
          { header: { id: 'arch-1', createdAt: 2, cwd: '/a' }, live: true, persisted: true },
          { header: { id: 'blank-1', createdAt: 1, cwd: '/b' }, live: true, persisted: true },
          { header: { id: 'open-1', createdAt: 4, cwd: '/c' }, live: true, persisted: true },
          { header: { id: 'child', origin: 'subagent', createdAt: 3 }, live: false, persisted: true },
        ]
      },
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({
          status: 'fulfilled',
          sessionId: id,
          value: { session: { id }, title: id === 'arch-1' ? { title: 'Kept' } : undefined },
        }))
      },
      async listEvents() {
        return []
      },
    },
  }
  const listed = await listVaultSessions(ctx)
  assert.deepEqual(listed.items.map((row) => row.sessionId), ['arch-1', 'blank-1'])
  assert.equal(listed.items[0].title, 'Kept')
  assert.equal(listed.items[0].archived, true)
  assert.equal(listed.items[1].blank, true)
})
