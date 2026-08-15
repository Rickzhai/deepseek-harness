/**
 * The gateway HTTP server: login page, `/auth/*` routes, the request gate
 * (cookie validation → per-user instance proxy), and WebSocket upgrade
 * forwarding. Plain `node:http` — the gateway is a standalone edge process,
 * not a cordis tree, so it owns the full request lifecycle itself.
 * @module @deepseek-ai/dsh-host-web-gateway/src/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Duplex } from 'node:stream'
import { InstanceManager } from './instances.ts'
import { newPendingOidcAuth, discoverOidc, pendingOidcAuthExpired, signOidcState, usernameFromOidc, type OidcProviderConfig } from './oidc.ts'
import { proxyHttp, proxyUpgrade } from './proxy.ts'
import { SESSION_COOKIE, SessionStore } from './sessions.ts'
import { ensureUserDirs, UserStore, userWorkspaceDir, verifyPassword, type GatewayUser } from './users.ts'
import { LOGIN_PAGE_HTML } from './login-page.ts'

/** Gateway server configuration. */
export interface GatewayServerConfig {
  /** Gateway data root (users, sessions, per-user homes live here). */
  dataRoot: string
  /** Server secret: cookie signing + OIDC state signing. */
  secret: string
  /** Listen host. Defaults to `127.0.0.1`; set `0.0.0.0` for LAN/container. */
  host?: string
  /** Listen port; `0` requests an OS-assigned port. */
  port?: number
  /** Whether cookies carry the `Secure` attribute (serve behind TLS). */
  secureCookies?: boolean
  /** Session TTL (ms). Defaults to 7 days. */
  sessionTtlMs?: number
  /** The `dsh` executable for per-user instances. Defaults to `dsh` on PATH. */
  dshBin?: string
  /** Extra `dsh web` args (e.g. `--patch` overlays). */
  dshArgs?: readonly string[]
  /** Idle recycle timeout (ms); `0` disables. Defaults to 30 minutes. */
  idleTimeoutMs?: number
  /** Instance start timeout (ms). Defaults to 60 seconds. */
  startTimeoutMs?: number
  /** OIDC provider config; absent disables SSO login. */
  oidc?: OidcProviderConfig
  /** Auto-provision a gateway user from a successful OIDC sign-in. Default true. */
  oidcAutoProvision?: boolean
  /** Login attempt throttle: max failures per username+IP window (ms). */
  loginMaxFailures?: number
  /** Login throttle window (ms). Defaults to 5 minutes. */
  loginWindowMs?: number
}

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7
const DEFAULT_IDLE_TIMEOUT_MS = 1000 * 60 * 30
const DEFAULT_START_TIMEOUT_MS = 60_000
const DEFAULT_LOGIN_MAX_FAILURES = 5
const DEFAULT_LOGIN_WINDOW_MS = 1000 * 60 * 5
const MAX_BODY_BYTES = 64 * 1024

/** The running gateway server handle. */
export interface GatewayServer {
  /** The underlying HTTP server (bound after `listen()`). */
  server: Server
  /** Start listening on the configured host/port. */
  listen(): Promise<void>
  /** Stop listening and dispose every per-user instance. */
  close(): Promise<void>
  /** The resolved listen port (valid after `listen()`). */
  port: number
  /** The user store (for admin CLI integration in-process). */
  users: UserStore
  /** The instance manager (exposed for lifecycle tests). */
  instances: InstanceManager
}

/** In-memory login throttle keyed by `username|ip`. */
class LoginThrottle {
  private readonly failures = new Map<string, { count: number; windowStart: number }>()

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  /** Record one failure; returns the new count. */
  record(key: string): number {
    const now = Date.now()
    const entry = this.failures.get(key)
    if (entry === undefined || now - entry.windowStart > this.windowMs) {
      this.failures.set(key, { count: 1, windowStart: now })
      return 1
    }
    entry.count += 1
    return entry.count
  }

  /** Whether the key is currently locked out. */
  blocked(key: string): boolean {
    const entry = this.failures.get(key)
    if (entry === undefined) return false
    if (Date.now() - entry.windowStart > this.windowMs) {
      this.failures.delete(key)
      return false
    }
    return entry.count >= this.maxFailures
  }

  /** Clear failures for a key (successful login). */
  clear(key: string): void {
    this.failures.delete(key)
  }
}

/**
 * Create the gateway server. Call `listen()` to bind; `close()` tears down
 * the server and every per-user dsh instance.
 * @param config - gateway configuration.
 * @returns the server handle.
 */
