import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VAULT_ENDPOINTS, VAULT_RPC_CHANNEL } from '../lib/api.js'
import { MAX_DELETE_BATCH } from '../lib/config.js'
import { inject } from '../lib/index.js'
import { createVaultRpcHandler, installVaultRpc, parseSessionIds } from '../lib/rpc.js'

function handlerFor(ctx = {}) {
  return createVaultRpcHandler(ctx)
}

function mountCtx() {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection() { return undefined },
    },
  }
  ctx.routes = routes
  return ctx
}

test('host plugin injects webServer so the RPC prefix can mount', () => {
  assert.ok(inject.includes('webServer'))
  assert.ok(inject.includes('connection'))
})

test('parseSessionIds rejects empty or non-string ids', () => {
  assert.throws(() => parseSessionIds({}), /non-empty/)
  assert.throws(() => parseSessionIds({ sessionIds: [''] }), /non-empty strings/)
  assert.deepEqual(parseSessionIds({ sessionIds: ['a', 'b'] }), ['a', 'b'])
})

test('parseSessionIds drops repeats and bounds the batch', () => {
  // A repeated id would delete once and then report "not found" for itself.
  assert.deepEqual(parseSessionIds({ sessionIds: ['a', 'b', 'a'] }), ['a', 'b'])
  const tooMany = Array.from({ length: MAX_DELETE_BATCH + 1 }, (_, i) => `s-${i}`)
  assert.throws(() => parseSessionIds({ sessionIds: tooMany }), /at most/)
})

test('installVaultRpc registers the channel on webServer', async () => {
  const ctx = mountCtx()
  ctx.workspaceRegistry = { archivedSessionIds: [] }
  ctx.sessions = { get() { return undefined } }
  ctx.sessionQuery = {
    async listSessions() { return [] },
    async readTitleSnapshots() { return [] },
  }
  installVaultRpc(ctx)
  assert.equal(ctx.routes[0].kind, 'prefix')
  assert.equal(ctx.routes[0].path, VAULT_RPC_CHANNEL)
  const listed = await createVaultRpcHandler(ctx)(VAULT_ENDPOINTS.list, {})
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.value, { items: [] })
})

test('unknown endpoints and cancelled signals fail loudly', async () => {
  const handler = handlerFor({})
  const aborted = AbortSignal.abort()
  const cancelled = await handler(VAULT_ENDPOINTS.list, {}, aborted)
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error.code, 'cancelled')
  const unknown = await handler('vault.nope', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bad-request')
})

test('installVaultRpc fails loud when webServer is missing', () => {
  assert.throws(
    () => installVaultRpc({ connection: { requestRejection() { return undefined } } }),
    /webServer.register/,
  )
})

test('vault.delete reports per-id results and keeps going after one failure', async () => {
  const handler = handlerFor({
    sessions: { get() { return undefined } },
    sessionQuery: {
      async listSessions() { return [] },
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list() { return [] },
    },
  })
  const result = await handler(VAULT_ENDPOINTS.delete, { sessionIds: ['missing-1'] })
  assert.equal(result.ok, true)
  assert.equal(result.value.results[0].ok, false)
  assert.match(result.value.results[0].error, /not found/)
  // The per-id code stays machine-routable instead of collapsing to a string.
  assert.equal(result.value.results[0].code, 'session-not-found')
})

test('a cancellation raised mid-flight reports as cancelled, not bad-request', async () => {
  // `throwIfAborted()` rejects with a DOMException whose legacy numeric `code`
  // is 20; classifying on it would mislabel every cancellation.
  const handler = handlerFor({
    sessionQuery: {
      async listSessions(signal) {
        signal?.throwIfAborted?.()
        return []
      },
    },
  })
  const controller = new AbortController()
  const pending = handler(VAULT_ENDPOINTS.list, {}, controller.signal)
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'cancelled')
})

test('vault.delete stops between sessions once the caller cancels', async () => {
  const seen = []
  const controller = new AbortController()
  const handler = handlerFor({
    sessions: {
      get(id) {
        seen.push(id)
        controller.abort()
        return undefined
      },
    },
    sessionQuery: { async filterSessions() { return [] } },
    workspaceRegistry: { archivedSessionIds: [], list() { return [] } },
  })
  const result = await handler(
    VAULT_ENDPOINTS.delete,
    { sessionIds: ['a', 'b', 'c'] },
    controller.signal,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'cancelled')
  assert.deepEqual(seen, ['a'])
})

test('vault.delete refuses the caller-declared current session by code', async () => {
  const handler = handlerFor({
    sessions: { get() { return undefined } },
    sessionQuery: { async filterSessions() { return [] } },
    workspaceRegistry: { archivedSessionIds: [], list() { return [] } },
  })
  const result = await handler(VAULT_ENDPOINTS.delete, {
    sessionIds: ['open-1'],
    keepSessionId: 'open-1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.results[0].ok, false)
  assert.equal(result.value.results[0].code, 'session-current')
})

test('a vault error code survives instead of flattening into bad-request', async () => {
  const handler = handlerFor({
    sessionQuery: {
      async listSessions() {
        throw Object.assign(new Error('no JSONL artifact'), { code: 'backend-unsupported' })
      },
    },
  })
  const result = await handler(VAULT_ENDPOINTS.list, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'backend-unsupported')
})

test('an unrecognized code is still reported as bad-request', async () => {
  const handler = handlerFor({
    sessionQuery: {
      async listSessions() { throw Object.assign(new Error('boom'), { code: 'ENOENT' }) },
    },
  })
  const result = await handler(VAULT_ENDPOINTS.list, {})
  assert.equal(result.error.code, 'bad-request')
})

test('mounted route refuses a rejected request before dispatch', async () => {
  const ctx = mountCtx()
  ctx.connection.requestRejection = () => 403
  installVaultRpc(ctx)
  let status = 0
  let body = ''
  const res = {
    writableEnded: false,
    writeHead(code) { status = code },
    end(chunk) { this.writableEnded = true; body = chunk ?? '' },
    on() {},
  }
  await ctx.routes[0].handler({ method: 'POST', url: '/x', headers: {} }, res)
  assert.equal(status, 403)
  assert.equal(body, 'forbidden')
})
