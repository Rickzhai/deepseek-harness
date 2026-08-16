/**
 * Reverse-proxy unit tests: HTTP forwarding with header sanitation against a
 * fake upstream, exercised through a real gateway-side HTTP server.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { proxyHttp } from '../src/proxy.ts'

let upstream: Server | undefined
let upstreamPort = 0
let lastSeen: { headers: import('node:http').IncomingHttpHeaders; url?: string; body?: string } | undefined

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      lastSeen = {
        headers: req.headers,
        ...(req.url !== undefined ? { url: req.url } : {}),
        body: Buffer.concat(chunks).toString('utf8'),
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' })
      res.end(JSON.stringify({ ok: true, url: req.url, host: req.headers.host }))
    })
  })
  await new Promise<void>((resolve) => {
    const server = upstream
    if (server === undefined) throw new Error('upstream not bound')
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const bound = upstream
  if (bound === undefined) throw new Error('upstream not bound')
  upstreamPort = (bound.address() as AddressInfo).port
})

afterEach(() => {
  lastSeen = undefined
})

afterAll(async () => {
  const server = upstream
  if (server === undefined) return
  await new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })
})

/** A gateway-side server that proxies every request to the fake upstream. */
async function gatewaySideProxy(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void proxyHttp(req, res, { host: '127.0.0.1', port: upstreamPort })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address() as AddressInfo
  return { server, port: address.port }
}

function fetchThrough(
  port: number,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
  })
}

describe('proxyHttp', () => {
  it('forwards method, path, and body, rewriting the Host to loopback', async () => {
    const proxy = await gatewaySideProxy()
    try {
      const response = await fetchThrough(proxy.port, '/api/session.list', {
        method: 'POST',
        headers: {
          host: 'gateway.example:3080',
          origin: 'http://gateway.example:3080',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          cookie: 'dsh_gw_session=abc',
          'content-type': 'application/json',
          'x-custom': 'keep-me',
        },
        body: JSON.stringify({ q: 1 }),
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { ok: boolean; url: string; host: string }
      expect(body.ok).toBe(true)
      expect(body.url).toBe('/api/session.list')
      expect(body.host).toBe(`127.0.0.1:${String(upstreamPort)}`)
      // Browser-origin markers and cookies must not leak to the child.
      expect(lastSeen?.headers['origin']).toBeUndefined()
      expect(lastSeen?.headers['cookie']).toBeUndefined()
      expect(lastSeen?.headers['sec-fetch-site']).toBeUndefined()
      expect(lastSeen?.headers['sec-fetch-mode']).toBeUndefined()
      expect(lastSeen?.headers['x-custom']).toBe('keep-me')
      expect(JSON.parse(lastSeen?.body ?? '{}')).toEqual({ q: 1 })
    } finally {
      await new Promise<void>((resolve) => {
        proxy.server.close(() => { resolve() })
      })
    }
  })

  it('strips the upgrade header so the child never sees a stale one', async () => {
    const proxy = await gatewaySideProxy()
    try {
      const response = await new Promise<{ status: number }>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: proxy.port,
          path: '/api/events.mux',
          method: 'GET',
          headers: { host: 'gateway.example', connection: 'keep-alive', upgrade: 'websocket' },
        }, (res) => {
          res.resume()
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0 })
          })
        })
        req.on('error', reject)
        req.end()
      })
      expect(response.status).toBe(200)
      // `upgrade` is caller-supplied and must be stripped; `connection` is
      // rewritten by node's client, so assert only the caller-owned header.
      expect(lastSeen?.headers['upgrade']).toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => {
        proxy.server.close(() => { resolve() })
      })
    }
  })

  it('answers 502 when the upstream is unreachable', async () => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void proxyHttp(req, res, { host: '127.0.0.1', port: 1 }).catch(() => {})
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => { resolve() })
    })
    const address = server.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/x`)
      expect(response.status).toBe(502)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    }
  })

  it('injects the user menu into an HTML response', async () => {
    // A fake HTML upstream + a gateway-side proxy; the proxied body must gain
    // the user-menu marker before </head>, while non-HTML responses are
    // streamed unchanged.
    const htmlUpstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>x</title></head><body></body></html>')
    })
    await new Promise<void>((resolve) => { htmlUpstream.listen(0, '127.0.0.1', () => { resolve() }) })
    const htmlPort = (htmlUpstream.address() as AddressInfo).port
    const proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
      void proxyHttp(req, res, { host: '127.0.0.1', port: htmlPort })
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', () => { resolve() }) })
    const proxyPort = (proxy.address() as AddressInfo).port
    try {
      const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/`)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain('data-dsh-gateway-user')
      expect(body).toContain('/auth/logout')
      // The marker must land inside <head>, before the SPA boots.
      expect(body.indexOf('data-dsh-gateway-user')).toBeLessThan(body.indexOf('</head>'))
    } finally {
      await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { htmlUpstream.close(() => { resolve() }) })
    }
  })
})
