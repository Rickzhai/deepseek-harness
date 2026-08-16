#!/usr/bin/env node
/**
 * dsh-web-gateway — the multi-user gateway CLI.
 *
 * `serve` boots the gateway (login page + per-user dsh web instances behind
 * the reverse proxy); `user` manages gateway accounts (add/remove/passwd/
 * list, workspace grants) against the same data root.
 * @module @deepseek-ai/dsh-host-web-gateway/bin
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Command } from 'commander'
import { createGatewayServer, type GatewayServerConfig } from './server.ts'
import { UserStore, userHomeDir, userWorkspaceDir } from './users.ts'
import { defaultGatewaySecret } from './sessions.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const DEFAULT_DATA_ROOT = join(resolveDshHome(), 'gateway')
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 // 1 hour (sliding)
const DEFAULT_IDLE_TIMEOUT_MS = 1000 * 60 * 30
const DEFAULT_START_TIMEOUT_MS = 60_000
const DEFAULT_LOGIN_MAX_FAILURES = 5
const DEFAULT_LOGIN_WINDOW_MS = 1000 * 60 * 5

/** Serve-command options after commander defaulting. */
interface ServeOptions {
  host: string
  port: number
  dataRoot: string
  secureCookies: boolean
  sessionTtlMs: number
  dshBin: string
  dshArg?: string[]
  idleTimeoutMs: number
  startTimeoutMs: number
  oidcIssuer?: string
  oidcClientId?: string
  oidcClientSecret?: string
  oidcRedirectUri?: string
  oidcExtraScopes?: string
  oidcAutoProvision: boolean
  loginMaxFailures: number
  loginWindowMs: number
}

/** User-command options (the `--data-root` lives on the parent command). */
interface UserOptions {
  dataRoot?: string
  password?: string
  admin?: boolean
  defaultWorkspace?: string
  sharedWorkspace?: string[]
}

/** Read the gateway data root from resolved options. */
function dataRootOf(options: { dataRoot?: string | undefined }): string {
  return options.dataRoot ?? DEFAULT_DATA_ROOT
}

/** Load the user store from the data root (creating it when absent). */
async function openUserStore(dataRoot: string): Promise<UserStore> {
  const store = new UserStore(dataRoot)
  await store.load()
  return store
}

/** Read the persisted server secret, creating a fresh one on first run. */
async function loadOrCreateSecret(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true })
  const file = join(dataRoot, 'secret')
  try {
    const secret = (await readFile(file, 'utf8')).trim()
    if (secret !== '') return secret
  } catch {
    // Fall through to creation.
  }
  const fromEnv = process.env.GATEWAY_SECRET?.trim()
  const secret = fromEnv !== undefined && fromEnv !== '' ? fromEnv : defaultGatewaySecret()
  await writeFile(file, secret, { mode: 0o600 })
  return secret
}

/** Apply OIDC environment-variable fallbacks to serve options (Docker style). */
function applyOidcEnv(options: ServeOptions): ServeOptions {
  const issuer = options.oidcIssuer ?? process.env.OIDC_ISSUER
  const clientId = options.oidcClientId ?? process.env.OIDC_CLIENT_ID
  const clientSecret = options.oidcClientSecret ?? process.env.OIDC_CLIENT_SECRET
  const redirectUri = options.oidcRedirectUri ?? process.env.OIDC_REDIRECT_URI
  const extraScopes = options.oidcExtraScopes ?? process.env.OIDC_EXTRA_SCOPES
  const autoProvision = options.oidcAutoProvision
    && (process.env.OIDC_AUTO_PROVISION ?? 'true') !== 'false'
  return {
    ...options,
    ...(issuer !== undefined && issuer !== '' ? { oidcIssuer: issuer } : {}),
    ...(clientId !== undefined && clientId !== '' ? { oidcClientId: clientId } : {}),
    ...(clientSecret !== undefined && clientSecret !== '' ? { oidcClientSecret: clientSecret } : {}),
    ...(redirectUri !== undefined && redirectUri !== '' ? { oidcRedirectUri: redirectUri } : {}),
    ...(extraScopes !== undefined && extraScopes !== '' ? { oidcExtraScopes: extraScopes } : {}),
    oidcAutoProvision: autoProvision,
  }
}

/** Build the gateway config from serve options. */
function gatewayConfigFrom(options: ServeOptions, secret: string): GatewayServerConfig {
  return {
    dataRoot: options.dataRoot,
    secret,
    host: options.host,
    port: options.port,
    secureCookies: options.secureCookies,
    sessionTtlMs: options.sessionTtlMs,
    dshBin: options.dshBin,
    ...(options.dshArg !== undefined ? { dshArgs: options.dshArg } : {}),
    idleTimeoutMs: options.idleTimeoutMs,
    startTimeoutMs: options.startTimeoutMs,
    loginMaxFailures: options.loginMaxFailures,
    loginWindowMs: options.loginWindowMs,
    ...(options.oidcIssuer !== undefined && options.oidcClientId !== undefined && options.oidcRedirectUri !== undefined ? {
      oidc: {
        issuer: options.oidcIssuer,
        clientId: options.oidcClientId,
        ...(options.oidcClientSecret !== undefined ? { clientSecret: options.oidcClientSecret } : {}),
        redirectUri: options.oidcRedirectUri,
        ...(options.oidcExtraScopes !== undefined ? { extraScopes: options.oidcExtraScopes } : {}),
      },
    } : {}),
    ...(!options.oidcAutoProvision ? { oidcAutoProvision: false } : {}),
  }
}

