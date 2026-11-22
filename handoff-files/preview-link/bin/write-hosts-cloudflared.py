#!/usr/bin/env python3
"""Write private/hosts.cloudflared without the argotunnel /etc/hosts override."""
import re
from pathlib import Path

src = Path("/etc/hosts").read_text()
src = re.sub(
    r"\n?# ecomnomics-preview-link begin\n.*?# ecomnomics-preview-link end\n?",
    "\n",
    src,
    flags=re.S,
)
lines = []
for line in src.splitlines(True):
    if "region1.v2.argotunnel.com" in line or "region2.v2.argotunnel.com" in line:
        continue
    lines.append(line)
src = "".join(lines)
if "localhost" not in src:
    src = "127.0.0.1 localhost\n" + src
out = Path("/workspace/preview-link/private/hosts.cloudflared")
out.write_text(src)
print(f"wrote {out}")
