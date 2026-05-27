#!/bin/zsh
set -e

cd "$(dirname "$0")"

echo "Starting Personal Immersive Translator..."
echo

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI was not found in PATH."
  echo "Install or open Codex first, then try again."
  read -k 1 "?Press any key to close..."
  exit 1
fi

login_status="$(codex login status 2>&1)"
if ! echo "$login_status" | grep -q "Logged in"; then
  echo "Codex is not logged in yet."
  echo "Run: codex login"
  echo
  echo "$login_status"
  read -k 1 "?Press any key to close..."
  exit 1
fi

export TRANSLATOR_BACKEND="${TRANSLATOR_BACKEND:-codex-app}"
export CODEX_MODEL="${CODEX_MODEL:-gpt-5.3-codex-spark}"

echo "Backend: $TRANSLATOR_BACKEND"
echo "Model: $CODEX_MODEL"
echo "Server: http://127.0.0.1:8787"
echo
echo "Keep this window open while translating."
echo "Logs will show prewarm, cache hits, batch size, and latency."
echo

npm start
