#!/usr/bin/env python3
"""Manage ACCESS.txt without printing secret values."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ACCESS = Path("/workspace/preview-link/ACCESS.txt")
NOTE = (
    "# Aman set his own password. It is not stored here.\n"
    "# start.sh and test-public.sh read PREVIEW_LINK_PASSWORD from the environment.\n"
    "# Caddy uses the bcrypt hash in private/basic.bcrypt (not the plain value).\n"
)

# Never persist these in ACCESS.txt.
SECRET_KEYS = {"BASIC_PASSWORD", "APP_PASSWORD"}


def read_access() -> dict[str, str]:
    data: dict[str, str] = {}
    if not ACCESS.exists():
        return data
    for line in ACCESS.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        data[k.strip()] = v
    return data


def write_access(data: dict[str, str]) -> None:
    ACCESS.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Private preview access. Do not share or commit. chmod 600.",
        f"# Updated: {__import__('datetime').datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}",
    ]
    # Always include the owner-set note; never write password values.
    lines.extend(NOTE.splitlines())
    order = [
        "PUBLIC_URL",
        "BASIC_USER",
        "APP_EMAIL",
        "UPSTREAM",
        "LISTEN",
    ]
    seen = set()
    for k in order:
        if k in data and k not in SECRET_KEYS:
            lines.append(f"{k}={data[k]}")
            seen.add(k)
    for k, v in data.items():
        if k not in seen and k not in SECRET_KEYS:
            lines.append(f"{k}={v}")
    ACCESS.write_text("\n".join(lines) + "\n")
    os.chmod(ACCESS, 0o600)


def cmd_get(key: str) -> int:
    if key in SECRET_KEYS:
        return 1
    data = read_access()
    if key not in data:
        return 1
    sys.stdout.write(data[key])
    return 0


def cmd_set(key: str, value: str) -> int:
    if key in SECRET_KEYS:
        return 1
    data = read_access()
    data[key] = value
    write_access(data)
    return 0


def cmd_set_from_file(key: str, path: str) -> int:
    value = Path(path).read_text().replace("\n", "")
    return cmd_set(key, value)


def cmd_has(key: str) -> int:
    data = read_access()
    return 0 if data.get(key) else 1


def cmd_strip_secrets() -> int:
    data = read_access()
    write_access(data)
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "get":
        raise SystemExit(cmd_get(sys.argv[2]))
    if cmd == "set":
        raise SystemExit(cmd_set(sys.argv[2], sys.argv[3]))
    if cmd == "set-from-file":
        raise SystemExit(cmd_set_from_file(sys.argv[2], sys.argv[3]))
    if cmd == "has":
        raise SystemExit(cmd_has(sys.argv[2]))
    if cmd == "strip-secrets":
        raise SystemExit(cmd_strip_secrets())
    raise SystemExit(f"unknown command {cmd}")
