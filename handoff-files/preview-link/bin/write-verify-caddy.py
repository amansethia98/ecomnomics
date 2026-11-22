#!/usr/bin/env python3
"""Create the temporary 127.0.0.1:8789 Caddyfile. Never prints secrets."""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/workspace/preview-link")
PRIVATE = ROOT / "private"
COOKIE_FILE = PRIVATE / "verify.session.set-cookie"
CADDYFILE = PRIVATE / "Caddyfile.verify"
EMAIL = "${APP_EMAIL}"
API = "http://127.0.0.1:3100"
AUTH_ORIGIN = "http://127.0.0.1:5173"
STATIC = "/workspace/preview-link/web-dist"


def sign_in() -> str:
    password = os.environ.get("PREVIEW_LINK_PASSWORD") or ""
    if len(password) < 8:
        raise SystemExit("PREVIEW_LINK_PASSWORD is missing or too short")
    body = json.dumps({"email": EMAIL, "password": password}, separators=(",", ":")).encode()
    req = urllib.request.Request(
        f"{API}/api/auth/sign-in/email",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": AUTH_ORIGIN,
            "Referer": AUTH_ORIGIN + "/sign-in",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            headers = resp.headers
            status = resp.status
    except urllib.error.HTTPError as e:
        raise SystemExit(f"sign-in for verify listener failed: http {e.code}") from e
    if status != 200:
        raise SystemExit(f"sign-in for verify listener failed: http {status}")
    cookies = headers.get_all("Set-Cookie") or []
    token = None
    for c in cookies:
        if c.lower().startswith("better-auth.session_token="):
            token = c
            break
    if not token:
        raise SystemExit("sign-in succeeded but no session cookie was returned")
    pair = token.split(";", 1)[0].strip()
    name, _, value = pair.partition("=")
    if name != "better-auth.session_token" or not value:
        raise SystemExit("session cookie was empty or unexpected")
    set_cookie = f"{name}={value}; Path=/; HttpOnly; SameSite=Lax"
    PRIVATE.mkdir(parents=True, exist_ok=True)
    COOKIE_FILE.write_text(set_cookie + "\n")
    COOKIE_FILE.chmod(0o600)
    print(
        f"wrote session cookie file ({COOKIE_FILE.name}, value_len={len(value)}, "
        "flags=HttpOnly; SameSite=Lax; Path=/; no Secure)"
    )
    return set_cookie


def caddy_quote(value: str) -> str:
    # Quoted Caddy token; escape backslash, quotes, and placeholder braces.
    out = value.replace("\\", "\\\\").replace('"', '\\"').replace("{", "\\{").replace("}", "\\}")
    return '"' + out + '"'


def write_caddyfile(set_cookie: str) -> None:
    quoted = caddy_quote(set_cookie)
    text = f"""{{
	admin off
}}

:8789 {{
	bind 127.0.0.1

	header {{
		defer
		Set-Cookie {quoted}
	}}

	@admin path /admin /admin/*
	handle @admin {{
		respond 404
	}}

	@signup path /api/auth/sign-up /api/auth/sign-up/*
	handle @signup {{
		respond 403
	}}

	@app path /app /app/*
	handle @app {{
		redir * /restaurants 302
	}}

	handle /api/* {{
		reverse_proxy 127.0.0.1:3100 {{
			header_up Host 127.0.0.1:3100
			header_up Origin {AUTH_ORIGIN}
			header_up Referer {AUTH_ORIGIN}
			header_up X-Forwarded-Host 127.0.0.1:8789
			header_up X-Forwarded-Proto http
			header_up -Authorization
			lb_try_duration 15s
			lb_try_interval 250ms
		}}
	}}

	handle /rpc* {{
		reverse_proxy 127.0.0.1:3100 {{
			header_up Host 127.0.0.1:3100
			header_up Origin {AUTH_ORIGIN}
			header_up Referer {AUTH_ORIGIN}
			header_up X-Forwarded-Host 127.0.0.1:8789
			header_up X-Forwarded-Proto http
			header_up -Authorization
			lb_try_duration 15s
			lb_try_interval 250ms
		}}
	}}

	handle {{
		root * {STATIC}
		encode gzip
		try_files {{path}} /index.html
		file_server
	}}
}}
"""
    CADDYFILE.write_text(text)
    CADDYFILE.chmod(0o600)
    # Sanity: the written file must not be world-readable and must listen locally.
    if not re.search(r"bind 127\.0\.0\.1", text) or ":8789" not in text:
        raise SystemExit("verify Caddyfile missing bind or port")
    if "basic_auth" in text:
        raise SystemExit("verify Caddyfile must not use basic_auth")
    print(f"wrote {CADDYFILE.name} (mode 600, 127.0.0.1:8789, no basic auth, no tunnel)")


def main() -> int:
    write_caddyfile(sign_in())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
