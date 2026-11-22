#!/usr/bin/env python3
"""Tiny DNS server: region*.v2.argotunnel.com -> 127.0.0.1, other names via DoH."""
from __future__ import annotations

import json
import socketserver
import struct
import urllib.request

LISTEN = ("127.0.0.1", 5353)
DOH = "https://cloudflare-dns.com/dns-query?name={name}&type={typ}"
# DNS type A = 1, AAAA = 28
TYPE_A = 1
TYPE_AAAA = 28


def parse_name(data: bytes, offset: int):
    labels = []
    jumped = False
    orig = offset
    while True:
        if offset >= len(data):
            raise ValueError("short name")
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(data):
                raise ValueError("short pointer")
            ptr = ((length & 0x3F) << 8) | data[offset + 1]
            if not jumped:
                orig = offset + 2
            offset = ptr
            jumped = True
            continue
        offset += 1
        labels.append(data[offset : offset + length].decode("ascii", "replace"))
        offset += length
    return ".".join(labels), (orig if jumped else offset)


def encode_name(name: str) -> bytes:
    out = b""
    if name:
        for label in name.split("."):
            lb = label.encode("ascii")
            out += bytes([len(lb)]) + lb
    return out + b"\x00"


def doh_ips(name: str, typ: int) -> list[str]:
    typ_name = "A" if typ == TYPE_A else "AAAA"
    url = DOH.format(name=name, typ=typ_name)
    req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.loads(r.read().decode())
    return [a["data"] for a in data.get("Answer") or [] if a.get("type") == typ]


def build_response(query: bytes) -> bytes:
    if len(query) < 12:
        return b""
    tid, flags, qd, *_ = struct.unpack("!HHHHHH", query[:12])
    if qd < 1:
        return struct.pack("!HHHHHH", tid, 0x8183, 0, 0, 0, 0)
    name, off = parse_name(query, 12)
    qtype, qclass = struct.unpack("!HH", query[off : off + 4])
    question = query[12 : off + 4]
    answers = b""
    ancount = 0
    lname = name.lower().rstrip(".")
    if (lname.endswith(".v2.argotunnel.com") or lname in ("region1.v2.argotunnel.com", "region2.v2.argotunnel.com")) and qtype in (TYPE_A, 255):
        # 127.0.0.1
        answers += encode_name(name) + struct.pack("!HHIH", TYPE_A, 1, 30, 4) + socket_aton()
        ancount = 1
        if qtype == 255:
            pass
    elif (lname.endswith(".v2.argotunnel.com") or lname in ("region1.v2.argotunnel.com", "region2.v2.argotunnel.com")) and qtype == TYPE_AAAA:
        # no AAAA, so cloudflared uses IPv4
        ancount = 0
    else:
        try:
            ips = doh_ips(name, qtype) if qtype in (TYPE_A, TYPE_AAAA) else []
        except Exception:
            ips = []
        for ip in ips:
            if qtype == TYPE_A:
                answers += encode_name(name) + struct.pack("!HHIH", TYPE_A, 1, 30, 4)
                answers += bytes(int(x) for x in ip.split("."))
                ancount += 1
            elif qtype == TYPE_AAAA and ":" in ip:
                import ipaddress
                answers += encode_name(name) + struct.pack("!HHIH", TYPE_AAAA, 1, 30, 16)
                answers += ipaddress.IPv6Address(ip).packed
                ancount += 1
    flags_out = 0x8180 if ancount or lname.endswith(".v2.argotunnel.com") else 0x8183
    return struct.pack("!HHHHHH", tid, flags_out, 1, ancount, 0, 0) + question + answers


def socket_aton():
    return bytes((127, 0, 0, 1))


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        try:
            resp = build_response(data)
            if resp:
                sock.sendto(resp, self.client_address)
        except Exception:
            pass


class Server(socketserver.ThreadingUDPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    import socket
    with Server(LISTEN, Handler) as srv:
        srv.serve_forever()
