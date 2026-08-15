/**
 * Instance-manager unit tests: port allocation and per-user spawn/readiness
 * against the fake dsh fixture, plus idle recycling.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceManager, freePort } from '../src/instances.ts'
import { ensureUserDirs, userHomeDir, userWorkspaceDir } from '../src/users.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

const roots: string[] = []
const managers: InstanceManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-instances-'))
  roots.push(root)
  return root
}

function makeManager(dataRoot: string, extra?: Partial<ConstructorParameters<typeof InstanceManager>[0]>): InstanceManager {
  const manager = new InstanceManager({
    dataRoot,
    dshBin: FIXTURE,
    idleTimeoutMs: extra?.idleTimeoutMs ?? 0,
    startTimeoutMs: extra?.startTimeoutMs ?? 5000,
    probeIntervalMs: 50,
  }, () => {})
  managers.push(manager)
  return manager
}

describe('freePort', () => {
  it('allocates a listening loopback port and releases it', async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
    // The port must be free again: binding it should succeed.
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { resolve() })
    })
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  })
})

describe('InstanceManager', () => {
  it('spawns one instance per user and reports readiness', async () => {
    const root = await tempDataRoot()
    await ensureUserDirs(root, 'alice')
    const manager = makeManager(root)
    const instance = await manager.ensure('alice')
    expect(instance.ready).toBe(true)
    expect(instance.port).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${String(instance.port)}/`)
    expect(response.ok).toBe(true)
    expect(await response.text()).toContain('fake dsh web')
    // Same user reuses the same instance.
    const again = await manager.ensure('alice')
    expect(again.port).toBe(instance.port)
    expect(manager.size()).toBe(1)
  })

  it('gives every user its own DSH_HOME', async () => {
    const root = await tempDataRoot()
    await ensureUserDirs(root, 'alice')
    await ensureUserDirs(root, 'bob')
    const manager = makeManager(root)
    const alice = await manager.ensure('alice')
    const bob = await manager.ensure('bob')
    expect(alice.port).not.toBe(bob.port)
    const aliceMe = await (await fetch(`http://127.0.0.1:${String(alice.port)}/api/me`)).json() as { home: string }
    const bobMe = await (await fetch(`http://127.0.0.1:${String(bob.port)}/api/me`)).json() as { home: string }
    expect(aliceMe.home).toBe(userHomeDir(root, 'alice'))
    expect(bobMe.home).toBe(userHomeDir(root, 'bob'))
    expect(aliceMe.home).not.toBe(bobMe.home)
  })

  it('recycles idle instances when the timeout elapses', async () => {
    const root = await tempDataRoot()
    await ensureUserDirs(root, 'alice')
    const manager = makeManager(root, { idleTimeoutMs: 100 })
    const instance = await manager.ensure('alice')
    expect(instance.ready).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(manager.size()).toBe(0)
  })

  it('fails fast when the dsh binary is missing', async () => {
    const root = await tempDataRoot()
    await ensureUserDirs(root, 'alice')
    const manager = new InstanceManager({
      dataRoot: root,
      dshBin: '/nonexistent/dsh',
      idleTimeoutMs: 0,
      startTimeoutMs: 2000,
      probeIntervalMs: 50,
    }, () => {})
    managers.push(manager)
    await expect(manager.ensure('alice')).rejects.toMatchObject({ code: 'spawn-failed' })
  })
})

describe('user workspace layout', () => {
  it('creates the per-user home and workspace directories', async () => {
    const root = await tempDataRoot()
    await ensureUserDirs(root, 'carol')
    const { stat } = await import('node:fs/promises')
    const home = await stat(userHomeDir(root, 'carol'))
    const workspace = await stat(userWorkspaceDir(root, 'carol'))
    expect(home.isDirectory()).toBe(true)
    expect(workspace.isDirectory()).toBe(true)
  })
})
