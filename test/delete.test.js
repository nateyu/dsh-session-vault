import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deleteSessionDirectory, deleteVaultSession, forgetWorkspaceAccount } from '../lib/delete.js'
import { findLifecycleDisposer, disposeLiveAgent } from '../lib/dispose-agent.js'

const EFFECT = Symbol.for('cordis.effect')

test('forgetWorkspaceAccount detaches every workspace and prunes the archive set', async () => {
  const detached = []
  const registry = {
    archivedSessionIds: ['gone', 'kept'],
    state: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['gone', 'kept'] },
    headers: new Map([['gone', { id: 'gone' }]]),
    sessionPaths: new Map([['gone', '/tmp']]),
    invalidSessionPaths: new Map(),
    list() {
      return [{
        async detachSession(id) { detached.push(id) },
      }]
    },
    async setState(next) {
      this.state = next
      this.archivedSessionIds = next.archivedSessionIds
    },
  }
  await forgetWorkspaceAccount({ workspaceRegistry: registry }, 'gone')
  assert.deepEqual(detached, ['gone'])
  assert.deepEqual(registry.archivedSessionIds, ['kept'])
  assert.equal(registry.headers.has('gone'), false)
})

test('deleteSessionDirectory removes the session folder, not just the log file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-del-'))
  const dir = join(root, 'session-1')
  await mkdir(dir)
  const log = join(dir, 'session.jsonl.zstd')
  await writeFile(log, 'x')
  const ctx = {
    sessionPersistence: {
      locate() { return { kind: 'jsonl', path: log } },
    },
  }
  await deleteSessionDirectory(ctx, { id: 'session-1' })
  await assert.rejects(rm(dir, { recursive: false }), /ENOENT/)
  await rm(root, { recursive: true, force: true })
})

test('deleteVaultSession refuses the current session before touching disk', async () => {
  await assert.rejects(
    deleteVaultSession({}, 's1', { keepSessionId: 's1' }),
    /current session/,
  )
})

test('findLifecycleDisposer reads the public effect label on another fiber', () => {
  const dispose = Object.assign(() => 'torn-down', {
    [EFFECT]: { label: 'agentLoop.lifecycle(s-9)', children: [] },
  })
  const ctx = {
    registry: {
      values() {
        return [{ fibers: [{ _disposables: [dispose] }] }]
      },
    },
  }
  assert.equal(findLifecycleDisposer(ctx, 's-9'), dispose)
})

test('disposeLiveAgent refuses a running agent', async () => {
  await assert.rejects(
    disposeLiveAgent({
      agents: { get() { return { status: 'running' } } },
    }, 's-run'),
    /running/,
  )
})

test('deleteVaultSession disposes a live idle session then deletes its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-live-'))
  const dir = join(root, 's-live')
  await mkdir(dir)
  const log = join(dir, 'session.jsonl.zstd')
  await writeFile(log, 'x')
  const live = new Map()
  const header = { id: 's-live', cwd: '/work', createdAt: 1 }
  live.set('s-live', { header, events: [] })
  const dispose = Object.assign(async () => { live.delete('s-live') }, {
    [EFFECT]: { label: 'agentLoop.lifecycle(s-live)', children: [] },
  })
  const detached = []
  const ctx = {
    agents: { get() { return { status: 'idle' } } },
    sessions: {
      get(id) { return live.get(id) },
      async flush() {},
    },
    registry: { values() { return [{ fibers: [{ _disposables: [dispose] }] }] } },
    sessionPersistence: {
      locate() { return { kind: 'jsonl', path: log } },
      async inspect() { return { meta: header, events: [] } },
    },
    workspaceRegistry: {
      archivedSessionIds: ['s-live'],
      state: { archivedSessionIds: ['s-live'] },
      headers: new Map([['s-live', header]]),
      sessionPaths: new Map(),
      invalidSessionPaths: new Map(),
      list() { return [{ async detachSession(id) { detached.push(id) } }] },
      async setState(next) {
        this.state = next
        this.archivedSessionIds = next.archivedSessionIds
      },
    },
  }
  await deleteVaultSession(ctx, 's-live')
  assert.equal(live.has('s-live'), false)
  await assert.rejects(rm(dir, { recursive: false }), /ENOENT/)
  assert.deepEqual(detached, ['s-live'])
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [])
  await rm(root, { recursive: true, force: true })
})
