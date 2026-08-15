/**
 * User-store and password-hashing unit tests for the web gateway.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword, UserStore, verifyPassword } from '../src/users.ts'

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots = []
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-users-'))
  roots.push(root)
  return root
}

describe('password hashing', () => {
  it('hashes and verifies a password', () => {
    const encoded = hashPassword('correct horse battery staple')
    expect(encoded.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword(encoded, 'correct horse battery staple')).toBe(true)
    expect(verifyPassword(encoded, 'wrong')).toBe(false)
  })

  it('produces a unique salt per hash', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })

  it('rejects malformed records', () => {
    expect(verifyPassword('plain', 'x')).toBe(false)
    expect(verifyPassword('scrypt$1$2$3$aa', 'x')).toBe(false)
    expect(verifyPassword('scrypt$1$2$3$aa$bb$cc', 'x')).toBe(false)
  })
})

describe('UserStore', () => {
  it('persists users across instances', async () => {
    const root = await tempRoot()
    const store = new UserStore(root)
    await store.load()
    store.create({ username: 'alice', password: 'pw' })
    await store.save()

    const reloaded = new UserStore(root)
    await reloaded.load()
    const alice = reloaded.byUsername('alice')
    expect(alice).toBeDefined()
    expect(alice?.passwordHash).not.toBe('pw')
    expect(alice !== undefined && (alice.passwordHash === null || verifyPassword(alice.passwordHash, 'pw'))).toBe(true)
  })

  it('rejects duplicate usernames', async () => {
    const store = new UserStore(await tempRoot())
    await store.load()
    store.create({ username: 'alice', password: 'pw' })
    expect(() => store.create({ username: 'alice', password: 'pw2' })).toThrow(/already exists/)
  })

  it('manages passwords and roles', async () => {
    const store = new UserStore(await tempRoot())
    await store.load()
    const user = store.create({ username: 'bob', password: 'one', roles: ['admin'] })
    expect(user.roles).toEqual(['admin'])
    store.setPassword(user.id, 'two')
    expect(store.byId(user.id)?.passwordHash === null
      || verifyPassword(store.byId(user.id)!.passwordHash!, 'two')).toBe(true)
    expect(verifyPassword(store.byId(user.id)!.passwordHash!, 'one')).toBe(false)
  })

  it('links OIDC identities and finds by them', async () => {
    const store = new UserStore(await tempRoot())
    await store.load()
    const user = store.create({
      username: 'carol',
      oidc: { issuer: 'https://idp.example', sub: 'sub-1' },
    })
    expect(store.byOidc('https://idp.example', 'sub-1')?.id).toBe(user.id)
    expect(() => store.create({
      username: 'dave',
      oidc: { issuer: 'https://idp.example', sub: 'sub-1' },
    })).toThrow(/already linked/)
    store.setOidc(user.id, null)
    expect(store.byOidc('https://idp.example', 'sub-1')).toBeUndefined()
  })

  it('grants and revokes shared workspaces', async () => {
    const store = new UserStore(await tempRoot())
    await store.load()
    const user = store.create({ username: 'erin' })
    store.setDefaultWorkspace(user.id, '/srv/erin')
    store.grantSharedWorkspace(user.id, '/srv/team')
    store.grantSharedWorkspace(user.id, '/srv/team') // idempotent
    expect(store.byId(user.id)?.workspaces.default).toBe('/srv/erin')
    expect(store.byId(user.id)?.workspaces.shared).toEqual(['/srv/team'])
    store.revokeSharedWorkspace(user.id, '/srv/team')
    expect(store.byId(user.id)?.workspaces.shared).toEqual([])
  })

  it('removes users', async () => {
    const store = new UserStore(await tempRoot())
    await store.load()
    const user = store.create({ username: 'frank' })
    expect(store.remove(user.id)).toBe(true)
    expect(store.remove(user.id)).toBe(false)
    expect(store.byUsername('frank')).toBeUndefined()
  })

  it('writes the file with owner-only mode', async () => {
    const root = await tempRoot()
    const store = new UserStore(root)
    await store.load()
    store.create({ username: 'grace', password: 'pw' })
    await store.save()
    const stat = await (await import('node:fs/promises')).stat(join(root, 'users.json'))
    expect(stat.mode & 0o777).toBe(0o600)
    const raw = await readFile(join(root, 'users.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; users: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.users).toHaveLength(1)
  })
})
