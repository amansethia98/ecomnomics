#!/usr/bin/env bash
set -euo pipefail
ROOT=/workspace/preview-link
LOG="$ROOT/logs"
log(){ printf '[preview-link %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
for name in watchdog cloudflared caddy edge-forward dns53-forward local-dns; do
  if [[ -f "$LOG/$name.pid" ]]; then
    pid=$(cat "$LOG/$name.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || sudo -n kill "$pid" 2>/dev/null || true
      for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -9 "$pid" 2>/dev/null || sudo -n kill -9 "$pid" 2>/dev/null || true
      log "stopped $name ($pid)"
    else
      log "$name pid $pid not running"
    fi
    rm -f "$LOG/$name.pid"
  else
    log "no $name pid file"
  fi
done
