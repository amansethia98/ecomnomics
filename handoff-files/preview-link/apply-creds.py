#!/usr/bin/env python3
"""Apply PREVIEW_LINK_PASSWORD to the Caddy bcrypt file and/or print a Better Auth hash.

Never prints the plaintext password. Subcommands:
  bcrypt     write private/basic.bcrypt from the env var
  apphash    write Better Auth hash to the path in argv[2] (hash only, not the password)
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path("/workspace/preview-link")
BIN = ROOT / "bin"
PRIV = ROOT / "private"
ENV = "PREVIEW_LINK_PASSWORD"


def password() -> str:
    pw = os.environ.get(ENV, "")
    if len(pw) < 8:
        raise SystemExit(f"{ENV} is missing or too short")
    if "\n" in pw or "\r" in pw:
        raise SystemExit(f"{ENV} must be a single line")
    return pw


def cmd_bcrypt() -> int:
    pw = password()
    proc = subprocess.run(
        [str(BIN / "caddy"), "hash-password"],
        input=(pw + "\n").encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        sys.stderr.write("caddy hash-password failed\n")
        return 1
    hashed = proc.stdout.decode().strip()
    if not hashed.startswith("$2") or len(hashed) < 40:
        sys.stderr.write("caddy hash-password produced an unexpected hash\n")
        return 1
    PRIV.mkdir(mode=0o700, exist_ok=True)
    out = PRIV / "basic.bcrypt"
    out.write_text(hashed)
    out.chmod(0o600)
    print(f"wrote {out} (bcrypt, length {len(hashed)})")
    return 0


def cmd_apphash(path: str) -> int:
    # Hash via the existing node helper, passing the password on stdin of a
    # tiny node script so it never appears on a command line.
    pw = password()
    script = ROOT / "set-app-password.mjs"
    proc = subprocess.run(
        ["node", str(script), "--stdin", os.environ.get("APP_EMAIL", "${APP_EMAIL}")],
        input=pw.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr.decode() or "set-app-password failed\n")
        return 1
    hashed = proc.stdout.decode().strip()
    if len(hashed) < 80:
        sys.stderr.write("app hash too short\n")
        return 1
    email = os.environ.get("APP_EMAIL", "${APP_EMAIL}")
    if not all(c.isalnum() or c in "@._+-" for c in email):
        sys.stderr.write("unexpected email\n")
        return 1
    if "'" in hashed:
        sys.stderr.write("unexpected hash\n")
        return 1
    sql = (
        "UPDATE account SET password = '%s', \"updatedAt\" = NOW()\n"
        "FROM \"user\" u\n"
        "WHERE account.\"userId\" = u.id AND lower(u.email) = lower('%s');\n"
        % (hashed, email)
    )
    p = Path(path)
    p.write_text(sql)
    p.chmod(0o600)
    print(f"wrote app password SQL ({len(hashed)}-char hash)")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "bcrypt":
        raise SystemExit(cmd_bcrypt())
    if cmd == "apphash":
        raise SystemExit(cmd_apphash(sys.argv[2]))
    raise SystemExit("usage: apply-creds.py bcrypt|apphash <path>")
