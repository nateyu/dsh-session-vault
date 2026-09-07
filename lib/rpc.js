import { VAULT_ENDPOINTS, VAULT_RPC_CHANNEL } from './api.js'
import { MAX_DELETE_BATCH } from './config.js'
import { deleteVaultSession } from './delete.js'
import { errorCode, errorMessage, isAbortError } from './errors.js'
import { listVaultSessions } from './list.js'

/**
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) {
  if (code === 'session-not-found') {
    const sessionId = message.match(/"([^"]+)"/)?.[1] ?? ''
    return { ok: false, error: { code, message, details: { sessionId } } }
  }
  if (code === 'bad-request') {
    return { ok: false, error: { code, message, details: { issues: [{ message }] } } }
  }
  // Every other vault code is machine-routable on its own; flattening it into
  // `bad-request` would leave the page unable to tell "busy" from "malformed".
  return { ok: false, error: { code, message, details: {} } }
}

const CANCELLED = fail('cancelled', 'The request was cancelled.')

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
  /** @type {string[]} */
  const ids = []
  const seen = new Set()
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error('vault.delete sessionIds must be non-empty strings'), { code: 'bad-request' })
    }
    // A repeated id would delete once and then report "not found" for itself.
    if (seen.has(value)) continue
    seen.add(value)
    ids.push(value)
  }
  if (ids.length > MAX_DELETE_BATCH) {
    throw Object.assign(
      new Error(`vault.delete accepts at most ${MAX_DELETE_BATCH} sessionIds per call (received ${ids.length})`),
      { code: 'bad-request' },
    )
  }
  return ids
}

/**
 * @param {unknown} payload
 * @returns {string | undefined}
 */
function parseKeepSessionId(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = /** @type {Record<string, unknown>} */ (payload).keepSessionId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Delete each id in turn, reporting one result per id so a single refusal does
 * not discard the outcome of the others.
 * @param {object} ctx
 * @param {readonly string[]} sessionIds
 * @param {string | undefined} keepSessionId
 * @param {AbortSignal | undefined} signal
 */
async function deleteBatch(ctx, sessionIds, keepSessionId, signal) {
  /** @type {Array<{ sessionId: string, ok: boolean, code?: string, error?: string }>} */
  const results = []
  for (const sessionId of sessionIds) {
    // Each id is an independent teardown, so cancellation stops the batch
    // between sessions rather than in the middle of one.
    if (signal?.aborted) return undefined
    try {
      await deleteVaultSession(ctx, sessionId, { keepSessionId })
      results.push({ sessionId, ok: true })
    } catch (error) {
      if (isAbortError(error)) return undefined
      results.push({ sessionId, ok: false, code: errorCode(error), error: errorMessage(error) })
    }
  }
  return results
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
    if (signal?.aborted) return CANCELLED
    try {
      if (endpoint === VAULT_ENDPOINTS.list) {
        return ok(await listVaultSessions(ctx, signal))
      }
      if (endpoint === VAULT_ENDPOINTS.delete) {
        const sessionIds = parseSessionIds(payload)
        const results = await deleteBatch(ctx, sessionIds, parseKeepSessionId(payload), signal)
        return results === undefined ? CANCELLED : ok({ results })
      }
      return fail('bad-request', `unknown endpoint "${endpoint}"`)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return CANCELLED
      return fail(errorCode(error), errorMessage(error))
    }
  }, { authority: 'loopback' })
}
