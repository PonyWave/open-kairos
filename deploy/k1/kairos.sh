#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIRECTORY/common.sh"

usage() {
  cat <<'EOF'
Usage:
  kairos.sh init
  kairos.sh install INCOMING_RELEASE_DIRECTORY
  kairos.sh start prod|test
  kairos.sh drain prod|test
  kairos.sh stop prod|test --confirm-active-tasks-drained
  kairos.sh status prod|test
  kairos.sh backup prod|test
  kairos.sh release prod|test COMMIT --confirm-active-tasks-drained
  kairos.sh rollback prod|test COMMIT --confirm-active-tasks-drained
  kairos.sh restore prod|test COMMIT BACKUP_DIRECTORY --confirm-active-tasks-drained --confirm-restore
EOF
}

initialize() {
  mkdir -p "$KAIROS_ROOT/incoming" "$KAIROS_ROOT/releases" "$KAIROS_ROOT/backups" "$KAIROS_ROOT/scripts"
  local environment directory
  for environment in prod test; do
    directory=$(environment_directory "$environment")
    mkdir -p "$directory/data" "$directory/workspace" "$directory/logs" "$directory/run" "$directory/daemon-releases"
    chmod 0700 "$directory" "$directory/data" "$directory/run" "$directory/daemon-releases"
  done
}

install_release() {
  local source=$1 target version node incoming
  [[ -d "$source" ]] || fail 'Incoming release directory does not exist.'
  source=$(realpath "$source")
  incoming=$(realpath "$KAIROS_ROOT/incoming")
  case "$source" in
    "$incoming/"*) ;;
    *) fail 'Incoming release must be under the Kairos incoming directory.' ;;
  esac
  node=$(node_binary)
  "$node" "$KAIROS_SCRIPTS/verify-release.mjs" "$source"
  version=$(release_version "$source")
  target="$KAIROS_ROOT/releases/$version"
  [[ ! -e "$target" ]] || fail "Refusing to overwrite installed release: $target"
  mv "$source" "$target"
  cp -a "$target/operations/." "$KAIROS_SCRIPTS/"
  printf 'Installed release %s.\n' "$version"
}

