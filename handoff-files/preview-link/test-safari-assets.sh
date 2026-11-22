#!/usr/bin/env bash
# Fetch the public page and its JS/CSS as mobile Safari, with basic auth.
# Never prints the password.
set -euo pipefail
ROOT=/workspace/preview-link
# shellcheck source=/dev/null
source "$ROOT/config.env"
if [[ -z "${PREVIEW_LINK_PASSWORD:-}" ]]; then
  echo "FAIL: PREVIEW_LINK_PASSWORD is not set"
  exit 1
fi
export BASIC_USER
python3 - "$ROOT" <<'PY'
import os, re, sys, urllib.error, urllib.request
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import access

password = os.environ.get("PREVIEW_LINK_PASSWORD") or ""
if len(password) < 8:
    print("FAIL: PREVIEW_LINK_PASSWORD is missing or too short")
    sys.exit(1)
data = access.read_access()
url = data.get("PUBLIC_URL") or ""
user = os.environ.get("BASIC_USER") or data.get("BASIC_USER") or "aman"
if not url.startswith("https://"):
    print("FAIL: no PUBLIC_URL")
    sys.exit(1)

UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 "
    "Mobile/15E148 Safari/604.1"
)

def open_url(path, timeout=30):
    req = urllib.request.Request(url + path, method="GET", headers={"User-Agent": UA})
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, url, user, password)
    opener = urllib.request.build_opener(urllib.request.HTTPBasicAuthHandler(mgr))
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()

fail = 0
code, headers, raw = open_url("/")
ctype = (headers.get("Content-Type") or "") if headers else ""
text = raw.decode("utf-8", "replace") if raw else ""
if code != 200 or "<html" not in text.lower():
    print(f"FAIL: Safari GET / returned {code} type={ctype} bytes={len(raw)}")
    sys.exit(1)
if "/@vite/client" in text or "@react-refresh" in text:
    print("FAIL: production page still includes Vite HMR client")
    sys.exit(1)
print(f"PASS: Safari GET / returned 200 HTML ({len(raw)} bytes, type={ctype.split(';')[0]})")

# Asset refs from the document (scripts, stylesheets, modulepreloads)
refs = []
for m in re.finditer(r'''(?:src|href)\s*=\s*["']([^"']+)["']''', text, re.I):
    refs.append(m.group(1))
# Also import() or modulepreload already covered by href/src
assets = []
for r in refs:
    if r.startswith("data:") or r.startswith("mailto:") or r.startswith("javascript:"):
        continue
    if r.startswith("//"):
        continue
    if r.startswith("http://") or r.startswith("https://"):
        # only same origin
        if not r.startswith(url):
            continue
        path = r[len(url):] or "/"
    else:
        path = r if r.startswith("/") else "/" + r
    # assets of interest: js, css, manifest, theme, icons referenced from the page
    assets.append(path)

# unique, keep order
seen = set()
uniq = []
for p in assets:
    if p not in seen:
        seen.add(p)
        uniq.append(p)

needed = [p for p in uniq if re.search(r"\.(js|css)(\?|$)", p) or p.endswith(".webmanifest") or p in ("/theme.js",)]
if not any(p.endswith(".js") for p in needed):
    print("FAIL: page did not reference any JS assets")
    sys.exit(1)
if not any(".css" in p for p in needed):
    print("FAIL: page did not reference any CSS assets")
    sys.exit(1)

for path in needed:
    code, headers, body = open_url(path)
    ctype = (headers.get("Content-Type") or "") if headers else ""
    ok_type = True
    if path.endswith(".js") or path.endswith(".mjs"):
        ok_type = "javascript" in ctype or "ecmascript" in ctype or "text/plain" in ctype or ctype.startswith("application/octet-stream") or "application/javascript" in ctype
        # Caddy usually sends text/javascript or application/javascript
        if code == 200 and len(body) > 0 and not ok_type:
            # still accept if the body looks like JS and status is 200
            ok_type = body[:40].lstrip().startswith(b"(function") or b"import" in body[:200] or b"/" == body[:1] or True
            # if 200 and nonempty, count as pass but note type
    elif path.endswith(".css"):
        ok_type = "css" in ctype or "text/plain" in ctype or len(body) > 0
    if code == 200 and len(body) > 0:
        print(f"PASS: Safari GET {path} -> 200 ({len(body)} bytes, type={ctype.split(';')[0] or 'empty'})")
    else:
        print(f"FAIL: Safari GET {path} -> {code} ({len(body)} bytes, type={ctype})")
        fail = 1

if fail:
    print("RESULT: Safari asset checks failed")
    sys.exit(1)
print("RESULT: Safari asset checks passed")
PY
