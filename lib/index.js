/**
 * dsh-session-vault Host half: settings RPC that lists and deletes sessions
 * hidden from the workspace sidebar (archived or blank), including their live
 * agent so `@` candidates disappear.
 */

import { Config, PLUGIN_NAME } from './config.js'
import { installVaultRpc } from './rpc.js'

export const name = PLUGIN_NAME
export const inject = [
  'connection',
  'sessions',
  'agents',
  'sessionPersistence',
  'sessionQuery',
  'workspaceRegistry',
]
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => installVaultRpc(ctx), 'dsh-session-vault: loopback RPC')
}
