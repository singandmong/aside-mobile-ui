#!/bin/zsh
set -euo pipefail
ROOT_DIR="${0:A:h:h}"
ENV_FILE="${HOME}/.config/aside-mobile/env"
if [[ ! -r "$ENV_FILE" ]]; then
  print -u2 "Missing $ENV_FILE"
  exit 1
fi
set -a
source "$ENV_FILE"
set +a
cd "$ROOT_DIR"
exec "${BUN_BIN:-$(command -v bun)}" run src/server.ts
