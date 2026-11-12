#!/bin/sh
set -eu

for tool in node npm bash python python3 pip pip3 git curl wget jq rg file less ssh \
  tar gzip xz zip unzip rsync ps ip dig make gcc g++ pkg-config; do
  command -v "$tool" >/dev/null
done

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
python3 -m venv "$temporary/venv"
"$temporary/venv/bin/python" -m pip --version >/dev/null
"$temporary/venv/bin/python" -c 'import json, sqlite3, ssl; assert sqlite3.connect(":memory:").execute("select 1").fetchone() == (1,)'
printf '%s\n' 'int main(void) { return 0; }' > "$temporary/smoke.c"
gcc "$temporary/smoke.c" -o "$temporary/smoke"
"$temporary/smoke"
printf '%s\n' '{"ready":true}' | jq -e '.ready' >/dev/null
printf '%s\n' 'kairos sandbox tools verified'