wait_for_health() {
  local url=$1
  for ((attempt=0; attempt<30; attempt++)); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

tmux_target() {
  printf 'kairos-%s:%s\n' "$1" "$2"
}

record_pane() {
  local directory=$1 environment=$2 role=$3 pane
  pane=$(tmux -S "$directory/run/tmux.sock" display-message -p -t "$(tmux_target "$environment" "$role")" '#{pane_pid}')
  [[ "$pane" =~ ^[0-9]+$ ]] || fail "tmux did not provide a PID for $role"
  write_pid "$directory/run/$role.runner.pid" "$pane"
}

stop_tmux_session() {
  local directory=$1 environment=$2
  tmux -S "$directory/run/tmux.sock" kill-session -t "kairos-$environment" 2>/dev/null || true
}

start_environment() {
  local environment=$1 directory release session
  directory=$(environment_directory "$environment")
  load_config "$directory"
  release=$(current_release "$directory")
  node_binary >/dev/null
  caddy_binary >/dev/null
  [[ -x "$KAIROS_CHAMBER_BIN" ]] || fail "chamber is not executable: $KAIROS_CHAMBER_BIN"
  mkdir -p "$directory/logs" "$directory/run" "$KAIROS_DATA_DIR" "$KAIROS_DAEMON_RELEASE_DIR"
  if role_running "$directory" server || role_running "$directory" entry; then
    fail "$environment is already running; use status or stop first."
  fi
  session="kairos-$environment"
  if tmux -S "$directory/run/tmux.sock" has-session -t "$session" 2>/dev/null; then
    fail "tmux session $session already exists on the environment socket; inspect it before starting."
  fi
  rm -f "$directory/run/server.stop" "$directory/run/entry.stop" "$directory/run/maintenance"
  rm -f "$directory/run/server.pid" "$directory/run/entry.pid"
  if ! tmux -S "$directory/run/tmux.sock" new-session -d -s "$session" -n server "bash '$KAIROS_SCRIPTS/runner.sh' '$environment' server"; then
    fail 'Unable to create the Server tmux session.'
  fi
  record_pane "$directory" "$environment" server
  if ! wait_for_health "http://127.0.0.1:$KAIROS_PORT/health"; then
    touch "$directory/run/maintenance"
    terminate_role "$directory" server
    stop_tmux_session "$directory" "$environment"
    fail "Server health check failed; inspect $directory/logs/server.log"
  fi
  if ! tmux -S "$directory/run/tmux.sock" new-window -d -t "$session" -n entry "bash '$KAIROS_SCRIPTS/runner.sh' '$environment' entry"; then
    touch "$directory/run/maintenance"
    terminate_role "$directory" server
    stop_tmux_session "$directory" "$environment"
    fail 'Unable to create the chamber tmux window.'
  fi
  record_pane "$directory" "$environment" entry
  if ! wait_for_health "http://127.0.0.1:$KAIROS_CADDY_PORT/health"; then
    touch "$directory/run/maintenance"
    terminate_role "$directory" entry
    terminate_role "$directory" server
    stop_tmux_session "$directory" "$environment"
    fail "Caddy health check failed; inspect $directory/logs/entry.log"
  fi
  printf '%s is running release %s.\n' "$environment" "$(basename "$release")"
}

drain_environment() {
  local environment=$1 directory
  directory=$(environment_directory "$environment")
  mkdir -p "$directory/run"
  touch "$directory/run/maintenance"
  terminate_role "$directory" entry
}

stop_environment() {
  local environment=$1 confirmation=${2:-} directory
  require_drained_confirmation "$confirmation"
  directory=$(environment_directory "$environment")
  drain_environment "$environment"
  terminate_role "$directory" server
  stop_tmux_session "$directory" "$environment"
  printf '%s stopped.\n' "$environment"
}

backup_environment() {
  local environment=$1 directory backup release node
  directory=$(environment_directory "$environment")
  if role_running "$directory" server; then fail 'Stop the Server before creating a consistent backup.'; fi
  backup="$KAIROS_ROOT/backups/$environment/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$KAIROS_ROOT/backups/$environment"
  mkdir "$backup"
  chmod 0700 "$backup"
  if [[ -d "$directory/data" ]]; then cp -a "$directory/data" "$backup/data"; fi
  if [[ -d "$directory/workspace" ]]; then cp -a "$directory/workspace" "$backup/workspace"; fi
  if [[ -f "$directory/config.env" ]]; then cp -a "$directory/config.env" "$backup/config.env"; fi
  if [[ -L "$directory/current" ]]; then
    release=$(current_release "$directory")
    basename "$release" > "$backup/release-commit"
    if [[ -f "$directory/data/kairos.sqlite" ]]; then
      node=$(node_binary)
      "$node" "$release/app/apps/server/dist/migrate.js" --data-dir "$backup/data" --backup-dir "$backup/migration-check" --check > "$backup/schema.json"
    fi
  fi
  printf '%s\n' "$backup"
}

run_migration() {
  local release=$1 data=$2 backup=$3 node output
  node=$(node_binary)
  mkdir -p "$backup"
  output=$("$node" "$release/app/apps/server/dist/migrate.js" --data-dir "$data" --backup-dir "$backup")
  printf '%s\n' "$output"
}

release_environment() {
  local environment=$1 version=$2 confirmation=${3:-} directory target backup status
  require_drained_confirmation "$confirmation"
  directory=$(environment_directory "$environment")
  [[ "$version" =~ ^[a-f0-9]{40}$ ]] || fail 'Release commit must be a 40-character lowercase Git hash.'
  target="$KAIROS_ROOT/releases/$version"
  [[ -d "$target" ]] || fail "Release is not installed: $version"
  [[ $(release_version "$target") == "$version" ]] || fail 'Release metadata does not match the requested commit.'
  drain_environment "$environment"
  terminate_role "$directory" server
  stop_tmux_session "$directory" "$environment"
  backup=$(backup_environment "$environment")
  printf 'Pre-release backup: %s\n' "$backup"
  status=$(migration_status "$target" "$directory/data")
  if [[ "$status" == migration_required ]]; then
    run_migration "$target" "$directory/data" "$backup/migration"
  elif [[ "$status" != current && "$status" != missing ]]; then
    fail "Migration status does not allow release: $status"
  fi
  replace_workspace "$directory" "$target"
  switch_release "$directory" "$target"
  start_environment "$environment"
}

rollback_environment() {
  local environment=$1 version=$2 confirmation=${3:-} directory target backup status
  require_drained_confirmation "$confirmation"
  directory=$(environment_directory "$environment")
  [[ "$version" =~ ^[a-f0-9]{40}$ ]] || fail 'Release commit must be a 40-character lowercase Git hash.'
  target="$KAIROS_ROOT/releases/$version"
  [[ -d "$target" ]] || fail "Rollback release is not installed: $version"
  drain_environment "$environment"
  terminate_role "$directory" server
  stop_tmux_session "$directory" "$environment"
  backup=$(backup_environment "$environment")
  printf 'Pre-rollback backup: %s\n' "$backup"
  status=$(migration_status "$target" "$directory/data")
  [[ "$status" == current || "$status" == missing ]] || fail 'The rollback release is not schema-compatible. Restore a compatible backup instead.'
  replace_workspace "$directory" "$target"
  switch_release "$directory" "$target"
  start_environment "$environment"
}

restore_environment() {
  local environment=$1 version=$2 backup=$3 drained=${4:-} confirmed=${5:-} directory target safety stage previous status backupsRoot
  require_drained_confirmation "$drained"
  [[ "$confirmed" == '--confirm-restore' ]] || fail 'Data replacement requires --confirm-restore.'
  directory=$(environment_directory "$environment")
  [[ "$version" =~ ^[a-f0-9]{40}$ ]] || fail 'Release commit must be a 40-character lowercase Git hash.'
  target="$KAIROS_ROOT/releases/$version"
  [[ -d "$target" ]] || fail "Restore release is not installed: $version"
  [[ -d "$backup/data" ]] || fail 'Restore backup must contain a data directory.'
  backup=$(realpath "$backup")
  backupsRoot=$(realpath "$KAIROS_ROOT/backups/$environment")
  [[ $(dirname "$backup") == "$backupsRoot" ]] || fail 'Restore backup must belong to the selected environment.'
  drain_environment "$environment"
  terminate_role "$directory" server
  stop_tmux_session "$directory" "$environment"
  safety=$(backup_environment "$environment")
  printf 'Pre-restore backup: %s\n' "$safety"
  stage="$KAIROS_ROOT/.$environment.restore-new-$$"
  previous="$KAIROS_ROOT/.$environment.restore-old-$$"
  [[ ! -e "$stage" && ! -e "$previous" ]] || fail 'Restore staging path already exists; inspect it before retrying.'
  mkdir -p "$stage/run"
  cp -a "$backup/data" "$stage/data"
  status=$(migration_status "$target" "$stage/data")
  [[ "$status" == current ]] || fail 'The selected release is not compatible with the restore backup.'
  if [[ -d "$backup/workspace" ]]; then
    cp -a "$backup/workspace" "$stage/workspace"
  else
    cp -a "$target/workspace" "$stage/workspace"
  fi
  if [[ -f "$backup/config.env" ]]; then
    cp -a "$backup/config.env" "$stage/config.env"
  else
    cp -a "$directory/config.env" "$stage/config.env"
  fi
  if [[ -d "$directory/logs" ]]; then cp -a "$directory/logs" "$stage/logs"; fi
  if [[ -d "$directory/daemon-releases" ]]; then
    cp -a "$directory/daemon-releases" "$stage/daemon-releases"
  else
    mkdir -p "$stage/daemon-releases"
  fi
  ln -s "$target" "$stage/current"
  chmod 0700 "$stage" "$stage/data" "$stage/run" "$stage/daemon-releases"

  mv "$directory" "$previous"
  if ! mv "$stage" "$directory"; then
    mv "$previous" "$directory"
    fail 'Unable to activate the prepared restore directory.'
  fi
  start_environment "$environment"
  rm -rf "$previous"
}

status_environment() {
  local environment=$1 directory release role unhealthy=0
  directory=$(environment_directory "$environment")
  printf 'Environment: %s\n' "$environment"
  if [[ -L "$directory/current" ]]; then
    release=$(current_release "$directory")
    printf 'Release: %s\n' "$(basename "$release")"
  else
    printf 'Release: none\n'
    unhealthy=1
  fi
  for role in server entry; do
    if role_running "$directory" "$role"; then printf '%s runner: running\n' "$role";
    else printf '%s runner: stopped\n' "$role"; unhealthy=1; fi
  done
  if [[ -f "$directory/config.env" ]]; then
    load_config "$directory"
    if curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$KAIROS_PORT/health"; then printf '\n';
    else unhealthy=1; fi
    if curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$KAIROS_CADDY_PORT/health"; then printf '\n';
    else unhealthy=1; fi
    if [[ -n "${release:-}" && -f "$directory/data/kairos.sqlite" ]]; then
      printf 'Schema: %s\n' "$(migration_status "$release" "$directory/data")"
    fi
  fi
  return "$unhealthy"
}

case "${1:-}" in
  init) initialize ;;
  install) [[ $# -eq 2 ]] || { usage; exit 2; }; install_release "$2" ;;
  start) [[ $# -eq 2 ]] || { usage; exit 2; }; start_environment "$2" ;;
  drain) [[ $# -eq 2 ]] || { usage; exit 2; }; drain_environment "$2" ;;
  stop) stop_environment "${2:-}" "${3:-}" ;;
  status) [[ $# -eq 2 ]] || { usage; exit 2; }; status_environment "$2" ;;
  backup) [[ $# -eq 2 ]] || { usage; exit 2; }; backup_environment "$2" ;;
  release) release_environment "${2:-}" "${3:-}" "${4:-}" ;;
  rollback) rollback_environment "${2:-}" "${3:-}" "${4:-}" ;;
  restore) restore_environment "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}" ;;
  *) usage; exit 2 ;;
esac
