#!/usr/bin/env python3
"""Serve the page-browser commands on the Chromium showing on this computer's DISPLAY.

agent-browser (pinned in the image) attaches to that Chromium over CDP and browses. This wrapper
keeps Rakazo's contract and policy on top: which tab, refs that must still name the element the
bot saw, the snapshot's size, masked secrets, upload confinement, and the computer_act fallback.
Saved logins, cards and pay tokens go through page_secrets instead.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import mimetypes
import os
import re
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.request
from typing import Any
from urllib.parse import urljoin, urlsplit

sys.path[:0] = [os.path.dirname(os.path.realpath(__file__)), "/usr/local/lib/rakazo"]
import page_secrets  # noqa: E402
from page_secrets import CardFieldUncertain, Refused, payment_frame_origin  # noqa: E402

discover_ws_url = page_secrets.discover_ws_url

AGENT_BROWSER = os.environ.get("RAKAZO_AGENT_BROWSER") or "/usr/local/bin/agent-browser"

NO_ANSWER = "The page did not answer in time."
STALE_REF = "Stale element ref: the page has changed since that snapshot. Use a ref from the page below."
NOT_KEPT = "The page did not keep every character typed. Check the field in this snapshot before trying again."
CODE_PARTIAL = ("The code was not typed into every box. Check the boxes before asking for a new code; "
                "it may have been only partly typed.")
DISABLED = "That control is disabled, so nothing happened. Pick another control from this snapshot."
PAYMENT_FRAME_HINT = "Card fields are in a payment frame: use fill_card without ref."

# The snapshot goes to the model whole, in one piece of at most 12,000 characters, or the tool result
# shortener cuts out its middle. So the control list and the page text share a budget, measured as
# they will be sent (with their line breaks escaped).
TREE_BUDGET = 10000
CONTROLS_BUDGET = 5500
MAX_CONTROLS = 80
MIN_TEXT = 1500
MAX_OPTIONS = 100
OPTIONS_CHARS = 2000
MAX_OPTION_TEXT = 80

SETTLE_SECONDS = 3.0
# The most an action's result waits for its requests and the snapshot after them together.
ACTION_WAIT_SECONDS = 2.0
# Requests an action sets off begin a moment after its last step.
ACTION_QUIET_SECONDS = 0.3
# A page is quiet once no request has begun for this long and none is still waiting for its answer.
QUIET_SECONDS = 0.5
# A request still unanswered after this long is a stream or a lost request, not the page loading.
REQUEST_PATIENCE_SECONDS = 10.0
# browser_navigate returns the page as an action does when the navigation took less than
# NAVIGATE_SNAPSHOT_BY; the snapshot then ends by NAVIGATE_SNAPSHOT_UNTIL or is left out, inside
# the supervisor's limit on one call.
NAVIGATE_SECONDS = 15.0
NAVIGATE_SNAPSHOT_BY = 12.0
NAVIGATE_SNAPSHOT_UNTIL = 20.0
# Typing presses each key after checking the page is still the same one with focus in the field.
# Longer text is typed in one go and checked after.
CHECKED_KEYS = 32

MAX_UPLOAD_FILES = 10
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# agent-browser errors raised before anything reached the page: the step is settled.
SETTLED_ERRORS = ("Unknown ref", "is stale", "cannot be recovered", "Could not locate element", "is covered by",
                  "so the click would not reach it", "No option matched", "Element not found")


class Settled(RuntimeError):
    """A step the page cannot take as asked (stale ref, covered or disabled element, no such option).

    Nothing changed, and the result carries the page as it is, so the bot can choose again.
    """


class TypingStopped(RuntimeError):
    """Typing ended before the last key. The message never repeats any of the text."""


class KeysNotKept(RuntimeError):
    """Every key was pressed, but the field did not keep them all: the step ran, its result is wrong."""


class AbError(RuntimeError):
    def __init__(self, message: str, index: int = 0) -> None:
        super().__init__(message)
        self.index = index


def display_num() -> int:
    raw = os.environ.get("DISPLAY", ":1")
    try:
        return int(str(raw).lstrip(":").split(".")[0] or "1")
    except ValueError:
        return 1


def cdp_port() -> int:
    override = os.environ.get("RAKAZO_CDP_PORT")
    if override:
        return int(override)
    # rakazo-browser uses 9221 + display number (:1 -> 9222).
    return 9221 + display_num()


def http_get_json(url: str, timeout: float = 5.0) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        data = resp.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise RuntimeError("CDP discovery response too large")
        return json.loads(data.decode("utf-8"))


def wait_for_cdp(port: int, timeout_s: float = 3.0) -> None:
    deadline = time.time() + timeout_s
    last_error = "unreachable"
    while time.time() < deadline:
        try:
            http_get_json(f"http://127.0.0.1:{port}/json/version", timeout=1.0)
            return
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            time.sleep(0.25)
    raise RuntimeError(f"CDP not ready on port {port}: {last_error}")


# Chromium's own pages, such as the new tab page, which agent-browser leaves alone.
INTERNAL_SCHEMES = ("chrome", "chrome-extension", "chrome-untrusted", "chrome-search", "devtools")
INTERNAL_PAGE = "The browser is showing one of its own pages, which the page tools cannot read. Open a site with browser_navigate."


def front_tab(port: int) -> tuple[str, str]:
    """The tab the person sees, and its address: Chromium lists tabs by when they were last brought to the front."""
    for target in http_get_json(f"http://127.0.0.1:{port}/json/list"):
        if isinstance(target, dict) and target.get("type") == "page":
            return str(target["id"]), str(target.get("url") or "")
    raise RuntimeError("No browser tab is open. Use desktop tools to open one.")


def internal(url: str) -> bool:
    return urlsplit(url).scheme in INTERNAL_SCHEMES


def check_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise RuntimeError("Only HTTP(S) URLs without embedded credentials are supported")


class AgentBrowser:
    """agent-browser's session for this display: one daemon, kept attached between calls."""

    def __init__(self, port: int) -> None:
        self.port = port
        self.home = os.path.join(tempfile.gettempdir(), f"rakazo-ab-{os.getuid()}")
        os.makedirs(self.home, mode=0o700, exist_ok=True)
        info = os.lstat(self.home)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("The page browser's own folder is not this user's")
        # Its own configuration, never one from the bot's home or working folder.
        self.config = os.path.join(self.home, "config.json")
        with open(self.config, "w", encoding="utf-8") as config:
            config.write("{}")
        self.session = f"display-{port}"
        self.env = {key: value for key, value in os.environ.items()
                    if key in ("LANG", "LD_PRELOAD", "NSS_WRAPPER_PASSWD", "NSS_WRAPPER_GROUP")}
        self.env.update({
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": self.home,
            "AGENT_BROWSER_CONFIG": self.config,
            "AGENT_BROWSER_SOCKET_DIR": self.home,
            "AGENT_BROWSER_SESSION": self.session,
            # Always the Chromium on this display: without it, agent-browser would start a browser of its own.
            "AGENT_BROWSER_CDP": str(port),
            "AGENT_BROWSER_IDLE_TIMEOUT_MS": "900000",
            # Dialogs are the person's and the page's to answer, as on the screen; see PageBrowser.dialog_result.
            "AGENT_BROWSER_NO_AUTO_DIALOG": "1",
            "AGENT_BROWSER_NO_WEBMCP": "1",
        })

    def batch(self, commands: list[list[str]], *, timeout: float = 20.0, bail: bool = True) -> list[Any]:
        """Each command's result, in one agent-browser call. Commands and their text go over stdin, not argv."""
        try:
            proc = subprocess.run(
                [AGENT_BROWSER, "batch", "--json", "--omit-command", *(["--bail"] if bail else [])],
                input=json.dumps(commands), capture_output=True, text=True, env=self.env, cwd=self.home,
                timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError(NO_ANSWER) from None
        try:
            items = json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise AbError((proc.stderr or proc.stdout).strip()[:500] or "agent-browser gave no answer") from None
        if not isinstance(items, list):
            raise AbError(str((items or {}).get("error") if isinstance(items, dict) else items)[:500])
        results: list[Any] = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise AbError("agent-browser gave no answer", index)
            data = item.get("result") if isinstance(item.get("result"), dict) else {}
            # Only ever the browser on the screen: a page agent-browser opened itself is not the bot's.
            if (data.get("lifecycle") or {}).get("launched") is True:
                raise RuntimeError("Page browser is not attached to this computer's Chrome.")
            if not item.get("success"):
                if bail:
                    raise AbError(str(item.get("error") or "agent-browser failed"), index)
                results.append(None)
                continue
            results.append(data)
        if len(results) < len(commands):
            raise AbError("agent-browser stopped early", len(results))
        return results

    def session_tab(self) -> str | None:
        """The tab the session reads now; it also follows tabs opened while it was attached."""
        # One answer or none: a probe that hangs must leave the call's short budget to the work after it.
        try:
            proc = subprocess.run(
                [AGENT_BROWSER, "tab", "list", "--json"], capture_output=True, text=True,
                env=self.env, cwd=self.home, timeout=1.0)
            envelope = json.loads(proc.stdout)
            data = envelope.get("data") if isinstance(envelope, dict) else None
            tabs = data.get("tabs") if isinstance(data, dict) else None
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None
        for tab in tabs if isinstance(tabs, list) else []:
            if isinstance(tab, dict) and tab.get("active") and tab.get("type") == "page":
                return str(tab.get("targetId"))
        return None

    def use_tab(self, target_id: str) -> None:
        """Point the session at the tab on screen when the person has switched tabs since the last call.

        agent-browser follows a newly opened tab on its own, so the tab it was last pointed at is
        not enough: ask where the session is and move it only when it reads another tab.
        """
        if self.session_tab() == target_id:
            return
        self.batch([["tab", target_id]])


# A navigation as from the address bar: no referrer leaves for the next site.
NAVIGATE = r"""(() => {
  const timeOrigin = performance.timeOrigin;
  const policy = document.createElement("meta");
  policy.name = "referrer";
  policy.content = "no-referrer";
  (document.head || document.documentElement).append(policy);
  // After this script has answered: a page being replaced answers late.
  setTimeout(() => location.assign(URL), 0);
  return { timeOrigin, href: location.href };
})()"""

# Whether the page has loaded, and the requests it has finished, failed ones included.
PAGE_LOAD = r"""({ href: location.href, ready: document.readyState,
  done: performance.getEntriesByType("resource").slice(-500).map((entry) => entry.name) })"""

# The page's address, title and text, the values a snapshot must not show (password fields, fields
# holding a saved login or card, and fields drawn as dots), and the merchant account a pay token checkout names in the page itself.
PAGE_STATE = r"""(() => {
  const masked = [...document.querySelectorAll("input, textarea")]
    .filter((el) => el.value && (el.type === "password" || el.hasAttribute("data-rakazo-filled")
      || getComputedStyle(el).webkitTextSecurity !== "none"))
    .map((el) => el.value);
  const blocks = [...document.querySelectorAll(".AiAgentPaymentSteering")]
    .filter((block) => block.querySelector('input[name="link_pay_token"]'));
  const holder = blocks.length !== 1 ? null : blocks[0].matches("[data-stripe-merchant-account]") ? blocks[0]
    : blocks[0].querySelector("[data-stripe-merchant-account]");
  const account = holder?.getAttribute("data-stripe-merchant-account") || "";
  return {
    url: location.href,
    title: (document.title || "").slice(0, 200),
    ready: document.readyState,
    text: (document.body?.innerText || "").slice(0, 200000),
    masked,
    payToken: /^acct_[A-Za-z0-9]{1,64}$/.test(account) ? account : null,
  };
})()"""


class Node:
    """One line of agent-browser's snapshot: role, name, [attributes], what follows, and its value."""

    def __init__(self, depth: int, role: str, name: str = "", attrs: str = "", extra: str = "",
                 value: str | None = None) -> None:
        self.depth, self.role, self.name, self.attrs, self.extra, self.value = depth, role, name, attrs, extra, value
        self.children: list[Node] = []
        self.parent: Node | None = None

    @property
    def frame(self) -> Node | None:
        """The frame element this element's page is in, when it is inside one."""
        at = self.parent
        while at is not None and not (at.role == "Iframe" and at.ref):
            at = at.parent
        return at

    @property
    def ref(self) -> str | None:
        found = re.search(r"\bref=(e\d+)\b", self.attrs)
        return found.group(1) if found else None


LINE = re.compile(r"^(?P<indent> *)- (?P<role>[^\s\"\[]+)(?P<rest>.*)$")


def parse_line(text: str) -> Node | None:
    match = LINE.match(text)
    if not match:
        return None
    rest, name = match["rest"], ""
    if rest.startswith(' "'):
        try:
            name, end = json.JSONDecoder().raw_decode(rest, 1)
            rest = rest[end:]
        except json.JSONDecodeError:
            end = rest.rfind('" [')
            name, rest = (rest[2:end], rest[end + 1:]) if end > 1 else (rest[2:].rstrip('"'), "")
    attrs = ""
    if rest.startswith(" ["):
        close = rest.find("]")
        if close > 0:
            attrs, rest = rest[2:close], rest[close + 1:]
    value = None
    if ": " in rest:
        rest, value = rest.split(": ", 1)
    return Node(len(match["indent"]) // 2, match["role"], " ".join(str(name).split()), attrs, rest, value)


def parse_tree(text: str) -> list[Node]:
    roots: list[Node] = []
    stack: list[Node] = []
    for line in str(text or "").splitlines():
        node = parse_line(line)
        if node is None:
            continue
        while stack and stack[-1].depth >= node.depth:
            stack.pop()
        if stack:
            node.parent = stack[-1]
        (stack[-1].children if stack else roots).append(node)
        stack.append(node)
    return roots


def walk(nodes: list[Node]):  # type: ignore[no-untyped-def]
    for node in nodes:
        yield node
        yield from walk(node.children)


def find_ref(nodes: list[Node], ref: str) -> Node | None:
    return next((node for node in walk(nodes) if node.ref == ref), None)


def native_options(node: Node) -> list[Node]:
    """A native dropdown's options, which the snapshot lists under it."""
    if node.role != "combobox":
        return []
    return [child for child in walk(node.children) if child.role == "option"]


def sent(text: str) -> int:
    """A text's length as the bot receives it, line breaks escaped."""
    return len(json.dumps(text, ensure_ascii=False)) - 2


def cut_option(text: str) -> str:
    # A long option keeps its start and its end, which is where long options usually differ.
    return f"{text[:50]}…{text[-(MAX_OPTION_TEXT - 51):]}" if len(text) > MAX_OPTION_TEXT else text


def options_of(node: Node) -> tuple[list[dict[str, Any]], int]:
    """A dropdown's options as the page shows them: the first MAX_OPTIONS and the chosen one."""
    every = native_options(node)
    shown = every[:MAX_OPTIONS]
    chosen = next((option for option in every if "selected" in option.attrs.split(", ")), None)
    if chosen is not None and chosen not in shown:
        shown.append(chosen)
    options = []
    for option in shown:
        label = cut_option(" ".join(option.name.split()))
        attrs = option.attrs.split(", ")
        options.append({"label": label, "value": label, **({"selected": True} if "selected" in attrs else {}),
                        **({"disabled": True} if "disabled" in attrs else {})})
    return options, len(every)


def describe_options(options: list[dict[str, Any]], total: int) -> str:
    """The options a model reads, as many as fit; the chosen one is always shown."""
    def describe(option: dict[str, Any]) -> str:
        return (json.dumps(option["label"], ensure_ascii=False) + (" (selected)" if option.get("selected") else "")
                + (" (disabled)" if option.get("disabled") else ""))
    parts: list[str] = []
    used = 0
    for option in options:
        part = describe(option)
        if parts and used + len(part) > OPTIONS_CHARS:
            break
        parts.append(part)
        used += len(part) + 2
    chosen = next((option for option in options if option.get("selected")), None)
    if chosen is not None and describe(chosen) not in parts:
        parts.append(describe(chosen))
    return ", ".join(parts) + (f", and {total - len(parts)} more" if total > len(parts) else "")


CONTROL_ROLES = frozenset({"button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
                           "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
                           "spinbutton", "treeitem", "Iframe"})


def same_site(url: Any) -> str:
    """The site a URL is on, as its host's last two labels; close enough to tell a page's own requests apart."""
    try:
        host = urlsplit(str(url or "")).hostname or ""
    except ValueError:
        return ""
    return ".".join(host.split(".")[-2:])


def unframed(text: str) -> str:
    """Page text with anything that reads like a frame's header line set apart, so a page cannot name a site."""
    return text.replace("[frame ", "[ frame ")


def frame_site(src: Any) -> str:
    try:
        parts = urlsplit(str(src or ""))
        return f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}" if parts.scheme in ("http", "https") else ""
    except ValueError:
        return ""


# A covered click walks a ladder before it fails: scroll, an obvious overlay or the frame that
# holds the control, Enter on the related field, a script click, a coordinate click, then one
# reload. BOX and FORCE are numbers. MODE is plan, keyboard, save, or signature. SCRIPT is whether
# this pass may call click() itself.
RECOVER_CLICK = r"""(() => {
  const rakazoRecover = true;
  const box = __BOX__;
  const force = __FORCE__;
  const mode = __MODE__;
  const scriptClick = __SCRIPT__;
  const close = (a, b) => Math.abs(a - b) < 4;
  const same = (rect, other) => rect && other && rect.width > 0 && close(rect.x, other.x) && close(rect.y, other.y)
    && close(rect.width, other.width) && close(rect.height, other.height);
  const localRect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const docs = () => {
    const all = [document];
    const walk = (doc) => {
      for (const frame of doc.querySelectorAll("iframe,frame")) {
        try {
          if (frame.contentDocument) { all.push(frame.contentDocument); walk(frame.contentDocument); }
        } catch (e) { /* a cross-origin frame is not readable here */ }
      }
    };
    walk(document);
    return all;
  };
  const frameOffset = (doc) => {
    const win = doc.defaultView;
    if (!win || win === win.top) return { x: 0, y: 0 };
    let node = win.frameElement;
    let x = 0;
    let y = 0;
    while (node) {
      const r = node.getBoundingClientRect();
      x += r.left;
      y += r.top;
      const parent = node.ownerDocument.defaultView;
      node = parent && parent.frameElement;
    }
    return { x, y };
  };
  const localBox = (doc) => {
    const off = frameOffset(doc);
    return { x: box.x - off.x, y: box.y - off.y, width: box.width, height: box.height };
  };
  const matches = (el, doc) => {
    const rect = localRect(el);
    return same(rect, localBox(doc)) || same(rect, box);
  };
  if (mode === "save") {
    const fields = [];
    for (const doc of docs()) {
      for (const el of doc.querySelectorAll("input,textarea")) {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "checkbox", "radio", "button", "submit", "file", "image"].includes(type)) continue;
        if (!el.value) continue;
        fields.push({ name: el.name || "", id: el.id || "", type, value: el.value });
      }
    }
    return { href: location.href, fields };
  }
  if (mode === "signature") {
    const body = document.body;
    const text = (body && body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);
    return { href: location.href, title: document.title, text };
  }
  const labelOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || "")
    .replace(/\s+/g, " ").trim().slice(0, 80);
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return "element";
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += "#" + el.id.slice(0, 40);
    else if (typeof el.className === "string" && el.className.trim())
      desc += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    const text = labelOf(el);
    return text ? desc + ' "' + text + '"' : desc;
  };
  let target = null;
  let targetDoc = null;
  for (const doc of docs()) {
    const area = localBox(doc);
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    let stack = [];
    try { stack = doc.elementsFromPoint(cx, cy); } catch (e) { stack = []; }
    target = stack.find((el) => matches(el, doc)) || null;
    if (!target) {
      const nodes = doc.querySelectorAll("a,button,input,summary,[role='button']");
      for (const el of nodes) if (matches(el, doc)) { target = el; break; }
    }
    if (target) { targetDoc = doc; break; }
  }
  if (!target || !targetDoc) return { found: false };
  const framed = targetDoc !== document;
  if (mode === "keyboard") {
    const form = target.form || (target.closest && target.closest("form"));
    const root = form || targetDoc;
    const fields = [...root.querySelectorAll("input,textarea")].filter((el) => {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return !["hidden", "checkbox", "radio", "button", "submit", "file", "image"].includes(type);
    });
    const field = [...fields].reverse().find((el) => (el.value || "").trim()) || fields[fields.length - 1];
    if (!field) return { found: false, frame: framed };
    field.focus();
    return { found: true, focused: true, frame: framed };
  }
  const area = localBox(targetDoc);
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  let stack = [];
  try { stack = targetDoc.elementsFromPoint(cx, cy); } catch (e) { stack = []; }
  const index = stack.indexOf(target);
  const above = index >= 0 ? stack.slice(0, index) : stack.filter((el) => el !== target && !target.contains(el));
  const cover = above.find((el) => el !== target && !target.contains(el) && !el.contains(target)) || null;
  const blocker = describe(cover);
  const centerClear = !cover;
  const obvious = (el) => {
    let src = "";
    try { src = el.src || ""; } catch (e) { src = ""; }
    const blob = [el.id, el.className, el.title, el.name, src, labelOf(el)].join(" ").toLowerCase();
    return /cookie|consent|gdpr|privacy|onetrust|sp_message/.test(blob);
  };
  let holdsTarget = false;
  try { holdsTarget = !!(cover && cover.contentDocument && cover.contentDocument.contains(target)); }
  catch (e) { holdsTarget = false; }
  if (!force && holdsTarget) return { found: true, frame: true, blocker };
  if (!force && cover && !holdsTarget && !target.contains(cover) && !cover.contains(target) && obvious(cover)) {
    cover.style.setProperty("display", "none", "important");
    return { found: true, removed: describe(cover), blocker, frame: framed };
  }
  if (!force && centerClear) return { found: true, clear: true, blocker, frame: framed };
  const DISMISS = /^(close|dismiss|got it|accept|ok|okay|not now|no thanks|skip|×|x|✕|reject|decline|allow all|accept all|agree|i agree)$/i;
  const overlay = cover && (cover.closest("[role='dialog'],[role='alertdialog'],[aria-modal='true']") || cover);
  if (!force && overlay) {
    const controls = overlay.querySelectorAll("button,[role='button'],a,input[type='button'],input[type='submit']");
    for (const control of controls) {
      if (control === target || target.contains(control)) continue;
      const name = labelOf(control);
      const aria = control.getAttribute("aria-label") || "";
      if (DISMISS.test(name) || /close|dismiss/i.test(aria)) {
        control.click();
        return { found: true, dismissed: name || aria || "close", blocker, frame: framed };
      }
    }
  }
  const stickyBar = (el) => {
    for (let node = el; node && node !== targetDoc.documentElement; node = node.parentElement) {
      const style = targetDoc.defaultView.getComputedStyle(node);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      const rect = node.getBoundingClientRect();
      const view = targetDoc.defaultView;
      if (rect.width > view.innerWidth * 0.5 && rect.height > 0 && rect.height < view.innerHeight * 0.85)
        return node;
    }
    return null;
  };
  const bar = !force && cover ? stickyBar(cover) : null;
  if (bar) {
    const rect = target.getBoundingClientRect();
    const band = bar.getBoundingClientRect();
    const margin = 8;
    const delta = band.top < targetDoc.defaultView.innerHeight / 2
      ? rect.top - (band.bottom + margin)
      : rect.bottom - (band.top - margin);
    if (Math.abs(delta) > 2) {
      let scroller = target.parentElement;
      while (scroller && scroller !== targetDoc.documentElement) {
        const style = targetDoc.defaultView.getComputedStyle(scroller);
        if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 4) break;
        scroller = scroller.parentElement;
      }
      (scroller || targetDoc.scrollingElement || targetDoc.documentElement).scrollBy(0, delta);
      return { found: true, scrolled: true, blocker, frame: framed };
    }
  }
  const samples = [[0.5, 0.5], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]];
  const rect = target.getBoundingClientRect();
  let point = null;
  for (const [sx, sy] of samples) {
    const x = rect.left + rect.width * sx;
    const y = rect.top + rect.height * sy;
    let hit = null;
    try { hit = targetDoc.elementFromPoint(x, y); } catch (e) { hit = null; }
    if (hit && (hit === target || target.contains(hit) || hit.contains(target))) {
      const off = frameOffset(targetDoc);
      point = { x: x + off.x, y: y + off.y };
      if (sx !== 0.5 || sy !== 0.5) break;
    }
  }
  if (point && !centerClear) return { found: true, point, blocker, frame: framed };
  if (!scriptClick) return { found: true, blocker, frame: framed, pending: true };
  if (typeof target.click === "function") target.click();
  const form = target.form || (target.closest && target.closest("form"));
  if (form && typeof form.requestSubmit === "function") {
    try {
      const submitter = target.tagName === "BUTTON" || target.type === "submit" ? target : undefined;
      form.requestSubmit(submitter);
    } catch (e) { /* requestSubmit can reject a control that is not a submitter */ }
  }
  return { found: true, clicked: true, blocker, detail: blocker, frame: framed };
})()"""


def blocker_of(message: str) -> str:
    found = re.search(r"covered by <([^>]{1,180})>", message)
    return found.group(1) if found else "another element"


def covered_note(plan: dict[str, Any], blocker: str, strategy: str) -> str:
    """What the bot is told after a covered click was recovered, including which strategy worked."""
    if strategy == "scroll":
        return f"Covered by <{blocker}>. Scrolled it into view and clicked the element. Strategy: scroll."
    if strategy == "keyboard":
        return (f"Covered by <{blocker}>. Focused the related field and pressed Enter. "
                "Strategy: keyboard.")
    if strategy == "frame" or plan.get("frame") and strategy == "overlay" and not (
            plan.get("dismissed") or plan.get("removed") or plan.get("scrolled")):
        return f"Covered by <{blocker}>. Clicked the element inside its frame. Strategy: frame."
    if plan.get("removed"):
        return (f"Covered by <{blocker}>. Removed {plan['removed']} and clicked the element. "
                "Strategy: overlay.")
    if plan.get("dismissed"):
        return f"Covered by <{blocker}>. Dismissed {plan['dismissed']} and clicked the element. Strategy: overlay."
    if plan.get("scrolled"):
        return f"Covered by <{blocker}>. Scrolled it clear and clicked the element. Strategy: overlay."
    if strategy == "coordinate" or plan.get("point"):
        where = ("Clicked the center of the element." if plan.get("center")
                 else "Its center was covered, so the click went to a clear point on the element.")
        return f"Covered by <{blocker}>. {where} Strategy: coordinate."
    if plan.get("clear"):
        return f"Covered by <{blocker}>. Clicked the element once it was clear. Strategy: overlay."
    detail = plan.get("detail") or blocker
    return (f"Covered by <{blocker}>. The click was sent to the element directly because {detail} "
            "still blocked the pointer. Check the page. Strategy: script.")


class PageBrowser:
    def __init__(self, port: int, target_id: str, browser: AgentBrowser) -> None:
        self.port, self.target, self.ab = port, target_id, browser
        self.downloads: Downloads | None = None
        # What a recovered click wants the bot to know, joined onto the result.
        self.notes: list[str] = []
        # Which blocked-click strategy landed, or "exhausted" when every one failed.
        self.ladder: str | None = None
        self.ladder_target: str | None = None
        self._reloaded_for_click = False
        # Set by a step whose input opened a JavaScript dialog. Reading a page that a dialog blocks
        # times out, and agent-browser then stops answering for the tab, dialog commands included.
        self.dialog_opened = False

    def with_notes(self, result: dict[str, Any]) -> dict[str, Any]:
        merged = result
        if self.notes:
            extra = " ".join(self.notes)
            note = result.get("note")
            merged = {**result, "note": f"{note} {extra}" if isinstance(note, str) and note else extra}
        if self.ladder:
            merged = {**merged, "ladder": self.ladder}
        if self.ladder_target:
            merged = {**merged, "ladderTarget": self.ladder_target}
        return merged

    def element_box(self, ref: str) -> dict[str, float] | None:
        try:
            (found,) = self.ab.batch([["get", "box", f"@{ref}"]])
        except Exception:  # noqa: BLE001
            return None
        box = found.get("box") if isinstance(found, dict) and isinstance(found.get("box"), dict) else found
        if not isinstance(box, dict):
            return None
        try:
            parsed = {key: float(box[key]) for key in ("x", "y", "width", "height")}
        except (KeyError, TypeError, ValueError):
            return None
        if parsed["width"] <= 0 or parsed["height"] <= 0:
            return None
        return parsed

    def recovery_plan(self, box: dict[str, float] | None, force: bool, mode: str = "plan",
                      script: bool = False) -> dict[str, Any] | None:
        if not box and mode == "plan":
            return None
        payload = box or {"x": 0, "y": 0, "width": 0, "height": 0}
        source = (RECOVER_CLICK.replace("__BOX__", json.dumps(payload))
                  .replace("__FORCE__", "true" if force else "false")
                  .replace("__MODE__", json.dumps(mode))
                  .replace("__SCRIPT__", "true" if script else "false"))
        try:
            (found,) = self.ab.batch([["eval", source]])
        except Exception:  # noqa: BLE001
            return None
        result = found.get("result") if isinstance(found, dict) else None
        return result if isinstance(result, dict) else None

    def coordinate_click(self, point: dict[str, Any]) -> None:
        x, y = point.get("x"), point.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            raise RuntimeError("no point")
        if isinstance(x, float) or isinstance(y, float):
            x, y = int(round(x)), int(round(y))
        self.step([["mouse", "move", str(x), str(y)], ["mouse", "down"], ["mouse", "up"]])

    def page_mark(self) -> str:
        found = self.recovery_plan(None, False, mode="signature") or {}
        return json.dumps({key: found.get(key) for key in ("href", "title", "text")}, sort_keys=True)

    def page_changed(self, before: str) -> bool:
        after = self.page_mark()
        return bool(after) and after != before and after != json.dumps(
            {"href": None, "text": None, "title": None}, sort_keys=True)

    def changed_after(self, before: str) -> bool:
        """Let a submit or navigation land, then see whether the page is different."""
        self.settle(1)
        return self.page_changed(before)

    def finish_climb(self, strategy: str, blocker: str, plan: dict[str, Any] | None = None) -> str:
        self.ladder = strategy
        return covered_note(plan or {}, blocker, strategy)

    def retry_click(self, ref: str) -> None:
        with contextlib.suppress(Exception):
            self.step([["scrollintoview", f"@{ref}"]])
        self.step([["click", f"@{ref}"]])

    def overlay_click(self, ref: str, box: dict[str, float] | None, message: str) -> str | None:
        """Dismiss an obvious cover, or click the control inside the frame that holds it."""
        plan = self.recovery_plan(box, False, script=False) or {}
        if not plan.get("found"):
            return None
        blocker = str(plan.get("blocker") or blocker_of(message))[:180]
        if plan.get("dismissed") or plan.get("removed") or plan.get("scrolled") or plan.get("clear") or plan.get("frame"):
            try:
                self.retry_click(ref)
            except Settled as exc:
                if "is covered by" not in str(exc):
                    raise
                box = self.element_box(ref) or box
                plan = self.recovery_plan(box, True, script=False) or plan
                blocker = str(plan.get("blocker") or blocker_of(str(exc)))[:180]
            else:
                strategy = "frame" if plan.get("frame") and not (
                    plan.get("dismissed") or plan.get("removed") or plan.get("scrolled")) else "overlay"
                return self.finish_climb(strategy, blocker, plan)
        if isinstance(plan.get("point"), dict):
            try:
                self.coordinate_click(plan["point"])
            except Exception:  # noqa: BLE001
                return None
            # A clear point on the element is the click. It can land without the page text changing.
            return self.finish_climb("coordinate", blocker, plan)
        if plan.get("clicked"):
            self._pending_script = plan
        return None

    def keyboard_click(self, ref: str, box: dict[str, float] | None, blocker: str) -> str | None:
        """Focus the related field and press Enter, then Tab and Enter."""
        plan = self.recovery_plan(box, False, mode="keyboard") or {}
        if not plan.get("focused"):
            return None
        before = self.page_mark()
        for keys in ([["press", "Enter"]], [["press", "Tab"], ["press", "Enter"]]):
            try:
                self.step(keys)
            except Exception:  # noqa: BLE001
                continue
            if self.changed_after(before):
                return self.finish_climb("keyboard", blocker, plan)
        return None

    def script_click(self, ref: str, box: dict[str, float] | None, blocker: str) -> str | None:
        """element.click() and requestSubmit(), only when the page actually changes.

        A page can ignore an untrusted click. That leaves the pointer and the keyboard for later.
        """
        before = self.page_mark()
        plan = self.recovery_plan(box, True, script=True) or {}
        if not plan.get("clicked"):
            plan = getattr(self, "_pending_script", None) or plan
        self._pending_script = None
        if plan.get("clicked") and self.changed_after(before):
            return self.finish_climb("script", str(plan.get("blocker") or blocker)[:180], plan)
        return None

    def coordinate_center(self, box: dict[str, float] | None, blocker: str) -> str | None:
        """A real pointer click at the element's center, the same point computer_act would use."""
        if not box:
            return None
        before = self.page_mark()
        point = {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2}
        try:
            self.coordinate_click(point)
        except Exception:  # noqa: BLE001
            return None
        if self.changed_after(before):
            return self.finish_climb("coordinate", blocker, {"point": point, "center": True})
        return None

    def reload_for_click(self, ref: str, message: str) -> str | None:
        """One reload, then the same ladder again, after putting typed values back."""
        if self._reloaded_for_click:
            return None
        saved = self.recovery_plan(None, False, mode="save") or {}
        href = saved.get("href") if isinstance(saved.get("href"), str) else ""
        fields = saved.get("fields") if isinstance(saved.get("fields"), list) else []
        self._reloaded_for_click = True
        try:
            if href:
                self.ab.batch([["eval", f"location.assign({json.dumps(href)})"]])
            else:
                self.ab.batch([["eval", "location.reload()"]])
        except Exception:  # noqa: BLE001
            return None
        self.settle(2)
        if fields:
            restore = (
                "(() => { const rakazoRecover = true; const mode = \"restore\"; const fields = "
                + json.dumps(fields)
                + """;
  const docs = [document];
  for (const frame of document.querySelectorAll("iframe,frame")) {
    try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (e) {}
  }
  for (const field of fields) {
    for (const doc of docs) {
      const found = (field.id && doc.getElementById(field.id))
        || (field.name && doc.querySelector(`[name="${String(field.name).replace(/"/g, "")}"]`));
      if (!found) continue;
      found.value = field.value;
      found.dispatchEvent(new Event("input", { bubbles: true }));
      break;
    }
  }
  return { ok: true };
})()"""
            )
            with contextlib.suppress(Exception):
                self.ab.batch([["eval", restore]])
        try:
            return self.recover_covered(ref, message)
        except Settled:
            return None

    def recover_covered(self, ref: str, message: str) -> str:
        """Land a click the page blocked, and name the strategy that worked."""
        box = self.element_box(ref)
        blocker = blocker_of(message)
        # (a) Scroll the control into view and click it again.
        try:
            self.retry_click(ref)
            return self.finish_climb("scroll", blocker)
        except Settled as exc:
            if "is covered by" not in str(exc) and "stale" not in str(exc).lower() and "Unknown ref" not in str(exc):
                raise
            message = str(exc) if "is covered by" in str(exc) else message
            blocker = blocker_of(message)
            box = self.element_box(ref) or box
        # (b) Dismiss an obvious overlay, or click inside the frame that holds the control.
        landed = self.overlay_click(ref, box, message)
        if landed:
            return landed
        box = self.element_box(ref) or box
        # (c) Focus the related field and press Enter, then Tab and Enter.
        landed = self.keyboard_click(ref, box, blocker)
        if landed:
            return landed
        # (d) element.click() and form.requestSubmit().
        landed = self.script_click(ref, box, blocker)
        if landed:
            return landed
        # (e) A coordinate click at the element's center.
        landed = self.coordinate_center(box, blocker)
        if landed:
            return landed
        # (f) Reload once, put typed values back, and walk the ladder again.
        landed = self.reload_for_click(ref, message)
        if landed:
            if self.ladder and self.ladder != "reload":
                self.ladder = f"reload+{self.ladder}"
            else:
                self.ladder = "reload"
            return f"Reloaded the page and kept what was typed. {landed}"
        self.ladder = "exhausted"
        self.ladder_target = ref
        raise Settled(
            f"{message} Ladder exhausted for @{ref}: tried scroll, overlay, keyboard, "
            "script click, coordinate click, and one reload."
        )

    # -- reading the page -------------------------------------------------------------------------

    def pending_requests(self) -> tuple[bool, float]:
        """Whether the page is waiting on a request of its current document, and when its latest began."""
        state, log = self.ab.batch([["eval", PAGE_LOAD], ["network", "requests"]])
        page = state.get("result") or {}
        # agent-browser logs a response but never a failure; the page lists failed requests as done.
        done = set(page.get("done") or [])
        requests = [r for r in log.get("requests") or [] if isinstance(r, dict)]
        documents = [r for r in requests if r.get("resourceType") == "Document"]
        current = [r for r in documents if r.get("url") == page.get("href")] or documents
        since = float(current[-1].get("timestamp") or 0) if current else 0.0
        now = time.time() * 1000
        # The page's own requests: a third-party widget or beacon that hangs does not hold the page back.
        site = same_site(page.get("href"))
        recent = [r for r in requests if float(r.get("timestamp") or 0) >= since and same_site(r.get("url")) == site]
        waiting = [r for r in recent if r.get("status") is None and r.get("url") not in done
                   and r.get("resourceType") not in ("EventSource", "WebSocket")
                   and now - float(r.get("timestamp") or 0) < REQUEST_PATIENCE_SECONDS * 1000]
        latest = max((float(r.get("timestamp") or 0) for r in recent), default=0.0)
        return bool(waiting) or page.get("ready") != "complete", latest / 1000

    def settle(self, seconds: float, quiet_from: float = 0.0) -> bool:
        """Wait until the page has loaded and its requests are answered, then QUIET_SECONDS more.

        Many sites draw a signed-out shell first and replace it once their own requests return,
        so a page captured earlier can show "Sign in" to an account that is signed in.
        """
        deadline = time.monotonic() + seconds
        while True:
            busy, latest = self.pending_requests()
            if not busy and time.time() - max(latest, quiet_from) >= QUIET_SECONDS:
                # agent-browser keeps every request it sees; once none is waiting, the log can start over.
                self.ab.batch([["network", "requests", "--clear"]])
                return True
            if time.monotonic() >= deadline:
                return not busy
            time.sleep(min(0.15, max(0.0, deadline - time.monotonic())))

    def snapshot(self, settle: float | None = None) -> dict[str, Any]:
        settled = self.settle(SETTLE_SECONDS if settle is None else settle)
        state_result, snap, marked = self.ab.batch([["eval", PAGE_STATE], ["snapshot"], ["eval", MARK_CLICKABLES]])
        state = state_result.get("result") or {}
        roots = parse_tree(snap.get("snapshot") or "")
        frames = [node for node in walk(roots) if node.role == "Iframe" and node.ref]
        sources = self.ab.batch([["get", "attr", f"@{node.ref}", "src"] for node in frames], bail=False) if frames else []
        sites = {id(node): frame_site(urljoin(str(state.get("url") or ""), str((found or {}).get("value") or "")))
                 for node, found in zip(frames, sources)}
        masked = {str(value) for value in state.get("masked") or [] if value}
        hints: list[str] = []
        frame_text: list[str] = []
        controls: list[tuple[str, dict[str, Any]]] = []

        def render(nodes: list[Node], depth: int, inside: str | None) -> None:
            for node in nodes:
                if node.role == "Iframe":
                    site = sites.get(id(node), "")
                    if payment_frame_origin(site):
                        # Card details reach a payment provider's frame only through fill_card.
                        if PAYMENT_FRAME_HINT not in hints and any(n.role == "textbox" for n in walk(node.children)):
                            hints.append(PAYMENT_FRAME_HINT)
                        continue
                    text = " ".join(n.name for n in walk(node.children) if n.role == "StaticText").strip()
                    if text:
                        frame_text.append(f"[frame {site or 'unknown'}]\n{unframed(text)}")
                if node.role == "option" and inside == "select":
                    continue
                ref = node.ref
                # agent-browser also hands refs to named text such as headings and table cells; the
                # list is of what a click or a fill can mean something for.
                if ref is None or not (node.role in CONTROL_ROLES or "clickable" in node.extra):
                    render(node.children, depth, inside)
                    continue
                value = node.value
                if value is not None and (value in masked or set(value) <= {"•"}):
                    value = None
                entry: dict[str, Any] = {"ref": ref, "role": node.role, "name": node.name[:200]}
                checked = re.search(r"\bchecked=(true|false)\b", node.attrs)
                if value is not None and value != "":
                    entry["value"] = value[:2000]
                elif checked:
                    entry["value"] = "checked" if checked.group(1) == "true" else "unchecked"
                line = f"{'  ' * depth}- {node.role}"
                if node.name:
                    line += " " + json.dumps(node.name[:100], ensure_ascii=False)
                line += f" [{node.attrs}]{node.extra}"
                if node.role == "Iframe" and sites.get(id(node)):
                    line += f" {sites[id(node)]}"
                if value is not None and value != "":
                    line += ": " + value[:100]
                options, total = options_of(node)
                if options:
                    entry["options"] = options
                    if total > len(options):
                        entry["optionsTotal"] = total
                    line += " options: " + describe_options(options, total)
                controls.append((line, entry))
                render(node.children, depth + 1, "select" if options else inside)

        render(roots, 0, None)
        named = {entry["name"].casefold() for _, entry in controls if isinstance(entry.get("name"), str)}
        extra = marked.get("result") if isinstance(marked, dict) else None
        if not isinstance(extra, list):
            extra = []
        try:
            extra = [*extra, *page_secrets.cross_origin_clickables(self.port, self.target)]
        except Exception:  # noqa: BLE001
            pass
        if isinstance(extra, list):
            for item in extra:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name") or "").strip()
                ref = str(item.get("ref") or "")
                if not name or not re.fullmatch(r"f\d+e\d+", ref) or name.casefold() in named:
                    continue
                named.add(name.casefold())
                role = str(item.get("role") or "button")
                line = f'- {role} {json.dumps(name[:100], ensure_ascii=False)} [ref={ref}]'
                controls.append((line, {"ref": ref, "role": role, "name": name[:200]}))
        if state.get("payToken"):
            account = state["payToken"]
        elif any(sites.get(id(node)) == page_secrets.PAY_TOKEN_FRAME_ORIGIN for node in frames):
            try:
                account = page_secrets.stripe_pay_token_account(self.port, self.target)
            except Exception:  # noqa: BLE001
                account = None
        else:
            account = None
        if account:
            hints.append(f'This checkout accepts a pay token: merchantAccountId "{account}".')
        shown: list[tuple[str, dict[str, Any]]] = []
        used = 0
        for line, entry in controls:
            length = sent(line) + 1
            if len(shown) >= MAX_CONTROLS or (shown and used + length > CONTROLS_BUDGET):
                break
            shown.append((line, entry))
            used += length
        listing = "\n".join(line for line, _ in shown) or "(no interactive elements)"
        notices = f"[controls: showing {len(shown)} of {len(controls)}]\n" if len(shown) < len(controls) else ""
        text = "\n".join([unframed(str(state.get("text") or "")), *frame_text])
        room = max(MIN_TEXT, TREE_BUDGET - sent(listing) - sum(sent(h) + 1 for h in hints) - 200)
        cut = len(text)
        while cut > 0 and sent(text[:cut]) > room:
            cut = int(cut * 0.9)
        if cut < len(text):
            notices += f"[page text: showing first {cut} of {len(text)} characters]\n"
        tree = notices + text[:cut] + "\n" + listing + "".join("\n" + hint for hint in hints)
        return {"ok": True, "url": str(state.get("url") or snap.get("origin") or ""),
                "title": str(state.get("title") or ""), "tree": tree, "elements": [entry for _, entry in shown],
                **({} if settled else {"loading": True})}

    def control(self, ref: str, *, check_disabled: bool = False) -> Node:
        """The element a ref names in the page as it is now; a ref that names nothing now is stale.

        agent-browser keeps a ref while its element lives, but would hand an action a replacement
        with the same role and name, even on another page. Checking right before the step stops that.
        """
        commands = [["snapshot", "-i"]]
        if check_disabled:
            # `is enabled` includes disabled fieldsets (and their first-legend exception),
            # but agent-browser does not include aria-disabled in that check.
            commands += [["is", "enabled", f"@{ref}"], ["get", "attr", f"@{ref}", "aria-disabled"]]
        snap, *state = self.step(commands)
        node = find_ref(parse_tree(snap.get("snapshot") or ""), ref)
        if node is None or ref not in (snap.get("refs") or {}):
            raise Settled(STALE_REF)
        if check_disabled and (state[0].get("enabled") is False or str(state[1].get("value")).lower() == "true"):
            raise Settled(DISABLED)
        return node

    # -- commands ---------------------------------------------------------------------------------

    def navigate(self, url: str, opened: bool = False) -> dict[str, Any]:
        """Go to url, or, when `opened`, read the tab that was just opened on it."""
        check_url(url)
        started = time.monotonic()
        before: dict[str, Any] = {}
        same_document = opened
        if not opened:
            # agent-browser's own `open` holds its session until the load event, up to 25 seconds; the
            # page is read while it is still loading instead, as the person would see it.
            _, before = self.ab.batch([["network", "requests", "--clear"],
                                       ["eval", NAVIGATE.replace("URL", json.dumps(url))]])
            before = before.get("result") or {}
            # Scripts run in a page that is being replaced answer late, so the new document's response is
            # awaited in the request log first. A new fragment of the same page loads no document.
            same_document = str(before.get("href") or "").split("#")[0] == url.split("#")[0] and "#" in url
        while not same_document:
            if self.downloads:
                self.downloads.client.listen(0.01)
                if self.downloads.client.downloads:
                    return {"ok": True, **self.snapshot(0.0)}
            (log,) = self.ab.batch([["network", "requests"]])
            if any(r.get("resourceType") == "Document" and r.get("status") is not None
                   for r in log.get("requests") or [] if isinstance(r, dict)):
                break
            if time.monotonic() - started > NAVIGATE_SECONDS:
                raise RuntimeError("Navigation did not settle; inspect the screen before continuing")
            time.sleep(0.1)
        while True:
            (now,) = self.ab.batch([["eval", "({ timeOrigin: performance.timeOrigin, href: location.href, "
                                              "ready: document.readyState })"]])
            now = now.get("result") or {}
            if self.downloads:
                self.downloads.client.listen(0.01)
                if self.downloads.client.downloads:
                    return {"ok": True, **self.snapshot(0.0)}
            moved = opened or now.get("timeOrigin") != before.get("timeOrigin") or (same_document and now.get("href") == url)
            if moved and now.get("ready") in ("interactive", "complete"):
                break
            if time.monotonic() - started > NAVIGATE_SECONDS:
                raise RuntimeError("Navigation did not settle; inspect the screen before continuing")
            time.sleep(0.1)
        page: dict[str, Any] = {}
        left = NAVIGATE_SNAPSHOT_BY - (time.monotonic() - started)
        if left > 0:
            try:
                page = self.snapshot(min(SETTLE_SECONDS, left))
            except Exception:  # noqa: BLE001
                page = {}
            if time.monotonic() - started > NAVIGATE_SNAPSHOT_UNTIL:
                page = {}
        if not page:
            url_result, title_result = self.ab.batch([["get", "url"], ["get", "title"]])
            page = {"url": url_result.get("url"), "title": str(title_result.get("title") or "")[:200]}
        return {"ok": True, **{key: page[key] for key in ("url", "title", "tree", "elements", "loading") if key in page}}

    def dialog(self) -> dict[str, Any] | None:
        """The JavaScript dialog (alert, confirm, prompt or beforeunload) the page has open, if any."""
        try:
            # Short: it can follow a step that already used most of the caller's time limit.
            (status,) = self.ab.batch([["dialog", "status"]], timeout=3.0)
        except Exception:  # noqa: BLE001
            return None
        return status if status.get("hasDialog") else None

    def dialog_result(self, dialog: dict[str, Any], progress: dict[str, Any], remaining: bool = False) -> dict[str, Any]:
        """An alert only informs and OK is its one answer, so it is closed and its message reported.
        Any other dialog asks something: it stays open on the screen for computer_act or the person."""
        kind = str(dialog.get("type") or "")
        message = str(dialog.get("message") or "")[:300]
        quoted = f": {json.dumps(message, ensure_ascii=False)}" if message else ""
        if kind != "alert":
            name = '"Leave site?"' if kind == "beforeunload" else kind
            return self.with_notes({"ok": False, **progress, "error": f"A {name} dialog is open on the screen{quoted}",
                                    "dialog": kind, "fallback": "computer_act"})
        note = f"The page showed an alert, now closed{quoted}."
        try:
            self.ab.batch([["dialog", "dismiss"]])
            snap = self.snapshot(ACTION_WAIT_SECONDS)
        except Exception:  # noqa: BLE001
            return self.with_notes({"ok": False, **progress, "error": f"The page showed an alert{quoted}.",
                                    "fallback": "computer_act"})
        # A step that was still running when the alert came may or may not have taken effect.
        unsure = " Check whether the last step took effect." if progress.get("uncertain") else ""
        if remaining or unsure:
            after = " The remaining steps did not run." if remaining else ""
            return self.with_notes({**snap, **progress, "ok": False, "error": f"{note}{unsure}{after}"})
        return self.with_notes({**snap, **progress, "note": note})

    def step(self, commands: list[list[str]]) -> list[Any]:
        try:
            results = self.ab.batch(commands)
        except AbError as error:
            if re.search(r"Element\b.*\bis disabled", str(error)):
                raise Settled(DISABLED) from None
            if any(marker in str(error) for marker in SETTLED_ERRORS):
                raise Settled(str(error)) from None
            raise
        self.dialog_opened = any(result.get("dialogOpened") is True for result in results)
        return results

    def fill(self, ref: str, text: str) -> None:
        if len(text) > 1 and self.fill_split_code(ref, text):
            return
        _, kept = self.step([["fill", f"@{ref}", text], ["get", "value", f"@{ref}"]])
        value = kept.get("value")
        if isinstance(value, str) and value and value != text:
            raise RuntimeError("Input did not accept the requested value")

    def fill_split_code(self, ref: str, text: str) -> bool:
        """Type a multi-character value one box at a time when the field is one of a split code.

        Same-origin frames are typed here. A cross-origin frame is typed in that frame.
        """
        self.step([["focus", f"@{ref}"]])
        (found,) = self.ab.batch([["eval", CODE_PROBE]])
        info = found.get("result") if isinstance(found, dict) else None
        if not isinstance(info, dict):
            return False
        if info.get("code"):
            self.type(ref, text)
            self.notes.append("Typed one character into each box.")
            return True
        if info.get("frame"):
            try:
                page_secrets.fill_code_boxes(self.port, self.target, text)
            except page_secrets.NotACode:
                return False
            self.notes.append("Typed one character into each box.")
            return True
        return False

    def click_point(self, *, ref: str | None = None, text: str | None = None) -> bool:
        """A real pointer click at a frame control or at visible text, including inside a frame."""
        source = (CLICK_POINT.replace("__REF__", json.dumps(ref or ""))
                  .replace("__TEXT__", json.dumps(text or "")))
        try:
            (found,) = self.ab.batch([["eval", source]])
        except Exception:  # noqa: BLE001
            found = None
        point = found.get("result") if isinstance(found, dict) else None
        if not isinstance(point, dict) or not isinstance(point.get("x"), (int, float)):
            try:
                point = page_secrets.cross_origin_click_point(self.port, self.target, ref=ref, text=text)
            except Exception:  # noqa: BLE001
                point = None
        if not isinstance(point, dict) or not isinstance(point.get("x"), (int, float)):
            return False
        self.coordinate_click({"x": point["x"], "y": point["y"]})
        return True

    def type(self, ref: str, text: str) -> None:
        """Real key presses into whatever has focus, as a person types: a code widget that moves
        focus from box to box gets each key in its own box. Before each key the page must still be
        the same document, with focus in the field or a box next to it."""
        token = os.urandom(8).hex()
        _, start = self.step([["focus", f"@{ref}"], ["eval", TYPE_START.replace("TOKEN", token)
                                                     .replace("WHOLE", json.dumps(len(text) > 1))]])
        info = start.get("result") or {}
        if info.get("frame") and len(text) > 1:
            # A cross-origin frame keeps focus on the frame element. Type one character per box there.
            try:
                page_secrets.fill_code_boxes(self.port, self.target, text)
            except page_secrets.NotACode:
                pass
            else:
                self.notes.append("Typed one character into each box.")
                return
        multiline = info.get("multiline") is True
        # Enter in a one-line field would submit its form; Shift+Enter breaks the line elsewhere.
        chars = [char for char in text.replace("\r\n", "\n").replace("\r", "\n") if multiline or char != "\n"]
        check = ["eval", TYPE_CHECK.replace("TOKEN", token)]
        commands: list[list[str]] = []
        if info.get("frame") or len(chars) > CHECKED_KEYS:
            for index, line in enumerate("".join(chars).split("\n")):
                if index:
                    commands.append(["press", "Shift+Enter"])
                if line:
                    commands.append(["keyboard", "type", line])
            keys_per_command = 0
        else:
            for char in chars:
                commands += [check, key_command(char)]
            keys_per_command = 2
        try:
            if commands:
                self.ab.batch(commands, timeout=60.0)
        except AbError as error:
            if keys_per_command and error.index % keys_per_command == 0 and "Typing stopped" in str(error):
                done, total = error.index // keys_per_command, len(chars)
                if "Typing stopped: page" in str(error):
                    raise TypingStopped(f"The page changed while typing, after {done} of {total} characters, "
                                        "so the rest was not typed. Take a fresh snapshot before continuing.") from None
                raise TypingStopped(f"Focus left the field while typing, after {done} of {total} characters, "
                                    "so the rest was not typed. Check the page in this snapshot before trying again.") from None
            raise
        # A page that moved on after the last key, as auto-submitting codes do, has taken the step.
        (done,) = self.ab.batch([["eval", TYPE_DONE.replace("TOKEN", token)
                                  .replace("TEXT", json.dumps(text))]])
        done_result = done.get("result") or {}
        if done_result.get("kept") is False:
            raise KeysNotKept(CODE_PARTIAL if done_result.get("boxes") else NOT_KEPT)

    def act(self, actions: list[dict[str, Any]]) -> dict[str, Any]:
        validate_actions(actions)
        completed = 0
        uncertain = False
        try:
            for step in actions:
                kind, ref = step["kind"], step.get("ref")
                if kind == "click" and isinstance(ref, str) and re.fullmatch(r"f\d+e\d+", ref):
                    uncertain = True
                    if not self.click_point(ref=ref):
                        raise Settled(STALE_REF)
                    self.notes.append("Clicked it inside its frame.")
                    completed += 1
                    uncertain = False
                    continue
                node = self.control(ref, check_disabled=kind in ("fill", "type")) if ref is not None else None
                uncertain = True
                if kind == "pay_token" or step.get("origin"):
                    if ref is not None:
                        self.step([["focus", f"@{ref}"]])
                    page_secrets.run_step(self.port, self.target, step)
                elif kind == "click":
                    # agent-browser scrolls an element into view inside its frame, not the frame into view
                    # on the page, so a click on a frame below the fold would land on whatever is there.
                    frame = node.frame  # type: ignore[union-attr]
                    # A native dropdown takes its option from fill; a click would open a list the page cannot see.
                    if self.downloads:
                        with contextlib.suppress(Exception):
                            self.step([["focus", f"@{ref}"]])
                            (link,) = self.ab.batch([["eval", "Boolean(document.activeElement?.closest('a[download]'))"]])
                            if link.get("result"):
                                self.downloads.client.download_links.append(time.monotonic())
                    try:
                        self.step([*([["scrollintoview", f"@{frame.ref}"]] if frame else []),
                                   ["focus" if native_options(node) else "click", f"@{ref}"]])  # type: ignore[arg-type]
                    except Settled as exc:
                        # A control drawn as text inside a frame has no accessible click. Hit that text.
                        if node.frame and node.name and self.click_point(text=node.name):
                            self.notes.append(
                                f"Clicked {json.dumps(node.name, ensure_ascii=False)} by its text inside the frame.")
                        elif native_options(node) or "is covered by" not in str(exc):
                            raise
                        else:
                            # A banner, sticky bar, or a strict hit test can be cleared without the bot retrying.
                            self.notes.append(self.recover_covered(ref, str(exc)))
                elif kind == "upload":
                    self.step([["upload", f"@{ref}", *step["files"]]])
                elif kind == "fill" and native_options(node):  # type: ignore[arg-type]
                    self.step([["select", f"@{ref}", step["text"]]])
                elif kind == "fill":
                    self.fill(ref, step["text"])
                else:
                    try:
                        self.type(ref, step["text"])
                    except KeysNotKept:
                        completed += 1
                        raise
                completed += 1
                uncertain = False
                dialog = self.dialog() if self.dialog_opened else None
                if dialog:
                    return self.dialog_result(dialog, {"completed": completed, "uncertain": False},
                                              remaining=completed < len(actions))
            ended = time.time()
            time.sleep(ACTION_QUIET_SECONDS)
            started = time.monotonic()
            busy = not self.settle(ACTION_WAIT_SECONDS - ACTION_QUIET_SECONDS, quiet_from=ended)
            left = ACTION_WAIT_SECONDS - ACTION_QUIET_SECONDS - (time.monotonic() - started)
            snap = self.snapshot(0.0 if busy else max(0.0, left))
            return self.with_notes({**snap, "completed": completed, **({"loading": True} if busy else {})})
        except (Settled, TypingStopped, KeysNotKept) as exc:
            # Nothing changed for this step, or typing stopped where it says. The page as it is goes with the reason.
            try:
                snap = self.snapshot(0.0)
            except Exception:  # noqa: BLE001
                snap = {}
            error = NOT_KEPT if isinstance(exc, KeysNotKept) else str(exc)
            return self.with_notes({"uncertain": False, **snap, "ok": False, "completed": completed, "error": error})
        except Refused as exc:
            # Settled, and fixable in the page browser: no desktop fallback.
            return {"ok": False, "completed": completed, "uncertain": False, "error": str(exc)}
        except CardFieldUncertain as exc:
            return {"ok": False, "completed": completed, "uncertain": True, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            dialog = self.dialog()
            if dialog:
                return self.dialog_result(dialog, {"completed": completed, "uncertain": uncertain},
                                          remaining=completed + uncertain < len(actions))
            return {"ok": False, "completed": completed, "uncertain": uncertain, "error": str(exc),
                    "fallback": "computer_act"}


# Typing runs in the page's own world: it reads and checks only what the page could change anyway.
# A code is typed into its boxes: like-named one- or two-character inputs around the field, up to
# where their numbering starts again, so a second code or a middle-initial field next to it is left alone.
CODE_BOXES = r"""
  // instanceof against this document's constructors misses an element in a same-origin frame.
  const viewOf = (node) => node && node.ownerDocument && node.ownerDocument.defaultView;
  const isInput = (node) => { const view = viewOf(node); return !!(view && node instanceof view.HTMLInputElement); };
  const isTextArea = (node) => { const view = viewOf(node); return !!(view && node instanceof view.HTMLTextAreaElement); };
  const isFrame = (node) => {
    const view = viewOf(node);
    return !!(view && (node instanceof view.HTMLIFrameElement || node instanceof view.HTMLFrameElement));
  };
  // Boxes cap their own length at one or two characters. Number boxes ignore a cap, and some pages
  // set none: those must be narrow and say they take one digit, so card or date fields never count.
  const box = (input) => {
    if (!isInput(input)) return false;
    if (input.maxLength > 0) return input.maxLength <= 2;
    const width = input.getBoundingClientRect().width;
    return ["text", "tel", "number", "password"].includes(input.type) && width > 0 && width <= 72
      && (input.autocomplete === "one-time-code"
        || (input.type === "number" && input.max !== "" && Number(input.max) <= 9));
  };
  const naming = (field) => [field.getAttribute("aria-label"), field.name, field.id,
    ...Array.from(field.labels || [], (label) => label.textContent)].join("|").replace(/[\d\s]+/g, "").toLowerCase();
  // Pages often label only the first box, with the prompt, and leave the rest unnamed. Unnamed boxes
  // straight after a named one, with no other field between, are its code, if the whole run is a code's size.
  const unnamed = (field) => /^\|*$/.test(naming(field));
  const cache = new WeakMap();
  const led = new WeakMap();
  const named = (field, container) => {
    let names = cache.get(container);
    if (!names) {
      names = new Map();
      const members = new Set();
      led.set(container, members);
      const inputs = [...container.querySelectorAll("input")].filter((input) => input.type !== "hidden");
      const bare = (input) => input && box(input) && unnamed(input);
      inputs.forEach((input, at) => {
        if (names.has(input)) return;
        names.set(input, naming(input));
        if (!bare(input)) return;
        let from = at;
        let to = at;
        while (bare(inputs[from - 1])) from--;
        while (bare(inputs[to + 1])) to++;
        const lead = inputs[from - 1];
        const name = lead && box(lead) && to - from >= 2 && to - from <= 6 ? naming(lead) : naming(input);
        if (name === naming(input)) return;
        for (let i = from - 1; i <= to; i++) members.add(inputs[i]);
        for (let i = from; i <= to; i++) names.set(inputs[i], name);
      });
      cache.set(container, names);
    }
    return names.get(field) ?? naming(field);
  };
  // Boxes with no length cap only count as a code when a named box leads them.
  const joined = (input, container) => input.maxLength > 0 || (named(input, container), led.get(container).has(input));
  const numberOf = (field) => {
    const found = /\d+/.exec(field.getAttribute("aria-label")
      || Array.from(field.labels || [], (label) => label.textContent).join(" ") || field.name || "");
    return found ? Number(found[0]) : null;
  };
  const like = (container, name) => [...container.querySelectorAll("input")].filter((input) => box(input)
    && joined(input, container) && named(input, container) === name);
  function codeOf(el) {
    if (!box(el)) return null;
    for (let node = el.parentElement, up = 0; node && up < 3; node = node.parentElement, up++) {
      if ([...node.querySelectorAll("input")].filter(box).length < 4 || !joined(el, node)) continue;
      const boxes = like(node, named(el, node));
      const restarts = (a, b) => numberOf(a) !== null && numberOf(b) !== null && numberOf(b) <= numberOf(a);
      let from = boxes.indexOf(el);
      let to = from;
      while (from > 0 && !restarts(boxes[from - 1], boxes[from])) from--;
      while (to < boxes.length - 1 && !restarts(boxes[to], boxes[to + 1])) to++;
      return { container: node, name: named(el, node), from, size: to - from + 1, at: boxes.indexOf(el) };
    }
    return null;
  }
  const empty = (field) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, "");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const focused = () => {
    let active = document.activeElement;
    for (let i = 0; i < 8 && active; i++) {
      if (active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
        continue;
      }
      // A same-origin frame's focused field is the one the keys reach. A cross-origin frame stays
      // the frame element, and the keys are sent to it as a whole.
      try {
        const doc = active.contentDocument;
        const inner = doc && doc.activeElement;
        if (inner && inner !== doc.body && inner !== doc.documentElement) {
          active = inner;
          continue;
        }
      } catch (e) { /* cross-origin */ }
      break;
    }
    return active;
  };
"""

TYPE_START = "(() => {" + CODE_BOXES + r"""
  const el = focused();
  if (isFrame(el)) return { frame: true };
  if (!el || el === document.body) throw new Error("The field did not take keyboard focus. Click it, then type again.");
  const code = codeOf(el);
  let start = code ? code.at : 0;
  if (code && code.size > 1 && WHOLE) {
    // A whole code replaces the code: every box is emptied and typing starts at the first. Widgets
    // that draw their boxes again on each input are found again in the same place each time.
    const boxes = () => {
      cache.delete(code.container);
      return like(code.container, code.name).slice(code.from, code.from + code.size);
    };
    for (let i = 0; i < 24; i++) {
      const filled = boxes().find((field) => field.value);
      if (!filled) break;
      empty(filled);
    }
    start = code.from;
    boxes()[0]?.focus();
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  } else if ((isInput(el) || isTextArea(el)) && el.value) {
    empty(el);
  }
  window.__rakazoTyping = { token: "TOKEN", el, code, start };
  return { multiline: !isInput(el) };
})()"""

# Focus may move on by itself to the next box of the code, and nowhere else.
TYPE_CHECK = "(() => {" + CODE_BOXES + r"""
  const typing = window.__rakazoTyping;
  if (typing?.token !== "TOKEN") throw new Error("Typing stopped: page");
  const active = focused();
  const { el, code } = typing;
  const holds = active === el || el.contains(active) || (code !== null && code.container.isConnected
    && code.container.contains(active) && box(active) && named(active, code.container) === code.name);
  if (!holds) throw new Error("Typing stopped: focus");
  return true;
})()"""

TYPE_DONE = "(() => {" + CODE_BOXES + r"""
  const typing = window.__rakazoTyping;
  if (typing?.token !== "TOKEN") return { kept: true };
  const { el, code, start } = typing;
  const letters = (value) => String(value).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const wanted = letters(TEXT);
  if (code) {
    if (!code.container.isConnected) return { kept: true };
    const shown = like(code.container, code.name).slice(start).map((field) => field.value).join("");
    const kept = letters(shown).slice(0, wanted.length) === wanted;
    return { kept, boxes: true };
  }
  if (!el.isConnected) return { kept: true };
  return { kept: letters(el.isContentEditable ? el.innerText : el.value) === wanted };
})()"""

# A fill or type of several characters into one box of a split code. Same rules as typing a code.
CODE_PROBE = "(() => { const rakazoCodeProbe = true; " + CODE_BOXES + r"""
  const el = focused();
  if (isFrame(el)) return { frame: true };
  const code = el && codeOf(el);
  if (!code || code.size < 4) return {};
  const boxes = like(code.container, code.name).slice(code.from, code.from + code.size);
  if (!boxes.length || !boxes.every((field) => field.maxLength === 1)) return {};
  return { code: true, size: boxes.length };
})()"""

# Clickable text inside a frame that the accessibility tree does not give a ref: a span with a
# click handler, a pointer cursor, or a button role. Refs are frame-qualified (f2e1).
MARK_CLICKABLES = r"""(() => {
  const marks = [];
  let nextFrame = 0;
  const clickableText = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName;
    if (["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "FRAME", "HTML", "BODY"].includes(tag)) return "";
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return "";
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return "";
    const role = (el.getAttribute("role") || "").toLowerCase();
    const clicky = role === "button" || role === "link" || el.hasAttribute("onclick")
      || typeof el.onclick === "function" || style.cursor === "pointer";
    if (!clicky) return "";
    return (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  };
  const pagePoint = (el) => {
    const rect = el.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    let win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const frame = win.frameElement;
      const outer = frame.getBoundingClientRect();
      const sx = outer.width / (frame.clientWidth || outer.width || 1);
      const sy = outer.height / (frame.clientHeight || outer.height || 1);
      x = outer.left + x * sx;
      y = outer.top + y * sy;
      win = frame.ownerDocument.defaultView;
    }
    const view = window.visualViewport;
    if (view) {
      x = (x - view.offsetLeft) * (view.scale || 1);
      y = (y - view.offsetTop) * (view.scale || 1);
    }
    return { x, y };
  };
  const visit = (doc) => {
    const frameNo = nextFrame++;
    if (frameNo > 0) {
      let serial = 0;
      for (const el of doc.querySelectorAll("span,div,p,label,[role='button'],[role='link']")) {
        const text = clickableText(el);
        if (!text) continue;
        if ([...el.querySelectorAll("span,div,p,label,[role='button'],[role='link']")].some((child) => clickableText(child) === text))
          continue;
        serial += 1;
        const ref = "f" + frameNo + "e" + serial;
        el.setAttribute("data-rakazo-click", ref);
        marks.push({ ref, name: text, role: (el.getAttribute("role") || "button").toLowerCase() });
      }
    }
    for (const frame of doc.querySelectorAll("iframe,frame")) {
      try { if (frame.contentDocument) visit(frame.contentDocument); } catch (e) { /* cross-origin */ }
    }
  };
  visit(document);
  return marks;
})()"""

# Where to send a real pointer click for a frame ref or a visible text, in top-viewport CSS pixels.
CLICK_POINT = r"""(() => {
  const wantRef = __REF__;
  const wantText = __TEXT__;
  const pagePoint = (el) => {
    const rect = el.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    let win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const frame = win.frameElement;
      const outer = frame.getBoundingClientRect();
      const sx = outer.width / (frame.clientWidth || outer.width || 1);
      const sy = outer.height / (frame.clientHeight || outer.height || 1);
      x = outer.left + x * sx;
      y = outer.top + y * sy;
      win = frame.ownerDocument.defaultView;
    }
    const view = window.visualViewport;
    if (view) {
      x = (x - view.offsetLeft) * (view.scale || 1);
      y = (y - view.offsetTop) * (view.scale || 1);
    }
    return { x, y };
  };
  const docs = [document];
  const walk = (doc) => {
    for (const frame of doc.querySelectorAll("iframe,frame")) {
      try { if (frame.contentDocument) { docs.push(frame.contentDocument); walk(frame.contentDocument); } }
      catch (e) { /* cross-origin */ }
    }
  };
  walk(document);
  if (wantRef) {
    for (const doc of docs) {
      const el = doc.querySelector(`[data-rakazo-click="${wantRef}"]`);
      if (el) return pagePoint(el);
    }
    return null;
  }
  const wanted = String(wantText || "").replace(/\s+/g, " ").trim();
  if (!wanted) return null;
  for (const doc of docs) {
    const nodes = [...doc.querySelectorAll("a,button,span,div,p,label,[role='button'],[role='link']")];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const text = (nodes[i].innerText || nodes[i].getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (text === wanted) return pagePoint(nodes[i]);
    }
  }
  return null;
})()"""


def key_command(char: str) -> list[str]:
    """One character as a real key press, or as inserted text where a key cannot name it."""
    if char == "\n":
        return ["press", "Shift+Enter"]
    if char.isascii() and char.isalnum():
        return ["press", char]
    return ["keyboard", "inserttext", char]


class CdpClient(page_secrets.CdpClient):
    """The shared CDP transport with events for this call's downloads."""

    def __init__(self, ws_url: str) -> None:
        super().__init__(ws_url)
        # Downloads Chromium began since download events were turned on, by guid, in the order they began.
        self.downloads: dict[str, dict[str, Any]] = {}
        # The MIME type each document response was sent with, by URL, for the type of a download.
        self._mime_types: dict[str, str] = {}
        # The page's top frame while its downloads are saved, and the documents it requested since then
        # that have not loaded: when each was requested and when its answer came. A download's answer
        # ends its request just before the download begins.
        self.download_frame: str | None = None
        self._documents: dict[str, list[float | None]] = {}
        # When the bot clicked links that download (`<a download>`) whose downloads have not begun: the
        # browser makes their requests, so the page has no document for them.
        self.download_links: list[float] = []
        # Pages that opened during this call. A download that starts in a new tab has no request on the
        # page that was clicked, so the call waits for it the way it waits for a download link.
        self.new_pages: list[dict[str, Any]] = []

    def _handle_event(self, message: dict[str, Any]) -> None:
        super()._handle_event(message)
        method = message.get("method")
        params = message.get("params") or {}
        if method == "Browser.downloadWillBegin":
            if self.download_links:
                self.download_links.pop(0)
            for page in self.new_pages:
                page["done"] = True
            guid = params.get("guid")
            if isinstance(guid, str):
                self.downloads.setdefault(guid, {"name": params.get("suggestedFilename"), "url": params.get("url"),
                                                 "state": "inProgress", "received": 0, "total": 0})
        elif method == "Runtime.bindingCalled" and params.get("name") == "rakazoDownloadHint":
            self.download_links.append(time.monotonic())
        elif method == "Target.targetCreated":
            info = params.get("targetInfo") or {}
            if info.get("type") == "page" and isinstance(info.get("targetId"), str) and len(self.new_pages) < 20:
                self.new_pages.append({"id": info["targetId"], "url": str(info.get("url") or ""),
                                       "at": time.monotonic()})
        elif method == "Target.targetInfoChanged":
            info = params.get("targetInfo") or {}
            for page in self.new_pages:
                if page["id"] == info.get("targetId") and isinstance(info.get("url"), str):
                    page["url"] = info["url"]
        elif method == "Browser.downloadProgress":
            download = self.downloads.get(params.get("guid"))
            if download is not None:
                download.update(state=params.get("state"), received=params.get("receivedBytes") or 0,
                                total=params.get("totalBytes") or 0)
        elif method == "Network.responseReceived":
            response = params.get("response") or {}
            if params.get("type") == "Document" and isinstance(response.get("mimeType"), str):
                self._mime_types[str(response.get("url"))] = response["mimeType"]
            if params.get("requestId") in self._documents:
                self._documents[params["requestId"]][1] = time.monotonic()
        elif method == "Network.requestWillBeSent":
            request_id = params.get("requestId")
            if (self.download_frame and params.get("frameId") == self.download_frame
                    and params.get("type") == "Document" and isinstance(request_id, str)):
                self._documents.setdefault(request_id, [time.monotonic(), None])
        elif method in ("Network.loadingFinished", "Network.loadingFailed"):
            if method == "Network.loadingFinished":
                self._documents.pop(params.get("requestId"), None)
            elif params.get("requestId") in self._documents:
                self._documents[params["requestId"]][1] = time.monotonic()

    def mime_type(self, url: Any) -> str | None:
        kind = self._mime_types.get(str(url), "")
        # A server's text that reaches the bot, so only a plain type/subtype is kept.
        return kind if len(kind) <= 100 and re.fullmatch(r"[\w.+-]+/[\w.+-]+", kind, re.ASCII) else None

    def documents_pending(self, grace: float, wait: float) -> bool:
        """Whether a document the page requested may still turn out to be a download."""
        now = time.monotonic()

        def page_pending(page: dict[str, Any]) -> bool:
            if page.get("done"):
                return False
            url = str(page.get("url") or "")
            age = now - page["at"]
            # A new tab is about:blank until it navigates. Wait briefly for that address, then only
            # for one that looks like a file.
            if not url or url.startswith("about:"):
                return age < grace
            return page_may_download(url) and age < wait

        return any(now - clicked < wait for clicked in self.download_links) or any(
            page_pending(page) for page in self.new_pages) or any(
            now - requested < wait if answered is None else now - answered < grace
            for requested, answered in self._documents.values())

    def listen(self, seconds: float) -> None:
        """Handle the events that arrive within `seconds`, as they arrive, so their times are true."""
        assert self._sock is not None
        deadline = time.monotonic() + seconds
        while (left := deadline - time.monotonic()) > 0:
            self._sock.settimeout(left)
            try:
                frame = self._read_frame()
            except socket.timeout:
                return
            message = json.loads(frame.decode("utf-8"))
            if isinstance(message, dict) and message.get("method"):
                self._handle_event(message)


def max_file_bytes() -> int:
    """The most bytes a file moved between this computer and a page may have, uploaded or downloaded."""
    try:
        override = int(os.environ.get("RAKAZO_BROWSER_UPLOAD_MAX_BYTES", ""))
    except ValueError:
        return MAX_UPLOAD_BYTES
    return override if override > 0 else MAX_UPLOAD_BYTES


# A navigate or act that the host gives the bot's download folder saves the files its page downloads
# there, under the name the site gave (made safe), and lists them in its result.
MAX_DOWNLOADS = MAX_UPLOAD_FILES
# Downloads are waited for until this long after the helper started, inside the supervisor's limit on
# one call. One still running then is listed as downloading and given its name when it finishes.
DOWNLOAD_WAIT_UNTIL = 15.0
# A document whose answer is a download ends its request a moment before the download begins. A
# document still unanswered this long after it was requested is a slow page, not waited for longer.
DOWNLOAD_BEGIN_SECONDS = 0.5
DOCUMENT_WAIT_SECONDS = 5.0
FINISH_LATER_SECONDS = 15 * 60
STARTED = time.monotonic()
DOWNLOAD_FAILED = "The download failed."
DOWNLOADS_UNUSABLE = "Downloads cannot be saved on this computer: its Downloads folder is not usable."
TOO_MANY_DOWNLOADS = f"downloads not saved: a call saves at most {MAX_DOWNLOADS} files."
# A new tab whose address looks like a file, or that has not navigated yet, may be a download starting.
FILE_DOWNLOAD = re.compile(r"\.(csv|xlsx?|pdf|zip|tsv)(?:$|\?)", re.IGNORECASE)


def page_may_download(url: str) -> bool:
    if url.startswith(("blob:", "data:")):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    return bool(FILE_DOWNLOAD.search(parts.path))


def journal_path(folder: str) -> str:
    """Where a download that finishes after its call is recorded, outside the folder the bot lists."""
    digest = hashlib.sha256(os.path.realpath(folder).encode()).hexdigest()[:24]
    return f"/tmp/rakazo/downloads-{digest}.jsonl"


def remember_download(folder: str, name: str, size: int, kind: str | None = None) -> None:
    home = os.path.realpath(os.environ.get("HOME") or "/home/rakazo")
    shown = os.path.relpath(folder, home)
    entry: dict[str, Any] = {"name": name, "path": f"{shown}/{name}", "size": size}
    if kind:
        entry["type"] = kind
    path = journal_path(folder)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def take_remembered(folder: str) -> list[dict[str, Any]]:
    """Downloads recorded since the last page result, each reported once."""
    path = journal_path(folder)
    taken_path = f"{path}.take"
    try:
        os.replace(path, taken_path)
    except OSError:
        return []
    try:
        with open(taken_path, encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return []
    finally:
        with contextlib.suppress(OSError):
            os.remove(taken_path)
    found = []
    for line in lines:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and isinstance(item.get("path"), str) and isinstance(item.get("name"), str):
            found.append(item)
    return found


def download_busy_path(folder: str) -> str:
    digest = hashlib.sha256(folder.encode()).hexdigest()[:16]
    return f"/tmp/rakazo/download-busy-{digest}"


def hold_marker(folder: str) -> str:
    digest = hashlib.sha256(folder.encode()).hexdigest()[:16]
    return f"/tmp/rakazo/download-hold-{digest}"


def hold_alive(marker: str) -> bool:
    try:
        pid = int(open(marker, encoding="utf-8").read().strip())
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


# Tells the helper a click is about to download, including a blob link or a new tab, so the call waits
# for the file instead of returning before Chromium has started it.
DOWNLOAD_HINT = r"""(() => {
  if (window.__rakazoDownloadHint) return;
  window.__rakazoDownloadHint = true;
  const mark = () => { try { window.rakazoDownloadHint("1"); } catch (e) {} };
  const proto = HTMLAnchorElement.prototype;
  const click = proto.click;
  proto.click = function () {
    const href = String(this.href || "");
    if (this.hasAttribute("download") || href.startsWith("blob:")) mark();
    return click.apply(this, arguments);
  };
  document.addEventListener("click", (event) => {
    const node = event.target && event.target.closest ? event.target.closest("a[download], a[href^='blob:']") : null;
    if (node) mark();
  }, true);
  const open = window.open;
  window.open = function (url) {
    if (typeof url === "string" && url) mark();
    return open.apply(this, arguments);
  };
})()"""


def hold_tick(client: CdpClient, folder: str, busy: str, seen_busy: set[str]) -> None:
    """Keep Chromium saving into `folder` with no dialog, except while a page call is naming files itself.

    A download that started during that call is left to the call. One that finishes in between is named
    the same way as a call (the guid file, then a safe name) and recorded for the next snapshot. One
    over the size limit is cancelled and not recorded.
    """
    if os.path.exists(busy):
        seen_busy.add("__busy__")
        seen_busy.update(client.downloads)
        return
    # The first tick after the call ends still belongs to it: those files are named by the call.
    if "__busy__" in seen_busy:
        seen_busy.update(client.downloads)
        seen_busy.discard("__busy__")
    client.call("Browser.setDownloadBehavior", {
        "behavior": "allowAndName", "downloadPath": folder, "eventsEnabled": True,
    })
    max_bytes = max_file_bytes()
    taken: set[str] = set()
    for guid, download in client.downloads.items():
        if guid in seen_busy or download.get("journaled"):
            continue
        state = download.get("state")
        if state not in ("inProgress", "completed"):
            continue
        staged = os.path.join(folder, guid)
        total = download.get("total") or 0
        received = download.get("received") or 0
        if (isinstance(total, int) and isinstance(received, int) and max(total, received) > max_bytes):
            with contextlib.suppress(Exception):
                client.call("Browser.cancelDownload", {"guid": guid})
            remove_partial(staged)
            download["journaled"] = True
            continue
        if state != "completed" or os.path.islink(staged) or not os.path.isfile(staged):
            continue
        try:
            chosen = place_download(staged, folder, download_name(download.get("name")), taken)
        except (OSError, RuntimeError):
            remove_partial(staged)
            download["journaled"] = True
            continue
        taken.add(chosen)
        remember_download(folder, chosen, os.path.getsize(os.path.join(folder, chosen)))
        download["journaled"] = True


def download_folder(folder: Any, home: str) -> str:
    """The bot's download folder, made inside the home folder without passing through a symlink.

    A folder reached through a symlink (bots/b1 -> bots/b2) could put files in another bot's folder.
    """
    if not isinstance(folder, str) or not folder or "\0" in folder or os.path.isabs(folder):
        raise RuntimeError(DOWNLOADS_UNUSABLE)
    expected = os.path.normpath(os.path.join(home, folder))
    if expected == home or os.path.commonpath([home, expected]) != home:
        raise RuntimeError(DOWNLOADS_UNUSABLE)
    path = home
    for part in os.path.relpath(expected, home).split(os.sep):
        path = os.path.join(path, part)
        with contextlib.suppress(FileExistsError):
            os.mkdir(path, 0o755)
        if os.path.islink(path) or not os.path.isdir(path):
            raise RuntimeError(DOWNLOADS_UNUSABLE)
    return expected


def download_name(name: Any) -> str:
    """A site's name for a file as one short, plain path segment: it is untrusted text the bot reads and
    puts in its shell, so shell characters such as `$`, backticks, quotes and `;` become `_` too."""
    text = "".join(
        "_" if char in "/\\$`;|&<>!\"'" else " " if unicodedata.category(char)[0] in "CZ" else char
        for char in unicodedata.normalize("NFC", str(name or ""))
    )
    stem, ext = os.path.splitext(" ".join(text.split()).strip(". "))
    if len(ext) > 12 or " " in ext:
        stem, ext = stem + ext, ""
    while stem and (len(stem) + len(ext) > 80 or len((stem + ext).encode()) > 200):
        stem = stem[:-1]
    stem = stem.rstrip(". ")
    return stem + ext if stem else "download" + ext


def free_name(folder: str, name: str, taken: set[str]) -> str:
    """`name`, or `name (1)` and so on, that nothing in the folder or `taken` already has."""
    stem, ext = os.path.splitext(name)
    for number in range(1000):
        candidate = name if number == 0 else f"{stem} ({number}){ext}"
        if candidate not in taken and not os.path.lexists(os.path.join(folder, candidate)):
            return candidate
    raise RuntimeError(DOWNLOAD_FAILED)


def place_download(staged: str, folder: str, name: str, taken: set[str]) -> str:
    """Give a finished download its name. A link never replaces an existing entry or writes through a symlink."""
    info = os.lstat(staged)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > max_file_bytes():
        raise RuntimeError(DOWNLOAD_FAILED)
    while True:
        chosen = free_name(folder, name, taken)
        try:
            os.link(staged, os.path.join(folder, chosen))
        except FileExistsError:
            taken.add(chosen)
            continue
        os.unlink(staged)
        return chosen


def remove_partial(staged: str) -> None:
    for path in (staged, staged + ".crdownload"):
        with contextlib.suppress(OSError):
            os.unlink(path)


class Downloads:
    """Saves the files a call's page downloads into the bot's folder, from when it is made until `finish`.

    Chromium's download setting covers the whole browser and goes back to its default when the CDP
    connection that made it closes, so the person's own downloads afterwards are unaffected.
    """

    def __init__(self, client: CdpClient, folder: Any, session_id: str | None = None, home: str | None = None) -> None:
        self.client = client
        self.home = os.path.realpath(home or os.environ.get("HOME") or "/home/rakazo")
        try:
            self.folder: str | None = download_folder(folder, self.home)
        except (RuntimeError, OSError):
            # Fail closed: the call's downloads are refused rather than saved anywhere else.
            self.folder = None
        try:
            client.call("Browser.setDownloadBehavior", {
                "behavior": "allowAndName" if self.folder else "deny",
                **({"downloadPath": self.folder} if self.folder else {}),
                "eventsEnabled": True,
            })
        except Exception:  # noqa: BLE001
            # A browser that cannot be told downloads as it would without a folder; the call goes on.
            self.folder = None
        self.max_bytes = max_file_bytes()
        self.stopped: dict[str, str] = {}
        # Only the page's own navigations can turn into downloads; a frame's slow document is not waited for.
        with contextlib.suppress(Exception):
            if session_id:
                frame = client.call("Page.getFrameTree", session_id=session_id)["frameTree"]["frame"]
                client.download_frame = frame["id"]

    def arm(self, session_id: str) -> None:
        """Notice blob links and new tabs on this page, and new targets in the browser."""
        with contextlib.suppress(Exception):
            self.client.call("Runtime.addBinding", {"name": "rakazoDownloadHint"}, session_id=session_id)
            self.client.call("Page.addScriptToEvaluateOnNewDocument", {"source": DOWNLOAD_HINT}, session_id=session_id)
            self.client.call("Runtime.evaluate", {"expression": DOWNLOAD_HINT}, session_id=session_id)
        with contextlib.suppress(Exception):
            self.client.call("Target.setDiscoverTargets", {"discover": True})

    def check_limits(self) -> None:
        """Cancel a download past the call's count or over the size limit; Chromium deletes what it wrote."""
        for index, (guid, download) in enumerate(self.client.downloads.items()):
            if guid in self.stopped or download["state"] not in ("inProgress", "completed"):
                continue
            if index >= MAX_DOWNLOADS:
                self.stopped[guid] = TOO_MANY_DOWNLOADS
            elif max(download["total"], download["received"]) > self.max_bytes:
                self.stopped[guid] = f"Not saved: larger than {self.max_bytes / (1024 * 1024):g} MB."
            else:
                continue
            with contextlib.suppress(Exception):
                self.client.call("Browser.cancelDownload", {"guid": guid})

    def finish(self) -> list[dict[str, Any]]:
        """Wait for the call's downloads within its time, then list each one as the bot will find it."""
        prior = take_remembered(self.folder) if self.folder else []
        while True:
            self.check_limits()
            running = any(download["state"] == "inProgress" and guid not in self.stopped
                          for guid, download in self.client.downloads.items())
            left = STARTED + DOWNLOAD_WAIT_UNTIL - time.monotonic()
            documents = self.client.documents_pending(DOWNLOAD_BEGIN_SECONDS, DOCUMENT_WAIT_SECONDS)
            if left <= 0 or not (running or documents):
                break
            self.client.listen(min(0.05, left))
        taken: set[str] = set()
        later: list[dict[str, str]] = []
        found = [self.entry(guid, download, taken, later) for guid, download in self.client.downloads.items()]
        if later:
            # Detached and holding none of this call's files or connections, so the call ends now. Each
            # call that leaves a download running starts one; it ends with them or after FINISH_LATER_SECONDS.
            env = {key: value for key, value in os.environ.items()
                   if key not in ("RAKAZO_BROWSER_ARGS_STDIN", "RAKAZO_BROWSER_WATCH_STDIN")}
            subprocess.Popen([sys.executable, os.path.abspath(__file__), "finish", json.dumps({"downloads": later})],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, close_fds=True, env=env)
        if len(found) > MAX_DOWNLOADS:
            found = found[:MAX_DOWNLOADS] + [{"error": f"{len(found) - MAX_DOWNLOADS} more {TOO_MANY_DOWNLOADS}"}]
        return prior + found

    def entry(self, guid: str, download: dict[str, Any], taken: set[str],
              later: list[dict[str, str]]) -> dict[str, Any]:
        name = download_name(download["name"])
        if self.folder is None:
            return {"name": name, "error": DOWNLOADS_UNUSABLE}
        staged = os.path.join(self.folder, guid)
        if guid in self.stopped or download["state"] not in ("completed", "inProgress"):
            remove_partial(staged)
            return {"name": name, "error": self.stopped.get(guid, DOWNLOAD_FAILED)}
        shown = os.path.relpath(self.folder, self.home)
        if download["state"] == "inProgress":
            # Not held on disk until it finishes: a file given this name meanwhile makes it `name (1)`.
            name = free_name(self.folder, name, taken)
            taken.add(name)
            later.append({"guid": guid, "staged": staged, "folder": self.folder, "name": name})
            return {"name": name, "path": f"{shown}/{name}", "state": "downloading", "size": download["received"]}
        try:
            name = place_download(staged, self.folder, name, taken)
            size = os.stat(os.path.join(self.folder, name)).st_size
        except (OSError, RuntimeError):
            remove_partial(staged)
            return {"name": name, "error": DOWNLOAD_FAILED}
        taken.add(name)
        kind = self.client.mime_type(download["url"]) or mimetypes.guess_type(name)[0]
        return {"name": name, "path": f"{shown}/{name}", "size": size, **({"type": kind} if kind else {})}


def finish_later(pending: list[dict[str, str]], seconds: float = FINISH_LATER_SECONDS) -> None:
    """Name the downloads still running when their call ended once Chromium finishes them.

    Chromium writes `<guid>.crdownload` and renames it `<guid>` when complete. Over the size limit,
    the download is cancelled.
    """
    until = time.monotonic() + seconds
    max_bytes = max_file_bytes()
    begun: set[str] = set()
    placement_failed: set[str] = set()
    while pending and time.monotonic() < until:
        time.sleep(0.5)
        for item in list(pending):
            staged = item["staged"]
            try:
                size = os.path.getsize(staged + ".crdownload")
            except OSError:
                if os.path.exists(staged):
                    try:
                        chosen = place_download(staged, item["folder"], item["name"], set())
                    except (OSError, RuntimeError):
                        placement_failed.add(staged)
                    else:
                        with contextlib.suppress(OSError):
                            remember_download(item["folder"], chosen,
                                              os.path.getsize(os.path.join(item["folder"], chosen)))
                        pending.remove(item)
                        placement_failed.discard(staged)
                elif staged in begun:
                    # Cancelled or failed: Chromium removed what it wrote.
                    pending.remove(item)
                continue
            begun.add(staged)
            if size > max_bytes:
                pending.remove(item)
                with contextlib.suppress(Exception):
                    client = CdpClient(discover_ws_url(cdp_port()))
                    client.connect()
                    try:
                        client.call("Browser.cancelDownload", {"guid": item["guid"]})
                    finally:
                        client.close()
                remove_partial(staged)

    if any(item["staged"] in placement_failed for item in pending):
        # Keep completed files available for retries until the deadline, then fail like entry().
        for item in pending:
            if item["staged"] in placement_failed:
                remove_partial(item["staged"])
        raise RuntimeError(DOWNLOAD_FAILED)


def resolve_upload_paths(paths: Any, home: str | None = None, roots: list[str] | None = None) -> list[str]:
    """Resolve regular files within trusted roots before handing them to Chromium."""
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_UPLOAD_FILES:
        raise RuntimeError(f"upload needs 1 to {MAX_UPLOAD_FILES} file paths")
    home = os.path.realpath(home or os.environ.get("HOME") or "/home/rakazo")
    location = "your folder or shared/" if roots is not None else "this computer's home folder"
    allowed = [home]
    if roots is not None:
        allowed = []
        for root in roots:
            expected = os.path.normpath(os.path.join(home, root))
            full = os.path.realpath(expected)
            # A root redirected by a symlink (bots/b1 -> bots/b2) could reach another bot's files.
            if os.path.isabs(root) or full != expected or os.path.commonpath([home, full]) != home:
                raise RuntimeError(f"Upload files must be inside {location}")
            # A folder that does not exist yet holds no files; the other root still applies.
            if os.path.isdir(full):
                allowed.append(full)
    max_bytes = max_file_bytes()
    resolved = []
    total = 0
    for path in paths:
        if not isinstance(path, str) or not path.strip():
            raise RuntimeError("upload paths must be non-empty strings")
        full = os.path.realpath(os.path.join(home, path))
        # Check confinement before existence to avoid revealing outside targets.
        if not any(os.path.commonpath([root, full]) == root for root in allowed):
            raise RuntimeError(f"Upload files must be inside {location}: {path}")
        try:
            info = os.stat(full)
        except OSError:
            raise RuntimeError(f"File not found: {path}") from None
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError(f"Not a regular file: {path}")
        total += info.st_size
        if total > max_bytes:
            raise RuntimeError(f"upload files are larger than {max_bytes / (1024 * 1024):g} MB in total")
        resolved.append(full)
    return resolved


def validate_actions(actions: Any) -> None:
    """Every step is checked before any runs, so a bad one cannot leave a half-done form."""
    if not isinstance(actions, list) or not actions or len(actions) > 24:
        raise RuntimeError("Expected 1 to 24 actions")
    for step in actions:
        if not isinstance(step, dict) or step.get("kind") not in ("click", "fill", "type", "upload", "pay_token"):
            raise RuntimeError("Invalid browser action")
        if step["kind"] == "pay_token":
            if (step.get("ref") is not None or not isinstance(step.get("text"), str) or not step["text"]
                    or not isinstance(step.get("origin"), str) or not isinstance(step.get("merchantAccountId"), str)):
                raise RuntimeError("A pay token needs its text, origin and merchant account, and no ref")
            continue
        if step.get("ref") is None and step["kind"] == "fill" and step.get("field") == "card":
            if step.get("cardField") not in page_secrets.CARD_AUTOCOMPLETE:
                raise RuntimeError("A card fill without a ref needs its card field")
        elif not isinstance(step.get("ref"), str) or not re.fullmatch(r"e\d+|f\d+e\d+", step["ref"]):
            raise RuntimeError("Element ref is required")
        if step["kind"] == "upload":
            step["files"] = resolve_upload_paths(step.get("paths"), roots=step.get("roots"))
        elif step["kind"] != "click" and not isinstance(step.get("text"), str):
            raise RuntimeError("Text is required")
        if step.get("origin") is not None and (step["kind"] != "fill" or not isinstance(step["origin"], str)):
            raise RuntimeError("An origin applies only to fill")
        # A card detail is hidden and checked only on an origin-bound fill.
        if step.get("field") == "card" and not step.get("origin"):
            raise RuntimeError("A card fill needs its origin")
        if step.get("origin") and not step.get("field"):
            raise RuntimeError("A saved login fill needs its field")


def exit_when_stdin_closes() -> None:
    """The supervisor owns this pipe; losing it cancels this helper, not Chromium."""
    try:
        while os.read(0, 1024):
            pass
    finally:
        os._exit(130)


def read_stdin_line() -> str:
    """Read one line from fd 0 unbuffered, leaving the rest of stdin for the EOF watcher."""
    data = bytearray()
    while len(data) < 1_048_576:
        chunk = os.read(0, 1)
        if not chunk or chunk == b"\n":
            break
        data += chunk
    return data.decode("utf-8")


def ensure_download_hold(folder: str) -> None:
    """One background process keeps later downloads in this folder, with no save dialog."""
    if os.environ.get("RAKAZO_DOWNLOAD_HOLD") == "0":
        return
    marker = hold_marker(folder)
    if hold_alive(marker):
        return
    os.makedirs("/tmp/rakazo", exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if key not in ("RAKAZO_BROWSER_ARGS_STDIN", "RAKAZO_BROWSER_WATCH_STDIN")}
    proc = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "hold", json.dumps({"downloads": folder})],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True, env=env)
    with contextlib.suppress(OSError):
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write(str(proc.pid))


def hold_downloads(folder: Any) -> None:
    """Apply the no-dialog download folder until the browser goes away."""
    home = os.path.realpath(os.environ.get("HOME") or "/home/rakazo")
    try:
        absolute = download_folder(folder, home)
    except (RuntimeError, OSError):
        return
    busy = download_busy_path(str(folder))
    seen: set[str] = set()
    try:
        client = CdpClient(discover_ws_url(cdp_port()))
        client.connect()
    except Exception:  # noqa: BLE001
        return
    try:
        while True:
            try:
                hold_tick(client, absolute, busy, seen)
            except Exception:  # noqa: BLE001
                return
            try:
                client.listen(0.3)
            except Exception:  # noqa: BLE001
                return
    finally:
        client.close()


def run(argv: list[str]) -> int:
    stdin_args = read_stdin_line() if os.environ.get("RAKAZO_BROWSER_ARGS_STDIN") == "1" else None
    if os.environ.get("RAKAZO_BROWSER_WATCH_STDIN") == "1":
        threading.Thread(target=exit_when_stdin_closes, daemon=True).start()
    if len(argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: rakazo-page-browser <command> [json-args]",
                          "fallback": "computer_act"}))
        return 2
    command = argv[1]
    if command not in ("navigate", "snapshot", "act", "finish", "hold"):
        print(json.dumps({"ok": False, "error": f"unknown command: {command}", "fallback": "computer_act"}))
        return 2
    raw_args = stdin_args if stdin_args is not None else (argv[2] if len(argv) >= 3 else "")
    args: dict[str, Any] = json.loads(raw_args) if raw_args.strip() else {}
    if command == "finish":
        try:
            finish_later(args.get("downloads") or [])
        except (OSError, RuntimeError):
            print(json.dumps({"downloads": [{"error": DOWNLOAD_FAILED}]}))
            return 1
        return 0
    if command == "hold":
        hold_downloads(args.get("downloads"))
        return 0
    port = cdp_port()
    downloads: Downloads | None = None
    client: CdpClient | None = None
    saved: list[dict[str, Any]] = []
    # Set once the browser answers: before that, no action can have reached the page.
    connected = False
    opened = False
    page: PageBrowser | None = None
    busy: str | None = None
    try:
        wait_for_cdp(port)
        connected = True
        target, address = front_tab(port)
        browser = AgentBrowser(port)
        if command in ("navigate", "act") and args.get("downloads") is not None:
            # While this file exists, the background hold does not change Chromium's download setting.
            busy = download_busy_path(str(args["downloads"]))
            os.makedirs("/tmp/rakazo", exist_ok=True)
            with open(busy, "w", encoding="utf-8") as handle:
                handle.write("1")
            client = CdpClient(discover_ws_url(port))
            client.connect()
            downloads = Downloads(client, args["downloads"])
            if downloads.folder:
                ensure_download_hold(str(args["downloads"]))
        if internal(address):
            if command != "navigate":
                raise RuntimeError(INTERNAL_PAGE)
            # agent-browser cannot drive Chromium's own pages, so the site opens in a tab of its own,
            # in front, and an empty new tab page it replaces is closed.
            url = str(args.get("url") or "")
            check_url(url)
            browser.batch([["tab", "new", url]], timeout=NAVIGATE_SECONDS)
            if urlsplit(address).netloc in ("newtab", "new-tab-page"):
                urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{target}", timeout=5.0).close()
            target, address = front_tab(port)
            # The new tab is already on the site: navigating it again would go unseen by the request log
            # it has only just started.
            opened = True
        browser.use_tab(target)
        page = PageBrowser(port, target, browser)
        if downloads:
            session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
            frame = client.call("Page.getFrameTree", session_id=session)["frameTree"]["frame"]
            client.download_frame = frame["id"]
            client.call("Network.enable", {"maxPostDataSize": 1}, session_id=session)
            page.downloads = downloads
            if downloads.folder:
                downloads.arm(session)
        if command == "navigate":
            result = page.navigate(str(args.get("url") or ""), opened=opened)
        elif command == "snapshot":
            result = page.snapshot()
            if args.get("downloads"):
                try:
                    folder = download_folder(args["downloads"], os.path.realpath(os.environ.get("HOME") or "/home/rakazo"))
                    saved = take_remembered(folder)
                except (RuntimeError, OSError):
                    saved = []
        else:
            actions = args.get("actions")
            if not isinstance(actions, list):
                raise RuntimeError("actions must be an array")
            result = page.act(actions)
        if downloads:
            client.listen(0.01)
            saved = downloads.finish()
            downloads = None
        print(json.dumps({**result, **({"downloads": saved} if saved else {})}))
        return 0  # Structured failures preserve partial action progress.
    except Exception as exc:  # noqa: BLE001
        if downloads:
            try:
                client.listen(0.01)
                saved = downloads.finish()
            except Exception:
                saved = [{"error": DOWNLOAD_FAILED}]
        dialog = page.dialog() if page else None
        failure = page.dialog_result(dialog, {}) if page and dialog else {
            "ok": False, "error": str(exc), "fallback": "computer_act", "uncertain": command == "act" and connected}
        print(json.dumps({**failure, **({"downloads": saved} if saved else {})}))
        return 0
    finally:
        # Close first so Chromium drops this call's setting, then let the hold apply its own.
        if client:
            client.close()
        if busy:
            with contextlib.suppress(OSError):
                os.remove(busy)


if __name__ == "__main__":
    sys.exit(run(sys.argv))
