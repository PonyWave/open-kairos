#!/usr/bin/env bash

kairos_fail() {
  printf 'kairos-daemon: %s\n' "$*" >&2
  exit 78
}

kairos_require_root() {
  [[ ${EUID} -eq 0 ]] || kairos_fail 'root is required only for service installation and maintenance.'
}

kairos_require_platform() {
  kairos_require_root
  [[ -r /etc/os-release ]] || kairos_fail '/etc/os-release is unavailable.'
  # The operating system owns this root-only system file.
  source /etc/os-release
  [[ ${ID:-} == ubuntu && ( ${VERSION_ID:-} == 22.04 || ${VERSION_ID:-} == 24.04 ) ]] ||
    kairos_fail 'only Ubuntu 22.04 LTS and 24.04 LTS are supported by this release.'
  [[ $(uname -m) == x86_64 ]] || kairos_fail 'only x86_64 is supported by this release.'
  [[ $(cat /proc/1/comm 2>/dev/null) == systemd ]] ||
    kairos_fail 'PID 1 must be systemd.'
  command -v systemctl >/dev/null 2>&1 || kairos_fail 'systemctl is required.'
}

kairos_require_commands() {
  local command_name
  for command_name in "$@"; do
    command -v "$command_name" >/dev/null 2>&1 ||
      kairos_fail "required command is unavailable: ${command_name}"
  done
}

kairos_verify_release() {
  local release_root=$1
  [[ -f "$release_root/SHA256SUMS" && -f "$release_root/VERSION" ]] ||
    kairos_fail 'release metadata is incomplete.'
  [[ -x "$release_root/node/bin/node" && -x "$release_root/bin/kairos-daemon" ]] ||
    kairos_fail 'release runtime is incomplete.'
  if ! (cd "$release_root" && sha256sum --quiet -c SHA256SUMS); then
    kairos_fail 'release checksum verification failed.'
  fi
}

kairos_release_version() {
  local release_root=$1
  local version
  version=$(cat "$release_root/VERSION")
  [[ $version =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$ ]] ||
    kairos_fail 'release version is invalid.'
  printf '%s' "$version"
}

kairos_service_uid() {
  local pid uid
  systemctl is-enabled --quiet kairos-daemon.service || return 1
  systemctl is-active --quiet kairos-daemon.service || return 1
  pid=$(systemctl show kairos-daemon.service --property MainPID --value)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  uid=$(ps -o uid= -p "$pid" | tr -d '[:space:]')
  [[ $uid =~ ^[0-9]+$ && $uid != 0 ]] || return 1
  [[ $uid == "$(id -u kairos)" ]] || return 1
}
