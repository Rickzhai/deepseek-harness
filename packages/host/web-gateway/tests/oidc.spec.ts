/**
 * OIDC client unit tests: discovery parsing, PKCE challenge derivation, state
 * expiry, and username derivation from userinfo.
 */

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverOidc, newPendingOidcAuth, pendingOidcAuthExpired, pkceChallenge,
  signOidcState, usernameFromOidc, type OidcUserinfo,
} from '../src/oidc.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

/** Start a fake OIDC provider answering discovery/token/userinfo. */
async function fakeProvider(): Promise<{ issuer: string; redirectUri: string; clientId: string }> {
  let port = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: `http://127.0.0.1:${String(port)}`,
        authorization_endpoint: `http://127.0.0.1:${String(port)}/authorize`,
        token_endpoint: `http://127.0.0.1:${String(port)}/token`,
        userinfo_endpoint: `http://127.0.0.1:${String(port)}/userinfo`,
      }))
      return
    }
    if (url.pathname === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'access-token-1' }))
      return
    }
    if (url.pathname === '/userinfo') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sub: 'sub-42', email: 'alice@example.com', preferred_username: 'alice' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
  return { issuer: `http://127.0.0.1:${String(port)}`, redirectUri: 'http://localhost/callback', clientId: 'client-1' }
}

describe('OIDC discovery and flow', () => {
  it('discovers endpoints and builds an authorization URL with PKCE', async () => {
    const provider = await fakeProvider()
    const client = await discoverOidc({
      issuer: provider.issuer,
      clientId: provider.clientId,
      redirectUri: provider.redirectUri,
    })
    const pending = newPendingOidcAuth()
    const url = new URL(client.authorizeUrl(pending))
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(pending.codeVerifier))
    expect(url.searchParams.get('state')).toBe(pending.state)
  })

  it('exchanges a code and resolves userinfo', async () => {
    const provider = await fakeProvider()
    const client = await discoverOidc({
      issuer: provider.issuer,
      clientId: provider.clientId,
      redirectUri: provider.redirectUri,
    })
    const pending = newPendingOidcAuth()
    const { accessToken } = await client.exchangeCode('code-1', pending)
    expect(accessToken).toBe('access-token-1')
    const info = await client.userinfo(accessToken)
    expect(info.sub).toBe('sub-42')
    expect(info.preferred_username).toBe('alice')
  })

  it('fails loudly on an unreachable issuer', async () => {
    await expect(discoverOidc({
      issuer: 'http://127.0.0.1:1',
      clientId: 'c',
      redirectUri: 'http://localhost/callback',
    })).rejects.toMatchObject({ code: 'discovery-failed' })
  })
})

describe('PKCE and state helpers', () => {
  it('derives a stable S256 challenge', () => {
    const challenge = pkceChallenge('verifier')
    expect(challenge).toBe(pkceChallenge('verifier'))
    expect(challenge).not.toBe(pkceChallenge('other'))
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('expires pending attempts', () => {
    const expired = { ...newPendingOidcAuth(), createdAt: Date.now() - 60_000 }
    expect(pendingOidcAuthExpired(expired, 0)).toBe(true)
    const fresh = newPendingOidcAuth()
    expect(pendingOidcAuthExpired(fresh, 60_000)).toBe(false)
  })

  it('signs state deterministically under one secret', () => {
    expect(signOidcState('secret', 'state-1')).toBe(signOidcState('secret', 'state-1'))
    expect(signOidcState('secret', 'state-1')).not.toBe(signOidcState('secret', 'state-2'))
    expect(signOidcState('secret', 'state-1')).not.toBe(signOidcState('other', 'state-1'))
  })
})

describe('username derivation', () => {
  it('prefers preferred_username', () => {
    const info: OidcUserinfo = { sub: 's', preferred_username: 'bob', email: 'bob@example.com' }
    expect(usernameFromOidc(info)).toBe('bob')
  })

  it('falls back to the email local part', () => {
    const info: OidcUserinfo = { sub: 's', email: 'carol@example.com' }
    expect(usernameFromOidc(info)).toBe('carol')
  })

  it('falls back to a sub-derived name and sanitizes', () => {
    const info: OidcUserinfo = { sub: 'abc-123', email: 'odd name@example.com' }
    expect(usernameFromOidc(info)).toMatch(/^[A-Za-z0-9._-]+$/)
    const bare: OidcUserinfo = { sub: 'xyz' }
    expect(usernameFromOidc(bare)).toBe(`user-${'xyz'.slice(0, 12)}`)
  })
})
