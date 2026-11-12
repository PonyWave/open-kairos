#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export KAIROS_MODEL_ENV_FILE="${KAIROS_MODEL_ENV_FILE:-$ROOT/.env}"
export KAIROS_RUN_REAL_MODEL="${KAIROS_RUN_REAL_MODEL:-1}"

TEST_FILE="$ROOT/apps/server/src/integration/real-model.test.ts"
if [[ "${1:-}" == "thinking" ]]; then
  TEST_FILE="$ROOT/apps/server/src/integration/real-model-thinking.test.ts"
fi
if [[ "${1:-}" == "recap" ]]; then
  TEST_FILE="$ROOT/apps/server/src/integration/real-model-recap.test.ts"
fi
if [[ "${1:-}" == "recall" ]]; then
  TEST_FILE="$ROOT/apps/server/src/integration/recall-real-model.test.ts"
fi
if [[ "${1:-}" == "slash-commands" ]]; then
  TEST_FILE="$ROOT/apps/server/src/integration/compact-real-model.test.ts"
fi
if [[ "${1:-}" == "attachment" ]]; then
  TEST_FILE="$ROOT/apps/server/src/integration/real-model-attachment.test.ts"
fi
if [[ "${1:-}" == "background-guidance" ]]; then
  TEST_FILE="$ROOT/apps/server/src/integration/background-guidance-real-model.test.ts"
fi

node --env-file-if-exists="$KAIROS_MODEL_ENV_FILE" "$ROOT/node_modules/vitest/vitest.mjs" run "$TEST_FILE"
