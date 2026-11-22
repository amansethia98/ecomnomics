#!/usr/bin/env python3
"""Forward TCP 127.0.0.1:7844 to Cloudflare's tunnel edge via the box HTTP CONNECT proxy.

cloudflared on this box resolves edge hostnames to a fake IP and cannot use HTTP_PROXY
for the edge dial. This process lets it connect to localhost; we then CONNECT to a real
edge address (learned over DoH) through 127.0.0.1:8791.
"""
from __future__ import annotations

import json
import logging
import os
import select
import socket
import threading
import time
import urllib.request

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("EDGE_FORWARD_PORT", "7844"))
PROXY = os.environ.get("CONNECT_PROXY", "127.0.0.1:8791")
EDGE_HOST = os.environ.get("EDGE_HOST", "region1.v2.argotunnel.com")
EDGE_PORT = int(os.environ.get("EDGE_PORT", "7844"))
DOH = "https://cloudflare-dns.com/dns-query?name={name}&type=A"
LOG = logging.getLogger("edge-forward")

def set_keepalive(sock: socket.socket) -> None:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    # Detect a silent mid-path drop on the HTTP CONNECT hop within about a minute.
    if hasattr(socket, "TCP_KEEPIDLE"):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 30)
    if hasattr(socket, "TCP_KEEPINTVL"):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
    if hasattr(socket, "TCP_KEEPCNT"):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)


_edge_ips: list[str] = []
_edge_lock = threading.Lock()


def refresh_ips() -> list[str]:
    url = DOH.format(name=EDGE_HOST)
    req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode())
    ips = [a["data"] for a in data.get("Answer") or [] if a.get("type") == 1]
    if not ips:
        raise RuntimeError("DoH returned no A records")
    with _edge_lock:
        _edge_ips[:] = ips
    LOG.info("edge IPs for %s: %s", EDGE_HOST, ", ".join(ips))
    return ips


def current_ips() -> list[str]:
    with _edge_lock:
        return list(_edge_ips)


def refresher():
    while True:
        time.sleep(300)
        try:
            refresh_ips()
        except Exception:
            LOG.exception("DoH refresh failed")


def http_connect(ip: str, port: int, timeout: float = 10) -> socket.socket:
    ph, pp = PROXY.rsplit(":", 1)
    s = socket.create_connection((ph, int(pp)), timeout=timeout)
    set_keepalive(s)
    s.sendall(f"CONNECT {ip}:{port} HTTP/1.1\r\nHost: {ip}:{port}\r\n\r\n".encode())
    s.settimeout(timeout)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    status = buf.split(b"\r\n", 1)[0].decode("iso-8859-1", "replace")
    if " 200 " not in status:
        s.close()
        raise RuntimeError(f"CONNECT {ip}:{port} -> {status}")
    leftover = buf.split(b"\r\n\r\n", 1)[1]
    s.settimeout(None)
    return s, leftover


def splice(a: socket.socket, b: socket.socket, leftover: bytes):
    if leftover:
        a.sendall(leftover)
    sockets = [a, b]
    try:
        while True:
            r, _, x = select.select(sockets, [], sockets, 300)
            if x or not r:
                break
            for src in r:
                dst = b if src is a else a
                data = src.recv(65536)
                if not data:
                    return
                dst.sendall(data)
    finally:
        try:
            a.close()
        finally:
            b.close()


def handle(client: socket.socket, addr):
    client.settimeout(None)
    set_keepalive(client)
    last_err = None
    for ip in current_ips() or refresh_ips():
        try:
            upstream, leftover = http_connect(ip, EDGE_PORT)
            LOG.info("session %s -> %s:%s", addr, ip, EDGE_PORT)
            splice(client, upstream, leftover)
            return
        except Exception as e:
            last_err = e
            LOG.warning("edge %s failed: %s", ip, e)
    LOG.error("all edges failed for %s: %s", addr, last_err)
    client.close()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    refresh_ips()
    threading.Thread(target=refresher, daemon=True).start()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(128)
    LOG.info("listening on %s:%s", LISTEN_HOST, LISTEN_PORT)
    while True:
        client, addr = srv.accept()
        threading.Thread(target=handle, args=(client, addr), daemon=True).start()


if __name__ == "__main__":
    main()
