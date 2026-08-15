/**
 * Session-store unit tests for the web gateway.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/sessions.ts'

const stores: SessionStore[] = []
const roots: string[] = []

afterEach(async () => {
  // Flush every queued write before removing the temp roots so the store's
  // atomic rename never races directory cleanup.
  await Promise.all(stores.splice(0).map(store => store.flush()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-sessions-'))
  roots.push(root)
  const store = new SessionStore(root, 'test-secret')
  stores.push(store)
  await store.load()
  return store
}

describe('SessionStore', () => {
  it('issues and validates sessions, resolving the user id', async () => {
    const store = await tempStore()
    const cookie = store.issue('u-1')
    expect(cookie).toContain('.')
    expect(store.validate(cookie)).toBe('u-1')
  })

  it('rejects forged cookies (bad signature)', async () => {
    const store = await tempStore()
    const cookie = store.issue('u-1')
    const forged = `${cookie.slice(0, -4)}AAAA`
    expect(store.validate(forged)).toBeUndefined()
  })

  it('rejects cookies for unknown tokens', async () => {
    const store = await tempStore()
    expect(store.validate('unknown-token.fakesig')).toBeUndefined()
  })

  it('respects the TTL', async () => {
    const store = await tempStore()
    const cookie = store.issue('u-1', 10)
    expect(store.validate(cookie, 10)).toBe('u-1')
    // An already-expired token is rejected.
    const expired = store.issue('u-1', -1)
    expect(store.validate(expired)).toBeUndefined()
  })

  it('slides expiry forward on validation', async () => {
    const store = await tempStore()
    const cookie = store.issue('u-1', 1000 * 60 * 60)
    expect(store.validate(cookie, 1000 * 60 * 60)).toBe('u-1')
    expect(store.validate(cookie, 1000 * 60 * 60)).toBe('u-1')
  })

  it('revokes sessions', async () => {
    const store = await tempStore()
    const cookie = store.issue('u-1')
    store.revoke(cookie)
    expect(store.validate(cookie)).toBeUndefined()
  })

  it('persists sessions across instances and keeps them valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-sessions-persist-'))
    roots.push(root)
    const first = new SessionStore(root, 'same-secret')
    stores.push(first)
    await first.load()
    const cookie = first.issue('u-1')
    await first.flush()

    const second = new SessionStore(root, 'same-secret')
    stores.push(second)
    await second.load()
    expect(second.validate(cookie)).toBe('u-1')
  })

  it('drops expired sessions on load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-sessions-expired-'))
    roots.push(root)
    const first = new SessionStore(root, 'same-secret')
    stores.push(first)
    await first.load()
    first.issue('u-1', -1) // immediately expired
    await first.flush()

    const second = new SessionStore(root, 'same-secret')
    stores.push(second)
    await second.load()
    expect(second.size()).toBe(0)
  })
})
