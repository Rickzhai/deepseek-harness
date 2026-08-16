#!/usr/bin/env bash
# start-gateway.sh — lifecycle manager for the multi-user DeepSeek Harness
# gateway (see packages/host/web-gateway/README.md). It locates the checkout,
# manages the gateway as a background service (default 127.0.0.1:3088), and
# forwards user-management verbs to the same data root.
#
# Usage (run from anywhere):
#   ./docker/web-gateway/start-gateway.sh                      # start (background)
#   ./docker/web-gateway/start-gateway.sh foreground           # start (foreground)
#   ./docker/web-gateway/start-gateway.sh stop                 # stop the gateway
#   ./docker/web-gateway/start-gateway.sh restart              # stop then start
#   ./docker/web-gateway/start-gateway.sh status               # show running state
#   ./docker/web-gateway/start-gateway.sh logs                 # follow the log
#   ./docker/web-gateway/start-gateway.sh user add alice --admin --password 'pw'
#   ./docker/web-gateway/start-gateway.sh user list
#
# Environment overrides:
#   GATEWAY_PORT      listen port (default 3088)
#   GATEWAY_DATA_ROOT gateway data root (default ~/.dsh/gateway)
#   GATEWAY_HOST      listen host (default 127.0.0.1)
#   GATEWAY_SESSION_TTL_MS  session lifetime in ms (default 3600000 = 1 hour, sliding)
#   DSH_BIN           dsh executable for per-user instances
set -euo pipefail

# Resolve the repository root: this script lives at docker/web-gateway/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${GATEWAY_PORT:-3088}"
GATEWAY_DATA_ROOT="${GATEWAY_DATA_ROOT:-$HOME/.dsh/gateway}"
GATEWAY_SESSION_TTL_MS="${GATEWAY_SESSION_TTL_MS:-3600000}"

PID_FILE="${GATEWAY_DATA_ROOT}/gateway.pid"
LOG_FILE="${GATEWAY_DATA_ROOT}/gateway.log"

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

# ── helpers ───────────────────────────────────────────────────────────────────

log() { printf 'start-gateway: %s\n' "$*"; }

die() { printf 'start-gateway: error: %s\n' "$*" >&2; exit 1; }

# Whether the gateway answers /healthz on the configured port.
health_ok() {
  curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${GATEWAY_PORT}/healthz" 2>/dev/null
}

# Ensure the data root exists.
ensure_data_root() {
  mkdir -p "${GATEWAY_DATA_ROOT}"
}

# The gateway process command line (used to avoid killing an unrelated process
# that happened to reuse a stale PID).
gateway_proc_args() {
  pnpm --dir "${REPO_ROOT}" exec tsx "${BIN_ENTRY}" serve \
    --host "${GATEWAY_HOST}" --port "${GATEWAY_PORT}" \
    --data-root "${GATEWAY_DATA_ROOT}" --dsh-bin "${DSH_BIN}" \
    --session-ttl-ms "${GATEWAY_SESSION_TTL_MS}"
}

# Match pattern for the REAL node process that owns the port. `pnpm exec` forks
# a node child, so `$!` records the pnpm wrapper, not the listener; matching the
# serve command line (unique per data root + port) targets the listener itself.
gateway_proc_pattern() {
  printf 'web-gateway/src/bin.ts serve .*--port %s .*--data-root %s' \
    "${GATEWAY_PORT}" "${GATEWAY_DATA_ROOT}"
}

# PIDs of every process matching the gateway serve command line.
gateway_pids() {
  pgrep -f "$(gateway_proc_pattern)" 2>/dev/null || true
}

# ── commands ──────────────────────────────────────────────────────────────────

cmd_start() {
  ensure_data_root
  if [[ -n "$(gateway_pids)" ]] && health_ok; then
    log "already running (pid $(gateway_pids | tr '\n' ' '), http://127.0.0.1:${GATEWAY_PORT})"
    return 0
  fi
  # A stale PID file (crashed gateway) must not block a fresh start.
  rm -f "${PID_FILE}"
  log "starting gateway on http://127.0.0.1:${GATEWAY_PORT} (data root ${GATEWAY_DATA_ROOT})"
  nohup $(gateway_proc_args) >> "${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  # Wait briefly for readiness so the caller gets an immediate answer.
  local i
  for i in $(seq 1 30); do
    if health_ok; then
      log "ready"
      return 0
    fi
    sleep 0.2
  done
  die "gateway did not become ready within ~6s; see ${LOG_FILE}"
}

cmd_stop() {
  local pids
  pids="$(gateway_pids)"
  if [[ -z "${pids}" ]]; then
    rm -f "${PID_FILE}"
    log "not running"
    return 0
  fi
  log "stopping gateway (pid ${pids//$'\n'/ })"
  # SIGTERM first: the gateway tears down per-user dsh instances.
  for pid in ${pids}; do kill "${pid}" 2>/dev/null || true; done
  # Wait up to ~10s for graceful shutdown, then escalate to SIGKILL.
  local i
  for i in $(seq 1 50); do
    if [[ -z "$(gateway_pids)" ]]; then
      rm -f "${PID_FILE}"
      pkill -f "${REPO_ROOT}/apps/cli/lib/bin.js web" 2>/dev/null || true
      log "stopped"
      return 0
    fi
    sleep 0.2
  done
  log "graceful stop timed out; sending SIGKILL"
  for pid in $(gateway_pids); do kill -9 "${pid}" 2>/dev/null || true; done
  rm -f "${PID_FILE}"
  pkill -f "${REPO_ROOT}/apps/cli/lib/bin.js web" 2>/dev/null || true
}

cmd_status() {
  local pids
  pids="$(gateway_pids)"
  echo "data root : ${GATEWAY_DATA_ROOT}"
  echo "listen    : http://${GATEWAY_HOST}:${GATEWAY_PORT}"
  if [[ -n "${pids}" ]]; then
    echo "status    : running (pid ${pids//$'\n'/ })"
  else
    echo "status    : stopped"
  fi
  if health_ok; then
    echo "health    : ok"
  else
    echo "health    : not responding"
  fi
  # Per-user dsh instances spawned from this checkout.
  local instances
  instances="$(pgrep -f "${REPO_ROOT}/apps/cli/lib/bin.js web" 2>/dev/null | wc -l | tr -d ' ' || true)"
  echo "instances : ${instances:-0} dsh web child process(es)"
  # Users known to this data root.
  if [[ -f "${GATEWAY_DATA_ROOT}/users.json" ]]; then
    echo "users     :"
    sed -n 's/.*"username": "\([^"]*\)".*/  - \1/p' "${GATEWAY_DATA_ROOT}/users.json"
  fi
}

cmd_logs() {
  [[ -f "${LOG_FILE}" ]] || die "no log file yet (${LOG_FILE}); start the gateway first"
  exec tail -n 50 -f "${LOG_FILE}"
}

cmd_user() {
  exec pnpm --dir "${REPO_ROOT}" exec tsx "${BIN_ENTRY}" user \
    --data-root "${GATEWAY_DATA_ROOT}" "$@"
}

cmd_foreground() {
  exec $(gateway_proc_args)
}

# ── dispatch ──────────────────────────────────────────────────────────────────

case "${1:-}" in
  start) cmd_start ;;
  foreground) cmd_foreground ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  user) shift; cmd_user "$@" ;;
  *) cmd_start ;;
esac
