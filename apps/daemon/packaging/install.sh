#!/usr/bin/env bash
set -euo pipefail
set +x

RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $(uname -s) == Darwin ]]; then exec bash "$RELEASE_ROOT/macos/install.sh" "$@"; fi
source "$RELEASE_ROOT/lib/platform.sh"

ENV_ID=
SERVER_URL=
DIRECTORY=/home/kairos/projects
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-id)
      [[ $# -ge 2 ]] || kairos_fail '--env-id requires a value.'
      ENV_ID=$2
      shift 2
      ;;
    --server-url)
      [[ $# -ge 2 ]] || kairos_fail '--server-url requires a value.'
      SERVER_URL=$2
      shift 2
      ;;
    --directory)
      [[ $# -ge 2 ]] || kairos_fail '--directory requires a value.'
      DIRECTORY=$2
      shift 2
      ;;
    *)
      kairos_fail 'usage: install.sh --env-id ID --server-url WSS_URL --directory ABSOLUTE_PATH'
      ;;
  esac
done

kairos_require_platform
kairos_require_commands sha256sum tar runuser useradd getent install cmp stat ps id tr readlink
kairos_verify_release "$RELEASE_ROOT"
VERSION=$(kairos_release_version "$RELEASE_ROOT")
[[ $ENV_ID =~ ^[0-9A-Za-z._:-]{1,200}$ ]] || kairos_fail 'environment ID is invalid.'
[[ $DIRECTORY == /* && $DIRECTORY != *$'\n'* ]] ||
  kairos_fail 'the working directory must be an absolute path.'
[[ $SERVER_URL != *[$' \t\r\n\'"\\#']* ]] ||
  kairos_fail 'Server URL contains unsupported characters.'
if [[ $SERVER_URL != wss://* && $SERVER_URL != ws://127.0.0.1:* &&
      $SERVER_URL != ws://localhost:* && $SERVER_URL != 'ws://[::1]:'* ]]; then
  kairos_fail 'Server URL must use WSS, except for loopback development.'
fi

PREFIX=/opt/kairos-daemon
CONFIG_DIRECTORY=/etc/kairos-daemon
STATE_DIRECTORY=/var/lib/kairos-daemon
IDENTITY_PATH=$STATE_DIRECTORY/identity.json
TARGET=$PREFIX/releases/$VERSION
PAIRING_CREDENTIAL=${KAIROS_PAIRING_CREDENTIAL:-}
unset KAIROS_PAIRING_CREDENTIAL

if ! getent passwd kairos >/dev/null; then
  useradd --system --user-group --home-dir "$STATE_DIRECTORY" --shell /usr/sbin/nologin kairos
fi
[[ $(id -u kairos) != 0 ]] || kairos_fail 'the Daemon account must not be root.'
getent group kairos >/dev/null || kairos_fail 'the kairos group is unavailable.'

install -d -m 0755 -o root -g root "$PREFIX/releases"
if [[ -e $TARGET ]]; then
  [[ -d $TARGET && ! -L $TARGET ]] || kairos_fail 'the existing release path is unsafe.'
  kairos_verify_release "$TARGET"
else
  install -d -m 0755 -o root -g root "$TARGET"
  (cd "$RELEASE_ROOT" && tar -cf - .) | (cd "$TARGET" && tar -xf -)
  chown -R root:root "$TARGET"
  kairos_verify_release "$TARGET"
fi
ln -sfn "$TARGET" "$PREFIX/current.new"
mv -Tf "$PREFIX/current.new" "$PREFIX/current"

install -d -m 0750 -o root -g kairos "$CONFIG_DIRECTORY"
install -d -m 0700 -o kairos -g kairos "$STATE_DIRECTORY"
if [[ $DIRECTORY == /home/kairos/projects && ! -e $DIRECTORY ]]; then install -d -m 0750 -o kairos -g kairos "$DIRECTORY"; fi
EXPECTED_CONFIG=$STATE_DIRECTORY/.config.expected
install -m 0600 -o kairos -g kairos /dev/null "$EXPECTED_CONFIG"
printf 'KAIROS_DEVICE_SERVER_URL=%s\nKAIROS_DEVICE_IDENTITY_PATH=%s\n' \
  "$SERVER_URL" "$IDENTITY_PATH" >"$EXPECTED_CONFIG"
if [[ -f $CONFIG_DIRECTORY/config.env ]]; then
  if ! cmp -s "$EXPECTED_CONFIG" "$CONFIG_DIRECTORY/config.env"; then
    rm -f "$EXPECTED_CONFIG"
    kairos_fail 'existing configuration differs; refusing to replace another installation.'
  fi
  rm -f "$EXPECTED_CONFIG"
else
  mv "$EXPECTED_CONFIG" "$CONFIG_DIRECTORY/config.env"
fi
chown root:kairos "$CONFIG_DIRECTORY/config.env"
chmod 0640 "$CONFIG_DIRECTORY/config.env"

if [[ -e $IDENTITY_PATH ]]; then
  [[ -f $IDENTITY_PATH && ! -L $IDENTITY_PATH ]] || kairos_fail 'existing identity path is unsafe.'
  [[ $(stat -c %a "$IDENTITY_PATH") == 600 ]] || kairos_fail 'identity permissions must be 0600.'
  [[ $(stat -c %U "$IDENTITY_PATH") == kairos ]] || kairos_fail 'identity owner must be kairos.'
  EXISTING_ENV=$($PREFIX/current/bin/kairos-daemon identity-env "$IDENTITY_PATH") ||
    kairos_fail 'existing identity requires reauthorization; refusing to overwrite it.'
  [[ $EXISTING_ENV == "$ENV_ID" ]] ||
    kairos_fail 'existing identity belongs to another environment.'
elif [[ -z $PAIRING_CREDENTIAL ]]; then
  if [[ -t 0 ]]; then
    IFS= read -rsp 'Pairing credential: ' PAIRING_CREDENTIAL
    printf '\n'
  else
    IFS= read -r PAIRING_CREDENTIAL ||
      kairos_fail 'an unpaired installation requires a pairing credential on standard input.'
  fi
fi

install -m 0644 -o root -g root "$TARGET/systemd/kairos-daemon.service" \
  /etc/systemd/system/kairos-daemon.service
systemctl daemon-reload
systemctl stop kairos-daemon.service 2>/dev/null || true

set +e
printf '%s' "$PAIRING_CREDENTIAL" |
  runuser -u kairos -- "$PREFIX/current/bin/kairos-daemon" pair-once \
    --identity-path "$IDENTITY_PATH" \
    --env-id "$ENV_ID" --server-url "$SERVER_URL" --directory "$DIRECTORY" \
    --device-name "$(hostname)"
PAIR_STATUS=$?
set -e
unset PAIRING_CREDENTIAL
if [[ $PAIR_STATUS -ne 0 && $PAIR_STATUS -ne 69 ]]; then
  systemctl start kairos-daemon.service 2>/dev/null || true
  kairos_fail 'pairing failed; the environment was not reported ready.'
fi

systemctl enable kairos-daemon.service
source "$TARGET/systemd/control-home.sh"
kairos_control_resolve "$CONFIG_DIRECTORY"
kairos_control_install_link "$PREFIX"
kairos_control_write_config
"$CONTROL_LINK" start "$ENV_ID"
if ! kairos_service_uid; then
  kairos_fail 'service enablement, activity, or non-root UID verification failed.'
fi
[[ $(stat -c %a "$IDENTITY_PATH") == 600 ]] || kairos_fail 'identity verification failed.'
printf 'Manage environment %s:\n  %s status %s\n  %s stop %s\n  %s start %s\n' "$ENV_ID" "$CONTROL_LINK" "$ENV_ID" "$CONTROL_LINK" "$ENV_ID" "$CONTROL_LINK" "$ENV_ID"
printf 'stop retains the paired identity; start only starts that existing identity. Ctrl+C exits status without stopping the Daemon.\n'
if [[ $PAIR_STATUS -eq 69 ]]; then
  printf 'kairos-daemon: installed and bound; directory or capability readiness is not confirmed.\n' >&2
  exit 69
fi
printf 'kairos-daemon: installed, paired, and ready; systemd service is active as kairos.\n'
