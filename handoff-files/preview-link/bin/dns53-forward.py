#!/usr/bin/env python3
"""Forward UDP 127.0.0.1:53 to local-dns on 127.0.0.1:5353.

Must be started with privileges that can bind port 53 (sudo -n).
Does not log query names that are unrelated; logs only start/errors.
"""
from __future__ import annotations

import socket
import select
import sys
import time

LISTEN = ("127.0.0.1", 53)
UPSTREAM = ("127.0.0.1", 5353)


def main() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(LISTEN)
    up = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    up.bind(("127.0.0.1", 0))
    # txn id (first 2 bytes) + a short ttl map to client addr. Collisions are rare
    # for the few names cloudflared looks up.
    pending: dict[bytes, tuple[tuple[str, int], float]] = {}
    print(f"dns53-forward listening on {LISTEN[0]}:{LISTEN[1]} -> {UPSTREAM[0]}:{UPSTREAM[1]}", flush=True)
    while True:
        now = time.time()
        for k, (_, exp) in list(pending.items()):
            if exp < now:
                pending.pop(k, None)
        r, _, _ = select.select([sock, up], [], [], 1.0)
        if sock in r:
            data, addr = sock.recvfrom(4096)
            if len(data) >= 2:
                pending[data[:2]] = (addr, now + 5)
            up.sendto(data, UPSTREAM)
        if up in r:
            data, _ = up.recvfrom(4096)
            if len(data) >= 2 and data[:2] in pending:
                dest, _ = pending.pop(data[:2])
                sock.sendto(data, dest)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PermissionError:
        print("dns53-forward: cannot bind 127.0.0.1:53 (need sudo -n)", file=sys.stderr)
        raise SystemExit(1)
