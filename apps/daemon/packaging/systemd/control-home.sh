#!/usr/bin/env bash

kairos_control_resolve() {
  local config_directory=$1 passwd_entry
  CONTROL_CONFIG=$config_directory/control.env
  CONTROL_USER=${SUDO_USER:-root}
  CONTROL_HOME=
  if [[ -f $CONTROL_CONFIG ]]; then
    [[ ! -L $CONTROL_CONFIG && $(stat -c %U "$CONTROL_CONFIG") == root && $(stat -c %a "$CONTROL_CONFIG") == 644 ]] ||
      kairos_fail 'control configuration ownership or permissions are invalid.'
    source "$CONTROL_CONFIG"
  fi
  [[ $CONTROL_USER =~ ^[0-9A-Za-z._-]{1,64}$ ]] || kairos_fail 'control user is invalid.'
  passwd_entry=$(getent passwd "$CONTROL_USER") || kairos_fail 'control user does not exist.'
  CONTROL_UID=$(id -u "$CONTROL_USER")
  if [[ $CONTROL_USER == "${SUDO_USER:-}" && -n ${SUDO_UID:-} && $CONTROL_UID != "$SUDO_UID" ]]; then
    kairos_fail 'sudo user and UID do not match.'
  fi
  if [[ -z $CONTROL_HOME ]]; then
    IFS=: read -r _ _ _ _ _ CONTROL_HOME _ <<< "$passwd_entry"
  fi
  [[ $CONTROL_HOME == /* && $CONTROL_HOME != / && $CONTROL_HOME != *$'\n'* ]] ||
    kairos_fail 'control user home is invalid.'
  CONTROL_GROUP=$(id -gn "$CONTROL_USER")
  CONTROL_DIRECTORY=$CONTROL_HOME/.local/bin
  CONTROL_LINK=$CONTROL_DIRECTORY/kairos-daemon
}

kairos_control_write_config() {
  install -m 0644 -o root -g root /dev/null "$CONTROL_CONFIG"
  printf 'CONTROL_USER=%q\nCONTROL_HOME=%q\n' "$CONTROL_USER" "$CONTROL_HOME" > "$CONTROL_CONFIG"
}

kairos_control_install_link() {
  local prefix=$1 target=$1/current/systemd/control.sh
  install -d -m 0755 -o "$CONTROL_USER" -g "$CONTROL_GROUP" "$CONTROL_HOME/.local" "$CONTROL_DIRECTORY"
  if [[ -e $CONTROL_LINK || -L $CONTROL_LINK ]]; then
    [[ -L $CONTROL_LINK && $(readlink "$CONTROL_LINK") == "$target" ]] ||
      kairos_fail 'the user control entry belongs to another installation.'
  else
    ln -s "$target" "$CONTROL_LINK"
  fi
}

kairos_control_remove_link() {
  local prefix=$1 target=$1/current/systemd/control.sh
  if [[ -L $CONTROL_LINK && $(readlink "$CONTROL_LINK") == "$target" ]]; then rm -f "$CONTROL_LINK"; fi
}
