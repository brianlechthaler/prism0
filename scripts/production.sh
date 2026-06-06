#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is required for production startup." >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8787}"

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  npm ci
fi

npm run build
exec npm start
