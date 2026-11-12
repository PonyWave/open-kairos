#!/usr/bin/env bash
set -euo pipefail
set +x

TARGET=$0
if [[ -L $TARGET ]]; then TARGET=$(readlink "$TARGET"); fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$TARGET")" && pwd)
RELEASE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
source "$RELEASE_ROOT/lib/platform.sh"

if [[ $# != 2 ]]; then kairos_fail 'usage: kairos-daemon start|status|stop <env-id>'; fi
COMMAND=$1
ENV_ID=$2
[[ $COMMAND == start || $COMMAND == status || $COMMAND == stop ]] || kairos_fail 'usage: kairos-daemon start|status|stop <env-id>'
[[ $ENV_ID =~ ^[0-9A-Za-z._:-]{1,200}$ ]] || kairos_fail 'environment ID is invalid.'
IDENTITY_PATH=/var/lib/kairos-daemon/identity.json
DAEMON_UID=$(id -u kairos)

if [[ $(id -u) == "$DAEMON_UID" ]]; then
  [[ $COMMAND == status ]] || kairos_fail 'the service account may only observe Daemon status.'
  exec "$RELEASE_ROOT/bin/kairos-daemon" status "$ENV_ID"
fi

if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || kairos_fail 'sudo is required for Daemon service control.'
  exec sudo "$TARGET" "$@"
fi

case $COMMAND in
  start)
    EXISTING_ENV=$(runuser -u kairos -- "$RELEASE_ROOT/bin/kairos-daemon" identity-env "$IDENTITY_PATH") ||
      kairos_fail 'a paired identity owned by kairos is required; start does not pair.'
    [[ $EXISTING_ENV == "$ENV_ID" ]] || kairos_fail 'the command env-id does not match the paired identity.'
    if systemctl is-active --quiet kairos-daemon.service; then
      kairos_service_uid || kairos_fail 'the active Daemon is not running as kairos.'
      printf 'kairos-daemon: already running.\n'
    else
      systemctl start kairos-daemon.service
      kairos_service_uid || kairos_fail 'the Daemon did not start as kairos.'
      printf 'kairos-daemon: started.\n'
    fi
    ;;
  stop)
    if [[ -f $IDENTITY_PATH ]]; then
      EXISTING_ENV=$(runuser -u kairos -- "$RELEASE_ROOT/bin/kairos-daemon" identity-env "$IDENTITY_PATH") ||
        kairos_fail 'the paired identity could not be verified; stop did not change it.'
      [[ $EXISTING_ENV == "$ENV_ID" ]] || kairos_fail 'the command env-id does not match the paired identity.'
    fi
    if systemctl is-active --quiet kairos-daemon.service; then
      systemctl stop kairos-daemon.service
      printf 'kairos-daemon: stopped; identity was retained.\n'
    else
      printf 'kairos-daemon: already stopped.\n'
    fi
    ;;
  status)
    exec runuser -u kairos -- "$RELEASE_ROOT/bin/kairos-daemon" status "$ENV_ID"
    ;;
esac
