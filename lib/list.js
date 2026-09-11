import { stat } from 'node:fs/promises'

import { BLANK_PROBE_MAX_BYTES, INSPECT_CONCURRENCY } from './config.js'
import { isAbortError } from './errors.js'

/**
 * Whether a session log has started a model turn. Titles, slash commands, and
 * plan-mode events do not clear blankness — matching the web sidebar `blank` bit.
 * @param {Iterable<{ type?: string }>} events
 * @returns {boolean}
 */
export function eventsAreBlank(events) {
  for (const event of events) {
    if (event?.type === 'turn/start') return false
  }
  return true
}

/**
 * Host list metadata, when the same projection the sidebar reads is mounted.
 * @param {object} ctx
 * @param {{ header: object }} record
 * @param {object | undefined} live
 * @returns {boolean | undefined}
 */
function blankFromListMetadata(ctx, record, live) {
  try {
    const values = live !== undefined
      ? ctx.sessionProjections?.cachedSnapshot?.(live)?.values
        ?? ctx.sessionProjections?.snapshot?.(live)?.values
      : ctx.sessionProjectionCache?.cachedSnapshot?.(record.header, 0)?.values
    const blank = values?.sessionListMetadata?.blank
    return typeof blank === 'boolean' ? blank : undefined
  } catch {
    // A mismatched projection schema or cache layout is not a blank session;
    // fall through to the event log.
    return undefined
  }
}

/**
 * Live log without the removed `Session.events` getter. Missing/non-array
 * values must not become `[]`, or every in-memory conversation looks blank.
 * @param {object} live
 * @returns {Iterable<{ type?: string }> | undefined}
 */
export function liveLogEvents(live) {
  if (typeof live.snapshotEvents === 'function') {
    const snapshot = live.snapshotEvents()
    if (Array.isArray(snapshot)) return snapshot
  }
  if (Array.isArray(live.events)) return live.events
  return undefined
}

/**
 * Rows this page owns: sessions the workspace sidebar hides (archived, or
 * blank with no turn yet) plus sessions whose blankness could not be
 * determined, excluding subagents. The current blank "New Session" row stays
 * in the sidebar but is still listed here so it can be managed after switching
 * away.
 *
 * An unreadable session is listed deliberately. Its log is damaged enough that
 * the probe failed, so this page is the only surface that can still remove it;
 * dropping it would make it unreachable everywhere.
 * @param {{ origin?: string, archived: boolean, blank: boolean, probeFailed?: boolean }} session
 * @returns {boolean}
 */
export function shouldListInVault(session) {
  if (session.origin === 'subagent') return false
  return session.archived === true || session.blank === true || session.probeFailed === true
}

/**
 * Run `mapper` over items with a fixed worker cap.
 * @template T
 * @template R
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, concurrency, mapper) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1))
  /** @type {R[]} */
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/**
 * Fold title snapshots into a session-id → title map. Rejected observations
 * leave the id untitled rather than failing the whole list.
 * @param {readonly unknown[]} observations
 * @returns {Map<string, string>}
 */
export function titleMapFromObservations(observations) {
  const titles = new Map()
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue
    const row = /** @type {Record<string, unknown>} */ (observation)
    if (row.status === 'rejected') continue
    const value = row.status === 'fulfilled' ? row.value : observation
    if (!value || typeof value !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (value)
    const session = record.session
    const title = record.title
    const id = session && typeof session === 'object'
      ? /** @type {Record<string, unknown>} */ (session).id
      : undefined
    if (typeof id !== 'string' || id.length === 0) continue
    if (title && typeof title === 'object' && typeof /** @type {Record<string, unknown>} */ (title).title === 'string') {
      titles.set(id, /** @type {string} */ (/** @type {Record<string, unknown>} */ (title).title))
    }
  }
  return titles
}

/**
 * @param {object} ctx
 * @param {{ header: { id: string, origin?: string, cwd?: string, createdAt: number }, live: boolean }} record
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<boolean>}
 */
export async function sessionIsBlank(ctx, record, signal) {
  const id = record.header.id
  const live = ctx.sessions?.get?.(id)
  const fromMetadata = blankFromListMetadata(ctx, record, live)
  if (fromMetadata !== undefined) return fromMetadata

  if (live !== undefined) {
    const events = liveLogEvents(live)
    if (events !== undefined) return eventsAreBlank(events)
  } else {
    const location = ctx.sessionPersistence?.locate?.(record.header)
    if (location?.path) {
      try {
        const info = await stat(location.path)
        if (info.size > BLANK_PROBE_MAX_BYTES) return false
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
        return true
      }
    }
  }

  const events = await ctx.sessionQuery.listEvents(id)
  signal?.throwIfAborted?.()
  return eventsAreBlank(events)
}

/**
 * Probe blankness without letting one unreadable log fail the whole listing.
 *
 * A damaged, refused, or version-incompatible log is exactly the session a
 * user comes here to delete, so its probe failure becomes a row property
 * rather than a rejected request. Cancellation still propagates.
 * @param {object} ctx
 * @param {{ header: { id: string, origin?: string, cwd?: string, createdAt: number }, live: boolean }} record
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ blank: boolean, probeFailed: boolean }>}
 */
export async function probeSessionBlank(ctx, record, signal) {
  try {
    return { blank: await sessionIsBlank(ctx, record, signal), probeFailed: false }
  } catch (error) {
    if (isAbortError(error)) throw error
    return { blank: false, probeFailed: true }
  }
}

/**
 * Fold titles for the listed rows, tolerating a title source that is down.
 * Titles are decoration; an untitled row is still deletable.
 * @param {object} ctx
 * @param {readonly string[]} sessionIds
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Map<string, string>>}
 */
async function readTitles(ctx, sessionIds, signal) {
  if (sessionIds.length === 0) return new Map()
  try {
    return titleMapFromObservations(await ctx.sessionQuery.readTitleSnapshots(sessionIds, signal))
  } catch (error) {
    if (isAbortError(error)) throw error
    return new Map()
  }
}

/**
 * List sessions the sidebar hides (archived or blank) plus sessions whose
 * blankness could not be probed, excluding subagents.
 * @param {object} ctx
 * @param {AbortSignal | undefined} signal
 */
export async function listVaultSessions(ctx, signal) {
  signal?.throwIfAborted?.()
  const records = await ctx.sessionQuery.listSessions(signal)
  signal?.throwIfAborted?.()
  const archivedIds = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
  const candidates = records.filter((record) => record.header.origin !== 'subagent')

  const rows = await mapPool(candidates, INSPECT_CONCURRENCY, async (record) => {
    signal?.throwIfAborted?.()
    const archived = archivedIds.has(record.header.id)
    const { blank, probeFailed } = await probeSessionBlank(ctx, record, signal)
    return {
      sessionId: record.header.id,
      title: '',
      cwd: record.header.cwd ?? '',
      createdAt: record.header.createdAt,
      live: record.live === true,
      persisted: record.persisted === true,
      blank,
      probeFailed,
      archived,
      origin: record.header.origin,
    }
  })

  const hidden = rows.filter((row) => shouldListInVault(row))
  const titles = await readTitles(ctx, hidden.map((row) => row.sessionId), signal)
  for (const row of hidden) {
    row.title = titles.get(row.sessionId) ?? ''
    delete row.origin
  }

  hidden.sort((a, b) => b.createdAt - a.createdAt || String(a.sessionId).localeCompare(String(b.sessionId)))
  return { items: hidden }
}
