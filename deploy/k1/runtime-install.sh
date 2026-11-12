#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIRECTORY/runtime-lib.sh"
ROOT=${KAIROS_RUNTIME_ROOT:-/home/wanghailong/kairos}
NODE_VERSION=26.4.0
PNPM_VERSION=11.22.0
CADDY_VERSION=2.10.2

main() {
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
    printf 'error: k1 runtime installation requires Linux x86_64.\n' >&2
    return 1
  }
  command -v curl >/dev/null
  command -v tar >/dev/null
  command -v sha256sum >/dev/null
  command -v sha512sum >/dev/null

  local runtime="$ROOT/runtime"
  local downloads="$runtime/downloads"
  local staging="$runtime/.install-$$"
  local nodeHome="node-v$NODE_VERSION-linux-x64"
  local pnpmHome="pnpm-$PNPM_VERSION"
  local caddyHome="caddy-$CADDY_VERSION"
  local nodeArchive="node-v$NODE_VERSION-linux-x64.tar.gz"
  local nodeSums="node-v$NODE_VERSION-SHASUMS256.txt"
  local caddyArchive="caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  local caddySums="caddy_${CADDY_VERSION}_checksums.txt"
  local caddyBase="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"

  for target in "$runtime/$nodeHome" "$runtime/$pnpmHome" "$runtime/$caddyHome"; do
    [[ ! -e "$target" ]] || {
      printf 'error: Runtime target already exists: %s.\n' "$target" >&2
      return 1
    }
  done

  export HOME="$runtime/home"
  export XDG_CONFIG_HOME="$runtime/xdg-config"
  export XDG_DATA_HOME="$runtime/xdg-data"
  export XDG_CACHE_HOME="$runtime/xdg-cache"
  export TMPDIR="$runtime/tmp"
  export npm_config_cache="$runtime/npm-cache"
  export npm_config_logs_dir="$runtime/npm-logs"
  export npm_config_update_notifier=false
  mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$TMPDIR" \
    "$npm_config_cache" "$npm_config_logs_dir" "$downloads"
  mkdir "$staging"
  # shellcheck disable=SC2064
  trap "rm -rf '$staging'" EXIT

  download "https://nodejs.org/dist/v$NODE_VERSION/$nodeArchive" "$downloads/$nodeArchive"
  download "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$downloads/$nodeSums"
  download "$caddyBase/$caddyArchive" "$downloads/$caddyArchive"
  download "$caddyBase/$caddySums" "$downloads/$caddySums"
  verify_archive "$downloads/$nodeSums" "$downloads/$nodeArchive" 256
  verify_archive "$downloads/$caddySums" "$downloads/$caddyArchive" 512

  tar -xzf "$downloads/$nodeArchive" -C "$staging"
  local nodeBin="$staging/$nodeHome/bin"
  PATH="$nodeBin:$PATH" "$nodeBin/npm" install \
    --prefix "$staging/$pnpmHome" \
    --cache "$npm_config_cache" \
    --logs-dir "$npm_config_logs_dir" \
    --ignore-scripts --no-audit --no-fund "pnpm@$PNPM_VERSION"
  mkdir "$staging/$caddyHome"
  tar -xzf "$downloads/$caddyArchive" -C "$staging/$caddyHome" caddy LICENSE
  chmod 0755 "$staging/$caddyHome/caddy"

  [[ $("$nodeBin/node" --version) == "v$NODE_VERSION" ]]
  [[ $(PATH="$nodeBin:$PATH" "$staging/$pnpmHome/node_modules/.bin/pnpm" --version) == "$PNPM_VERSION" ]]
  [[ $("$staging/$caddyHome/caddy" version) == v$CADDY_VERSION\ * ]]

  mv -T "$staging/$nodeHome" "$runtime/$nodeHome"
  mv -T "$staging/$pnpmHome" "$runtime/$pnpmHome"
  mv -T "$staging/$caddyHome" "$runtime/$caddyHome"
  printf 'Node.js %s, pnpm %s and Caddy %s installed under %s.\n' \
    "$NODE_VERSION" "$PNPM_VERSION" "$CADDY_VERSION" "$runtime"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
