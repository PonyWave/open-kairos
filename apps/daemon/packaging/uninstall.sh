#!/usr/bin/env bash
set -euo pipefail
set +x

RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $(uname -s) == Darwin ]]; then exec bash "$RELEASE_ROOT/macos/uninstall.sh" "$@"; fi
source "$RELEASE_ROOT/lib/platform.sh"
kairos_require_platform
kairos_require_commands runuser systemctl readlink

PREFIX=/opt/kairos-daemon
IDENTITY_PATH=/var/lib/kairos-daemon/identity.json
REVOKE_STATUS=1
if [[ -x $PREFIX/current/bin/kairos-daemon && -f $IDENTITY_PATH ]]; then
  systemctl stop kairos-daemon.service 2>/dev/null || true
  set +e
  runuser -u kairos -- "$PREFIX/current/bin/kairos-daemon" revoke \
    --identity-path "$IDENTITY_PATH"
  REVOKE_STATUS=$?
  set -e
fi
if [[ $REVOKE_STATUS -ne 0 ]]; then
  printf 'kairos-daemon: platform revocation was not confirmed; revoke the environment in the GUI.\n' >&2
fi

source "$RELEASE_ROOT/systemd/control-home.sh"
kairos_control_resolve /etc/kairos-daemon
kairos_control_remove_link /opt/kairos-daemon
systemctl disable --now kairos-daemon.service 2>/dev/null || true
rm -f /etc/systemd/system/kairos-daemon.service
systemctl daemon-reload
rm -f /opt/kairos-daemon/current /opt/kairos-daemon/current.new /opt/kairos-daemon/current.rollback
rm -rf /opt/kairos-daemon/releases
rm -f /etc/kairos-daemon/config.env /etc/kairos-daemon/control.env
rm -f "$IDENTITY_PATH"
printf 'kairos-daemon: local service, release files, configuration, and identity were removed; project files were retained.\n'
if [[ $REVOKE_STATUS -ne 0 ]]; then
  exit 69
fi
printf 'kairos-daemon: platform revocation was confirmed before local removal.\n'
