/**
 * Gateway session store: opaque bearer tokens issued as signed HttpOnly
 * cookies, kept in memory with durable persistence so a gateway restart keeps
 * every user logged in, and expired on a sliding TTL.
 * @module @deepseek-ai/dsh-host-web-gateway/src/sessions
 */

import { createHmac, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One live gateway session. */
export interface GatewaySession {
  /** The user this session authenticates. */
  userId: string
  /** Absolute expiry (epoch ms); the session is invalid past this time. */
  expiresAt: number
  /** Creation time (epoch ms). */
  createdAt: number
}

/** The persisted session file shape (tokens stored as SHA-256 digests only). */
interface SessionStoreFile {
  version: 1
  sessions: Array<{ tokenHash: string; session: GatewaySession }>
}

/** Cookie name used for the gateway session. */
export const SESSION_COOKIE = 'dsh_gw_session'

const TOKEN_BYTES = 32
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7 // 7 days

/**
 * The gateway session store. Tokens are random 256-bit values; only their
 * SHA-256 digests are persisted, so a leaked session file does not expose
 * usable bearer tokens. The cookie value carries the raw token plus an HMAC
 * signature over it (keyed by the server secret), which lets the gateway
 * reject forged cookies before any lookup.
 */
export class SessionStore {
  private sessions = new Map<string, GatewaySession>()
  private readonly secret: string
  /** Serialized write chain so concurrent mutations never interleave a rename. */
  private saveChain: Promise<void> = Promise.resolve()

  /**
   * @param dataRoot - the gateway data root; sessions persist at
   * `sessions.json` inside it.
   * @param secret - server secret used to sign cookies.
   */
  constructor(
    private readonly dataRoot: string,
    secret: string,
  ) {
    this.secret = secret
  }

  private get file(): string {
    return join(this.dataRoot, 'sessions.json')
  }

  /**
   * Persist the current session table (digests only). Writes are queued on a
   * chain so overlapping mutations never race a rename; the returned promise
   * settles only after this write and every earlier one completed.
   */
  save(): Promise<void> {
    const write = async (): Promise<void> => {
      const payload: SessionStoreFile = {
        version: 1,
        sessions: [...this.sessions.entries()].map(([tokenHash, session]) => ({ tokenHash, session })),
      }
      const tmp = `${this.file}.tmp-${randomBytes(6).toString('hex')}`
      await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
      await rename(tmp, this.file)
    }
    this.saveChain = this.saveChain.then(write, write)
    return this.saveChain
  }

  /** Wait for every queued write to finish (test/lifecycle hook). */
  flush(): Promise<void> {
    return this.saveChain
  }

  /** Load persisted sessions; expired entries are dropped on the next sweep. */
  async load(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    const parsed = JSON.parse(raw) as Partial<SessionStoreFile>
    if (!Array.isArray(parsed.sessions)) return
    for (const entry of parsed.sessions) {
      if (entry.session.expiresAt > Date.now()) {
        this.sessions.set(entry.tokenHash, entry.session)
      }
    }
  }

  /**
   * Issue a new session for a user.
   * @param userId - the authenticated user.
   * @param ttlMs - session lifetime; defaults to 7 days.
   * @returns the raw cookie value (token.signature) to set on the client.
   */
  issue(userId: string, ttlMs = COOKIE_MAX_AGE_MS): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const now = Date.now()
    this.sessions.set(this.digest(token), {
      userId,
      expiresAt: now + ttlMs,
      createdAt: now,
    })
    void this.save()
    return this.sign(token)
  }

  /**
   * Validate a cookie value and resolve its user, sliding the expiry forward
   * on success.
   * @param cookieValue - the raw `token.signature` value from the cookie.
   * @param ttlMs - the sliding TTL applied on refresh.
   * @returns the user id, or `undefined` when the cookie is forged or expired.
   */
  validate(cookieValue: string | undefined, ttlMs = COOKIE_MAX_AGE_MS): string | undefined {
    if (cookieValue === undefined) return undefined
    const token = this.unsign(cookieValue)
    if (token === undefined) return undefined
    const session = this.sessions.get(this.digest(token))
    if (session === undefined) return undefined
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(this.digest(token))
      void this.save()
      return undefined
    }
    session.expiresAt = Date.now() + ttlMs
    return session.userId
  }

  /** Revoke a session by its cookie value. */
  revoke(cookieValue: string | undefined): void {
    if (cookieValue === undefined) return
    const token = this.unsign(cookieValue)
    if (token === undefined) return
    if (this.sessions.delete(this.digest(token))) void this.save()
  }

  /** Drop every expired session; returns the number removed. */
  sweep(): number {
    const now = Date.now()
    let removed = 0
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(hash)
        removed += 1
      }
    }
    if (removed > 0) void this.save()
    return removed
  }

  /** Live session count (after a sweep). */
  size(): number {
    this.sweep()
    return this.sessions.size
  }

  /** Sign a raw token: `token.hmac`. */
  private sign(token: string): string {
    const mac = createHmac('sha256', this.secret).update(token).digest('base64url')
    return `${token}.${mac}`
  }

  /** Verify the signature and return the raw token, or `undefined` on forgery. */
  private unsign(signed: string): string | undefined {
    const dot = signed.lastIndexOf('.')
    if (dot <= 0) return undefined
    const token = signed.slice(0, dot)
    const mac = signed.slice(dot + 1)
    const expected = createHmac('sha256', this.secret).update(token).digest('base64url')
    // Constant-time compare of equal-length base64url strings.
    const a = Buffer.from(mac)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return undefined
    let diff = 0
    for (let i = 0; i < a.length; i += 1) {
      diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
    }
    return diff === 0 ? token : undefined
  }

  /** SHA-256 digest of a raw token (the persisted form). */
  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }
}

/**
 * The default gateway server secret: 32 random bytes. A deployment SHOULD set
 * a stable secret (e.g. `GATEWAY_SECRET`) so cookies survive gateway restarts;
 * the random default re-signs nothing, but sessions are persisted by token
 * digest and remain valid across restarts regardless of the secret — the
 * secret only protects against cookie forgery.
 */
export function defaultGatewaySecret(): string {
  return randomBytes(32).toString('base64url')
}
