#!/usr/bin/env bash
# Run cloudflared in a mount namespace with a private /etc/hosts (no argotunnel
# override) and /etc/resolv.conf pointing at 127.0.0.1, so DNS lookups for
# region1.v2.argotunnel.com go to local-dns via dns53-forward and the resolver
# address is 127.0.0.1:53 instead of an empty ParseAddr("").
set -euo pipefail
ROOT=/workspace/preview-link
RESOLV="$ROOT/private/resolv.cloudflared"
HOSTS="$ROOT/private/hosts.cloudflared"
[[ -s "$RESOLV" && -s "$HOSTS" ]] || { echo "missing $RESOLV or $HOSTS" >&2; exit 1; }
mount --bind "$RESOLV" /etc/resolv.conf
mount --bind "$HOSTS" /etc/hosts
# Confirm the namespace view (written to stdout, which start.sh captures).
echo "cloudflared-namespace resolv=$(tr '\n' ' ' < /etc/resolv.conf)"
echo "cloudflared-namespace hosts-has-argotunnel=$(grep -c 'argotunnel.com' /etc/hosts || true)"
exec env TUNNEL_TRANSPORT_PROTOCOL=http2 \
  TUNNEL_EDGE_IP_VERSION=4 \
  TUNNEL_DNS_RESOLVER_ADDRS=10.0.0.2:53 \
  "$ROOT/bin/cloudflared" tunnel --no-autoupdate --no-prechecks --ha-connections 4 \
  --url "http://127.0.0.1:8787" \
  --logfile "$ROOT/logs/cloudflared.log" --metrics 127.0.0.1:0
