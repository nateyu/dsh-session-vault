import { dirname } from 'node:path'
import { rm } from 'node:fs/promises'

import { disposeLiveAgent } from './dispose-agent.js'

/**
 * Drop a session id from every workspace account and from the registry-global
 * archive set. WorkspaceRegistry has archive but no unarchive; the in-memory
 * `state` / `setState` pair is the same durable singleton the registry already
 * opened, so writing it keeps `workspace.json` and `@` accounting consistent.
 * @param {object} ctx
 * @param {string} sessionId
 */
export async function forgetWorkspaceAccount(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  if (registry === undefined) return
  for (const workspace of registry.list?.() ?? []) {
    await workspace.detachSession(sessionId)
  }
  const archived = registry.archivedSessionIds ?? []
  if (archived.includes(sessionId) && typeof registry.setState === 'function' && registry.state) {
    await registry.setState({
      ...registry.state,
      archivedSessionIds: archived.filter((id) => id !== sessionId),
    })
  }
  registry.headers?.delete?.(sessionId)
  registry.sessionPaths?.delete?.(sessionId)
  registry.invalidSessionPaths?.delete?.(sessionId)
}

/**
 * Delete one JSONL session directory after the live owner (if any) is gone.
 * @param {object} ctx
 * @param {{ id: string, cwd?: string, createdAt?: number, version?: number }} header
 */
export async function deleteSessionDirectory(ctx, header) {
  const location = ctx.sessionPersistence.locate(header)
  if (location?.path === undefined) {
    throw Object.assign(
      new Error(`session "${header.id}" has no per-session artifact (JSONL backend required)`),
      { code: 'backend-unsupported' },
    )
  }
  await rm(dirname(location.path), { recursive: true, force: true })
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
  } catch {
    // The log may already be absent, or inspect may refuse a torn file; the
    // caller still deletes the directory.
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
    await forgetWorkspaceAccount(ctx, sessionId)
    throw Object.assign(new Error(`session "${sessionId}" was not found`), { code: 'session-not-found' })
  }

  if (live !== undefined) {
    await disposeLiveAgent(ctx, sessionId)
    await waitForPersistenceQuiescence(ctx, sessionId)
  }

  await deleteSessionDirectory(ctx, header)
  await forgetWorkspaceAccount(ctx, sessionId)
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 */
async function readPersistedHeader(ctx, sessionId) {
  const records = await ctx.sessionQuery.listSessions()
  return records.find((record) => record.header.id === sessionId)?.header
}
