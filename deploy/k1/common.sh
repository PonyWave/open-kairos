#!/usr/bin/env bash
set -euo pipefail

KAIROS_ROOT=${KAIROS_ROOT:-/home/wanghailong/kairos}
KAIROS_SCRIPTS="$KAIROS_ROOT/scripts"
KAIROS_CHAMBER_BIN=${KAIROS_CHAMBER_BIN:-/home/wanghailong/.gyro/bin/chamber}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

environment_directory() {
  case "${1:-}" in
    prod|test) printf '%s/%s\n' "$KAIROS_ROOT" "$1" ;;
    *) fail 'Environment must be prod or test.' ;;
  esac
}

load_config() {
  local directory=$1
  [[ -f "$directory/config.env" ]] || fail "Missing configuration: $directory/config.env"
  set -a
  # shellcheck disable=SC1091
  . "$directory/config.env"
  set +a
  : "${KAIROS_PORT:?KAIROS_PORT is required}"
  : "${KAIROS_CADDY_PORT:?KAIROS_CADDY_PORT is required}"
  : "${KAIROS_CHAMBER_SERVICE:?KAIROS_CHAMBER_SERVICE is required}"
  : "${KAIROS_DATA_DIR:?KAIROS_DATA_DIR is required}"
  [[ "$KAIROS_DATA_DIR" == "$directory/data" ]] || fail 'KAIROS_DATA_DIR must be the environment data directory.'
}

