#!/usr/bin/env bash
set -euo pipefail
set +x

RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $(uname -s) == Darwin ]]; then exec bash "$RELEASE_ROOT/macos/upgrade.sh" "$@"; fi
source "$RELEASE_ROOT/lib/platform.sh"
kairos_require_platform
kairos_require_commands sha256sum tar runuser install stat ps id tr readlink
kairos_verify_release "$RELEASE_ROOT"
VERSION=$(kairos_release_version "$RELEASE_ROOT")

PREFIX=/opt/kairos-daemon
IDENTITY_PATH=/var/lib/kairos-daemon/identity.json
CURRENT=$PREFIX/current
[[ -x $CURRENT/bin/kairos-daemon && -f $IDENTITY_PATH ]] ||
  kairos_fail 'an existing paired installation is required.'
[[ -f /etc/systemd/system/kairos-daemon.service ]] || kairos_fail 'the systemd unit is missing.'
ENV_ID=$($CURRENT/bin/kairos-daemon identity-env "$IDENTITY_PATH") || kairos_fail 'existing identity requires reauthorization.'

TARGET=$PREFIX/releases/$VERSION
if [[ -e $TARGET ]]; then
  [[ -d $TARGET && ! -L $TARGET ]] || kairos_fail 'the existing release path is unsafe.'
  kairos_verify_release "$TARGET"
else
  install -d -m 0755 -o root -g root "$TARGET"
  (cd "$RELEASE_ROOT" && tar -cf - .) | (cd "$TARGET" && tar -xf -)
  chown -R root:root "$TARGET"
  kairos_verify_release "$TARGET"
fi
PREVIOUS=$(readlink -f "$CURRENT")
[[ $PREVIOUS == "$PREFIX"/releases/* ]] || kairos_fail 'the current release link is unsafe.'

runuser -u kairos -- "$TARGET/bin/kairos-daemon" --check >/dev/null ||
  kairos_fail 'the staged candidate release cannot execute as kairos; the existing service was not stopped.'
set +e
DRAIN_VERSION=$(runuser -u kairos -- "$TARGET/bin/kairos-daemon" drain \
  --timeout-seconds 60 --identity-path "$IDENTITY_PATH")
DRAIN_STATUS=$?
set -e
if [[ $DRAIN_STATUS -ne 0 ]]; then
  kairos_fail 'maintenance draining was not confirmed; the existing service and current release were not changed.'
fi

systemctl stop kairos-daemon.service
set +e
runuser -u kairos -- "$TARGET/bin/kairos-daemon" drain \
  --timeout-seconds 60 --expected-version "$DRAIN_VERSION" --identity-path "$IDENTITY_PATH"
DRAIN_STATUS=$?
set -e
if [[ $DRAIN_STATUS -ne 0 ]]; then
  systemctl start kairos-daemon.service
  kairos_fail 'maintenance version changed; the previous release was restarted.'
fi

ln -sfn "$TARGET" "$PREFIX/current.new"
mv -Tf "$PREFIX/current.new" "$CURRENT"
source "$TARGET/systemd/control-home.sh"
kairos_control_resolve /etc/kairos-daemon
kairos_control_install_link "$PREFIX"
kairos_control_write_config
if ! $CURRENT/bin/kairos-daemon --check; then
  ln -sfn "$PREVIOUS" "$PREFIX/current.rollback"
  mv -Tf "$PREFIX/current.rollback" "$CURRENT"
  systemctl start kairos-daemon.service
  kairos_fail 'new release check failed; the previous release was restored.'
fi

set +e
runuser -u kairos -- "$CURRENT/bin/kairos-daemon" pair-once --identity-path "$IDENTITY_PATH"
READINESS_STATUS=$?
set -e
if [[ $READINESS_STATUS -ne 0 ]]; then
  ln -sfn "$PREVIOUS" "$PREFIX/current.rollback"
  mv -Tf "$PREFIX/current.rollback" "$CURRENT"
  systemctl start kairos-daemon.service
  kairos_fail 'new release readiness failed; the previous release was restored.'
fi

"$CONTROL_LINK" start "$ENV_ID"
kairos_service_uid || kairos_fail 'upgraded service is not active as kairos.'
printf 'kairos-daemon: release files are active as kairos; maintenance remains draining. Set normal mode in the GUI to resume execution.\n' >&2
exit 69
