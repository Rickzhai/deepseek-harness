# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## This fork: multi-user gateway

This fork keeps the full upstream DeepSeek Harness and adds one opt-in,
self-contained capability: a **multi-user gateway** that lets several people
safely share a single Web service.

- **Per-user accounts and sign-in** — local accounts (scrypt password hashing,
  login throttling) and OIDC SSO (authorization code + PKCE), with signed
  HttpOnly session cookies.
- **Isolation by construction** — each authenticated user gets their own
  `dsh web` instance with a private `$DSH_HOME` (sessions, credentials,
  settings, and a default workspace), spawned behind the gateway and reached
  through an HTTP + WebSocket reverse proxy.
- **User management CLI** — `dsh-web-gateway user add/passwd/rm/list` plus
  workspace grants (`grant`/`revoke`), with no gateway restart required.
- **Docker deployment** — a ready `Dockerfile` and `docker-compose.yml` under
  [`docker/web-gateway/`](docker/web-gateway/).

The gateway lives in [`packages/host/web-gateway`](packages/host/web-gateway/README.md);
see its README for usage.

### Upstream compatibility

No upstream core package is modified — the gateway is entirely new files plus
four registration-only one-line edits (`tsconfig.host.json`, `knip.json`,
`scripts/verify-package-readme-model-experience.ts`, `pnpm-lock.yaml`). The
original `dsh` CLI, Web UI, and all upstream behavior are preserved
unchanged, and the gateway is opt-in: skip it and this checkout behaves
exactly like upstream.

Upstream releases merge in cleanly by rebasing the `multi-user-web-gateway`
branch onto `upstream/master`. The full procedure, including what to re-verify
after each upgrade, is in [`docker/web-gateway/UPGRADING.md`](docker/web-gateway/UPGRADING.md).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
