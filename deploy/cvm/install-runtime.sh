#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=26.4.0
CADDY_VERSION=2.10.2
RUNTIME=/opt/kairos/runtime

[[ $EUID -eq 0 ]] || { printf 'error: run as root.\n' >&2; exit 1; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
  printf 'error: Ubuntu x86_64 is required.\n' >&2
  exit 1
}
for command in curl tar sha256sum sha512sum awk; do command -v "$command" >/dev/null; done

NODE_HOME=$RUNTIME/node-v$NODE_VERSION-linux-x64
CADDY_HOME=$RUNTIME/caddy-$CADDY_VERSION
if [[ -x $NODE_HOME/bin/node && -x $CADDY_HOME/caddy ]]; then
  [[ $($NODE_HOME/bin/node --version) == "v$NODE_VERSION" ]]
  [[ $($CADDY_HOME/caddy version) == "v$CADDY_VERSION "* ]]
  printf 'Runtime already installed and verified.\n'
  exit 0
fi
[[ ! -e $NODE_HOME && ! -e $CADDY_HOME ]] || {
  printf 'error: incomplete runtime target exists; inspect it before retrying.\n' >&2
  exit 1
}

DOWNLOADS=$RUNTIME/downloads
STAGING=$RUNTIME/.install-$$
mkdir -p "$DOWNLOADS"
mkdir "$STAGING"
trap 'rm -rf "$STAGING"' EXIT

NODE_ARCHIVE=node-v$NODE_VERSION-linux-x64.tar.gz
NODE_SUMS=node-v$NODE_VERSION-SHASUMS256.txt
CADDY_ARCHIVE=caddy_${CADDY_VERSION}_linux_amd64.tar.gz
CADDY_SUMS=caddy_${CADDY_VERSION}_checksums.txt
CADDY_BASE=https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION

download() {
  local url=$1 target=$2
  rm -f "$target.part"
  curl --fail --location --silent --show-error --retry 3 --max-time 300 \
    "$url" --output "$target.part"
  mv "$target.part" "$target"
}

verify() {
  local sums=$1 archive=$2 algorithm=$3 expected actual length
  [[ $algorithm == 256 ]] && length=64 || length=128
  expected=$(awk -v name="$archive" '$2 == name {print $1}' "$DOWNLOADS/$sums")
  [[ $expected =~ ^[a-f0-9]{$length}$ ]] || {
    printf 'error: official checksum is missing for %s.\n' "$archive" >&2
    exit 1
  }
  actual=$("sha${algorithm}sum" "$DOWNLOADS/$archive" | awk '{print $1}')
  [[ $actual == "$expected" ]] || {
    printf 'error: checksum mismatch for %s.\n' "$archive" >&2
    exit 1
  }
}

download "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE" "$DOWNLOADS/$NODE_ARCHIVE"
download "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$DOWNLOADS/$NODE_SUMS"
download "$CADDY_BASE/$CADDY_ARCHIVE" "$DOWNLOADS/$CADDY_ARCHIVE"
download "$CADDY_BASE/$CADDY_SUMS" "$DOWNLOADS/$CADDY_SUMS"
verify "$NODE_SUMS" "$NODE_ARCHIVE" 256
verify "$CADDY_SUMS" "$CADDY_ARCHIVE" 512

tar -xzf "$DOWNLOADS/$NODE_ARCHIVE" -C "$STAGING"
mkdir "$STAGING/caddy-$CADDY_VERSION"
tar -xzf "$DOWNLOADS/$CADDY_ARCHIVE" -C "$STAGING/caddy-$CADDY_VERSION" caddy LICENSE
chmod 0755 "$STAGING/caddy-$CADDY_VERSION/caddy"
[[ $($STAGING/node-v$NODE_VERSION-linux-x64/bin/node --version) == "v$NODE_VERSION" ]]
[[ $($STAGING/caddy-$CADDY_VERSION/caddy version) == "v$CADDY_VERSION "* ]]
mv "$STAGING/node-v$NODE_VERSION-linux-x64" "$NODE_HOME"
mv "$STAGING/caddy-$CADDY_VERSION" "$CADDY_HOME"
printf 'Installed Node.js %s and Caddy %s under %s.\n' "$NODE_VERSION" "$CADDY_VERSION" "$RUNTIME"
