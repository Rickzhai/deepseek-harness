/**
 * Per-user dsh instance manager: spawns one isolated `dsh web` process per
 * user (each with its own `$DSH_HOME` under the gateway data root and its own
 * loopback port), probes readiness, recycles idle instances, and respawns
 * after crashes.
 * @module @deepseek-ai/dsh-host-web-gateway/src/instances
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { ensureUserDirs, userHomeDir, userWorkspaceDir } from './users.ts'

/** One managed per-user instance. */
export interface UserInstance {
  /** The user this instance serves. */
  userId: string
  /** Loopback port the instance listens on. */
  port: number
  /** The child process; `undefined` while starting or after a crash. */
  child: ChildProcess | undefined
  /** Whether the instance answered its readiness probe. */
  ready: boolean
  /** Last activity time (epoch ms), used for idle recycling. */
  lastActivity: number
  /** Promise resolving once the instance becomes ready; rejects on failure. */
  readyPromise: Promise<void> | undefined
}

/** Instance manager configuration. */
export interface InstanceManagerConfig {
  /** Gateway data root (per-user homes live under `users/<id>`). */
  dataRoot: string
  /** The `dsh` executable to spawn (path or bare command resolved on PATH). */
  dshBin: string
  /** Extra arguments appended to `web --host 127.0.0.1 --port <port>`. */
  dshArgs?: readonly string[]
  /** Idle timeout before recycling an instance; `0` disables recycling. */
  idleTimeoutMs: number
  /** How long to wait for the readiness probe before failing. */
  startTimeoutMs: number
  /** Readiness probe interval. */
  probeIntervalMs: number
}

/** Error with a stable code for HTTP mapping. */
export class InstanceError extends Error {
  constructor(
    readonly code: 'spawn-failed' | 'start-timeout' | 'port-conflict',
    message: string,
  ) {
    super(message)
    this.name = 'InstanceError'
  }
}

/** Allocate a free loopback TCP port by listening on :0 and releasing it. */
export async function freePort(): Promise<number> {
  const server: Server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  server.close()
  await once(server, 'close')
  if (port === undefined) throw new InstanceError('port-conflict', 'failed to allocate a loopback port')
  return port
}

/**
 * The per-user instance manager. Instances are spawned lazily on first use,
 * keyed by user id; `dispose()` stops every child.
 */
export class InstanceManager {
  private readonly instances = new Map<string, UserInstance>()
  private readonly log: (message: string) => void
  private disposed = false
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined

  /**
   * @param config - manager configuration.
   * @param log - log sink for lifecycle events (defaults to console).
   */
  constructor(
    private readonly config: InstanceManagerConfig,
    log?: (message: string) => void,
  ) {
    this.log = log ?? ((message) => { console.log(`web-gateway: ${message}`) })
    if (config.idleTimeoutMs > 0) {
      this.sweepTimer = setInterval(() => {  this.sweepIdle() }, Math.min(config.idleTimeoutMs, 60_000))
    }
  }

  /**
   * Resolve the ready loopback target for a user, spawning the instance on
   * first use. Concurrent callers share one startup promise.
   * @param userId - the user whose instance to ensure.
   * @returns the ready instance.
   */
  async ensure(userId: string): Promise<UserInstance> {
    const existing = this.instances.get(userId)
    if (existing !== undefined && existing.ready) {
      existing.lastActivity = Date.now()
      return existing
    }
    if (existing !== undefined && existing.readyPromise !== undefined) {
      await existing.readyPromise
      existing.lastActivity = Date.now()
      return existing
    }
    const instance: UserInstance = {
      userId,
      port: 0,
      child: undefined,
      ready: false,
      lastActivity: Date.now(),
      readyPromise: undefined,
    }
    this.instances.set(userId, instance)
    instance.readyPromise = this.start(userId, instance)
    try {
      await instance.readyPromise
    } catch (error) {
      this.instances.delete(userId)
      throw error
    }
    instance.lastActivity = Date.now()
    return instance
  }

