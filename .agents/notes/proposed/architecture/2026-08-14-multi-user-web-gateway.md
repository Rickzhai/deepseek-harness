# Multi-user Web gateway: architecture decision

Status: proposed · Date: 2026-08-14 · Author: agent

## Problem

`dsh web` is a single-tenant surface: one host process, no user concept, no
authentication, and every visitor shares one `$DSH_HOME` (sessions,
credentials, settings, workspaces). The `/api` trust fence is explicitly "not
an auth layer" — it only answers "is this request from a browser/host we
consider ours", never "who is this user". Multiple people sharing one `dsh web`
service would share conversations, credentials, and files.

The goal: several people safely share one service, each with their own login,
their own sessions, and no way to reach another user's data.

## Decision

Ship a standalone **gateway** (`@deepseek-ai/dsh-host-web-gateway`) as an edge
process in front of **one isolated `dsh web` instance per user**:

```
browser ──► gateway (login page + /auth/* + reverse proxy)
                 │ signed session cookie
                 ▼
        per-user `dsh web` on 127.0.0.1:<free port>
        DSH_HOME=<data-root>/users/<id>
```

- **Authentication**: local accounts (scrypt password hashing, constant-time
  compare, per-username+IP login throttling) and OIDC (authorization code +
  PKCE S256, discovery, token exchange, userinfo; auto-provision on first
  sign-in).
- **Sessions**: opaque 256-bit bearer tokens, HMAC-signed cookies
  (`HttpOnly; SameSite=Lax; Max-Age`, `Secure` when behind TLS), sliding TTL,
  persisted by token digest only so a leaked session file exposes no usable
  cookies.
- **Per-user instances**: spawned on first authenticated request, each with its
  own `$DSH_HOME` and default workspace as cwd; readiness-probed; idle-recycled
  after a timeout; respawned after crashes.
- **Reverse proxy**: HTTP + WebSocket upgrade forwarding with header
  sanitation — the child's browser-trust fence requires a loopback `Host` and
  no cross-site markers, so the gateway strips `Origin`/`Sec-Fetch-*`/`Cookie`
  and rewrites `Host` to `127.0.0.1:<port>`.

## Why per-user processes, not in-process multi-tenancy

The alternative — one `dsh web` process with per-user namespacing inside the
session/store/credential/workspace layers — was rejected because:

1. **Isolation is shallow even when namespacing succeeds.** The agent runs
   `bash` with this process's OS identity; a per-user namespace in the session
   store does not stop one user's agent from reading another user's files on
   the same host. The gateway gets true isolation "for free" because each user
   has a private `$DSH_HOME`, and can be hardened further by running each
   instance under a separate OS account or container later.
2. **The core is untouched.** Session persistence, the API proxy, credentials,
   settings, and the workspace registry are all process-global today; scoping
   them per user would touch every one of those packages and risk leaking data
   through an un-namespaced path. The gateway reuses the battle-tested
   single-user semantics unchanged.
3. **The project's own safety posture agrees.** `--host 0.0.0.0` is
   deliberately rejected for `dsh web` because it "would expose remote code
   execution to the network". Only the gateway binds to the network; every
   per-user instance stays on loopback.

## Trade-offs

- **Resource cost scales with active users** (one process each). Idle recycling
  bounds steady-state cost; a large deployment may want per-user OS accounts or
  containers (the gateway's spawn seam is the obvious hook).
- **File-level workspace enforcement is not yet implemented.** Workspace grants
  are directory grants recorded in the user store, surfaced through `/auth/me`;
  nothing stops a user's instance from reading another path on the same host.
- **OIDC state is in-memory**, so a gateway restart invalidates in-flight SSO
  attempts (completed sessions survive via the persisted session store).
- **No built-in TLS**; deploy behind a TLS-terminating reverse proxy or
  container ingress and set `--secure-cookies`.

## Team shared workspace mode (planned)

The user store already models per-user workspaces (`default` + `shared`
grants). The first release gives every user an isolated default workspace.
Shared team spaces build on the same record:

1. An admin creates a shared directory and grants it to members
   (`dsh-web-gateway user grant <user> <path>`).
2. The grant is surfaced through `/auth/me` and can back a workspace picker in
   the frontend, so a user can open a session whose cwd is the shared path.
3. For real enforcement, the per-user instance must restrict filesystem access
   to its granted paths — either a sandbox allow-list per instance or running
   each instance under its own OS account/container. That enforcement layer is
   the deferred work, and the gateway's spawn seam (`dshArgs`, per-user env) is
   where it lands.
