#!/usr/bin/env bash
# Start (or refresh) the private preview gateway and Cloudflare quick tunnel.
# Idempotent. Never prints passwords. Updates PUBLIC_URL in ACCESS.txt.
# Passwords come from PREVIEW_LINK_PASSWORD (or the stored Caddy bcrypt hash).
# They are not stored in ACCESS.txt.
set -euo pipefail
ROOT=/workspace/preview-link
BIN="$ROOT/bin"
LOG="$ROOT/logs"
PRIV="$ROOT/private"
# shellcheck source=/dev/null
source "$ROOT/config.env"
mkdir -p "$LOG" "$PRIV"
chmod 700 "$PRIV"
export PATH="$BIN:$PATH"

log(){ printf '[preview-link %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die(){ log "ERROR: $*"; exit 1; }

# ---------- credentials ----------
# Prefer the env var Aman set. Caddy only needs the bcrypt hash after that.
caddy_reload=0
if [[ -n "${PREVIEW_LINK_PASSWORD:-}" ]]; then
  python3 "$ROOT/apply-creds.py" bcrypt || die "failed to hash basic-auth password"
  caddy_reload=1
  log "updated Caddy bcrypt hash from PREVIEW_LINK_PASSWORD"
  HASH_SQL="$PRIV/set-password.sql"
  export APP_EMAIL
  python3 "$ROOT/apply-creds.py" apphash "$HASH_SQL" || die "failed to hash app password"
  rows=$(sudo -n docker exec -i ecomnomics-agentv1-postgres-1 psql -U postgres -d agentv1 -v ON_ERROR_STOP=1 -tA < "$HASH_SQL" | tail -1)
  rm -f "$HASH_SQL"
  log "updated app password for $APP_EMAIL (psql said: $rows)"
elif [[ -s "$PRIV/basic.bcrypt" ]]; then
  log "PREVIEW_LINK_PASSWORD not set; using stored Caddy bcrypt hash"
else
  die "PREVIEW_LINK_PASSWORD is not set and $PRIV/basic.bcrypt is missing"
fi
# Drop any leftover plaintext copies and password keys in ACCESS.txt
rm -f "$PRIV/basic.plain" "$PRIV/basic.plain.nl" "$PRIV/app.plain"
python3 "$ROOT/access.py" set BASIC_USER "$BASIC_USER"
python3 "$ROOT/access.py" set APP_EMAIL "$APP_EMAIL"
python3 "$ROOT/access.py" set UPSTREAM "$UPSTREAM"
python3 "$ROOT/access.py" set LISTEN "$LISTEN"
python3 "$ROOT/access.py" strip-secrets

"$ROOT/generate-caddyfile.sh" >/dev/null

# ---------- check upstream ----------
if [[ -n "${STATIC_ROOT:-}" && -n "${API_UPSTREAM:-}" ]]; then
  if [[ ! -d "$STATIC_ROOT" || ! -f "$STATIC_ROOT/index.html" ]]; then
    die "STATIC_ROOT $STATIC_ROOT is missing index.html"
  fi
  if ! curl -sf --max-time 5 "http://$API_UPSTREAM/health" >/dev/null; then
    log "WARNING: API http://$API_UPSTREAM/health is not answering. Gateway will start anyway."
  else
    log "API http://$API_UPSTREAM/health is up; serving static $STATIC_ROOT"
  fi
else
  if ! curl -sf --max-time 5 "http://$UPSTREAM/" >/dev/null; then
    log "WARNING: upstream http://$UPSTREAM/ is not answering. Gateway will start anyway."
  else
    log "upstream http://$UPSTREAM/ is up"
  fi
fi

# ---------- helpers: local DNS + edge forwarder ----------
ensure_bg(){
  local name=$1; shift
  if [[ -f $LOG/$name.pid ]] && kill -0 "$(cat $LOG/$name.pid)" 2>/dev/null; then
    log "$name already running (pid $(cat $LOG/$name.pid))"
    return
  fi
  nohup "$@" >"$LOG/$name.log" 2>&1 &
  echo $! > "$LOG/$name.pid"
  log "started $name pid $(cat $LOG/$name.pid)"
}
# Point Cloudflare edge hostnames at the local forwarder. Needed because the box
# resolver otherwise returns a fake IP and cloudflared never reaches 127.0.0.1:7844.
if ! grep -q "ecomnomics-preview-link begin" /etc/hosts; then
  sudo -n tee -a /etc/hosts >/dev/null <<'H'
# ecomnomics-preview-link begin
127.0.0.1 region1.v2.argotunnel.com region2.v2.argotunnel.com
# ecomnomics-preview-link end
H
  log "added /etc/hosts override for argotunnel.com (127.0.0.1)"
fi
ensure_bg local-dns python3 "$BIN/local-dns.py"
# Privileged UDP forwarder so cloudflared's resolver (port 53) can reach local-dns.
start_dns53(){
  if [[ -f "$LOG/dns53-forward.pid" ]] && kill -0 "$(cat "$LOG/dns53-forward.pid")" 2>/dev/null; then
    log "dns53-forward already running (pid $(cat $LOG/dns53-forward.pid))"
    return 0
  fi
  if sudo -n "$BIN/dns53-forward.py" >>"$LOG/dns53-forward.log" 2>&1 & then
    echo $! > "$LOG/dns53-forward.pid"
    for i in $(seq 1 20); do
      if python3 -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(0.3);s.sendto(b'\x00',('127.0.0.1',53))" 2>/dev/null; then
        log "started dns53-forward pid $(cat $LOG/dns53-forward.pid)"
        return 0
      fi
      sleep 0.2
    done
    log "WARNING: dns53-forward started but 127.0.0.1:53 is not ready yet"
  else
    log "WARNING: sudo -n dns53-forward failed; DNS ParseAddr fix may not apply"
    rm -f "$LOG/dns53-forward.pid"
  fi
}
start_dns53
# Private views for the cloudflared mount namespace: no /etc/hosts short-circuit.
printf 'nameserver 127.0.0.1\n' > "$ROOT/private/resolv.cloudflared"
python3 "$BIN/write-hosts-cloudflared.py"
ensure_bg edge-forward python3 "$BIN/edge-forward.py"

# ---------- Caddy ----------
restart_caddy(){
  if [[ -f "$LOG/caddy.pid" ]]; then
    local pid
    pid=$(cat "$LOG/caddy.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$LOG/caddy.pid"
  fi
  nohup "$BIN/caddy" run --config "$ROOT/Caddyfile" --pidfile "$LOG/caddy.pid" \
    >"$LOG/caddy.log" 2>&1 &
}

caddy_up=0
if [[ $caddy_reload -eq 0 && -f "$LOG/caddy.pid" ]] && kill -0 "$(cat "$LOG/caddy.pid")" 2>/dev/null; then
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://$LISTEN/" || echo 000)
  if [[ "$code" == "401" ]]; then
    log "Caddy already running (pid $(cat $LOG/caddy.pid))"
    caddy_up=1
  else
    log "Caddy pid is up but not answering (http $code); restarting"
  fi
fi
if [[ $caddy_up -eq 0 ]]; then
  if [[ $caddy_reload -eq 1 ]]; then
    log "restarting Caddy to pick up the new basic-auth hash"
  fi
  restart_caddy
fi
for i in $(seq 1 30); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 1 "http://$LISTEN/" || echo 000)
  [[ "$code" == "401" ]] && break
  sleep 0.3
done
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://$LISTEN/" || echo 000)
[[ "$code" == "401" ]] || die "Caddy did not start (http $code); see $LOG/caddy.log"
log "Caddy listening on $LISTEN (unauthenticated -> 401)"

# ---------- cloudflared quick tunnel ----------
# Keep an existing tunnel if it is still running so the hostname stays stable.
if [[ -f "$LOG/cloudflared.pid" ]] && kill -0 "$(cat "$LOG/cloudflared.pid")" 2>/dev/null; then
  log "cloudflared already running (pid $(cat $LOG/cloudflared.pid)); keeping current hostname"
else
  : > "$LOG/cloudflared.log"
  : > "$LOG/cloudflared.stdout"
  # Edge dials go to 127.0.0.1:7844 (local DNS / hosts) and the forwarder CONNECTs through
  # the box egress proxy to a real Cloudflare edge address on port 7844.
  nohup unshare -r --mount "$BIN/run-cloudflared.sh" \
    >"$LOG/cloudflared.stdout" 2>&1 &
  echo $! > "$LOG/cloudflared.pid"
  log "started cloudflared pid $(cat $LOG/cloudflared.pid) in a mount namespace; waiting for URL"
fi

URL=""
for i in $(seq 1 60); do
  URL=$(rg -o --no-filename 'https://[a-z0-9-]+\.trycloudflare.com' "$LOG/cloudflared.log" "$LOG/cloudflared.stdout" 2>/dev/null | tail -1 || true)
  [[ -n "$URL" ]] && break
  sleep 1
done
if [[ -z "$URL" ]]; then
  die "no trycloudflare URL after 60s; see $LOG/cloudflared.log"
fi
python3 "$ROOT/access.py" set PUBLIC_URL "$URL"
log "public URL written to ACCESS.txt (hostname only: ${URL#https://})"
connected=0
for i in $(seq 1 30); do
  if rg -q 'Registered tunnel connection|connection established|Connected to the Cloudflare' "$LOG/cloudflared.log" "$LOG/cloudflared.stdout" 2>/dev/null; then
    connected=1
    break
  fi
  sleep 1
done
if [[ $connected -eq 1 ]]; then
  log "cloudflared reports an edge connection"
else
  log "WARNING: got a hostname but no edge connection yet; see $LOG/cloudflared.log"
fi
ensure_bg watchdog python3 "$BIN/watchdog.py"
log "done. Logins use PREVIEW_LINK_PASSWORD (not stored in ACCESS.txt). Stop with $ROOT/stop.sh"