  /** Stop the instance for a user, if any. */
  stop(userId: string): void {
    const instance = this.instances.get(userId)
    if (instance === undefined) return
    this.instances.delete(userId)
    if (instance.child !== undefined && !instance.child.killed) {
      instance.child.kill('SIGTERM')
    }
  }

  /** Stop every managed instance. */
  async dispose(): Promise<void> {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.disposed = true
    const children = [...this.instances.values()]
      .map(instance => instance.child)
      .filter((child): child is ChildProcess => child !== undefined)
    this.instances.clear()
    await Promise.all(children.map(child => new Promise<void>((resolve) => {
      if (child.killed) {
        resolve()
        return
      }
      child.once('exit', () => { resolve() })
      child.kill('SIGTERM')
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 5000).unref()
    })))
  }

  /** Live instance count. */
  size(): number {
    return this.instances.size
  }

  /** Spawn the instance and probe until ready or the start timeout elapses. */
  private async start(userId: string, instance: UserInstance): Promise<void> {
    const port = await freePort()
    instance.port = port
    await ensureUserDirs(this.config.dataRoot, userId)
    const home = userHomeDir(this.config.dataRoot, userId)
    const cwd = userWorkspaceDir(this.config.dataRoot, userId)
    this.log(`starting instance for ${userId} on 127.0.0.1:${port} (DSH_HOME=${home})`)
    const child = spawn(this.config.dshBin, [
      'web',
      '--host', '127.0.0.1',
      '--port', String(port),
      ...this.config.dshArgs ?? [],
    ], {
      cwd,
      env: {
        ...process.env,
        DSH_HOME: home,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    instance.child = child
    child.on('error', (error) => {
      this.log(`instance for ${userId} failed to spawn: ${error.message}`)
      this.stop(userId)
    })
    child.on('exit', (code, signal) => {
      this.log(`instance for ${userId} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      if (!this.disposed) this.stop(userId)
    })

    const deadline = Date.now() + this.config.startTimeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new InstanceError('spawn-failed', `dsh web for ${userId} exited early with code ${String(child.exitCode)}`)
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(this.config.probeIntervalMs) })
        if (response.ok && await probeWebSocketReady(port)) {
          instance.ready = true
          this.log(`instance for ${userId} ready on 127.0.0.1:${port}`)
          return
        }
      } catch {
        // Not ready yet; keep probing.
      }
      await sleep(this.config.probeIntervalMs)
    }
    this.stop(userId)
    throw new InstanceError('start-timeout', `dsh web for ${userId} did not become ready within ${String(this.config.startTimeoutMs)}ms`)
  }

  /** Recycle instances idle for longer than the configured timeout. */
  private sweepIdle(): void {
    if (this.config.idleTimeoutMs <= 0) return
    const now = Date.now()
    for (const [userId, instance] of this.instances) {
      if (instance.ready && now - instance.lastActivity > this.config.idleTimeoutMs) {
        this.log(`recycling idle instance for ${userId}`)
        this.stop(userId)
      }
    }
  }
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Probe whether the child's WebSocket downlink route (`/api/events.mux`) is
 * mounted yet, by sending a raw WebSocket handshake and checking for a 101.
 * The HTTP `/` probe returns 200 before the client-connection plugin has
 * registered its upgrade routes; a browser handshake racing that window gets
 * ECONNRESET and backs off, which surfaced as a ~30s login/refresh stall.
 * Requiring a real 101 here closes that race before the instance is marked
 * ready.
 * @param port - the child's loopback port.
 * @returns whether the child answered a WebSocket 101.
 */
function probeWebSocketReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      client.destroy()
      resolve(ok)
    }
    const client: Socket = connect(port, '127.0.0.1')
    const key = randomBytes(16).toString('base64')
    const request = [
      'GET /api/events.mux HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n')
    let buf = ''
    client.on('connect', () => { client.write(request) })
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      if (buf.includes('\r\n\r\n')) finish(buf.startsWith('HTTP/1.1 101'))
    })
    client.on('error', () => { finish(false) })
    client.on('close', () => { finish(false) })
    setTimeout(() => { finish(false) }, 1000)
  })
}
