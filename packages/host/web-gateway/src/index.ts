/**
 * @deepseek-ai/dsh-host-web-gateway — multi-user gateway for the DeepSeek
 * Harness Web GUI. The gateway is a standalone edge process (plain node:http,
 * no cordis tree): it serves a login page, authenticates local accounts
 * (scrypt) or OIDC providers (authorization-code + PKCE), issues signed
 * session cookies, and proxies every authenticated request to that user's own
 * isolated `dsh web` instance — each with its own `$DSH_HOME`, session
 * store, credentials, settings, and workspace under the gateway data root.
 * @module @deepseek-ai/dsh-host-web-gateway
 */

export { createGatewayServer } from './server.ts'
export type { GatewayServer, GatewayServerConfig } from './server.ts'
export { publicUser, readCookie, setSessionCookie } from './server.ts'
export { UserStore, hashPassword, verifyPassword, userHomeDir, userWorkspaceDir, ensureUserDirs } from './users.ts'
export type { GatewayUser, UserStoreFile } from './users.ts'
export { SessionStore, SESSION_COOKIE, defaultGatewaySecret } from './sessions.ts'
export type { GatewaySession } from './sessions.ts'
export { InstanceManager, freePort, sleep } from './instances.ts'
export type { InstanceManagerConfig, UserInstance } from './instances.ts'
export { InstanceError } from './instances.ts'
export { discoverOidc, newPendingOidcAuth, pendingOidcAuthExpired, pkceChallenge, signOidcState, usernameFromOidc } from './oidc.ts'
export type { OidcClient, OidcProviderConfig, OidcUserinfo, PendingOidcAuth } from './oidc.ts'
export { OidcError } from './oidc.ts'
export { proxyHttp, proxyUpgrade } from './proxy.ts'
export { LOGIN_PAGE_HTML } from './login-page.ts'
