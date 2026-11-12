#!/bin/sh
set -eu
set +x

TARGET=$0
if [ -L "$TARGET" ]; then TARGET=$(readlink "$TARGET"); fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$TARGET")" && pwd)
RELEASE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
exec "$RELEASE_ROOT/bin/kairos-daemon" "$@"
