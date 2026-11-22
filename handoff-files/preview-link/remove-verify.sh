#!/usr/bin/env bash
# Tear down the temporary 127.0.0.1:8789 verify listener and delete the session cookie files.
set -euo pipefail
ROOT=/workspace/preview-link
LOG="$ROOT/logs"
if [[ -f "$LOG/caddy-verify.pid" ]]; then
  pid=$(cat "$LOG/caddy-verify.pid")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped caddy-verify ($pid)"
  else
    echo "caddy-verify pid $pid not running"
  fi
  rm -f "$LOG/caddy-verify.pid"
else
  echo "no caddy-verify pid file"
fi
# In case the pid file was lost, stop anything bound only to 127.0.0.1:8789
if ss -lptn | rg -q '127\.0\.0\.1:8789'; then
  # Do not use a broad pkill of all caddy — the public :8787 listener must stay up.
  echo "WARNING: something is still listening on 127.0.0.1:8789; not force-killing all caddy"
fi
rm -f "$ROOT/private/Caddyfile.verify" "$ROOT/private/verify.session.set-cookie" "$ROOT/private/caddy-verify.json"
echo "removed verify cookie and Caddy config"
# Confirm 8787 still up and 8789 is gone
c8787=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8787/ || echo 000)
c8789=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8789/ || echo 000)
echo "after removal: :8787=$c8787 (should be 401), :8789=$c8789 (should be 000)"