const program = new Command()
  .name('dsh-web-gateway')
  .description('Multi-user gateway for the DeepSeek Harness Web GUI')
  .helpOption('-h, --help', 'show help')
  .showHelpAfterError()

// ── serve ────────────────────────────────────────────────────────────────────

program.command('serve')
  .description('Start the gateway: login page, /auth/* routes, and per-user dsh web instances')
  .option('--host <host>', 'listen host', '127.0.0.1')
  .option('--port <port>', 'listen port', value => Number(value), 3088)
  .option('--data-root <dir>', 'gateway data root', DEFAULT_DATA_ROOT)
  .option('--secure-cookies', 'set the Secure attribute on session cookies (behind TLS)')
  .option('--session-ttl-ms <ms>', 'session lifetime in ms (default 1 hour, sliding)', value => Number(value), DEFAULT_SESSION_TTL_MS)
  .option('--dsh-bin <path>', 'dsh executable for per-user instances', 'dsh')
  .option('--dsh-arg <arg...>', 'extra argument for each dsh web instance (repeatable)')
  .option('--idle-timeout-ms <ms>', 'recycle idle instances after this many ms (0 disables)', value => Number(value), DEFAULT_IDLE_TIMEOUT_MS)
  .option('--start-timeout-ms <ms>', 'per-instance start timeout in ms', value => Number(value), DEFAULT_START_TIMEOUT_MS)
  .option('--oidc-issuer <url>', 'OIDC issuer URL (enables SSO login)')
  .option('--oidc-client-id <id>', 'OIDC client id')
  .option('--oidc-client-secret <secret>', 'OIDC client secret')
  .option('--oidc-redirect-uri <url>', 'OIDC redirect URI (must match the IdP registration)')
  .option('--oidc-extra-scopes <scopes>', 'extra OIDC scopes beyond openid profile email')
  .option('--no-oidc-auto-provision', 'do not auto-create gateway users from OIDC sign-ins')
  .option('--login-max-failures <n>', 'login throttle: max failures per window', value => Number(value), DEFAULT_LOGIN_MAX_FAILURES)
  .option('--login-window-ms <ms>', 'login throttle window', value => Number(value), DEFAULT_LOGIN_WINDOW_MS)
  .action(async (options: ServeOptions) => {
    const secret = await loadOrCreateSecret(options.dataRoot)
    const effective = applyOidcEnv(options)
    const gateway = createGatewayServer(gatewayConfigFrom(effective, secret))
    await gateway.listen()
    console.log(`dsh-web-gateway: listening on http://${options.host}:${String(gateway.port)}`)
    console.log(`dsh-web-gateway: data root ${options.dataRoot}`)
    const shutdown = async (): Promise<void> => {
      await gateway.close()
      process.exit(0)
    }
    process.on('SIGINT', () => { void shutdown() })
    process.on('SIGTERM', () => { void shutdown() })
  })

// ── user ─────────────────────────────────────────────────────────────────────

const user = program.command('user')
  .description('Manage gateway users')
  .option('--data-root <dir>', 'gateway data root', DEFAULT_DATA_ROOT)

user.command('add')
  .description('Add a user (first user becomes admin)')
  .argument('<username>', 'login name')
  .option('--password <password>', 'password (omit to read from stdin)')
  .option('--admin', 'grant the admin role')
  .option('--default-workspace <path>', 'default workspace directory (defaults to <data-root>/users/<id>/workspace)')
  .option('--shared-workspace <path...>', 'grant a shared workspace path (repeatable)')
  .action(async (username: string, options: UserOptions, command: Command) => {
    const dataRoot = dataRootOf(command.parent?.opts<UserOptions>() ?? {})
    const store = await openUserStore(dataRoot)
    const password = options.password ?? await readPasswordStdin()
    if (store.byUsername(username) !== undefined) {
      console.error(`dsh-web-gateway: user '${username}' already exists`)
      process.exit(1)
    }
    const created = store.create({
      username,
      password,
      roles: [options.admin === true || store.list().length === 0 ? 'admin' : 'member'],
      defaultWorkspace: options.defaultWorkspace ?? userWorkspaceDir(dataRoot, username),
      ...(options.sharedWorkspace !== undefined ? { sharedWorkspaces: options.sharedWorkspace } : {}),
    })
    await ensureUserDirs(store, dataRoot, created.id)
    await store.save()
    console.log(`created user '${created.username}' (${created.roles.includes('admin') ? 'admin' : 'member'})`)
  })

