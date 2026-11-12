#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$RELEASE_ROOT/macos/common.sh"
BASE_PREFIX=$HOME/Library/Application\ Support/Kairos/daemon
ENV_ID=
SERVER_URL=
DIRECTORY=$HOME
NO_SERVICE=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-id) ENV_ID=$2; shift 2 ;;
    --server-url) SERVER_URL=$2; shift 2 ;;
    --directory) DIRECTORY=$2; shift 2 ;;
    --prefix) BASE_PREFIX=$2; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    *) kairos_macos_fail 'unsupported installer argument.' ;;
  esac
done
[[ $ENV_ID =~ ^[0-9A-Za-z._:-]{1,200}$ ]] || kairos_macos_fail 'environment ID is invalid.'
PREFIX=$BASE_PREFIX/environments/$ENV_ID
kairos_macos_require
[[ ! -L $PREFIX ]] || kairos_macos_fail 'environment installation prefix is a symlink.'
kairos_macos_verify "$RELEASE_ROOT"
[[ $DIRECTORY == /* && $DIRECTORY != *$'\n'* ]] || kairos_macos_fail 'working directory is invalid.'
[[ $SERVER_URL == wss://* || $SERVER_URL == ws://127.0.0.1:* || $SERVER_URL == ws://localhost:* || $SERVER_URL == 'ws://[::1]:'* ]] || kairos_macos_fail 'remote connections require WSS.'
VERSION=$(cat "$RELEASE_ROOT/VERSION")
[[ $VERSION =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$ ]] || kairos_macos_fail 'release version is invalid.'
if [[ -d $PREFIX && ! -f $PREFIX/INSTALLATION && -n $(ls -A "$PREFIX") ]]; then kairos_macos_fail 'refusing to replace an unmanaged directory.'; fi
mkdir -p "$PREFIX/releases"
chmod 0700 "$PREFIX"
printf 'kairos-daemon-macos-v1\n' > "$PREFIX/INSTALLATION"
kairos_macos_installed
if [[ -e $IDENTITY_PATH ]]; then
  [[ -f $IDENTITY_PATH && ! -L $IDENTITY_PATH && $(stat -f %Lp "$IDENTITY_PATH") == 600 && $(stat -f %u "$IDENTITY_PATH") == "$UID_NUMBER" ]] || kairos_macos_fail 'identity ownership or permissions are invalid.'
  EXISTING_ENV=$("$RELEASE_ROOT/bin/kairos-daemon" identity-env "$IDENTITY_PATH") || kairos_macos_fail 'existing identity requires reauthorization.'
  [[ $EXISTING_ENV == "$ENV_ID" ]] || kairos_macos_fail 'existing identity belongs to another environment.'
  PAIRING_CREDENTIAL=
else
  if [[ -t 0 ]]; then IFS= read -rsp 'Pairing credential: ' PAIRING_CREDENTIAL; printf '\n';
  else IFS= read -r PAIRING_CREDENTIAL || kairos_macos_fail 'a pairing credential is required on standard input.'; fi
fi
TARGET=$PREFIX/releases/$VERSION
if [[ -e $TARGET ]]; then
  [[ -d $TARGET && ! -L $TARGET ]] || kairos_macos_fail 'existing release path is unsafe.'
  kairos_macos_verify "$TARGET"
else
  mkdir "$TARGET"
  (cd "$RELEASE_ROOT" && tar -cf - .) | (cd "$TARGET" && tar -xf -)
  kairos_macos_verify "$TARGET"
fi
if [[ $NO_SERVICE == 0 ]]; then
  if [[ -f $PLIST ]]; then kairos_macos_owns_service || kairos_macos_fail 'another Kairos installation owns the login service.'; fi
  kairos_macos_stop
fi
kairos_macos_link "$TARGET"
kairos_macos_control_link
set +e
printf '%s\n' "$PAIRING_CREDENTIAL" | "$PREFIX/current/bin/kairos-daemon" pair-once --identity-path "$IDENTITY_PATH" --env-id "$ENV_ID" --server-url "$SERVER_URL" --directory "$DIRECTORY" --device-name "$(hostname)"
PAIR_STATUS=$?
set -e
unset PAIRING_CREDENTIAL
[[ $PAIR_STATUS == 0 || $PAIR_STATUS == 69 ]] || kairos_macos_fail 'pairing failed; the device was not reported ready.'
[[ -f $IDENTITY_PATH && $(stat -f %Lp "$IDENTITY_PATH") == 600 ]] || kairos_macos_fail 'identity verification failed.'
if [[ $NO_SERVICE == 1 ]]; then
  printf 'kairos-daemon: release installed and pairing checked; background service was explicitly skipped.\n'
  exit "$PAIR_STATUS"
fi
mkdir -p "$HOME/Library/LaunchAgents"
"$TARGET/node/bin/node" - "$PLIST" "$PREFIX/current/bin/kairos-daemon" "$IDENTITY_PATH" "$SERVICE" <<'JS'
const fs = require('node:fs');
const [file, binary, identity, label] = process.argv.slice(2);
const xml = (value) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(binary)}</string></array><key>EnvironmentVariables</key><dict><key>KAIROS_DEVICE_IDENTITY_PATH</key><string>${xml(identity)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`, {mode:0o600});
JS
kairos_macos_start
GUI_URL=${SERVER_URL%/devices/wss}
case $GUI_URL in
  wss://*) GUI_URL="https://${GUI_URL#wss://}" ;;
  ws://*) GUI_URL="http://${GUI_URL#ws://}" ;;
esac
printf 'Manage the environment:\n  %s status\n  %s stop\n  %s start\n' "$CONTROL_LINK" "$CONTROL_LINK" "$CONTROL_LINK"
printf 'stop retains the paired identity; start only starts that existing identity. Ctrl+C exits status without stopping the Daemon.\n'
if [[ $PAIR_STATUS -eq 69 ]]; then
  printf 'kairos-daemon: installed and bound; directory or capability readiness is not confirmed.\n' >&2
  exit 69
fi
printf 'kairos-daemon: installed, paired, and started as a launchd service (starts at user login); you can close this terminal.\n'
printf 'Conversation page on this machine: %s (sign in with the token URL printed by kairos start).\n' "$GUI_URL"
exit 0
