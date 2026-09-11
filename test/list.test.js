import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../lib/config.js'
import {
  eventsAreBlank, liveLogEvents, shouldListInVault, mapPool, titleMapFromObservations,
  sessionIsBlank, probeSessionBlank, listVaultSessions,
} from '../lib/list.js'

test('Config accepts an empty object', () => {
  assert.deepEqual(Config['~standard'].validate(), { value: {} })
})

test('eventsAreBlank is true until turn/start', () => {
  assert.equal(eventsAreBlank([]), true)
  assert.equal(eventsAreBlank([{ type: 'session/title' }, { type: 'command/done' }]), true)
  assert.equal(eventsAreBlank([{ type: 'user/message' }, { type: 'turn/start' }]), false)
})

test('shouldListInVault matches the sidebar hide rule and keeps unreadable rows', () => {
  assert.equal(shouldListInVault({ origin: 'subagent', archived: true, blank: true }), false)
  assert.equal(shouldListInVault({ archived: true, blank: false }), true)
  assert.equal(shouldListInVault({ archived: false, blank: true }), true)
  assert.equal(shouldListInVault({ archived: false, blank: false }), false)
  // An unreadable session is listed: this page is the only surface left that
  // can delete it.
  assert.equal(shouldListInVault({ archived: false, blank: false, probeFailed: true }), true)
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

test('liveLogEvents does not treat a missing events getter as an empty log', () => {
  assert.equal(liveLogEvents({ seq: 12 }), undefined)
  assert.equal(liveLogEvents({ events: undefined }), undefined)
  assert.deepEqual(liveLogEvents({
    snapshotEvents() { return [{ type: 'turn/start' }] },
  }), [{ type: 'turn/start' }])
})

test('sessionIsBlank reads snapshotEvents when Session.events is gone', async () => {
  const ctx = {
    sessions: {
      get(id) {
        return id === 'live'
          ? { snapshotEvents() { return [{ type: 'user/message' }, { type: 'turn/start' }] } }
          : undefined
      },
    },
    sessionQuery: {
      async listEvents() { return [] },
    },
  }
  assert.equal(await sessionIsBlank(ctx, { header: { id: 'live' } }, undefined), false)
})

test('sessionIsBlank does not mark a live conversation blank when events is missing', async () => {
  const ctx = {
    sessions: {
      get() { return { seq: 12 } },
    },
    sessionQuery: {
      async listEvents() { return [{ type: 'turn/start' }] },
    },
  }
  assert.equal(await sessionIsBlank(ctx, { header: { id: 'live' } }, undefined), false)
})

test('sessionIsBlank prefers the sidebar list-metadata projection', async () => {
  const ctx = {
    sessions: {
      get() { return { events: [] } },
    },
    sessionProjections: {
      cachedSnapshot() {
        return { values: { sessionListMetadata: { blank: false, lastPromptAt: 1 } } }
      },
    },
  }
  assert.equal(await sessionIsBlank(ctx, { header: { id: 'live' } }, undefined), false)
})

test('probeSessionBlank reports an unreadable log instead of rejecting', async () => {
  const ctx = {
    sessions: { get() { return undefined } },
    sessionQuery: {
      async listEvents() { throw new Error('log written by a newer harness') },
    },
  }
  assert.deepEqual(
    await probeSessionBlank(ctx, { header: { id: 'torn' } }, undefined),
    { blank: false, probeFailed: true },
  )
})

test('probeSessionBlank still propagates cancellation', async () => {
  const ctx = {
    sessions: { get() { return undefined } },
    sessionQuery: {
      async listEvents() { AbortSignal.abort().throwIfAborted() },
    },
  }
  await assert.rejects(
    probeSessionBlank(ctx, { header: { id: 'gone' } }, undefined),
    (error) => error.name === 'AbortError',
  )
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

test('listVaultSessions keeps going when one session cannot be probed', async () => {
  const ctx = {
    workspaceRegistry: { archivedSessionIds: [] },
    sessions: { get() { return undefined } },
    sessionQuery: {
      async listSessions() {
        return [
          { header: { id: 'ok-1', createdAt: 2 }, live: false, persisted: true },
          { header: { id: 'torn-1', createdAt: 1 }, live: false, persisted: true },
        ]
      },
      async listEvents(id) {
        if (id === 'torn-1') throw new Error('corrupt log')
        return []
      },
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { session: { id } } }))
      },
    },
  }
  const listed = await listVaultSessions(ctx)
  assert.deepEqual(listed.items.map((row) => row.sessionId), ['ok-1', 'torn-1'])
  assert.equal(listed.items[0].blank, true)
  assert.equal(listed.items[1].probeFailed, true)
  assert.equal(listed.items[1].blank, false)
})

test('listVaultSessions survives a title source that is down', async () => {
  const ctx = {
    workspaceRegistry: { archivedSessionIds: ['arch-1'] },
    sessions: { get() { return undefined } },
    sessionQuery: {
      async listSessions() {
        return [{ header: { id: 'arch-1', createdAt: 1 }, live: false, persisted: true }]
      },
      async listEvents() { return [{ type: 'turn/start' }] },
      async readTitleSnapshots() { throw new Error('title index unavailable') },
    },
  }
  const listed = await listVaultSessions(ctx)
  assert.deepEqual(listed.items.map((row) => row.sessionId), ['arch-1'])
  assert.equal(listed.items[0].title, '')
})
