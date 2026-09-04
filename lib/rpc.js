import { VAULT_ENDPOINTS, VAULT_RPC_CHANNEL } from './api.js'
import { deleteVaultSession } from './delete.js'
import { listVaultSessions } from './list.js'

/**
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) {
  if (code === 'cancelled') {
    return { ok: false, error: { code: 'cancelled', message, details: {} } }
  }
  if (code === 'session-not-found') {
    const sessionId = message.match(/"([^"]+)"/)?.[1] ?? ''
    return { ok: false, error: { code: 'session-not-found', message, details: { sessionId } } }
  }
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [{ message }] } } }
}

function ok(value) {
  return { ok: true, value }
}

/**
 * @param {unknown} payload
 * @returns {string[]}
 */
export function parseSessionIds(payload) {
  const record = payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {}
  const raw = record.sessionIds
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Object.assign(new Error('vault.delete requires a non-empty sessionIds array'), { code: 'bad-request' })
  }
  const ids = []
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error('vault.delete sessionIds must be non-empty strings'), { code: 'bad-request' })
    }
    ids.push(value)
  }
  return ids
}

/**
 * Register the settings-page RPC channel. Loopback-only: deleting sessions is
 * a host-privilege act, not a remote-browser one.
 * @param {object} ctx
 * @returns {() => Promise<void> | void}
 */
export function installVaultRpc(ctx) {
  if (ctx.connection?.rpc?.handle === undefined) {
    throw new Error('dsh-session-vault: ctx.connection.rpc.handle is required (load the web Connection plugin)')
  }
  return ctx.connection.rpc.handle(VAULT_RPC_CHANNEL, async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', 'The request was cancelled.')
    try {
      if (endpoint === VAULT_ENDPOINTS.list) {
        return ok(await listVaultSessions(ctx, signal))
      }
      if (endpoint === VAULT_ENDPOINTS.delete) {
        const sessionIds = parseSessionIds(payload)
        const keepSessionId = payload && typeof payload === 'object' && typeof payload.keepSessionId === 'string'
          ? payload.keepSessionId
          : undefined
        /** @type {Array<{ sessionId: string, ok: boolean, error?: string }>} */
        const results = []
        for (const sessionId of sessionIds) {
          try {
            await deleteVaultSession(ctx, sessionId, { keepSessionId })
            results.push({ sessionId, ok: true })
          } catch (error) {
            results.push({
              sessionId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        return ok({ results })
      }
      return fail('bad-request', `unknown endpoint "${endpoint}"`)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(/** @type {{ code: unknown }} */ (error).code)
        : 'bad-request'
      const message = error instanceof Error ? error.message : String(error)
      return fail(code, message)
    }
  }, { authority: 'loopback' })
}
