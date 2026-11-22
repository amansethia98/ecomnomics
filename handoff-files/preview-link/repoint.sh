#!/usr/bin/env bash
# Change the gateway upstream and reload Caddy. The Cloudflare hostname is kept if the tunnel is up.
# Usage: ./repoint.sh 127.0.0.1:5523 [http://127.0.0.1:5523]
set -euo pipefail
ROOT=/workspace/preview-link
[[ $# -ge 1 ]] || { echo "usage: $0 <host:port> [origin-url]" >&2; exit 2; }
UPSTREAM=$1
ORIGIN=${2:-http://$UPSTREAM}
# rewrite config.env keys in place
python3 - "$ROOT/config.env" "$UPSTREAM" "$ORIGIN" <<'PY'
import re, sys
from pathlib import Path
path, upstream, origin = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text()
def setk(text, key, val):
    pat = re.compile(rf'^{key}=.*$', re.M)
    line = f'{key}={val}'
    if pat.search(text):
        return pat.sub(line, text)
    return text.rstrip() + '\n' + line + '\n'
text = setk(text, 'UPSTREAM', upstream)
text = setk(text, 'UPSTREAM_ORIGIN', origin)
path.write_text(text)
print(f'set UPSTREAM={upstream} UPSTREAM_ORIGIN={origin}')
PY
exec "$ROOT/start.sh"
