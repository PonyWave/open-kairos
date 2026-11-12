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
    *) kairos_macos_fail 'usage: uninstall.sh [--env-id ID] [--prefix BASE_DIRECTORY]' ;;
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
if kairos_macos_owns_service; then
  kairos_macos_stop
  rm -f "$PLIST"
fi
REVOKE_STATUS=0
if [[ -f $IDENTITY_PATH ]]; then
  set +e
  "$PREFIX/current/bin/kairos-daemon" revoke --identity-path "$IDENTITY_PATH"
  REVOKE_STATUS=$?
  set -e
fi
kairos_macos_remove_control_link
rm -f "$PREFIX/current" "$PREFIX/current.new" "$IDENTITY_PATH" "$PREFIX/INSTALLATION"
rm -rf "$PREFIX/releases"
printf 'kairos-daemon: user service and managed installation were removed; project files were retained.\n'
if [[ $REVOKE_STATUS != 0 ]]; then printf 'kairos-daemon: platform revocation was not confirmed; revoke the device in the GUI.\n' >&2; exit 69; fi
