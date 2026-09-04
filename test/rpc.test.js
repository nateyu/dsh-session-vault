import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VAULT_ENDPOINTS, VAULT_RPC_CHANNEL } from '../lib/api.js'
import { installVaultRpc, parseSessionIds } from '../lib/rpc.js'

test('parseSessionIds rejects empty or non-string ids', () => {
  assert.throws(() => parseSessionIds({}), /non-empty/)
  assert.throws(() => parseSessionIds({ sessionIds: [''] }), /non-empty strings/)
  assert.deepEqual(parseSessionIds({ sessionIds: ['a', 'b'] }), ['a', 'b'])
})

test('installVaultRpc registers a loopback channel and lists via the handler', async () => {
  const calls = []
  const ctx = {
    connection: {
      rpc: {
        handle(channel, handler, options) {
          calls.push({ channel, options })
          ctx.handler = handler
          return () => {}
        },
      },
    },
    workspaceRegistry: { archivedSessionIds: [] },
    sessions: { get() { return undefined } },
    sessionQuery: {
      async listSessions() { return [] },
      async readTitleSnapshots() { return [] },
    },
  }
  installVaultRpc(ctx)
  assert.equal(calls[0].channel, VAULT_RPC_CHANNEL)
  assert.deepEqual(calls[0].options, { authority: 'loopback' })
  const listed = await ctx.handler(VAULT_ENDPOINTS.list, {})
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.value, { items: [] })
})

test('unknown endpoints and cancelled signals fail loudly', async () => {
  const ctx = {
    connection: {
      rpc: {
        handle(_channel, handler) {
          ctx.handler = handler
          return () => {}
        },
      },
    },
  }
  installVaultRpc(ctx)
  const aborted = AbortSignal.abort()
  const cancelled = await ctx.handler(VAULT_ENDPOINTS.list, {}, aborted)
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error.code, 'cancelled')
  const unknown = await ctx.handler('vault.nope', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bad-request')
})

test('installVaultRpc fails loud when Connection RPC is missing', () => {
  assert.throws(() => installVaultRpc({}), /rpc.handle/)
})

test('vault.delete reports per-id results and keeps going after one failure', async () => {
  const ctx = {
    connection: {
      rpc: {
        handle(_channel, handler) {
          ctx.handler = handler
          return () => {}
        },
      },
    },
    sessions: { get() { return undefined } },
    sessionQuery: {
      async listSessions() { return [] },
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list() { return [] },
    },
  }
  installVaultRpc(ctx)
  const result = await ctx.handler(VAULT_ENDPOINTS.delete, { sessionIds: ['missing-1'] })
  assert.equal(result.ok, true)
  assert.equal(result.value.results[0].ok, false)
  assert.match(result.value.results[0].error, /not found/)
})
