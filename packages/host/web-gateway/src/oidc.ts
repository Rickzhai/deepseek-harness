/**
 * OIDC authorization-code client for the gateway: discovery, PKCE (S256),
 * token exchange, and userinfo resolution. Uses the global fetch; no external
 * dependencies.
 * @module @deepseek-ai/dsh-host-web-gateway/src/oidc
 */

import { createHash, randomBytes, createHmac } from 'node:crypto'

/** OIDC provider configuration the gateway needs at runtime. */
export interface OidcProviderConfig {
  /** OIDC issuer URL (e.g. `https://accounts.google.com`). */
  issuer: string
  /** Registered client id. */
  clientId: string
  /** Registered client secret; optional when the provider allows PKCE-only. */
  clientSecret?: string
  /** Redirect URI the IdP sends the authorization code to. */
  redirectUri: string
  /** Extra scopes beyond `openid profile email`; space-separated string. */
  extraScopes?: string
}

/** Resolved provider endpoints from discovery. */
interface OidcDiscovery {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  [key: string]: unknown
}

/** A pending authorization attempt held between /auth/oidc/start and callback. */
export interface PendingOidcAuth {
  state: string
  codeVerifier: string
  createdAt: number
}

/** Userinfo claims the gateway consumes. */
export interface OidcUserinfo {
  sub: string
  email?: string
  email_verified?: boolean
  preferred_username?: string
  name?: string
}

/** The discovered provider plus the validated config. */
export interface OidcClient {
  /** Resolved discovery document. */
  discovery: OidcDiscovery
  /** The validated config this client was built from. */
  config: OidcProviderConfig
  /** Build the authorization URL (PKCE challenge embedded) for a new attempt. */
  authorizeUrl(pending: PendingOidcAuth): string
  /** Exchange an authorization code for an access token. */
  exchangeCode(code: string, pending: PendingOidcAuth): Promise<{ accessToken: string }>
  /** Fetch the userinfo document for an access token. */
  userinfo(accessToken: string): Promise<OidcUserinfo>
}

/** Error carrying a stable `code` for the HTTP surface. */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OidcError'
  }
}

/**
 * Run OIDC discovery against an issuer and build the client.
 * @param config - validated provider config.
 * @param signal - optional abort signal for the discovery fetch.
 * @returns a ready client.
 */
export async function discoverOidc(config: OidcProviderConfig, signal?: AbortSignal): Promise<OidcClient> {
  const wellKnown = `${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  let response: Response
  try {
    response = await fetch(wellKnown, ...(signal === undefined ? [] : [{ signal }] as const))
  } catch (error) {
    throw new OidcError('discovery-failed', `OIDC discovery failed for ${config.issuer}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new OidcError('discovery-failed', `OIDC discovery for ${config.issuer} answered HTTP ${response.status}`)
  }
  const discovery = await response.json() as Partial<OidcDiscovery>
  const authorizationEndpoint = discovery.authorization_endpoint
  const tokenEndpoint = discovery.token_endpoint
  const userinfoEndpoint = discovery.userinfo_endpoint
  for (const [name, value] of [['authorization_endpoint', authorizationEndpoint], ['token_endpoint', tokenEndpoint], ['userinfo_endpoint', userinfoEndpoint]] as const) {
    if (typeof value !== 'string' || value === '') {
      throw new OidcError('discovery-invalid', `OIDC discovery for ${config.issuer} is missing ${name}`)
    }
  }
  // The loop above narrows each endpoint to a non-empty string; the closure
  // below needs the narrowed values re-extracted (control-flow narrowing does
  // not flow into the returned object literal's methods).
  const endpoints = {
    authorization_endpoint: authorizationEndpoint as string,
    token_endpoint: tokenEndpoint as string,
    userinfo_endpoint: userinfoEndpoint as string,
  }
  return {
    discovery: { ...discovery, ...endpoints },
    config,
    authorizeUrl(pending) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: ['openid', 'profile', 'email', config.extraScopes ?? ''].filter(Boolean).join(' '),
        state: pending.state,
        code_challenge: pkceChallenge(pending.codeVerifier),
        code_challenge_method: 'S256',
      })
      return `${endpoints.authorization_endpoint}${endpoints.authorization_endpoint.includes('?') ? '&' : '?'}${params.toString()}`
    },
    async exchangeCode(code, pending) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: pending.codeVerifier,
      })
      if (config.clientSecret !== undefined) body.set('client_secret', config.clientSecret)
      let response: Response
      try {
        response = await fetch(endpoints.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        })
      } catch (error) {
        throw new OidcError('token-failed', `OIDC token exchange failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        throw new OidcError('token-failed', `OIDC token exchange answered HTTP ${response.status}`)
      }
      const json = await response.json() as { access_token?: unknown }
      if (typeof json.access_token !== 'string') {
        throw new OidcError('token-invalid', 'OIDC token exchange returned no access token')
      }
      return { accessToken: json.access_token }
    },
    async userinfo(accessToken) {
      let response: Response
      try {
        response = await fetch(endpoints.userinfo_endpoint, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      } catch (error) {
        throw new OidcError('userinfo-failed', `OIDC userinfo failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        throw new OidcError('userinfo-failed', `OIDC userinfo answered HTTP ${response.status}`)
      }
      const info = await response.json() as Partial<OidcUserinfo>
      if (typeof info.sub !== 'string' || info.sub === '') {
        throw new OidcError('userinfo-invalid', 'OIDC userinfo returned no sub claim')
      }
      return info as OidcUserinfo
    },
  }
}

/** Create a new pending authorization attempt with a fresh state + PKCE pair. */
export function newPendingOidcAuth(): PendingOidcAuth {
  return {
    state: randomBytes(16).toString('base64url'),
    codeVerifier: randomBytes(32).toString('base64url'),
    createdAt: Date.now(),
  }
}

/** Whether a pending attempt is still within its TTL. */
export function pendingOidcAuthExpired(pending: PendingOidcAuth, ttlMs = 1000 * 60 * 10): boolean {
  return Date.now() - pending.createdAt > ttlMs
}

/** S256 PKCE challenge of a code verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Derive a gateway username from OIDC userinfo: preferred_username, else the
 * local part of the email, else a `user-<sub-prefix>` fallback. Usernames are
 * sanitized to the gateway's allowed charset (letters, digits, `._-`).
 */
export function usernameFromOidc(info: OidcUserinfo): string {
  const candidate = info.preferred_username
    ?? (info.email !== undefined ? info.email.split('@')[0] : undefined)
    ?? `user-${info.sub.slice(0, 12)}`
  const sanitized = candidate.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return sanitized === '' ? `user-${info.sub.slice(0, 12)}` : sanitized
}

/** HMAC of a value under the server secret (used for OIDC state signing). */
export function signOidcState(secret: string, state: string): string {
  return createHmac('sha256', secret).update(state).digest('base64url')
}
