#!/usr/bin/env bash
# Temporary local-only preview at 127.0.0.1:8789 with an injected owner session.
# Not exposed through the Cloudflare tunnel. Never prints the password or cookie.
set -euo pipefail
ROOT=/workspace/preview-link
LOG="$ROOT/logs"
mkdir -p "$LOG" "$ROOT/private"
if [[ -z "${PREVIEW_LINK_PASSWORD:-}" ]]; then
  echo "FAIL: PREVIEW_LINK_PASSWORD is not set"
  exit 1
fi
python3 "$ROOT/bin/write-verify-caddy.py"
# Stop a previous verify listener if any.
if [[ -f "$LOG/caddy-verify.pid" ]]; then
  pid=$(cat "$LOG/caddy-verify.pid")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$LOG/caddy-verify.pid"
fi
nohup "$ROOT/bin/caddy" run --config "$ROOT/private/Caddyfile.verify" --pidfile "$LOG/caddy-verify.pid" \
  >"$LOG/caddy-verify.log" 2>&1 &
for i in $(seq 1 30); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:8789/ || echo 000)
  [[ "$code" == "200" || "$code" == "302" ]] && break
  sleep 0.2
done
echo "verify listener http://127.0.0.1:8789/ status=$code (expected 200, no basic auth)"
# Confirm bind is localhost only
ss -lptn | awk '/:8789/ {print}'
