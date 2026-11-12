#!/usr/bin/env bash
set -euo pipefail
set +x
RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$RELEASE_ROOT/macos/common.sh"
BASE_PREFIX=$HOME/Library/Application\ Support/Kairos/daemon
ENV_ID=
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-id) ENV_ID=$2; shift 2 ;;
    --prefix) BASE_PREFIX=$2; shift 2 ;;
    *) kairos_macos_fail 'usage: upgrade.sh [--env-id ID] [--prefix BASE_DIRECTORY]' ;;
  esac
done
if [[ -n $ENV_ID ]]; then
  [[ $ENV_ID =~ ^[0-9A-Za-z._:-]{1,200}$ ]] || kairos_macos_fail 'environment ID is invalid.'
  PREFIX=$BASE_PREFIX/environments/$ENV_ID
else
  IDENTITIES=("$BASE_PREFIX"/environments/*/identity.json)
  [[ ${#IDENTITIES[@]} == 1 && -f ${IDENTITIES[0]} ]] || kairos_macos_fail 'an env-id is required when multiple or no environments are installed.'
  ENV_ID=$("$RELEASE_ROOT/bin/kairos-daemon" identity-env "${IDENTITIES[0]}") || kairos_macos_fail 'installed identity requires reauthorization.'
  PREFIX=$BASE_PREFIX/environments/$ENV_ID
fi
kairos_macos_require
kairos_macos_installed
kairos_macos_verify "$RELEASE_ROOT"
[[ -f $IDENTITY_PATH && -x $PREFIX/current/bin/kairos-daemon && -f $PLIST ]] || kairos_macos_fail 'an installed paired service is required.'
kairos_macos_owns_service || kairos_macos_fail 'the login service belongs to another installation.'
DRAIN_VERSION=$("$RELEASE_ROOT/bin/kairos-daemon" drain --timeout-seconds 60 --identity-path "$IDENTITY_PATH") || kairos_macos_fail 'maintenance draining was not confirmed.'
VERSION=$(cat "$RELEASE_ROOT/VERSION")
[[ $VERSION =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$ ]] || kairos_macos_fail 'release version is invalid.'
TARGET=$PREFIX/releases/$VERSION
if [[ ! -e $TARGET ]]; then mkdir "$TARGET"; (cd "$RELEASE_ROOT" && tar -cf - .) | (cd "$TARGET" && tar -xf -); fi
[[ ! -L $TARGET ]] || kairos_macos_fail 'release path is unsafe.'
kairos_macos_verify "$TARGET"
PREVIOUS=$(readlink "$PREFIX/current")
[[ $PREVIOUS == "$PREFIX"/releases/* ]] || kairos_macos_fail 'current release link is invalid.'
kairos_macos_stop
if ! "$RELEASE_ROOT/bin/kairos-daemon" drain --timeout-seconds 60 --expected-version "$DRAIN_VERSION" --identity-path "$IDENTITY_PATH"; then kairos_macos_start; kairos_macos_fail 'maintenance changed; previous release was restarted.'; fi
kairos_macos_link "$TARGET"
kairos_macos_control_link
if ! "$PREFIX/current/bin/kairos-daemon" --check || ! "$PREFIX/current/bin/kairos-daemon" pair-once --identity-path "$IDENTITY_PATH"; then
  kairos_macos_link "$PREVIOUS"
  kairos_macos_start
  kairos_macos_fail 'upgrade validation failed; previous release was restored.'
fi
kairos_macos_start
printf 'kairos-daemon: upgraded; maintenance remains draining until restored to normal.\n' >&2
exit 69