node_binary() {
  local candidates=("$KAIROS_ROOT"/runtime/node-*/bin/node)
  [[ -x "${candidates[0]}" ]] || fail 'Install exactly one versioned Node.js runtime first.'
  [[ ${#candidates[@]} -eq 1 && -x "${candidates[0]}" ]] || fail 'Multiple Node.js runtimes found; keep one active runtime.'
  printf '%s\n' "${candidates[0]}"
}

caddy_binary() {
  local candidates=("$KAIROS_ROOT"/runtime/caddy-*/caddy)
  [[ -x "${candidates[0]}" ]] || fail 'Install exactly one versioned Caddy runtime first.'
  [[ ${#candidates[@]} -eq 1 && -x "${candidates[0]}" ]] || fail 'Multiple Caddy runtimes found; keep one active runtime.'
  printf '%s\n' "${candidates[0]}"
}

current_release() {
  local directory=$1 link
  [[ -L "$directory/current" ]] || fail "No current release for $directory"
  link=$(readlink "$directory/current")
  [[ "$link" == "$KAIROS_ROOT/releases/"* ]] || fail 'Current release link escapes the releases directory.'
  [[ -d "$link" ]] || fail "Current release is missing: $link"
  printf '%s\n' "$link"
}

release_version() {
  local release=$1 node
  node=$(node_binary)
  "$node" -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(value.version!==value.sourceCommit||!/^[a-f0-9]{40}$/.test(value.version))process.exit(1);process.stdout.write(value.version)' "$release/release.json"
}

process_identity() {
  local pid=$1 record state
  if [[ -r "/proc/$pid/stat" ]]; then
    record=$(< "/proc/$pid/stat")
    record=${record##*) }
    state=${record%% *}
    [[ "$state" != Z ]] || return 1
    awk '{print $20}' <<< "$record"
  else
    state=$(ps -p "$pid" -o stat= 2>/dev/null | sed 's/^[[:space:]]*//')
    [[ -n "$state" && "$state" != Z* ]] || return 1
    ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//'
  fi
}

process_group_id() {
  ps -p "$1" -o pgid= 2>/dev/null | tr -d '[:space:]'
}

write_pid() {
  local path=$1 pid=$2 requireGroup=${3:-} identity group
  identity=$(process_identity "$pid") || return 1
  group=$(process_group_id "$pid")
  [[ "$group" =~ ^[0-9]+$ ]] || return 1
  if [[ "$requireGroup" == group ]]; then [[ "$group" == "$pid" ]] || return 1; fi
  printf '%s|%s|%s\n' "$pid" "$identity" "$group" > "$path"
}

read_pid() {
  local path=$1 requireGroup=${2:-} pid identity group currentIdentity currentGroup
  [[ -f "$path" ]] || return 1
  IFS='|' read -r pid identity group < "$path"
  [[ "$pid" =~ ^[0-9]+$ && "$group" =~ ^[0-9]+$ ]] || return 1
  currentIdentity=$(process_identity "$pid") || return 1
  currentGroup=$(process_group_id "$pid")
  [[ "$currentIdentity" == "$identity" && "$currentGroup" == "$group" ]] || return 1
  if [[ "$requireGroup" == group ]]; then [[ "$group" == "$pid" ]] || return 1; fi
  printf '%s\n' "$pid"
}

process_group_members() {
  local expected=$1
  ps -eo pid=,pgid=,stat= | awk -v expected="$expected" '$2 == expected && $1 != expected && $3 !~ /^Z/ {print $1}'
}

signal_group_members() {
  local expected=$1 signal=$2 member
  while read -r member; do
    [[ "$member" =~ ^[0-9]+$ ]] || continue
    if [[ "$(process_group_id "$member")" == "$expected" ]]; then
      kill "-$signal" "$member" 2>/dev/null || true
    fi
  done < <(process_group_members "$expected")
}

cleanup_process_group() {
  local pid=$1
  signal_group_members "$pid" TERM
  if [[ -n "$(process_group_members "$pid")" ]]; then sleep 2; fi
  signal_group_members "$pid" KILL
}

child_process_identities() {
  local parent=$1 child identity
  while read -r child; do
    [[ "$child" =~ ^[0-9]+$ ]] || continue
    identity=$(process_identity "$child") || continue
    printf '%s|%s\n' "$child" "$identity"
    child_process_identities "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

signal_identity_record() {
  local record=$1 signal=$2 pid identity
  IFS='|' read -r pid identity <<< "$record"
  if [[ "$(process_identity "$pid" || true)" == "$identity" ]]; then
    kill "-$signal" "$pid" 2>/dev/null || true
  fi
}

terminate_child() {
  local directory=$1 role=$2 pid
  pid=$(read_pid "$directory/run/$role.pid" group || true)
  if [[ -n "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for ((attempt=0; attempt<300; attempt++)); do
      read_pid "$directory/run/$role.pid" group >/dev/null || break
      sleep 0.1
    done
    if read_pid "$directory/run/$role.pid" group >/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
    cleanup_process_group "$pid"
  fi
  rm -f "$directory/run/$role.pid"
}

terminate_role() {
  local directory=$1 role=$2 runner record children
  touch "$directory/run/$role.stop"
  terminate_child "$directory" "$role"
  runner=$(read_pid "$directory/run/$role.runner.pid" || true)
  if [[ -n "$runner" ]]; then
    children=$(child_process_identities "$runner")
    kill -TERM "$runner" 2>/dev/null || true
    for ((attempt=0; attempt<50; attempt++)); do
      read_pid "$directory/run/$role.runner.pid" >/dev/null || break
      sleep 0.1
    done
    while IFS= read -r record; do
      if [[ -n "$record" ]]; then signal_identity_record "$record" TERM; fi
    done <<< "$children"
    if read_pid "$directory/run/$role.runner.pid" >/dev/null; then
      kill -KILL "$runner" 2>/dev/null || true
    fi
    while IFS= read -r record; do
      if [[ -n "$record" ]]; then signal_identity_record "$record" KILL; fi
    done <<< "$children"
  fi
  rm -f "$directory/run/$role.runner.pid"
}

role_running() {
  local directory=$1 role=$2
  read_pid "$directory/run/$role.runner.pid" >/dev/null
}

require_drained_confirmation() {
  [[ "${1:-}" == '--confirm-active-tasks-drained' ]] || fail 'Confirm in the GUI that active tasks have finished, then pass --confirm-active-tasks-drained.'
}

rotate_log() {
  local path=$1 size
  [[ -f "$path" ]] || return 0
  size=$(wc -c < "$path")
  if ((size > 10485760)); then mv -f "$path" "$path.1"; fi
}

replace_workspace() {
  local directory=$1 release=$2 next="$directory/workspace.new-$$" previous="$directory/workspace.old-$$"
  [[ -d "$release/workspace" ]] || fail 'Release workspace resources are missing.'
  rm -rf "$next" "$previous"
  cp -a "$release/workspace" "$next"
  if [[ -e "$directory/workspace" ]]; then mv "$directory/workspace" "$previous"; fi
  mv "$next" "$directory/workspace"
  rm -rf "$previous"
}

switch_release() {
  local directory=$1 release=$2 next="$directory/current.next-$$"
  rm -f "$next"
  ln -s "$release" "$next"
  rm -f "$directory/current"
  mv "$next" "$directory/current"
}

migration_status() {
  local release=$1 data=$2 output node
  node=$(node_binary)
  [[ -f "$release/app/apps/server/dist/migrate.js" ]] || fail 'Release does not provide the explicit migration command.'
  output=$("$node" "$release/app/apps/server/dist/migrate.js" --data-dir "$data" --backup-dir "$KAIROS_ROOT/backups/migration-check" --check)
  printf '%s\n' "$output" >&2
  "$node" -e 'const value=JSON.parse(process.argv[1]);if(!["current","migration_required","missing"].includes(value.status))process.exit(1);process.stdout.write(value.status)' "$output"
}
