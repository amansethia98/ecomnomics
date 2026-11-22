#!/usr/bin/env python3
"""Restart dead preview-link pieces. Never prints secrets.

Keeps cloudflared running (same hostname) when it can. Restarts edge-forward
when the public URL starts returning Cloudflare 5xx/530 or the edge hop is down.
Restarts Caddy if local :8787 is not requiring basic auth.
Only starts a new cloudflared (new hostname) if the process itself is dead,
via start.sh.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/workspace/preview-link")
LOG = ROOT / "logs"
ACCESS = ROOT / "ACCESS.txt"
INTERVAL = int(os.environ.get("WATCHDOG_INTERVAL", "15"))
PUBLIC_FAILS_BEFORE_RESTART = 2


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[watchdog {ts}] {msg}"
    print(line, flush=True)
    try:
        with (LOG / "watchdog.log").open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def pid_of(name: str) -> int | None:
    p = LOG / f"{name}.pid"
    if not p.exists():
        return None
    try:
        pid = int(p.read_text().strip())
    except ValueError:
        return None
    try:
        os.kill(pid, 0)
        return pid
    except OSError:
        return None


def public_url() -> str:
    if not ACCESS.exists():
        return ""
    for line in ACCESS.read_text().splitlines():
        if line.startswith("PUBLIC_URL="):
            return line.split("=", 1)[1].strip()
    return ""


def http_code(url: str, timeout: float = 12) -> int:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def restart(name: str, cmd: list[str]) -> None:
    old = pid_of(name)
    if old:
        log(f"stopping {name} pid {old}")
        try:
            os.kill(old, signal.SIGTERM)
        except OSError:
            pass
        for _ in range(15):
            try:
                os.kill(old, 0)
                time.sleep(0.2)
            except OSError:
                break
        try:
            os.kill(old, signal.SIGKILL)
        except OSError:
            pass
    # Start
    logf = (LOG / f"{name}.log").open("a")
    proc = subprocess.Popen(
        cmd,
        stdout=logf,
        stderr=subprocess.STDOUT,
        cwd=str(ROOT),
        start_new_session=True,
    )
    (LOG / f"{name}.pid").write_text(str(proc.pid))
    log(f"started {name} pid {proc.pid}")


def main() -> int:
    LOG.mkdir(parents=True, exist_ok=True)
    log("watching")
    started = time.time()
    grace = int(__import__("os").environ.get("WATCHDOG_GRACE", "45"))
    public_fails = 0
    while True:
        time.sleep(INTERVAL)
        # Do not treat tunnel startup as a public failure (avoids bouncing edge-forward).
        public_ok_to_check = (time.time() - started) >= grace
        try:
            # Caddy
            caddy = pid_of("caddy")
            code = http_code("http://127.0.0.1:8787/", timeout=5)
            if caddy is None or code != 401:
                log(f"Caddy unhealthy (pid={caddy} http={code}); restarting")
                restart(
                    "caddy",
                    [
                        str(ROOT / "bin/caddy"),
                        "run",
                        "--config",
                        str(ROOT / "Caddyfile"),
                        "--pidfile",
                        str(LOG / "caddy.pid"),
                    ],
                )

            # API origin used by Caddy for /api/* (a down API is a public 502).
            api_code = http_code("http://127.0.0.1:3100/health", timeout=3)
            if api_code != 200:
                log(f"API :3100/health http={api_code} (Caddy will retry briefly; not starting a second preview:local)")

            # edge-forward listener
            fwd = pid_of("edge-forward")
            import socket
            listening = False
            if fwd:
                s = socket.socket()
                s.settimeout(1)
                try:
                    s.connect(("127.0.0.1", 7844))
                    listening = True
                except OSError:
                    listening = False
                finally:
                    s.close()
            if fwd is None or not listening:
                log(f"edge-forward unhealthy (pid={fwd} listening={listening}); restarting")
                restart("edge-forward", [sys.executable, str(ROOT / "bin/edge-forward.py")])

            # local-dns
            dns = pid_of("local-dns")
            if dns is None:
                log("local-dns dead; restarting")
                restart("local-dns", [sys.executable, str(ROOT / "bin/local-dns.py")])

            # cloudflared process
            cf = pid_of("cloudflared")
            if cf is None:
                log("cloudflared process is dead; running start.sh (hostname may change)")
                subprocess.Popen(
                    [str(ROOT / "start.sh")],
                    cwd=str(ROOT),
                    stdout=(LOG / "watchdog-start.sh.log").open("a"),
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    env={k: v for k, v in os.environ.items() if k != "PREVIEW_LINK_PASSWORD" or True},
                )
                # start.sh will reuse bcrypt if env is unset; env is kept if present
                time.sleep(20)
                continue

            url = public_url()
            if not url or not public_ok_to_check:
                if not url:
                    log("no PUBLIC_URL yet")
                continue
            pcode = http_code(url + "/", timeout=15)
            if pcode == 401:
                if public_fails:
                    log(f"public URL healthy again (401) after {public_fails} fail(s)")
                public_fails = 0
            else:
                public_fails += 1
                log(f"public URL http={pcode} (fail {public_fails}/{PUBLIC_FAILS_BEFORE_RESTART})")
                if public_fails >= PUBLIC_FAILS_BEFORE_RESTART:
                    log("restarting edge-forward to re-establish the edge hop; keeping cloudflared")
                    restart("edge-forward", [sys.executable, str(ROOT / "bin/edge-forward.py")])
                    public_fails = 0
                    time.sleep(12)
        except Exception as e:
            log(f"watchdog loop error: {type(e).__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
