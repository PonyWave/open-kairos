#!/usr/bin/env bash

download() {
  local url=$1 destination=$2 partial="$2.part"
  if [[ -e "$destination" ]]; then return 0; fi
  rm -f "$partial"
  curl --fail --location --silent --show-error --retry 3 --max-time 300 "$url" --output "$partial"
  mv "$partial" "$destination"
}

official_checksum() {
  local sums=$1 archive=$2 algorithm=$3 expected length
  case "$algorithm" in
    256) length=64 ;;
    512) length=128 ;;
    *) printf 'error: Unsupported checksum algorithm %s.\n' "$algorithm" >&2; return 2 ;;
  esac
  expected=$(awk -v name="$(basename "$archive")" '$2 == name {print $1}' "$sums")
  [[ "$expected" =~ ^[a-f0-9]{$length}$ ]] || {
    printf 'error: Missing official SHA-%s checksum for %s.\n' "$algorithm" "$archive" >&2
    return 1
  }
  printf '%s\n' "$expected"
}

verify_archive() {
  local sums=$1 archive=$2 algorithm=$3 expected actual
  if ! expected=$(official_checksum "$sums" "$archive" "$algorithm"); then
    rm -f "$archive" "$sums"
    return 1
  fi
  if ! actual=$("sha${algorithm}sum" "$archive" | awk '{print $1}'); then
    rm -f "$archive"
    return 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'error: Checksum mismatch for %s.\n' "$archive" >&2
    rm -f "$archive"
    return 1
  fi
}
