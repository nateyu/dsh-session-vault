import { basename, dirname, isAbsolute } from 'node:path'
import { rm } from 'node:fs/promises'

import { disposeLiveAgent } from './dispose-agent.js'
import { isAbortError } from './errors.js'
import { forgetRegistryIndexes, unarchiveSession } from './registry-compat.js'

/**
 * Drop a session id from every workspace account and from the registry-global
 * archive set, so neither the sidebar nor `@` completion keeps naming a log
 * that is gone. Detaching is a published operation; unarchiving is not, and
 * lives behind `registry-compat`.
 * @param {object} ctx
 * @param {string} sessionId
 */
export async function forgetWorkspaceAccount(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  for (const workspace of registry.list?.() ?? []) {
    await workspace.detachSession(sessionId)
  }
  await unarchiveSession(registry, sessionId)
  forgetRegistryIndexes(registry, sessionId)
}

/**
 * Resolve the session-owned directory to remove, refusing anything that is not
 * one session's own JSONL artifact.
 *
 * `locate()` is a backend-declared location hint, and the JSONL layout is
 * `<root>/<project>/<session>/session.jsonl[.zstd]` — only the last component
 * belongs to this session, the project directory above it is shared. A backend
 * that answers with a shared artifact (an out-of-tree store pointing at one
 * database file, say) would otherwise have its parent directory removed.
 * @param {object} ctx
 * @param {{ id: string, cwd?: string, createdAt?: number, version?: number }} header
 * @returns {string}
 */
export function resolveSessionDirectory(ctx, header) {
  const location = ctx.sessionPersistence.locate(header)
  if (location?.kind !== 'jsonl' || typeof location.path !== 'string' || !isAbsolute(location.path)) {
    throw Object.assign(
      new Error(`session "${header.id}" has no per-session JSONL artifact (JSONL backend required)`),
      { code: 'backend-unsupported' },
    )
  }

  const directory = dirname(location.path)
  const name = basename(directory)
  // A session directory always sits at least two levels below the store root,
  // and its name is derived from the session id.
  const unsafe = name.length === 0
    || directory === dirname(directory)
    || dirname(directory) === dirname(dirname(directory))
    || !directoryNamesSession(name, header.id)
  if (unsafe) {
    throw Object.assign(
      new Error(`session "${header.id}" resolved to "${directory}", which is not a session-owned directory`),
      { code: 'backend-unsupported' },
    )
  }
  return directory
}

/**
 * Whether a directory name is derived from a session id. JSONL encodes the id
 * for the filesystem, so an exact match is not required — but an unrelated
 * name must never be removed.
 * @param {string} name
 * @param {string} sessionId
 * @returns {boolean}
 */
function directoryNamesSession(name, sessionId) {
  if (name === sessionId || name.includes(sessionId)) return true
  try {
    return decodeURIComponent(name) === sessionId
  } catch {
    return false
  }
}

/**
 * Delete one JSONL session directory after the live owner (if any) is gone.
 * @param {object} ctx
 * @param {{ id: string, cwd?: string, createdAt?: number, version?: number }} header
 */
export async function deleteSessionDirectory(ctx, header) {
  await rm(resolveSessionDirectory(ctx, header), { recursive: true, force: true })
}

/**
 * @param {string} directory
 */
async function removeDirectory(directory) {
  await rm(directory, { recursive: true, force: true })
}

/**
 * Drain persistence retirement so a subsequent directory delete cannot race
 * the last flush. `inspect` waits on the coordinator's per-id retirement map.
 * @param {object} ctx
 * @param {string} sessionId
 */
export async function waitForPersistenceQuiescence(ctx, sessionId) {
  try {
    await ctx.sessionPersistence.inspect(sessionId)
  } catch (error) {
    // The log may already be absent, or inspect may refuse a torn file; the
    // caller still deletes the directory. A cancelled request is not that.
    if (isAbortError(error)) throw error
  }
}

/**
 * Delete one session so `@` candidates, the sidebar, and the archive ledger
 * stop naming it. Live agents are disposed first so the next flush cannot
 * recreate the files.
 * @param {object} ctx
 * @param {string} sessionId
 * @param {{ keepSessionId?: string }} [options]
 */
export async function deleteVaultSession(ctx, sessionId, options = {}) {
  if (options.keepSessionId !== undefined && sessionId === options.keepSessionId) {
    throw Object.assign(new Error(`session "${sessionId}" is the current session; switch away before deleting`), {
      code: 'session-current',
    })
  }

  const live = ctx.sessions?.get?.(sessionId)
  const header = live?.header ?? await readPersistedHeader(ctx, sessionId)
  if (header === undefined) {
    // The ledger stays untouched: a transient persistence read failure is
    // indistinguishable from a genuinely absent session here, and dropping the
    // id would strand a log that no surface can reach afterwards.
    throw Object.assign(new Error(`session "${sessionId}" was not found`), { code: 'session-not-found' })
  }

  // Refuse an unsafe target before disposing a live agent the user would then
  // have to restart for nothing.
  const directory = resolveSessionDirectory(ctx, header)

  if (live !== undefined) {
    await disposeLiveAgent(ctx, sessionId)
    await waitForPersistenceQuiescence(ctx, sessionId)
  }

  await removeDirectory(directory)
  await forgetWorkspaceAccount(ctx, sessionId)
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 */
async function readPersistedHeader(ctx, sessionId) {
  const query = ctx.sessionQuery
  const records = typeof query.filterSessions === 'function'
    ? await query.filterSessions([{ kind: 'id', values: [sessionId] }])
    : await query.listSessions()
  return records.find((record) => record.header.id === sessionId)?.header
}
