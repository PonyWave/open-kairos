#!/usr/bin/env bash
set -euo pipefail
set -m
SCRIPT_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIRECTORY/common.sh"

DIRECTORY=$(environment_directory "${1:-}")
ROLE=${2:-}
[[ "$ROLE" == server || "$ROLE" == entry ]] || fail 'Runner role must be server or entry.'
load_config "$DIRECTORY"
RELEASE=$(current_release "$DIRECTORY")
NODE=$(node_binary)
export PATH="$(dirname "$NODE"):$PATH"
export HOME="$DIRECTORY/run"
export XDG_CONFIG_HOME="$DIRECTORY/run/xdg-config"
export XDG_DATA_HOME="$DIRECTORY/run/xdg-data"
export XDG_CACHE_HOME="$DIRECTORY/run/xdg-cache"
mkdir -p "$DIRECTORY/logs" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
LOG="$DIRECTORY/logs/$ROLE.log"
RESTARTS=0
RESTART_DELAY=${KAIROS_RESTART_DELAY:-5}

while true; do
  if [[ -e "$DIRECTORY/run/$ROLE.stop" || -e "$DIRECTORY/run/maintenance" ]]; then
    exit 0
  fi
  rotate_log "$LOG"
  if [[ "$ROLE" == server ]]; then
    "$NODE" "$KAIROS_SCRIPTS/process-supervisor.mjs" -- \
      "$NODE" "$RELEASE/app/apps/server/dist/main.js" >> "$LOG" 2>&1 &
  else
    CADDY=$(caddy_binary)
    export KAIROS_SERVER_PORT=$KAIROS_PORT
    export KAIROS_GUI_ROOT="$RELEASE/gui"
    "$NODE" "$KAIROS_SCRIPTS/process-supervisor.mjs" -- \
      "$KAIROS_CHAMBER_BIN" \
      --consul-service-name "$KAIROS_CHAMBER_SERVICE" \
      --consul-service-id "$KAIROS_CHAMBER_SERVICE" \
      --port "$KAIROS_CADDY_PORT" \
      --health-endpoint /health \
      --termination-grace-period-seconds 5 \
      --verbose \
      -- "$CADDY" run --config "$RELEASE/caddy/Caddyfile" --adapter caddyfile >> "$LOG" 2>&1 &
  fi
  CHILD=$!
  write_pid "$DIRECTORY/run/$ROLE.pid" "$CHILD" group
  set +e
  wait "$CHILD"
  STATUS=$?
  set -e
  cleanup_process_group "$CHILD"
  rm -f "$DIRECTORY/run/$ROLE.pid"
  if [[ -e "$DIRECTORY/run/$ROLE.stop" || -e "$DIRECTORY/run/maintenance" ]]; then
    exit "$STATUS"
  fi
  if ((RESTARTS >= 3)); then
    printf '%s restart limit reached; last exit status %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STATUS" >> "$LOG"
    exit 1
  fi
  RESTARTS=$((RESTARTS + 1))
  printf '%s unexpected exit status %s; restart %s of 3\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STATUS" "$RESTARTS" >> "$LOG"
  sleep "$RESTART_DELAY"
done
