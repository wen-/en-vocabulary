#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h:h}"
PORT="${1:-4180}"
HOST="127.0.0.1"
STARTED_LOCAL_SERVER=0
LOCAL_SERVER_PID=""

cleanup() {
  if [[ "$STARTED_LOCAL_SERVER" -eq 1 && -n "$LOCAL_SERVER_PID" ]]; then
    kill "$LOCAL_SERVER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

ensure_local_http_server() {
  if curl -fsS "http://$HOST:$PORT/index.html" >/dev/null 2>&1; then
    echo "Reusing existing local preview: http://$HOST:$PORT"
    return
  fi

  echo "Starting local HTTP preview on http://$HOST:$PORT"
  python3 -m http.server "$PORT" --bind "$HOST" --directory "$ROOT_DIR" >/dev/null 2>&1 &
  LOCAL_SERVER_PID="$!"
  STARTED_LOCAL_SERVER=1

  for _ in {1..20}; do
    if curl -fsS "http://$HOST:$PORT/index.html" >/dev/null 2>&1; then
      echo "Local preview ready: http://$HOST:$PORT"
      return
    fi
    sleep 0.25
  done

  echo "Failed to start local HTTP preview on port $PORT" >&2
  exit 1
}

ensure_local_http_server

echo "Starting public HTTPS tunnel..."
echo "When the tunnel URL appears, open it on iPhone Safari and then check the app's 设置 > 离线与安装状态。"

exec npx --yes localtunnel --port "$PORT" --local-host "$HOST"