#!/usr/bin/env bash
# Render Caddyfile from config.env + basic-auth hash file.
set -euo pipefail
ROOT=/workspace/preview-link
# shellcheck source=/dev/null
source "$ROOT/config.env"
HASH_FILE="$ROOT/private/basic.bcrypt"
OUT="$ROOT/Caddyfile"
[[ -s "$HASH_FILE" ]] || { echo "missing $HASH_FILE" >&2; exit 1; }
python3 - "$OUT" "$LISTEN" "$BASIC_USER" "$HASH_FILE" "${STATIC_ROOT:-}" "${API_UPSTREAM:-}" "${AUTH_ORIGIN:-}" "${UPSTREAM:-}" <<'PY'
from pathlib import Path
import sys
out, listen, user, hash_file, static_root, api_up, auth_origin, upstream = sys.argv[1:9]
hashed = Path(hash_file).read_text().strip()
listen_host, listen_port = listen.rsplit(":", 1)
for name, val in {
    "user": user, "hash": hashed, "listen_host": listen_host, "listen_port": listen_port,
    "static_root": static_root, "api_up": api_up, "auth_origin": auth_origin, "upstream": upstream,
}.items():
    if val and any(c.isspace() or c in '"\\' for c in val):
        raise SystemExit(f"unsafe value for {name}")

proxy_headers = """
		header_up Origin {origin}
		header_up Referer {origin}
		header_up X-Forwarded-Host {http.request.host}
		header_up X-Forwarded-Proto https
		header_up X-Forwarded-Ssl on
		header_up -Authorization
		# Brief tsx/watch restarts close :3100; retry instead of returning 502.
		lb_try_duration 15s
		lb_try_interval 250ms
""".replace("{origin}", auth_origin or "http://127.0.0.1:5173")

if static_root and api_up:
    origin_host = api_up
    routes = f"""
	# API (same-origin). Origin rewritten to the API's trusted web origin.
	handle /api/* {{
		reverse_proxy {api_up} {{
			header_up Host {origin_host}
{proxy_headers}		}}
		# Public link is always HTTPS. Better Auth's baseURL is http://127.0.0.1:5173,
		# so it does not set Secure by itself; add it for the browser.
		header {{
			defer
			Set-Cookie "(.+)" "$1; Secure"
		}}
	}}
	handle /rpc* {{
		reverse_proxy {api_up} {{
			header_up Host {origin_host}
{proxy_headers}		}}
	}}
	handle /.well-known/apple-app-site-association {{
		reverse_proxy {api_up} {{
			header_up Host {origin_host}
{proxy_headers}		}}
	}}
	handle /.well-known/assetlinks.json {{
		reverse_proxy {api_up} {{
			header_up Host {origin_host}
{proxy_headers}		}}
	}}

	# Direct loads of the old chat shell go to the owner dashboard picker/Home.
	@app path /app /app/*
	handle @app {{
		redir * /restaurants 302
	}}

	# Production SPA. No Vite dev server, no HMR, no Host allow-list.
	handle {{
		root * {static_root}
		encode gzip
		try_files {{path}} /index.html
		file_server
	}}
"""
    mode = f"static {static_root} api {api_up}"
else:
    up = upstream or "127.0.0.1:5173"
    routes = f"""
	reverse_proxy {up} {{
		header_up Host {up}
{proxy_headers}	}}
"""
    mode = f"upstream {up}"

text = f"""{{
	admin off
}}

:{listen_port} {{
	bind {listen_host}

	basic_auth {{
		{user} {hashed}
	}}

	@admin path /admin /admin/*
	handle @admin {{
		respond 404
	}}

	@signup path /api/auth/sign-up /api/auth/sign-up/*
	handle @signup {{
		respond 403
	}}
{routes}}}
"""
Path(out).write_text(text)
print(f"wrote {out} ({mode})")
PY
chmod 600 "$OUT"
