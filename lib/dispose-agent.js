const EFFECT = Symbol.for('cordis.effect')

/**
 * Find the Cordis effect disposer labeled `agentLoop.lifecycle(<sessionId>)`.
 * ApiProxy drops the AgentHandle, so this is the public teardown entry that
 * still stops the loop, unregisters the agent, and removes the live session.
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {(() => void | Promise<void>) | undefined}
 */
export function findLifecycleDisposer(ctx, sessionId) {
  const label = `agentLoop.lifecycle(${sessionId})`
  const registry = ctx.registry
  if (registry !== undefined) {
    for (const runtime of registry.values()) {
      for (const fiber of runtime.fibers ?? []) {
        const found = disposerInFiber(fiber, label)
        if (found) return found
      }
    }
  }
  const root = ctx.root?.fiber ?? ctx.fiber
  return root === undefined ? undefined : disposerInFiber(root, label)
}

/**
 * @param {object} fiber
 * @param {string} label
 * @returns {(() => void | Promise<void>) | undefined}
 */
function disposerInFiber(fiber, label) {
  for (const dispose of fiber._disposables ?? []) {
    if (dispose?.[EFFECT]?.label === label) return dispose
  }
  return undefined
}

/**
 * Tear down a live agent the way its owner handle would. Running agents are
 * refused so a turn is not cancelled out from under the user.
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<'missing' | 'disposed'>}
 */
export async function disposeLiveAgent(ctx, sessionId) {
  const agent = ctx.agents?.get?.(sessionId)
  const session = ctx.sessions?.get?.(sessionId)
  if (agent === undefined && session === undefined) return 'missing'
  if (agent?.status === 'running') {
    throw Object.assign(new Error(`session "${sessionId}" is running; stop it before deleting`), {
      code: 'session-busy',
    })
  }
  if (session !== undefined) {
    await ctx.sessions.flush(session)
  }
  const dispose = findLifecycleDisposer(ctx, sessionId)
  if (dispose === undefined) {
    throw Object.assign(
      new Error(`session "${sessionId}" is still live and has no disposable lifecycle effect`),
      { code: 'session-live' },
    )
  }
  await dispose()
  if (ctx.sessions?.get?.(sessionId) !== undefined) {
    throw Object.assign(
      new Error(`session "${sessionId}" remained live after lifecycle disposal`),
      { code: 'session-live' },
    )
  }
  return 'disposed'
}
