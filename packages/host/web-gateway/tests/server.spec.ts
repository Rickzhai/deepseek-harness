/**
 * End-to-end gateway tests: local login, session cookie gating, per-user
 * proxying to the fake dsh fixture, unauthenticated rejection, logout, and
 * the OIDC login flow against a fake provider.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createGatewayServer, type GatewayServer } from '../src/server.ts'
import { UserStore, userWorkspaceDir } from '../src/users.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

const roots: string[] = []
const gateways: GatewayServer[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close().catch(() => {})))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-server-'))
  roots.push(root)
  return root
}

async function startGateway(dataRoot: string, extra?: Partial<Parameters<typeof createGatewayServer>[0]>): Promise<GatewayServer> {
  const store = new UserStore(dataRoot)
  await store.load()
  store.create({ username: 'alice', password: 'pw-alice' })
  store.create({ username: 'bob', password: 'pw-bob' })
  await store.save()
  const gateway = createGatewayServer({
    dataRoot,
    secret: 'test-secret',
    host: '127.0.0.1',
    port: 0,
    dshBin: FIXTURE,
    idleTimeoutMs: 0,
    startTimeoutMs: 5000,
    ...extra,
  })
  await gateway.listen()
  gateways.push(gateway)
  return gateway
}

function baseUrl(gateway: GatewayServer): string {
  return `http://127.0.0.1:${String(gateway.port)}`
}

async function login(gateway: GatewayServer, username: string, password: string): Promise<{ status: number; cookie?: string }> {
  const response = await fetch(`${baseUrl(gateway)}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  return { status: response.status, ...(cookie !== undefined ? { cookie } : {}) }
}

describe('gateway login flow', () => {
  it('rejects unauthenticated page requests with a redirect to /login', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const response = await fetch(`${baseUrl(gateway)}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login')
  })

  it('rejects unauthenticated API requests with 401', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const response = await fetch(`${baseUrl(gateway)}/api/session.list`, {
      headers: { accept: 'application/json' },
    })
    expect(response.status).toBe(401)
  })

  it('serves the login page at /login', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const response = await fetch(`${baseUrl(gateway)}/login`)
    expect(response.status).toBe(200)
    expect((await response.text()).toLowerCase()).toContain('sign in')
  })

  it('logs in with valid credentials and issues a session cookie', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const { status, cookie } = await login(gateway, 'alice', 'pw-alice')
    expect(status).toBe(200)
    expect(cookie).toMatch(/^dsh_gw_session=/)
  })

  it('rejects bad credentials with 401', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const { status } = await login(gateway, 'alice', 'wrong')
    expect(status).toBe(401)
  })

  it('picks up CLI-added users without a gateway restart', async () => {
    // A user managed through the CLI writes users.json while the gateway is
    // already running; the next login must reload the file and authenticate.
    const dataRoot = await tempDataRoot()
    const gateway = await startGateway(dataRoot)
    const store = new UserStore(dataRoot)
    await store.load()
    store.create({ username: 'carol', password: 'pw-carol' })
    await store.save()
    const { status } = await login(gateway, 'carol', 'pw-carol')
    expect(status).toBe(200)
  })

  it('invalidates /auth/me for a user removed through the CLI', async () => {
    const dataRoot = await tempDataRoot()
    const gateway = await startGateway(dataRoot)
    const { cookie } = await login(gateway, 'alice', 'pw-alice')
    const store = new UserStore(dataRoot)
    await store.load()
    const alice = store.byUsername('alice')
    expect(alice).toBeDefined()
    store.remove(alice!.id)
    await store.save()
    const response = await fetch(`${baseUrl(gateway)}/auth/me`, { headers: { cookie: cookie! } })
    expect(response.status).toBe(401)
  })

  it('throttles repeated login failures', async () => {
    const gateway = await startGateway(await tempDataRoot(), { loginMaxFailures: 2, loginWindowMs: 60_000 })
    await login(gateway, 'alice', 'wrong')
    await login(gateway, 'alice', 'wrong')
    const third = await login(gateway, 'alice', 'pw-alice') // correct, but throttled
    expect(third.status).toBe(429)
  })

  it('reports the current user via /auth/me', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const { cookie } = await login(gateway, 'alice', 'pw-alice')
    const response = await fetch(`${baseUrl(gateway)}/auth/me`, { headers: { cookie: cookie! } })
    expect(response.status).toBe(200)
    const body = await response.json() as { user: { username: string; roles: string[] } }
    expect(body.user.username).toBe('alice')
  })

  it('logs out and invalidates the session', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const { cookie } = await login(gateway, 'alice', 'pw-alice')
    const logout = await fetch(`${baseUrl(gateway)}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookie! },
    })
    expect(logout.status).toBe(200)
    const me = await fetch(`${baseUrl(gateway)}/auth/me`, { headers: { cookie: cookie! } })
    expect(me.status).toBe(401)
  })
})

describe('gateway proxying', () => {
  it('proxies authenticated requests to the user\'s own instance', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const { cookie } = await login(gateway, 'alice', 'pw-alice')
    const response = await fetch(`${baseUrl(gateway)}/api/me`, { headers: { cookie: cookie! } })
    expect(response.status).toBe(200)
    const body = await response.json() as { home: string }
    // The proxied child saw Alice's isolated DSH_HOME.
    expect(body.home).toContain('users/alice')
  })

  it('isolates users: each sees its own instance', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const alice = await login(gateway, 'alice', 'pw-alice')
    const bob = await login(gateway, 'bob', 'pw-bob')
    const aliceMe = await (await fetch(`${baseUrl(gateway)}/api/me`, { headers: { cookie: alice.cookie! } })).json() as { home: string }
    const bobMe = await (await fetch(`${baseUrl(gateway)}/api/me`, { headers: { cookie: bob.cookie! } })).json() as { home: string }
    expect(aliceMe.home).toContain('users/alice')
    expect(bobMe.home).toContain('users/bob')
    expect(aliceMe.home).not.toBe(bobMe.home)
  })

  it('proxies the login page only when unauthenticated; SPA assets pass through when authenticated', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const { cookie } = await login(gateway, 'alice', 'pw-alice')
    const root = await fetch(`${baseUrl(gateway)}/`, { headers: { cookie: cookie! } })
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('fake dsh web')
  })
})

describe('gateway health', () => {
  it('answers /healthz without a session', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const response = await fetch(`${baseUrl(gateway)}/healthz`)
    expect(response.status).toBe(200)
  })
})

describe('gateway OIDC login', () => {
  async function fakeOidcProvider(): Promise<{ issuer: string; server: Server }> {
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
      if (url.pathname === '/authorize') {
        res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=code-1&state=${url.searchParams.get('state') ?? ''}` })
        res.end()
        return
      }
      if (url.pathname === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'at-1' }))
        return
      }
      if (url.pathname === '/userinfo') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sub: 'sub-alice', preferred_username: 'alice' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
    return { issuer: `http://127.0.0.1:${String(port)}`, server }
  }

  it('completes the OIDC flow and provisions the user', async () => {
    const oidc = await fakeOidcProvider()
    try {
      const gatewayDir = await tempDataRoot()
      const gateway = await startGateway(gatewayDir, {
        oidc: {
          issuer: oidc.issuer,
          clientId: 'client-1',
          redirectUri: 'http://localhost/callback',
        },
        oidcAutoProvision: true,
      })
      // Start the flow: /auth/oidc/start redirects to the provider, whose
      // /authorize bounces back to our callback with the code.
      const start = await fetch(`${baseUrl(gateway)}/auth/oidc/start`, { redirect: 'manual' })
      expect(start.status).toBe(302)
      const authorizeUrl = new URL(start.headers.get('location')!)
      // The fake provider redirects straight back; follow manually to read
      // the Set-Cookie on the callback response.
      const callbackResponse = await fetch(
        `${baseUrl(gateway)}/auth/oidc/callback?code=code-1&state=${authorizeUrl.searchParams.get('state')}`,
        { redirect: 'manual' },
      )
      expect(callbackResponse.status).toBe(302)
      const cookie = callbackResponse.headers.get('set-cookie')?.split(';')[0]
      expect(cookie).toMatch(/^dsh_gw_session=/)
      // The provisioned user exists with the OIDC link and a default workspace.
      const store = gateway.users
      const user = store.byOidc(oidc.issuer, 'sub-alice')
      expect(user).toBeDefined()
      expect(user?.workspaces.default).toBe(userWorkspaceDir(gatewayDir, user!.id))
    } finally {
      await new Promise<void>((resolve) => {
        oidc.server.close(() => { resolve() })
      })
    }
  })

  it('requires OIDC config before starting the flow', async () => {
    const gateway = await startGateway(await tempDataRoot())
    const response = await fetch(`${baseUrl(gateway)}/auth/oidc/start`)
    expect(response.status).toBe(404)
  })
})
