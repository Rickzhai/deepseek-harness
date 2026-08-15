# Upgrading the upstream DeepSeek Harness

This document is for a deployment that runs the multi-user gateway
(`@deepseek-ai/dsh-host-web-gateway`) as a **local addition on top of an
upstream `deepseek-harness` checkout** — the common case for the team-shared
service described in the gateway's architecture note. It records how to pull
new upstream releases without losing the gateway, and what to re-verify after
every upgrade.

## What the gateway touches

The gateway is almost entirely **new files**. The only edits to upstream files
are four registration-only additions (no existing logic is changed):

| File | Change |
|---|---|
| `tsconfig.host.json` | +1 line: adds the package to the Host aggregate project references |
| `knip.json` | +10 lines: registers the package's `src/bin.ts` and tests for dead-code analysis |
| `scripts/verify-package-readme-model-experience.ts` | +1 line: allowlists the package's Model Experience classification |
| `pnpm-lock.yaml` | +19 lines: the new workspace importer's dependency declarations (no deletions, no unrelated version drift) |

Everything else — `packages/host/web-gateway/`, `docker/web-gateway/`,
`.dockerignore`, and the architecture note under `.agents/notes/` — is new.
No core package (`webserver`, `connection`, `session`, `apiproxy`,
`settings`, `credentials`, the Web frontend) is modified, so an upstream
upgrade cannot regress the gateway through a shared-code change.

## Two upgrade workflows

### A. Local-only usage (no published fork)

Keep the gateway in a feature branch and rebase onto each new upstream release:

```sh
git checkout multi-user-web-gateway
git fetch origin
git rebase origin/master
```

Conflicts, when they occur, are confined to the four registration files above
and are nearly always "one line added at the same spot" merges. The gateway
package directory and `docker/web-gateway/` are entirely new, so upstream can
only collide with them if it adds the same paths (it has not, as of rc.5).

After a successful rebase, reinstall and re-verify:

```sh
pnpm install
pnpm exec tsc -b packages/host/web-gateway
pnpm exec oxlint packages/host/web-gateway
pnpm exec vitest run --config vitest.config.ts packages/host/web-gateway
```

If the upstream changed `workspace:*` peer APIs the gateway consumes
(`@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-invariants`,
`@deepseek-ai/cordis`), the typecheck above is the tripwire. The gateway uses
only their stable entry points (`resolveDshHome`, `invariants.register`, and
the `Context` type), which have not changed since the gateway was written.

### B. Long-term maintenance / upstream contribution

Commit the gateway on a branch and keep history linear, so it is ready to
open as a pull request later:

```sh
git checkout -b feat/multi-user-web-gateway
git add -A
git commit -m "feat(web-gateway): multi-user gateway with per-user dsh instances"

# On each upstream release:
git fetch origin
git rebase origin/master
```

The commit message follows the repository's conventional-commit style
(`feat:` / `docs:` prefixes). The pre-commit hook runs the staged lint,
third-party-notices regeneration, and whitespace checks automatically.

## What to re-verify after every upgrade

1. **Build** — `pnpm run build` (or at minimum the per-package `tsc -b`
   command above) must still emit `packages/host/web-gateway/lib/bin.js` and
   `apps/web/dist`.
2. **Tests** — `pnpm exec vitest run --config vitest.config.ts packages/host/web-gateway`.
3. **Runtime smoke** — start the gateway locally and confirm login, per-user
   instance proxying, and user isolation still hold (see the package README's
   CLI section for the exact commands).
4. **Deployment image** — if you use `docker/web-gateway/`, rebuild the image
   and re-run the smoke test inside the container.

## Recovering a botched rebase

If a rebase goes wrong, abort and redo from the pre-rebase state:

```sh
git rebase --abort
git status        # confirm the working tree is intact
```

Because the gateway lives in its own package plus four one-line registration
edits, a full reset and re-apply is also cheap: the only work to preserve is
`packages/host/web-gateway/`, `docker/web-gateway/`, `.dockerignore`, and the
four registration edits.
