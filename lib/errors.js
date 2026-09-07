/** Shared failure classification for the Host half. */

/**
 * The codes this plugin attaches to its own failures. A code outside this set
 * came from somewhere else and is reported as a generic bad request.
 */
export const VAULT_ERROR_CODES = Object.freeze([
  'bad-request',
  'backend-unsupported',
  'cancelled',
  'registry-unsupported',
  'session-busy',
  'session-current',
  'session-live',
  'session-not-found',
])

const CODES = new Set(VAULT_ERROR_CODES)

/**
 * Whether a rejection is a cancellation.
 *
 * `AbortSignal.throwIfAborted()` rejects with a `DOMException`, which carries a
 * numeric legacy `code` (`20`) — reading `error.code` would classify every
 * cancellation as an unrelated failure, so the name is the discriminant.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * The vault error code carried by a rejection, if any.
 * @param {unknown} error
 * @returns {string}
 */
export function errorCode(error) {
  if (isAbortError(error)) return 'cancelled'
  if (error === null || typeof error !== 'object') return 'bad-request'
  const code = /** @type {{ code?: unknown }} */ (error).code
  return typeof code === 'string' && CODES.has(code) ? code : 'bad-request'
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
