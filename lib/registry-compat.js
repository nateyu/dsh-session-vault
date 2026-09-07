/**
 * The one WorkspaceRegistry capability DeepSeek Harness does not expose.
 *
 * `archiveSession` ships without a counterpart, so an id can only leave
 * `archivedSessionIds` through the registry's own durable state. Every private
 * member reached for here is probed first and named in the failure: a silent
 * no-op would delete the log while leaving the id archived, and `@` completion
 * would keep offering a session that no longer exists.
 *
 * Everything in this file is expected to become a plain `unarchiveSession()`
 * call once upstream ships one; nothing else in the plugin touches registry
 * internals.
 */

/**
 * @param {object} registry
 * @param {string} sessionId
 * @returns {boolean}
 */
function isArchived(registry, sessionId) {
  return (registry.archivedSessionIds ?? []).includes(sessionId)
}

/**
 * @param {object} registry
 * @param {string} sessionId
 */
function assertUnarchived(registry, sessionId) {
  if (!isArchived(registry, sessionId)) return
  throw Object.assign(
    new Error(`session "${sessionId}" is still archived after the registry write`),
    { code: 'registry-unsupported' },
  )
}

/**
 * Drop one id from the registry-global archive set.
 *
 * The private path does not run on the registry's own operation queue, so the
 * durable state is read as late as possible and the result is verified: a
 * concurrent archive or workspace mutation landing inside that window is
 * reported rather than silently overwritten.
 * @param {object} registry
 * @param {string} sessionId
 */
export async function unarchiveSession(registry, sessionId) {
  if (!isArchived(registry, sessionId)) return

  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId)
    assertUnarchived(registry, sessionId)
    return
  }

  const missing = []
  if (typeof registry.setState !== 'function') missing.push('setState')
  if (registry.state === undefined || registry.state === null) missing.push('state')
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        `cannot unarchive "${sessionId}": this DeepSeek Harness build exposes no unarchive API and its `
        + `WorkspaceRegistry no longer provides ${missing.join(', ')}`,
      ),
      { code: 'registry-unsupported' },
    )
  }

  const state = registry.state
  await registry.setState({
    ...state,
    archivedSessionIds: (state.archivedSessionIds ?? []).filter((id) => id !== sessionId),
  })
  assertUnarchived(registry, sessionId)
}

/**
 * Drop the registry's cwd-index entries for a session whose log is gone.
 * Best effort by design: membership follows the durable account, so a stale
 * index costs memory rather than correctness, and an unrecognized registry
 * shape here must not fail a delete that already succeeded.
 * @param {object} registry
 * @param {string} sessionId
 */
export function forgetRegistryIndexes(registry, sessionId) {
  registry.headers?.delete?.(sessionId)
  registry.sessionPaths?.delete?.(sessionId)
  registry.invalidSessionPaths?.delete?.(sessionId)
}
