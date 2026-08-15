/**
 * Gateway user store: durable JSON user records under the gateway data root,
 * scrypt password hashing, OIDC identity links, and workspace grants.
 * @module @deepseek-ai/dsh-host-web-gateway/src/users
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One durable gateway account. */
export interface GatewayUser {
  /** Stable account id; also the per-user `$DSH_HOME` directory name. */
  id: string
  /** Unique login name. */
  username: string
  /**
   * scrypt hash in the form `scrypt$N$r$p$salt$hash` (all values hex/base10
   * as encoded), or `null` when the account is OIDC-only.
   */
  passwordHash: string | null
  /** Role set; `admin` may manage users through the CLI. */
  roles: readonly ('admin' | 'member')[]
  /** Linked OIDC identity, when the account signs in through an IdP. */
  oidc: { issuer: string; sub: string } | null
  /**
   * Workspace grants. `default` is the per-user working directory used as the
   * spawned instance's cwd; `shared` lists additional granted directories
   * (team shared spaces). Paths are absolute.
   */
  workspaces: { default: string; shared: readonly string[] }
  createdAt: string
  updatedAt: string
}

/** The persisted user file shape. */
export interface UserStoreFile {
  version: 1
  users: GatewayUser[]
}

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

/** Hash a password with a fresh random salt, returning the encoded record. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return [
    'scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P,
    salt.toString('hex'), hash.toString('hex'),
  ].join('$')
}

/**
 * Verify a password against an encoded scrypt record using a constant-time
 * compare. Non-scrypt records always fail.
 * @param encoded - the stored `scrypt$N$r$p$salt$hash` value.
 * @param password - the candidate password.
 * @returns whether the candidate matches.
 */
export function verifyPassword(encoded: string, password: string): boolean {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const nRaw = parts[1]
  const rRaw = parts[2]
  const pRaw = parts[3]
  const saltHex = parts[4]
  const hashHex = parts[5]
  if (nRaw === undefined || rRaw === undefined || pRaw === undefined || saltHex === undefined || hashHex === undefined) {
    return false
  }
  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)
    || salt.length === 0 || expected.length === 0) return false
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p })
  return timingSafeEqual(actual, expected)
}

/** The gateway user store: loads, mutates, and persists the user file atomically. */
export class UserStore {
  private users: GatewayUser[] = []

  /**
   * @param dataRoot - the gateway data root; the user file lives at
   * `users.json` inside it.
   */
  constructor(private readonly dataRoot: string) {}

  private get file(): string {
    return join(this.dataRoot, 'users.json')
  }

