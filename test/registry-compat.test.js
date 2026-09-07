import { test } from 'node:test'
import assert from 'node:assert/strict'

import { forgetRegistryIndexes, unarchiveSession } from '../lib/registry-compat.js'

test('unarchiveSession prefers a published API when the build has one', async () => {
  const calls = []
  const registry = {
    archivedSessionIds: ['gone'],
    async unarchiveSession(id) {
      calls.push(id)
      this.archivedSessionIds = this.archivedSessionIds.filter((each) => each !== id)
    },
    setState() { throw new Error('the private path must not run when an API exists') },
  }
  await unarchiveSession(registry, 'gone')
  assert.deepEqual(calls, ['gone'])
})

test('unarchiveSession is a no-op for an id that is not archived', async () => {
  const registry = {
    archivedSessionIds: ['other'],
    setState() { throw new Error('must not write') },
  }
  await unarchiveSession(registry, 'gone')
})

test('unarchiveSession drops the id through durable state without losing other fields', async () => {
  const registry = {
    archivedSessionIds: ['gone', 'kept'],
    state: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['gone', 'kept'] },
    async setState(next) {
      this.state = next
      this.archivedSessionIds = next.archivedSessionIds
    },
  }
  await unarchiveSession(registry, 'gone')
  assert.deepEqual(registry.archivedSessionIds, ['kept'])
  assert.equal(registry.state.initialized, true)
  assert.deepEqual(registry.state.workspaceIds, ['w1'])
})

test('unarchiveSession fails loud when the registry no longer exposes its state', async () => {
  // Silently skipping would delete the log and leave the id in `@` completion.
  await assert.rejects(
    unarchiveSession({ archivedSessionIds: ['gone'] }, 'gone'),
    (error) => error.code === 'registry-unsupported' && /setState, state/.test(error.message),
  )
})

test('unarchiveSession reports a write that did not take effect', async () => {
  const registry = {
    archivedSessionIds: ['gone'],
    state: { archivedSessionIds: ['gone'] },
    // A concurrent registry write landing between the read and this write
    // would look exactly like this.
    async setState() {},
  }
  await assert.rejects(
    unarchiveSession(registry, 'gone'),
    (error) => error.code === 'registry-unsupported' && /still archived/.test(error.message),
  )
})

test('forgetRegistryIndexes tolerates a registry without index maps', () => {
  forgetRegistryIndexes({}, 'gone')
  const registry = { headers: new Map([['gone', {}]]), sessionPaths: new Map([['gone', '/tmp']]) }
  forgetRegistryIndexes(registry, 'gone')
  assert.equal(registry.headers.has('gone'), false)
  assert.equal(registry.sessionPaths.has('gone'), false)
})