export function createGatewayServer(config: GatewayServerConfig): GatewayServer {
  const resolved = {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 3080,
    secureCookies: config.secureCookies ?? false,
    sessionTtlMs: config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    dshBin: config.dshBin ?? 'dsh',
    dshArgs: config.dshArgs ?? [],
    idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    startTimeoutMs: config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    oidc: config.oidc,
    oidcAutoProvision: config.oidcAutoProvision ?? true,
    loginMaxFailures: config.loginMaxFailures ?? DEFAULT_LOGIN_MAX_FAILURES,
    loginWindowMs: config.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS,
  }

  const users = new UserStore(config.dataRoot)
  const sessions = new SessionStore(config.dataRoot, config.secret)
  const instances = new InstanceManager({
    dataRoot: config.dataRoot,
    dshBin: resolved.dshBin,
    dshArgs: resolved.dshArgs,
    idleTimeoutMs: resolved.idleTimeoutMs,
    startTimeoutMs: resolved.startTimeoutMs,
    probeIntervalMs: 250,
  })
  const throttle = new LoginThrottle(resolved.loginMaxFailures, resolved.loginWindowMs)
  // Pending OIDC authorizations, keyed by signed state.
  const pendingOidc = new Map<string, ReturnType<typeof newPendingOidcAuth>>()

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head)
  })

  const gateway: GatewayServer = {
    server,
    users,
    instances,
    port: resolved.port,
    async listen() {
      await users.load()
      await sessions.load()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(resolved.port, resolved.host, () => {
          server.off('error', reject)
          gateway.port = (server.address() as { port: number }).port
          resolve()
        })
      })
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
      await sessions.flush()
      await instances.dispose()
    },
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    try {
      if (path === '/login' && req.method === 'GET') {
        sendLoginPage(res)
        return
      }
      if (path === '/auth/login' && req.method === 'POST') {
        await handleLogin(req, res)
        return
      }
      if (path === '/auth/logout' && req.method === 'POST') {
        handleLogout(req, res)
        return
      }
      if (path === '/auth/me' && req.method === 'GET') {
        await handleMe(req, res)
        return
      }
      if (path === '/auth/oidc/start' && req.method === 'GET') {
        await handleOidcStart(req, res)
        return
      }
      if (path === '/auth/oidc/callback' && req.method === 'GET') {
        await handleOidcCallback(req, res)
        return
      }
      if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }

      // Everything else is the proxied surface: require a valid session.
      const userId = sessions.validate(readCookie(req, SESSION_COOKIE), resolved.sessionTtlMs)
      if (userId === undefined) {
        rejectUnauthenticated(req, res)
        return
      }
      const instance = await instances.ensure(userId)
      await proxyHttp(req, res, { host: '127.0.0.1', port: instance.port })
    } catch (error) {
      respondError(res, error)
    }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const userId = sessions.validate(readCookie(req, SESSION_COOKIE), resolved.sessionTtlMs)
    if (userId === undefined) {
      socket.destroy()
      return
    }
    try {
      const instance = await instances.ensure(userId)
      await proxyUpgrade(req, socket, head, { host: '127.0.0.1', port: instance.port })
    } catch (error) {
      console.error('web-gateway: upgrade failed', error)
      socket.destroy()
    }
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req)
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const ip = req.socket.remoteAddress ?? 'unknown'
    const key = `${username}|${ip}`
    if (throttle.blocked(key)) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'too-many-attempts' }))
      return
    }
    // Reload the user file so CLI-managed accounts take effect without a
    // gateway restart (login is low-frequency; the file is small).
    await users.load()
    const user = users.byUsername(username)
    const ok = user !== undefined && user.passwordHash !== null && verifyPassword(user.passwordHash, password)
    if (!ok) {
      throttle.record(key)
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid-credentials' }))
      return
    }
    throttle.clear(key)
    const cookie = sessions.issue(user.id, resolved.sessionTtlMs)
    setSessionCookie(res, cookie, resolved.sessionTtlMs, resolved.secureCookies)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ user: publicUser(user) }))
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    sessions.revoke(readCookie(req, SESSION_COOKIE))
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
    })
    res.end('{"ok":true}')
  }

  async function handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = sessions.validate(readCookie(req, SESSION_COOKIE), resolved.sessionTtlMs)
    if (userId === undefined) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthenticated' }))
      return
    }
    await users.load()
    const user = users.byId(userId)
    if (user === undefined) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown-user' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ user: publicUser(user) }))
  }

  async function handleOidcStart(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (resolved.oidc === undefined) {
      res.writeHead(404)
      res.end('oidc not configured')
      return
    }
    const client = await discoverOidc(resolved.oidc)
    const pending = newPendingOidcAuth()
    const state = `${pending.state}.${signOidcState(config.secret, pending.state)}`
    pendingOidc.set(state, pending)
    // Authorize with the SIGNED state so the callback can look the attempt up
    // by the exact value the IdP echoes back.
    res.writeHead(302, { location: client.authorizeUrl({ ...pending, state }) })
    res.end()
  }

  async function handleOidcCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (resolved.oidc === undefined) {
      res.writeHead(404)
      res.end('oidc not configured')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (error !== null) {
      res.writeHead(302, { location: '/login?error=oidc' })
      res.end()
      return
    }
    if (state === null || code === null) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing-params' }))
      return
    }
    const pending = pendingOidc.get(state)
    pendingOidc.delete(state)
    if (pending === undefined || pendingOidcAuthExpired(pending)) {
      res.writeHead(302, { location: '/login?error=oidc-expired' })
      res.end()
      return
    }
    try {
      const client = await discoverOidc(resolved.oidc)
      const { accessToken } = await client.exchangeCode(code, pending)
      const info = await client.userinfo(accessToken)
      await users.load()
      let user = users.byOidc(resolved.oidc.issuer, info.sub)
      if (user === undefined && resolved.oidcAutoProvision) {
        const username = uniqueUsername(users, usernameFromOidc(info))
        const created = users.create({
          username,
          oidc: { issuer: resolved.oidc.issuer, sub: info.sub },
        })
        users.setDefaultWorkspace(created.id, userWorkspaceDir(config.dataRoot, created.id))
        await ensureUserDirs(config.dataRoot, created.id)
        await users.save()
        user = created
      }
      if (user === undefined) {
        res.writeHead(302, { location: '/login?error=oidc-unlinked' })
        res.end()
        return
      }
      const cookie = sessions.issue(user.id, resolved.sessionTtlMs)
      setSessionCookie(res, cookie, resolved.sessionTtlMs, resolved.secureCookies)
      res.writeHead(302, { location: '/' })
      res.end()
    } catch (oidcError) {
      console.error('web-gateway: oidc callback failed', oidcError)
      res.writeHead(302, { location: '/login?error=oidc' })
      res.end()
    }
  }

  function rejectUnauthenticated(req: IncomingMessage, res: ServerResponse): void {
    const accept = req.headers.accept ?? ''
    if (accept.includes('text/html')) {
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthenticated' }))
  }

  function sendLoginPage(res: ServerResponse): void {
    const html = resolved.oidc === undefined
      ? LOGIN_PAGE_HTML.replace('<!-- __OIDC__ -->', '')
      : LOGIN_PAGE_HTML.replace('<!-- __OIDC__ -->', '<a class="sso" href="/auth/oidc/start">Sign in with SSO</a>')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  return gateway
}

/** Public (non-secret) projection of a user for `/auth/me` and login responses. */
export function publicUser(user: GatewayUser): {
  id: string
  username: string
  roles: readonly string[]
  workspaces: { default: string; shared: readonly string[] }
  oidcLinked: boolean
} {
  return {
    id: user.id,
    username: user.username,
    roles: [...user.roles],
    workspaces: { default: user.workspaces.default, shared: [...user.workspaces.shared] },
    oidcLinked: user.oidc !== null,
  }
}

/** Read one cookie value from a request. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Write the gateway session cookie attribute onto a response header. */
export function setSessionCookie(res: ServerResponse, cookie: string, ttlMs: number, secure: boolean): void {
  const attributes = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
    ...secure ? ['Secure'] : [],
  ].join('; ')
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${cookie}; ${attributes}`)
}

/** Parse a JSON request body with a size cap. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    throw new Error('invalid JSON body')
  }
}

/** Derive a username not already taken, appending a numeric suffix. */
function uniqueUsername(users: UserStore, base: string): string {
  if (users.byUsername(base) === undefined) return base
  let n = 2
  while (users.byUsername(`${base}-${String(n)}`) !== undefined) n += 1
  return `${base}-${String(n)}`
}

/** Respond to an unexpected handler error with a stable JSON shape. */
function respondError(res: ServerResponse, error: unknown): void {
  console.error('web-gateway: request failed', error)
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(500, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'internal-error' }))
}
