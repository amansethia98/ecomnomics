"""Select the complete frozen pre-sync browser only while a Zomato login is present.

The two versioned files are unmodified Git blobs from 246c11b. Do not reimplement their
focus, keyboard, event, verification or submission behavior in this dispatcher.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

import page_secrets

AUTH_ORIGIN = "https://accounts.zomato.com"


def auth_page(url):
    try:
        parts = urlsplit(url)
        return parts.scheme == "https" and parts.hostname == "accounts.zomato.com" and parts.port in (None, 443)
    except (TypeError, ValueError):
        return False


def login_present(port, target, address):
    if auth_page(address):
        return True
    host = urlsplit(address).hostname or ""
    if host != "zomato.com" and not host.endswith(".zomato.com"):
        return False
    client = page_secrets.connect(port)
    try:
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        stack = [client.call("Page.getFrameTree", session_id=session)["frameTree"]]
        while stack:
            node = stack.pop()
            if auth_page(node["frame"].get("url", "")):
                return True
            stack.extend(node.get("childFrames") or [])
        return False
    finally:
        client.close()


def load_browser():
    root = Path(__file__).resolve().parent

    def load(name, filename):
        loader = importlib.machinery.SourceFileLoader(name, str(root / filename))
        spec = importlib.util.spec_from_loader(name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module

    # The frozen script imports its original module name. Bind it only while loading;
    # the current browser keeps its own helper, and the frozen module retains its old one.
    current = sys.modules.get("page_secrets")
    search_path = sys.path[:]
    try:
        sys.modules["page_secrets"] = load("zomato_secrets_246c11b", "zomato_secrets_246c11b.py")
        return load("zomato_browser_246c11b", "zomato_browser_246c11b.py")
    finally:
        sys.path[:] = search_path
        if current is None:
            sys.modules.pop("page_secrets", None)
        else:
            sys.modules["page_secrets"] = current


def dispatch(command, args, port, front_tab):
    if command not in ("navigate", "snapshot", "act"):
        return None
    selected = command == "navigate" and auth_page(args.get("url", ""))
    if not selected:
        try:
            target, address = front_tab(port)
            selected = login_present(port, target, address)
        except Exception:
            # No tab/browser can be an ordinary navigation; the current entry point handles it.
            return None
    if not selected:
        return None
    if command == "act" and any(step.get("field") == "code" for step in args.get("actions", [])):
        # The historical flow was an owner reply followed by ordinary browser_act type,
        # not request_secret/fill_code. Never silently mix the two handling contracts.
        print(json.dumps({"ok": False, "completed": 0, "uncertain": False,
                          "error": "This login uses the restored owner-code reply and browser_act type flow, not fill_code."}))
        return 1
    old = load_browser()
    flags = {key: os.environ.pop(key, None) for key in
             ("RAKAZO_BROWSER_ARGS_STDIN", "RAKAZO_BROWSER_WATCH_STDIN")}
    try:
        # Python arguments only, not a spawned process's argv. stdin was already read once.
        return old.run(["rakazo-page-browser", command, json.dumps(args)])
    finally:
        for key, value in flags.items():
            if value is not None:
                os.environ[key] = value
