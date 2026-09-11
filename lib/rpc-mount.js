/**
 * Mount a Connection-shaped JSON RPC prefix on the caller fiber's webServer.
 *
 * `connection.rpc.handle` resolves `webServer` on the Connection plugin fiber,
 * which injects only `credentials`. A plugin that injects `webServer` registers
 * the same POST envelope the browser client already sends (`/channel/endpoint`).
 */

const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Channel-relative endpoint from a Connection RPC pathname.
 * @param {string} channel
 * @param {string} pathname
 * @returns {string | undefined}
 */
export function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (
    endpoint.split('/').some(
      (segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment),
    )
  ) {
    return undefined
  }
  return endpoint
}

/**
 * @param {unknown} body
 * @returns {body is { type: 'client-request', rpcId: string, method: string, payload: unknown }}
 */
function isClientRequest(body) {
  return (
    body !== null
    && typeof body === 'object'
    && /** @type {Record<string, unknown>} */ (body).type === 'client-request'
    && typeof /** @type {Record<string, unknown>} */ (body).rpcId === 'string'
    && typeof /** @type {Record<string, unknown>} */ (body).method === 'string'
  )
}

/**
 * @param {object} ctx
 * @param {string} channel
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>} handler
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function serveRpc(ctx, channel, handler, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const endpoint = endpointFromPath(channel, url.pathname)
  if (endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > MAX_BODY_BYTES) {
      res.writeHead(413)
      res.end()
      req.destroy()
      return
    }
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  if (!isClientRequest(body) || body.method !== endpoint) {
    const rpcId = isClientRequest(body) ? body.rpcId : typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
    const message = isClientRequest(body)
      ? `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`
      : 'invalid client-request message'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'gateway/bad-request', message, details: { issues: [] } } },
    }))
    return
  }
  try {
    const result = await handler(endpoint, body.payload, abort.signal)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
  } catch (error) {
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
  }
}

/**
 * Register `channel` for the browser Connection client on `ctx.webServer`.
 * @param {object} ctx
 * @param {string} pluginName
 * @param {string} channel
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>} handler
 * @returns {() => void}
 */
export function mountRpcChannel(ctx, pluginName, channel, handler) {
  if (typeof ctx.webServer?.register !== 'function') {
    throw new Error(`${pluginName}: ctx.webServer.register is required (inject webServer)`)
  }
  if (typeof ctx.connection?.requestRejection !== 'function') {
    throw new Error(`${pluginName}: ctx.connection.requestRejection is required (load the web Connection plugin)`)
  }
  return ctx.webServer.register({
    kind: 'prefix',
    path: channel,
    handler: (req, res) => serveRpc(ctx, channel, handler, req, res),
  })
}
