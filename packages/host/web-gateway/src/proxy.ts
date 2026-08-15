/**
 * Reverse proxy from the gateway to a per-user dsh web instance: HTTP
 * forwarding with hop-by-hop and browser-origin header sanitation, plus
 * WebSocket upgrade forwarding over raw sockets.
 * @module @deepseek-ai/dsh-host-web-gateway/src/proxy
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { type Duplex } from 'node:stream'

/** Headers the gateway must not forward to the child instance. */
const STRIP_REQUEST_HEADERS = new Set([
  'cookie',
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
])

/** Headers the gateway must not forward from the child response. */
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
])

/** Forward one HTTP request to the child and stream the response back. */
export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: { host: string; port: number },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue
      headers[name] = value
    }
    // The child's browser-trust fence requires a loopback Host and no
    // cross-site markers; the gateway is the origin boundary, so the child
    // only ever sees loopback-origin traffic.
    headers['host'] = `${target.host}:${String(target.port)}`
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
    headers['x-forwarded-proto'] = 'http'

    const upstream: ClientRequest = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes: IncomingMessage) => {
      const responseHeaders: Record<string, string | string[] | number | undefined> = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue
        responseHeaders[name] = value
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders)
      upstreamRes.pipe(res)
      upstreamRes.on('end', () => { resolve() })
      upstreamRes.on('error', reject)
    })
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
      } else {
        res.writeHead(502)
        res.end('bad gateway')
      }
      reject(error)
    })
    req.pipe(upstream)
    req.on('error', () => upstream.destroy())
  })
}

/**
 * Forward one WebSocket upgrade to the child and bridge the sockets. The
 * caller owns the client socket lifecycle after this resolves; the returned
 * promise resolves once the bridge is established (or rejects on failure).
 */
export function proxyUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  target: { host: string; port: number },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue
      headers[name] = value
    }
    headers['host'] = `${target.host}:${String(target.port)}`
    headers['connection'] = 'Upgrade'
    headers['upgrade'] = 'websocket'
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
    headers['x-forwarded-proto'] = 'http'

    const upstream: ClientRequest = httpRequest({
      host: target.host,
      port: target.port,
      method: 'GET',
      path: req.url,
      headers,
    })
    upstream.on('upgrade', (upstreamRes, upstreamSocket) => {
      if (upstreamRes.statusCode !== 101) {
        upstreamSocket.destroy()
        reject(new Error(`upstream upgrade answered HTTP ${String(upstreamRes.statusCode)}`))
        return
      }
      // Replay the child's real 101 (its Sec-WebSocket-Accept is computed
      // from the client key, so the browser verifies it), then bridge.
      // A WebSocket 101 MUST carry both `Connection: Upgrade` and
      // `Upgrade: websocket`, and undici (and the WebSocket spec) match
      // `Sec-WebSocket-Accept` case-sensitively — but node:http lowercases
      // header names on `upstreamRes.headers`. Normalize the three handshake
      // headers back to their canonical casing on the wire; the generic
      // hop-by-hop strip must also keep `Connection` here.
      const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
      let wroteConnection = false
      let wroteUpgrade = false
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        const lower = name.toLowerCase()
        if (STRIP_RESPONSE_HEADERS.has(lower) && lower !== 'connection') continue
        const canonical = lower === 'connection' ? 'Connection'
          : lower === 'upgrade' ? 'Upgrade'
            : lower === 'sec-websocket-accept' ? 'Sec-WebSocket-Accept'
              : name
        wroteConnection = wroteConnection || lower === 'connection'
        wroteUpgrade = wroteUpgrade || lower === 'upgrade'
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${canonical}: ${v}`)
      }
      if (!wroteConnection) lines.push('Connection: Upgrade')
      if (!wroteUpgrade) lines.push('Upgrade: websocket')
      clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      bridgeSockets(clientSocket, upstreamSocket, head)
      resolve()
    })
    upstream.on('error', (error) => {
      clientSocket.destroy()
      reject(error)
    })
    upstream.end()
  })
}

/** Bidirectionally pipe two sockets, forwarding any buffered head first. */
function bridgeSockets(a: Duplex, b: Duplex, head: Buffer): void {
  if (head.length > 0) b.write(head)
  a.pipe(b)
  b.pipe(a)
  const destroy = (): void => { a.destroy(); b.destroy() }
  a.on('error', destroy)
  b.on('error', destroy)
  a.on('close', destroy)
  b.on('close', destroy)
}
