#!/usr/bin/env bash

kairos_macos_fail() { printf 'kairos-daemon: %s\n' "$*" >&2; exit 78; }

kairos_macos_require() {
  [[ $(uname -s) == Darwin ]] || kairos_macos_fail 'this installer requires macOS.'
  [[ $EUID -ne 0 ]] || kairos_macos_fail 'run this installer as the macOS login user, without sudo.'
  [[ $BASE_PREFIX == /* && $BASE_PREFIX != / && $BASE_PREFIX != *$'\n'* && ! -L $BASE_PREFIX ]] || kairos_macos_fail 'installation prefix is invalid.'
  [[ $PREFIX == "$BASE_PREFIX/environments/"* ]] || kairos_macos_fail 'environment installation prefix is invalid.'
  UID_NUMBER=$(id -u)
  if [[ -n ${KAIROS_DAEMON_SERVICE_LABEL:-} ]]; then
    SERVICE=$KAIROS_DAEMON_SERVICE_LABEL
  elif [[ -n $ENV_ID ]]; then
    SERVICE=team.kairos.daemon.$(printf '%s' "$ENV_ID" | shasum -a 256 | awk '{print substr($1, 1, 32)}')
  else
    SERVICE=team.kairos.daemon
  fi
  [[ $SERVICE =~ ^[0-9A-Za-z._-]{1,200}$ ]] || kairos_macos_fail 'service label is invalid.'
  DOMAIN=gui/$UID_NUMBER
  PLIST=$HOME/Library/LaunchAgents/$SERVICE.plist
  IDENTITY_PATH=$PREFIX/identity.json
  CONTROL_DIRECTORY=$HOME/.local/bin
  CONTROL_LINK=$CONTROL_DIRECTORY/kairos-daemon
}

kairos_macos_verify() {
  local release=$1
  [[ -f $release/SHA256SUMS && -x $release/node/bin/node && -x $release/bin/kairos-daemon ]] || kairos_macos_fail 'release is incomplete.'
  (cd "$release" && shasum -a 256 -c SHA256SUMS >/dev/null) || kairos_macos_fail 'release checksum verification failed.'
  "$release/bin/kairos-daemon" --check >/dev/null || kairos_macos_fail 'the bundled runtime cannot execute on this Mac.'
}

kairos_macos_installed() {
  [[ -f $PREFIX/INSTALLATION && $(cat "$PREFIX/INSTALLATION") == kairos-daemon-macos-v1 ]] || kairos_macos_fail 'the prefix is not a managed Kairos installation.'
  [[ $(stat -f %u "$PREFIX") == "$UID_NUMBER" ]] || kairos_macos_fail 'the installation belongs to another user.'
}

kairos_macos_link() {
  local target=$1
  rm -f "$PREFIX/current.new"
  ln -s "$target" "$PREFIX/current.new"
  "$target/node/bin/node" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$PREFIX/current.new" "$PREFIX/current"
}

kairos_macos_control_link() {
  local target=$PREFIX/current/macos/control.sh existing=
  mkdir -p "$CONTROL_DIRECTORY"
  if [[ -e $CONTROL_LINK || -L $CONTROL_LINK ]]; then
    [[ -L $CONTROL_LINK ]] || kairos_macos_fail 'the user control entry is not a managed link.'
    existing=$(readlink "$CONTROL_LINK")
    case $existing in
      "$BASE_PREFIX"/environments/*/current/macos/control.sh) ;;
      *) kairos_macos_fail 'the user control entry belongs to another installation.' ;;
    esac
  fi
  rm -f "$CONTROL_LINK.new"
  ln -s "$target" "$CONTROL_LINK.new"
  mv -f "$CONTROL_LINK.new" "$CONTROL_LINK"
}

kairos_macos_remove_control_link() {
  local target=$PREFIX/current/macos/control.sh replacement= candidate
  [[ -L $CONTROL_LINK && $(readlink "$CONTROL_LINK") == "$target" ]] || return 0
  for candidate in "$BASE_PREFIX"/environments/*/current/macos/control.sh; do
    if [[ $candidate != "$target" && -x $candidate ]]; then replacement=$candidate; break; fi
  done
  if [[ -n $replacement ]]; then
    rm -f "$CONTROL_LINK.new"
    ln -s "$replacement" "$CONTROL_LINK.new"
    mv -f "$CONTROL_LINK.new" "$CONTROL_LINK"
  else
    rm -f "$CONTROL_LINK"
  fi
}

kairos_macos_stop() {
  if launchctl print "$DOMAIN/$SERVICE" >/dev/null 2>&1; then
    kairos_macos_owns_service || kairos_macos_fail 'a different Kairos installation owns this login service.'
    launchctl bootout "$DOMAIN/$SERVICE"
  fi
}

kairos_macos_owns_service() {
  [[ -f $PLIST ]] || return 1
  local binary
  binary=$(plutil -extract ProgramArguments.0 raw -o - "$PLIST") || kairos_macos_fail 'existing launchd configuration is invalid.'
  [[ $binary == "$PREFIX/current/bin/kairos-daemon" ]]
}

kairos_macos_pid() {
  launchctl print "$DOMAIN/$SERVICE" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ { print $3; exit }' || true
}

kairos_macos_verify_pid() {
  local pid=$1 observed= attempt
  for attempt in {1..50}; do
    observed=$(ps -o uid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
    [[ $observed == "$UID_NUMBER" ]] && return 0
    sleep 0.1
  done
  printf 'kairos-daemon: launchd PID %s UID verification failed; expected %s, observed %s.\n' "$pid" "$UID_NUMBER" "${observed:-unavailable}" >&2
  return 1
}

kairos_macos_start() {
  local pid=
  if launchctl print "$DOMAIN/$SERVICE" >/dev/null 2>&1; then
    kairos_macos_owns_service || kairos_macos_fail 'a different Kairos installation owns this login service.'
    pid=$(kairos_macos_pid)
    if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
      kairos_macos_verify_pid "$pid" || kairos_macos_fail 'the active Daemon is not running as the login user.'
      printf 'kairos-daemon: launchd service is already active (pid %s).\n' "$pid"
      return 0
    fi
    launchctl kickstart -p "$DOMAIN/$SERVICE" >/dev/null || kairos_macos_fail 'launchd could not start the loaded Daemon service.'
  else
    launchctl bootstrap "$DOMAIN" "$PLIST" || kairos_macos_fail 'launchd registration failed; use a logged-in macOS user session.'
  fi
  for _ in {1..50}; do
    pid=$(kairos_macos_pid)
    [[ $pid =~ ^[1-9][0-9]*$ ]] && break
    sleep 0.1
  done
  [[ $pid =~ ^[1-9][0-9]*$ ]] || kairos_macos_fail 'launchd did not report a service process.'
  kairos_macos_verify_pid "$pid" || kairos_macos_fail 'the Daemon is not running as the login user.'
}