  /** Load the user file; an absent or empty file starts an empty store. */
  async load(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.users = []
      return
    }
    const parsed = JSON.parse(raw) as Partial<UserStoreFile>
    this.users = Array.isArray(parsed.users) ? parsed.users : []
  }

  /** Persist the current records atomically (write-then-rename). */
  async save(): Promise<void> {
    const payload: UserStoreFile = { version: 1, users: this.users }
    const tmp = `${this.file}.tmp-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await rename(tmp, this.file)
  }

  /** All users, in creation order. */
  list(): readonly GatewayUser[] {
    return this.users
  }

  /** Find a user by id. */
  byId(id: string): GatewayUser | undefined {
    return this.users.find(user => user.id === id)
  }

  /** Find a user by exact login name. */
  byUsername(username: string): GatewayUser | undefined {
    return this.users.find(user => user.username === username)
  }

  /** Find a user by linked OIDC identity. */
  byOidc(issuer: string, sub: string): GatewayUser | undefined {
    return this.users.find(user => user.oidc !== null && user.oidc.issuer === issuer && user.oidc.sub === sub)
  }

  /**
   * Create a user. The id is derived from the username (guaranteed unique by
   * `uniqueId`), so the per-user home directory is stable and readable.
   * @param input - username, optional password (hashed here), roles, OIDC link,
   * and workspace grants.
   * @returns the created record.
   */
  create(input: {
    username: string
    password?: string
    roles?: readonly ('admin' | 'member')[]
    oidc?: { issuer: string; sub: string }
    defaultWorkspace?: string
    sharedWorkspaces?: readonly string[]
  }): GatewayUser {
    if (this.byUsername(input.username) !== undefined) {
      throw new Error(`user '${input.username}' already exists`)
    }
    if (input.oidc !== undefined && this.byOidc(input.oidc.issuer, input.oidc.sub) !== undefined) {
      throw new Error(`oidc identity ${input.oidc.issuer}/${input.oidc.sub} is already linked`)
    }
    const now = new Date().toISOString()
    const user: GatewayUser = {
      id: this.uniqueId(input.username),
      username: input.username,
      passwordHash: input.password === undefined ? null : hashPassword(input.password),
      roles: input.roles ?? ['member'],
      oidc: input.oidc ?? null,
      workspaces: {
        default: input.defaultWorkspace ?? '',
        shared: input.sharedWorkspaces ?? [],
      },
      createdAt: now,
      updatedAt: now,
    }
    this.users.push(user)
    return user
  }

  /** Remove a user by id; returns whether a record was removed. */
  remove(id: string): boolean {
    const before = this.users.length
    this.users = this.users.filter(user => user.id !== id)
    return this.users.length !== before
  }

  /** Set (or clear, when password is `null`) the account password. */
  setPassword(id: string, password: string | null): GatewayUser | undefined {
    const user = this.byId(id)
    if (user === undefined) return undefined
    user.passwordHash = password === null ? null : hashPassword(password)
    user.updatedAt = new Date().toISOString()
    return user
  }

  /** Link (or clear) the account's OIDC identity. */
  setOidc(id: string, oidc: { issuer: string; sub: string } | null): GatewayUser | undefined {
    const user = this.byId(id)
    if (user === undefined) return undefined
    if (oidc !== null && this.byOidc(oidc.issuer, oidc.sub) !== undefined) {
      throw new Error(`oidc identity ${oidc.issuer}/${oidc.sub} is already linked`)
    }
    user.oidc = oidc
    user.updatedAt = new Date().toISOString()
    return user
  }

  /** Set the user's default (per-user) workspace directory. */
  setDefaultWorkspace(id: string, path: string): GatewayUser | undefined {
    const user = this.byId(id)
    if (user === undefined) return undefined
    user.workspaces = { ...user.workspaces, default: path }
    user.updatedAt = new Date().toISOString()
    return user
  }

  /** Grant a shared workspace path; the grant is idempotent. */
  grantSharedWorkspace(id: string, path: string): GatewayUser | undefined {
    const user = this.byId(id)
    if (user === undefined) return undefined
    if (!user.workspaces.shared.includes(path)) {
      user.workspaces = { ...user.workspaces, shared: [...user.workspaces.shared, path] }
      user.updatedAt = new Date().toISOString()
    }
    return user
  }

  /** Revoke a shared workspace path; the revoke is idempotent. */
  revokeSharedWorkspace(id: string, path: string): GatewayUser | undefined {
    const user = this.byId(id)
    if (user === undefined) return undefined
    if (user.workspaces.shared.includes(path)) {
      user.workspaces = { ...user.workspaces, shared: user.workspaces.shared.filter(p => p !== path) }
      user.updatedAt = new Date().toISOString()
    }
    return user
  }

  /** Derive a filesystem-safe, unique account id from the username. */
  private uniqueId(username: string): string {
    let id = username.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
    if (id === '') id = 'user'
    const suffix = this.byId(id) === undefined ? '' : `-${randomBytes(3).toString('hex')}`
    return `${id}${suffix}`
  }
}

/** Default per-user home directory inside the gateway data root. */
export function userHomeDir(dataRoot: string, userId: string): string {
  return join(dataRoot, 'users', userId)
}

/** Default per-user workspace directory inside the gateway data root. */
export function userWorkspaceDir(dataRoot: string, userId: string): string {
  return join(userHomeDir(dataRoot, userId), 'workspace')
}

/** Ensure the per-user home and default workspace directories exist. */
export async function ensureUserDirs(dataRoot: string, userId: string): Promise<void> {
  await mkdir(userWorkspaceDir(dataRoot, userId), { recursive: true })
}
