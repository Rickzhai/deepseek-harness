#!/usr/bin/env bash
# start-gateway.sh — one-shot launcher for the multi-user DeepSeek Harness
# gateway (see packages/host/web-gateway/README.md). It locates the checkout,
# starts the gateway on 127.0.0.1:3088 by default, and can also create or
# manage users against the same data root.
#
# Usage (run from anywhere):
#   ./docker/web-gateway/start-gateway.sh                    # start the gateway
#   ./docker/web-gateway/start-gateway.sh user add alice --admin --password 'pw'
#   ./docker/web-gateway/start-gateway.sh user list
#   ./docker/web-gateway/start-gateway.sh user passwd alice
#
# Environment overrides:
#   GATEWAY_PORT      listen port (default 3088)
#   GATEWAY_DATA_ROOT gateway data root (default ~/.dsh/gateway)
#   GATEWAY_HOST      listen host (default 127.0.0.1)
set -euo pipefail

# Resolve the repository root: this script lives at docker/web-gateway/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${GATEWAY_PORT:-3088}"
GATEWAY_DATA_ROOT="${GATEWAY_DATA_ROOT:-$HOME/.dsh/gateway}"

# The per-user instances run the real dsh CLI. It is the built bin in this
# checkout; fall back to `dsh` on PATH when the built bin is missing.
DSH_BIN="${DSH_BIN:-}"
if [[ -z "${DSH_BIN}" ]]; then
  if [[ -x "${REPO_ROOT}/apps/cli/lib/bin.js" ]]; then
    DSH_BIN="${REPO_ROOT}/apps/cli/lib/bin.js"
  else
    DSH_BIN="dsh"
  fi
fi

BIN_ENTRY="${REPO_ROOT}/packages/host/web-gateway/src/bin.ts"

# The gateway is an ordinary `dsh-web-gateway` invocation; user-management
# verbs are forwarded to the same bin so they share the data root.
if [[ "${1:-}" == "user" ]]; then
  shift
  exec pnpm --dir "${REPO_ROOT}" exec tsx "${BIN_ENTRY}" user \
    --data-root "${GATEWAY_DATA_ROOT}" "$@"
fi

exec pnpm --dir "${REPO_ROOT}" exec tsx "${BIN_ENTRY}" serve \
  --host "${GATEWAY_HOST}" \
  --port "${GATEWAY_PORT}" \
  --data-root "${GATEWAY_DATA_ROOT}" \
  --dsh-bin "${DSH_BIN}"