user.command('passwd')
  .description('Set a user\'s password')
  .argument('<username>', 'login name')
  .option('--password <password>', 'password (omit to read from stdin)')
  .action(async (username: string, options: UserOptions, command: Command) => {
    const dataRoot = dataRootOf(command.parent?.opts<UserOptions>() ?? {})
    const store = await openUserStore(dataRoot)
    const target = store.byUsername(username)
    if (target === undefined) {
      console.error(`dsh-web-gateway: no such user '${username}'`)
      process.exit(1)
    }
    const password = options.password ?? await readPasswordStdin()
    store.setPassword(target.id, password)
    await store.save()
    console.log(`updated password for '${target.username}'`)
  })

user.command('rm')
  .description('Remove a user')
  .argument('<username>', 'login name')
  .action(async (username: string, _options: UserOptions, command: Command) => {
    const dataRoot = dataRootOf(command.parent?.opts<UserOptions>() ?? {})
    const store = await openUserStore(dataRoot)
    const target = store.byUsername(username)
    if (target === undefined) {
      console.error(`dsh-web-gateway: no such user '${username}'`)
      process.exit(1)
    }
    store.remove(target.id)
    await store.save()
    console.log(`removed user '${username}'`)
  })

user.command('list')
  .description('List users')
  .action(async (_options: UserOptions, command: Command) => {
    const dataRoot = dataRootOf(command.parent?.opts<UserOptions>() ?? {})
    const store = await openUserStore(dataRoot)
    for (const entry of store.list()) {
      const oidc = entry.oidc !== null ? `oidc:${entry.oidc.issuer}/${entry.oidc.sub}` : 'password'
      console.log([entry.username, entry.roles.join(','), oidc, entry.workspaces.default].join('\t'))
    }
  })

user.command('grant')
  .description('Grant a shared workspace path to a user')
  .argument('<username>', 'login name')
  .argument('<path>', 'absolute workspace path')
  .action(async (username: string, path: string, _options: UserOptions, command: Command) => {
    const dataRoot = dataRootOf(command.parent?.opts<UserOptions>() ?? {})
    const store = await openUserStore(dataRoot)
    const target = store.byUsername(username)
    if (target === undefined) {
      console.error(`dsh-web-gateway: no such user '${username}'`)
      process.exit(1)
    }
    store.grantSharedWorkspace(target.id, path)
    await store.save()
    console.log(`granted shared workspace '${path}' to '${target.username}'`)
  })

user.command('revoke')
  .description('Revoke a shared workspace path from a user')
  .argument('<username>', 'login name')
  .argument('<path>', 'absolute workspace path')
  .action(async (username: string, path: string, _options: UserOptions, command: Command) => {
    const dataRoot = dataRootOf(command.parent?.opts<UserOptions>() ?? {})
    const store = await openUserStore(dataRoot)
    const target = store.byUsername(username)
    if (target === undefined) {
      console.error(`dsh-web-gateway: no such user '${username}'`)
      process.exit(1)
    }
    store.revokeSharedWorkspace(target.id, path)
    await store.save()
    console.log(`revoked shared workspace '${path}' from '${target.username}'`)
  })

user.command('set-default-workspace')
  .description('Set a user\'s default workspace directory')
  .argument('<username>', 'login name')
  .argument('<path>', 'absolute workspace path')
  .action(async (username: string, path: string, _options: UserOptions, command: Command) => {
    const dataRoot = dataRootOf(command.parent?.opts<UserOptions>() ?? {})
    const store = await openUserStore(dataRoot)
    const target = store.byUsername(username)
    if (target === undefined) {
      console.error(`dsh-web-gateway: no such user '${username}'`)
      process.exit(1)
    }
    store.setDefaultWorkspace(target.id, path)
    await store.save()
    console.log(`set default workspace of '${target.username}' to '${path}'`)
  })

/** Create the per-user home/workspace dirs and record the default path. */
async function ensureUserDirs(store: UserStore, dataRoot: string, userId: string): Promise<void> {
  await mkdir(userHomeDir(dataRoot, userId), { recursive: true })
  await mkdir(userWorkspaceDir(dataRoot, userId), { recursive: true })
  const target = store.byId(userId)
  if (target !== undefined && target.workspaces.default === '') {
    store.setDefaultWorkspace(userId, userWorkspaceDir(dataRoot, userId))
  }
}

/** Read one line (a password) from stdin without echo. */
async function readPasswordStdin(): Promise<string> {
  const { createInterface } = await import('node:readline')
  const { stdin, stdout } = await import('node:process')
  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  return new Promise<string>((resolve) => {
    stdout.write('Password: ')
    rl.question('', (answer) => {
      rl.close()
      stdout.write('\n')
      resolve(answer)
    })
  })
}

await program.parseAsync(process.argv)
