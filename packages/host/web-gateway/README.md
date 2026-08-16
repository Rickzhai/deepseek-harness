# `@deepseek-ai/dsh-host-web-gateway`

English | [中文](README.zh.md)

Multi-user gateway for the DeepSeek Harness Web GUI: one service, many isolated users. The gateway is a standalone edge process (plain `node:http` — no cordis tree, no Loader) that serves a login page, authenticates users, and proxies every authenticated request to that user's own private `dsh web` instance. Each instance runs with its own `$DSH_HOME` under the gateway data root, so sessions, credentials, settings, and the default workspace are isolated per user by construction.

## How it works

```
browser ──► gateway (login page + /auth/* + reverse proxy)
                 │  cookie session
                 ▼
        per-user `dsh web` on 127.0.0.1:<port>
        DSH_HOME=<data-root>/users/<id>
```

- **Local accounts** — passwords are stored as scrypt hashes (`scrypt$N$r$p$salt$hash`), verified with a constant-time compare; the login endpoint is throttled per username+IP.
- **OIDC/SSO** — authorization-code flow with PKCE (S256), discovery, token exchange, and userinfo; a successful sign-in auto-provisions a gateway user by default, or links to an existing account.
- **Session cookies** — opaque 256-bit bearer tokens, HMAC-signed, `HttpOnly`/`SameSite=Lax`, sliding TTL (default **1 hour** of inactivity, configurable via `--session-ttl-ms`); only token digests are persisted, so a leaked session file does not expose usable cookies.
- **Per-user instances** — `InstanceManager` spawns `dsh web --host 127.0.0.1 --port <free>` with `DSH_HOME=<data-root>/users/<id>` and the user's default workspace as cwd, probes readiness, recycles idle instances after a configurable timeout, and respawns after crashes. Signing out tears the instance down immediately.
- **Reverse proxy** — HTTP and WebSocket upgrade forwarding with header sanitation: the child's browser-trust fence requires a loopback `Host` and no cross-site markers, so the gateway strips `Origin`/`Sec-Fetch-*`/`Cookie` and rewrites `Host` to `127.0.0.1:<port>`. The proxied SPA's `index.html` gains a small self-contained avatar/username/sign-out menu in the top-right corner (driven by `/auth/me` and `/auth/logout`).

## CLI

The package ships a `dsh-web-gateway` bin, plus a one-shot lifecycle launcher
for a local checkout:

```sh
# Start the gateway as a background service on 127.0.0.1:3088
# (defaults: GATEWAY_PORT / GATEWAY_DATA_ROOT / GATEWAY_HOST).
./docker/web-gateway/start-gateway.sh

# Lifecycle verbs:
./docker/web-gateway/start-gateway.sh foreground           # run in the foreground
./docker/web-gateway/start-gateway.sh status               # show running state + users
./docker/web-gateway/start-gateway.sh logs                 # follow the gateway log
./docker/web-gateway/start-gateway.sh stop                 # stop the gateway
./docker/web-gateway/start-gateway.sh restart              # stop then start

# Create and manage users against the same data root.
./docker/web-gateway/start-gateway.sh user add alice --admin --password 'pw'
./docker/web-gateway/start-gateway.sh user list
```

The raw `dsh-web-gateway` bin (no wrapper) works identically:

```sh
# Serve the gateway (login page + proxy). First user created via `user add` becomes admin.
dsh-web-gateway serve --host 0.0.0.0 --port 8080 --data-root /srv/gateway --dsh-bin dsh

# Manage users (runs against the same data root).
dsh-web-gateway user add alice --admin
dsh-web-gateway user passwd alice
dsh-web-gateway user rm alice
dsh-web-gateway user list
dsh-web-gateway user grant alice /srv/team-shared
dsh-web-gateway user revoke alice /srv/team-shared
dsh-web-gateway user set-default-workspace alice /srv/alice
```

OIDC is configured through `serve` flags (`--oidc-issuer --oidc-client-id --oidc-client-secret --oidc-redirect-uri --oidc-extra-scopes`, plus `--no-oidc-auto-provision`). The server secret is persisted at `<data-root>/secret` (or `GATEWAY_SECRET`); set a stable one so cookies survive restarts.

## Workspaces

Each user has a default workspace at `<data-root>/users/<id>/workspace` (created automatically and used as the spawned instance's cwd). Shared team workspaces are directories granted per user through `user grant`/`user revoke`; the grants are surfaced through `/auth/me` and can back a workspace picker. File-level enforcement of shared-space access is out of scope for the gateway itself (see Known Limitations).

## Extension points

- `createGatewayServer(config)` — build the gateway in-process; returns `{ server, listen, close, port, users, instances }`.
- `UserStore`, `SessionStore`, `InstanceManager`, `discoverOidc`, `proxyHttp`/`proxyUpgrade` — reusable pieces for custom deployments (e.g. mounting the gateway into an existing server).

## Model Experience

None, as the gateway authenticates browser users and proxies requests to per-user dsh web instances; the child instances own every model-facing effect.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, and per-user instances are independent processes with their own request streams.

## Known Limitations and Deferred Work

- **File-level workspace enforcement is not implemented** — grants are directory grants recorded in the user store, but nothing stops a user's instance from reading another path on the same host. True enforcement needs per-user OS accounts/containers or a filesystem sandbox layer.
- **Instance resources scale with users** — one `dsh web` process per active user. Idle recycling bounds the steady-state cost, but a deployment with many concurrent users needs a sufficiently sized host.
- **No built-in TLS** — serve behind a TLS-terminating reverse proxy (or a container ingress) and set `--secure-cookies` so session cookies carry `Secure`.
- **OIDC state is held in memory** — a gateway restart invalidates in-flight SSO attempts (completed sessions survive via the persisted session store).
- **JWT signature verification is delegated to the provider** — the token exchange trusts the provider's token/userinfo endpoints over HTTPS; `id_token` verification is not performed (PKCE + HTTPS + signed state are the active protections).
