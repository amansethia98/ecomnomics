"""Saved logins, cards and pay tokens for the page browser, over CDP (stdlib only).

agent-browser does the rest of the page browsing, but its scripts run only in the top page's own
world. A secret is typed only after a check, in the same evaluation, that the field's own document
is on the right site, which can be a payment provider's or a login provider's frame. So these steps
attach to the tab themselves and run the check in an isolated world of that frame.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import struct
import time
import urllib.request
from typing import Any
from urllib.parse import urlsplit

WORLD_NAME = "rakazo-page-browser"
# The largest CDP message read whole; a larger one (a page event) is skipped.
MAX_FRAME_BYTES = 2 * 1024 * 1024

# A frame asked for, began or committed a load of another document. Same-document changes, such as
# a new URL fragment, leave the page and its fields in place and are not counted.
NAVIGATION_EVENTS = ("Page.frameRequestedNavigation", "Page.frameStartedNavigating", "Page.frameNavigated")

# Payment providers whose own card fields a purchase's card may be typed into, inside their frame on
# the merchant's page: Stripe Elements, Braintree Hosted Fields, Shopify checkout card fields, and
# Adyen secured fields in each of Adyen's live regions.
PAYMENT_FRAME_ORIGINS = frozenset({
    "https://js.stripe.com",
    "https://assets.braintreegateway.com",
    "https://checkout.pci.shopifyinc.com",
    "https://checkoutshopper-live.adyen.com",
    "https://checkoutshopper-live-us.adyen.com",
    "https://checkoutshopper-live-au.adyen.com",
    "https://checkoutshopper-live-apse.adyen.com",
    "https://checkoutshopper-live-in.adyen.com",
    "https://checkoutshopper-live-nea.adyen.com",
})

CARD_AUTOCOMPLETE = {"number": "cc-number", "expiry": "cc-exp", "cvc": "cc-csc", "postal_code": "postal-code"}

NOT_ON_MERCHANT = ("The page is not on the merchant's site for this purchase. "
                   "Open the merchant's checkout with browser_navigate, then fill again.")
CARD_FIELD_MISSING = "No field for this card detail was found on the page. Pass its ref from browser_snapshot."
CARD_FIELD_AMBIGUOUS = "More than one field on the page takes this card detail, so nothing was typed."

# A Stripe checkout that takes a wallet pay token in place of a card marks it with a hidden block
# naming the merchant account, in the page or in Stripe's own frame.
PAY_TOKEN_FRAME_ORIGIN = "https://js.stripe.com"
PAY_TOKEN_MISSING = "This checkout has no pay token field for this purchase's merchant. Take a fresh snapshot."

MAX_FRAME_DEPTH = 4
MAX_FRAME_SESSIONS = 32


def payment_frame_origin(url: Any) -> bool:
    try:
        parts = urlsplit(str(url))
        port = parts.port
    except ValueError:
        return False
    if parts.username or parts.password or not parts.hostname:
        return False
    return f"{parts.scheme}://{parts.hostname}{f':{port}' if port else ''}" in PAYMENT_FRAME_ORIGINS


class CardFieldUncertain(RuntimeError):
    """Part of a card may still be in a field that could not be confirmed empty."""


class Refused(RuntimeError):
    """The step was declined before anything it does not report was changed."""


class NotACode(RuntimeError):
    """The focused field is not one box of a split code."""


def discover_ws_url(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=5.0) as resp:
        data = resp.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise RuntimeError("CDP discovery response too large")
    ws = json.loads(data.decode("utf-8")).get("webSocketDebuggerUrl")
    if not isinstance(ws, str) or not ws:
        raise RuntimeError("CDP version endpoint missing webSocketDebuggerUrl")
    parsed = urlsplit(ws)
    if parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or parsed.port != port:
        raise RuntimeError("Unexpected CDP endpoint")
    return ws


class CdpClient:
    def __init__(self, ws_url: str) -> None:
        self._ws_url = ws_url
        self._sock: socket.socket | None = None
        self._buf = bytearray()
        self._next_id = 1
        self.context_id: int | None = None
        self._pending: dict[int, dict[str, Any] | None] = {}
        self._contexts: dict[int, dict[str, Any]] = {}
        # Navigations to another document started or committed in each frame, per CDP session.
        self._navigations: dict[tuple[Any, str], int] = {}
        self._frame_sessions: dict[str, Any] = {}
        # Navigations too large to read, which could have been in any frame.
        self._skipped_navigations = 0
        # What is left of an oversized frame being skipped, and the request it answers, if any.
        self._discard = 0
        self._discarded_reply: int | None = None

    def connect(self) -> None:
        parts = urlsplit(self._ws_url)
        host, port = parts.hostname or "127.0.0.1", parts.port or 80
        sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        sock.sendall((f"GET {parts.path or '/'} HTTP/1.1\r\nHost: {parts.netloc}\r\nUpgrade: websocket\r\n"
                      f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
                     .encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("CDP websocket handshake closed")
            data += chunk
            if len(data) > 16_384:
                raise RuntimeError("CDP handshake too large")
        header, _, leftover = data.partition(b"\r\n\r\n")
        if b"101" not in header.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"CDP websocket upgrade failed: {header[:200]!r}")
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
        if expected not in header:
            raise RuntimeError("CDP websocket accept mismatch")
        self._sock = sock
        self._buf.extend(leftover)

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _send(self, opcode: int, payload: bytes) -> None:
        assert self._sock is not None
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", n))
        self._sock.sendall(bytes(header) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _need(self, size: int) -> None:
        assert self._sock is not None
        while len(self._buf) < size:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise RuntimeError("CDP websocket closed")
            self._buf.extend(chunk)

    def _drain(self) -> None:
        """Drop the rest of an oversized frame, a chunk at a time, so that it is never held in memory."""
        assert self._sock is not None
        while self._discard:
            if not self._buf:
                chunk = self._sock.recv(65536)
                if not chunk:
                    raise RuntimeError("CDP websocket closed")
                self._buf.extend(chunk)
            taken = min(self._discard, len(self._buf))
            del self._buf[:taken]
            self._discard -= taken

    def _read_frame(self) -> bytes:
        while True:
            self._drain()
            if self._discarded_reply is not None:
                # Our own replies are small: an oversized one is failed alone, not mistaken for an event.
                msg_id, self._discarded_reply = self._discarded_reply, None
                return json.dumps({"id": msg_id, "error": {"message": "CDP reply too large"}}).encode("utf-8")
            self._need(2)
            b1, b2 = self._buf[0], self._buf[1]
            opcode, masked, length, offset = b1 & 0x0F, bool(b2 & 0x80), b2 & 0x7F, 2
            if length == 126:
                self._need(4)
                length, offset = struct.unpack("!H", self._buf[2:4])[0], 4
            elif length == 127:
                self._need(10)
                length, offset = struct.unpack("!Q", self._buf[2:10])[0], 10
            if not (b1 & 0x80):
                raise RuntimeError("Fragmented CDP message unsupported")
            mask = b""
            if masked:
                self._need(offset + 4)
                mask = bytes(self._buf[offset:offset + 4])
                offset += 4
            if length > MAX_FRAME_BYTES:
                # A page's own events can be huge (a request for a multi-megabyte data: URL): skip them.
                head_size = min(length, 256)
                self._need(offset + head_size)
                head = bytes(self._buf[offset:offset + head_size])
                if masked:
                    head = bytes(b ^ mask[i % 4] for i, b in enumerate(head))
                reply = re.match(rb'\{"id":\s*(\d+)\s*[,}]', head)
                if reply and opcode in (0x0, 0x1, 0x2):
                    self._discarded_reply = int(reply.group(1))
                elif opcode in (0x0, 0x1, 0x2):
                    self._skipped_event(head)
                del self._buf[:offset]
                self._discard = length
                continue
            self._need(offset + length)
            payload = bytes(self._buf[offset:offset + length])
            del self._buf[:offset + length]
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("CDP websocket closed by peer")
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode in (0x0, 0x1, 0x2):
                return payload

    def _skipped_event(self, head: bytes) -> None:
        """The first bytes of an event too large to read."""
        method = re.match(rb'\{"method":"([^"]+)"', head)
        if method and method.group(1).decode() in NAVIGATION_EVENTS:
            self._skipped_navigations += 1

    def _handle_event(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params") or {}
        session_id = message.get("sessionId")
        if method == "Runtime.executionContextCreated":
            context = params.get("context")
            if isinstance(context, dict) and isinstance(context.get("id"), int):
                self._contexts[context["id"]] = {**context, "_sessionId": session_id}
        elif method == "Runtime.executionContextDestroyed":
            self._contexts.pop(params.get("executionContextId"), None)
        elif method == "Runtime.executionContextsCleared":
            self._contexts = {cid: ctx for cid, ctx in self._contexts.items() if ctx.get("_sessionId") != session_id}
        elif method in NAVIGATION_EVENTS:
            frame_id = params.get("frameId") or (params.get("frame") or {}).get("id")
            if not isinstance(frame_id, str) or params.get("disposition", "currentTab") != "currentTab":
                return
            if params.get("navigationType") in ("sameDocument", "historySameDocument"):
                return
            self._navigations[(session_id, frame_id)] = self._navigations.get((session_id, frame_id), 0) + 1
        elif method == "Target.attachedToTarget":
            child = params.get("sessionId")
            if isinstance(child, str) and (params.get("targetInfo") or {}).get("type") == "iframe":
                self._frame_sessions[child] = session_id
        elif method == "Target.detachedFromTarget":
            self._frame_sessions.pop(params.get("sessionId"), None)

    def frame_sessions(self, parent_session_id: str) -> list[str]:
        return [child for child, parent in self._frame_sessions.items() if parent == parent_session_id]

    def navigations(self, session_id: str, frame_id: str) -> int:
        return self._navigations.get((session_id, frame_id), 0) + self._skipped_navigations

    def find_world_context(self, world_name: str, frame_id: str, session_id: str) -> int | None:
        for context_id, context in self._contexts.items():
            aux = context.get("auxData") or {}
            if (context.get("name") == world_name and context.get("_sessionId") == session_id
                    and isinstance(aux, dict) and aux.get("frameId") == frame_id and aux.get("isDefault") is False):
                return context_id
        return None

    def call(self, method: str, params: dict[str, Any] | None = None, *, session_id: str | None = None,
             timeout_s: float = 10.0) -> dict[str, Any]:
        assert self._sock is not None
        msg_id = self._next_id
        self._next_id += 1
        payload: dict[str, Any] = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        self._pending[msg_id] = None
        self._send(0x1, json.dumps(payload).encode("utf-8"))
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            pending = self._pending.get(msg_id)
            if pending is not None:
                self._pending.pop(msg_id, None)
                if "error" in pending:
                    raise RuntimeError(f"{method} failed: {pending['error']}")
                result = pending.get("result")
                return result if isinstance(result, dict) else {}
            self._sock.settimeout(max(0.1, deadline - time.time()))
            try:
                message = json.loads(self._read_frame().decode("utf-8"))
            except socket.timeout:
                continue
            if not isinstance(message, dict):
                continue
            if message.get("id") in self._pending:
                self._pending[int(message["id"])] = message
            elif message.get("method"):
                self._handle_event(message)
        raise TimeoutError(f"CDP call timed out: {method}")


# The checks and fills, run in an isolated world of the field's own frame: the page cannot see or
# change them, and they read the real DOM.
EVAL_HELPERS = r"""
(() => {
  if (window.__rakazoPageBrowser) return true;
  // Marks a field holding a saved login or card, which the page browser's snapshots never show.
  const FILLED = "data-rakazo-filled";
  // A refused fill changed nothing the bot cannot see; the step reports it as settled.
  const refused = (message) => new Error(`Refused: ${message}`);
  // Set through the CSSOM, which a page's Content-Security-Policy does not block, unlike an
  // injected stylesheet or style attribute.
  const cardMasked = new WeakSet();
  function maskCard(el) {
    el.style.setProperty("-webkit-text-security", "disc", "important");
    cardMasked.add(el);
  }
  function unmaskCard(el) {
    for (const node of codeSlots.get(el) || []) {
      if (cardMasked.delete(node)) node.style.removeProperty("-webkit-text-security");
    }
    codeSlots.delete(el);
    if (!cardMasked.delete(el)) return;
    el.style.removeProperty("-webkit-text-security");
  }
  // A code box often sits over slot elements that draw each digit; the nearest ancestor (up to
  // three up) that shows the code is drawn as dots too, so a screenshot never reads it.
  const codeSlots = new WeakMap();
  const codeShown = (text) => String(text).replace(/[\s-]+/g, "").toLowerCase();
  function maskCodeSlots(el, code) {
    const digits = codeShown(code);
    if (!digits || !el.isConnected) return;
    const held = codeSlots.get(el) || [];
    let node = el.parentElement;
    for (let level = 0; level < 3 && node && node !== document.body && node !== document.documentElement;
         level++, node = node.parentElement) {
      if (!codeShown(node.innerText ?? node.textContent ?? "").includes(digits)) continue;
      if (!cardMasked.has(node)) maskCard(node);
      if (!held.includes(node)) held.push(node);
      break;
    }
    codeSlots.set(el, held);
  }
  // Whether an input is made for a one-time code: it says so, or takes digits, or is named or
  // labelled like one, or holds a code's length. Single-character inputs need a validated group.
  function looksLikeCodeBox(el) {
    if (el.maxLength === 1) return false;
    if ((el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).includes("one-time-code")) return true;
    if ((el.getAttribute("inputmode") || "").toLowerCase() === "numeric") return true;
    if (el.maxLength >= 4 && el.maxLength <= 12) return true;
    const root = el.getRootNode();
    const named = [
      el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.title,
      ...[...(el.labels || [])].map((label) => label.textContent),
      ...(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
        .map((id) => root.getElementById?.(id)?.textContent),
    ].join(" ");
    return /otp|one.?time|code|token|2fa|mfa|verif|\bpin\b|passcode|קוד|אימות/i.test(named);
  }
  // A private code may span several inputs. Resolve the whole group before touching a value;
  // the ordinary page-world split-code typer cannot consume a run-held secret safely.
  function codePartShape(el) {
    return el instanceof HTMLInputElement && ["text", "email", "tel", "number"].includes(el.type)
      && visible(el) && (el.maxLength === 1 || (el.getAttribute("inputmode") || "").toLowerCase() === "numeric"
        || /one-time-code|otp|one.?time|verification|passcode|\bcode\b/i.test([
          el.autocomplete, el.name, el.id, el.getAttribute("aria-label"), el.placeholder,
        ].join(" ")));
  }
  // A structural DOM snapshot, never outerHTML/text/value or raw names/IDs/labels. Taken on the
  // verified origin before code entry. It explains the exact focused ref without storing a secret.
  function codeLayout(input, ref) {
    const root = input.getRootNode();
    const all = [...root.querySelectorAll("input")];
    const start = Math.max(0, all.indexOf(input) - 16);
    const fields = all.slice(start, start + 32);
    const tags = new Set(["HTML", "BODY", "FORM", "DIV", "SPAN", "SECTION", "MAIN", "FIELDSET", "LABEL", "INPUT"]);
    const tag = (el) => tags.has(el.tagName) ? el.tagName.toLowerCase() : "element";
    const path = (el) => {
      const parts = [];
      for (let n = el, depth = 0; n && depth < 12; n = n.parentElement, depth++) {
        parts.unshift(tag(n) + "[" + [...(n.parentNode?.children || [])].indexOf(n) + "]");
      }
      return parts.join("/");
    };
    const hint = (text) => /one-time-code|otp|one.?time|verification|passcode|\bcode\b/i.test(String(text || ""));
    const modes = new Set(["", "none", "text", "decimal", "numeric", "tel", "search", "email", "url"]);
    const tokens = new Set(["one-time-code", "username", "current-password", "new-password", "email", "tel", "on", "off"]);
    const ancestors = [];
    for (let n = input.parentElement, depth = 0; n && depth < 12; n = n.parentElement, depth++) {
      const children = [...n.querySelectorAll("input")].filter((f) => visible(f) && f.type !== "hidden");
      ancestors.push({ path: path(n), visibleInputs: children.length,
        shapedInputs: children.filter(codePartShape).length,
        bodyBoundary: n === document.body,
        allMaxlengthOne: children.every((f) => f.maxLength === 1) });
    }
    return { version: 1, ref, origin: location.origin, inFrame: window !== window.top,
      root: root === document ? "document" : root.host ? "shadow" : "other",
      target: fields.indexOf(input), firstInputIndex: start, inputCount: all.length,
      truncated: all.length > fields.length || ancestors.length === 12,
      fields: fields.map((f) => {
        const mode = (f.getAttribute("inputmode") || "").toLowerCase();
        return { path: path(f), type: f.type, maxlength: f.maxLength,
          inputmode: modes.has(mode) ? mode : "other",
          autocomplete: [...new Set((f.autocomplete || "").toLowerCase().split(/\s+/)
            .filter(Boolean).map((t) => tokens.has(t) ? t : "other"))],
          nameHint: hint(f.name), idHint: hint(f.id), labelHint: hint(f.getAttribute("aria-label")),
          placeholderHint: hint(f.placeholder), titleHint: hint(f.title),
          associatedLabelHint: [...(f.labels || [])].some((label) => hint(label.textContent)),
          visible: visible(f), disabled: f.disabled, readonly: f.readOnly,
          shaped: codePartShape(f), singleEligible: looksLikeCodeBox(f) };
      }), ancestors };
  }
  function splitCodeGroup(input, size) {
    const root = input.getRootNode();
    const shaped = codePartShape;
    const part = (el) => shaped(el) && !el.disabled && !el.readOnly;
    const groups = [];
    for (const el of root.querySelectorAll("input")) {
      if (!part(el)) continue;
      for (let parent = el.parentElement; parent && parent.getRootNode() === root; parent = parent.parentElement) {
        const fields = [...parent.querySelectorAll("input")].filter((node) => visible(node) && node.type !== "hidden");
        // Several independent full-code inputs in the document are not one segmented widget.
        if (parent === document.body && !fields.every((field) => field.maxLength === 1)) break;
        if (fields.length > 12) break;
        if (fields.includes(input) && fields.length >= 4 && fields.every(shaped) && !fields.every(part)) {
          throw refused("A code box is disabled or read-only; nothing was typed.");
        }
        if (fields.length < 4 || !fields.every(part)) continue;
        if (!groups.some((group) => group.fields.length === fields.length
          && group.fields.every((field, index) => field === fields[index]))) groups.push({ parent, fields });
        break;
      }
    }
    const target = groups.find((group) => group.fields.includes(input));
    if (!target) return null;
    if (groups.length !== 1) throw refused("More than one code group is available; ask the user to take over.");
    if (target.fields.length !== size) throw refused("The code length does not match the number of boxes.");
    if (target.fields.some((field) => field.value !== "")) {
      throw refused("The code boxes already contain input; ask the user to take over without replaying the code.");
    }
    return target;
  }
  function fillCodeGroup(group, value, origin) {
    const { parent, fields } = group;
    const doc = document;
    const page = location.href;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    let touched = 0;
    const live = () => document === doc && location.href === page && location.protocol === "https:" && location.origin === origin
      && parent.isConnected && fields.every((field) => field.isConnected && field.ownerDocument === doc
        && parent.contains(field) && !field.disabled && !field.readOnly
        && ["text", "email", "tel", "number"].includes(field.type));
    const partial = () => ({ codePartial: true, filled: touched, total: fields.length });
    // Mask the whole widget before dispatching events: a page may synchronously draw its slots.
    maskCard(parent);
    for (const field of fields) {
      field.setAttribute(FILLED, "");
      maskCard(field);
      codeSlots.set(field, [parent]);
    }
    if (!live() || !fields.includes(focused())) throw refused("The code group changed before entry; nothing was typed.");
    try {
      for (let index = 0; index < fields.length; index++) {
        const active = focused();
        if (!live() || (index === 0 ? !fields.includes(active)
          : active !== fields[index - 1] && active !== fields[index])) {
          if (touched) return partial();
          throw refused("Focus left the code group; nothing was typed.");
        }
        const field = fields[index];
        field.focus();
        if (!live() || focused() !== field) {
          if (touched) return partial();
          throw refused("The code box did not keep focus; nothing was typed.");
        }
        // From this point the outcome may be partial, even when the setter/event handler fails.
        touched = index + 1;
        setter.call(field, value[index]);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        if (!live() || field.value !== value[index]) return partial();
        maskCard(parent);
        fields.forEach((box) => { box.setAttribute(FILLED, ""); maskCard(box); });
      }
    } catch (error) {
      if (touched) return partial();
      throw error;
    }
    if (fields.some((field, index) => field.value !== value[index])) return partial();
    return true;
  }
  // Compatibility with widgets that depend on real keydown/keyup events. Select this path
  // BEFORE any value is entered; a partly accepted setter fill must never be retried as keys.
  let codeKeys = null;
  function prepareCodeKeys(group, origin) {
    const { parent, fields } = group;
    maskCard(parent);
    fields.forEach((field) => {
      field.setAttribute(FILLED, "");
      maskCard(field);
      codeSlots.set(field, [parent]);
    });
    codeKeys = { parent, fields, origin, page: location.href, next: 0 };
    return { codeKeys: true, total: fields.length };
  }
  function codeKeysLive() {
    const state = codeKeys;
    return state && location.protocol === "https:" && location.origin === state.origin
      && location.href === state.page && state.parent.isConnected
      && state.fields.every((field) => field.isConnected && field.ownerDocument === document
        && field.parentElement === state.parent && field.type === "text" && [1, 2].includes(field.maxLength)
        && visible(field) && !field.disabled && !field.readOnly);
  }
  function numericBox(el) {
    const mode = (el.getAttribute("inputmode") || "").toLowerCase();
    const pattern = (el.getAttribute("pattern") || "").trim();
    return mode === "numeric" || mode === "decimal" || el.type === "tel"
      || /^(\\d|\[0-9\])([*+]|\{\d+(,\d*)?\})?$/.test(pattern);
  }
  function visible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  let cardTarget = null;
  function cardFields(token) {
    return [...document.querySelectorAll("input")].filter((el) => ["text", "tel", "password"].includes(el.type)
      && !el.disabled && !el.readOnly && el.getAttribute("aria-hidden") !== "true" && visible(el)
      && (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).includes(token));
  }
  // The element keys go to in this document, through open shadow trees.
  function focused() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body && el !== document.documentElement ? el : null;
  }
  window.__rakazoPageBrowser = {
    prepareLegacyCode(size, origin, ref) {
      // A deliberately site-scoped rollback. Do not invoke fill/splitCodeGroup or try setters first.
      if (origin !== "https://accounts.zomato.com" || location.origin !== origin
        || location.protocol !== "https:") throw refused("The code is not on its expected HTTPS site.");
      const input = focused();
      const fields = [...document.querySelectorAll("input")].filter((field) => field.type !== "hidden" && visible(field));
      if (!fields.includes(input) || size !== 6 || fields.length !== size
        || !fields.every((field) => field.parentElement === input.parentElement && field.type === "text"
          && [1, 2].includes(field.maxLength) && !field.disabled && !field.readOnly)) {
        throw refused("The expected six code boxes are not available; nothing was typed.");
      }
      if (fields.some((field) => field.value !== "")) {
        throw refused("The code boxes already contain input; do not replay the code.");
      }
      const layout = typeof ref === "string" && /^(?:f\d+)?e\d{1,8}$/.test(ref) ? codeLayout(input, ref) : null;
      return { ...prepareCodeKeys({ parent: input.parentElement, fields }, origin), codeLayout: layout };
    },
    codeKeyReady(index) {
      if (!codeKeysLive() || codeKeys.next !== index) return false;
      const { fields } = codeKeys;
      const active = focused();
      if (index === 0 ? !fields.includes(active)
        : active !== fields[index - 1] && active !== fields[index]) return false;
      if (fields.slice(index).some((field) => field.value !== "")) return false;
      fields[index].focus();
      return Boolean(codeKeysLive() && focused() === fields[index]);
    },
    codeKeyAccepted(index, char) {
      if (!codeKeysLive() || codeKeys.next !== index || codeKeys.fields[index].value !== char) return false;
      codeKeys.next++;
      return true;
    },
    codeKeysDone(value) {
      const ok = Boolean(codeKeysLive() && codeKeys.next === codeKeys.fields.length
        && codeKeys.fields.every((field, index) => field.value === value[index]));
      codeKeys = null;
      return ok;
    },
    // The frame element holding focus in this document, when focus is inside one of its frames.
    focusedFrame() {
      const el = focused();
      return el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement ? el : null;
    },
    // A saved login or a card detail, typed into the focused field only when this document is on its
    // site. Checked in the same evaluation as the fill, so a navigation cannot slip in between.
    // Private-LAN plain HTTP is not a login target, even when the page origin matches.
    fill(value, origin, field, targetRef) {
      const card = field === "card";
      // A code the user entered for this page: a visible field like a username, but drawn as dots
      // and only into a box that looks made for a code.
      const code = field === "code";
      let saved = null;
      try { saved = new URL(origin); } catch { /* rejected below */ }
      if (!saved || saved.protocol !== "https:" || location.protocol !== "https:") {
        throw refused(card
          ? "A card can only be filled on HTTPS. Open the merchant's checkout with browser_navigate, then fill again."
          : code ? "A code can only be filled on HTTPS. Open the site with browser_navigate, then fill again."
          : "Website logins can only be filled on HTTPS. Open the saved site with browser_navigate, then fill again.");
      }
      if (location.origin !== saved.origin) {
        throw refused(card
          ? "The page is not on the merchant's site for this purchase. Open the merchant's checkout with browser_navigate, then fill again."
          : code ? "The page is not on the site this code was asked for. Open that site with browser_navigate, then fill again."
          : `This login is saved for ${saved.origin}; the page is on ${location.origin}. Open the saved site with browser_navigate, then fill again.`);
      }
      const el = focused();
      if (!el) throw refused("The field did not keep focus, so nothing was typed. Take a fresh snapshot and fill again.");
      if (el.readOnly || el.disabled) throw refused("Element is read-only");
      // A password goes only into a password field, which never displays it. A username is an input;
      // textareas, search boxes, and editable page content stay out. A card goes only into a plain
      // input: text, tel, or password (CVC boxes are often masked).
      const input = el instanceof HTMLInputElement ? el : null;
      if (card && !(input && ["text", "tel", "password"].includes(input.type))) {
        throw refused("A card can only be typed into a card field.");
      }
      const password = !card && !code && field !== "username";
      if (password && !(input && input.type === "password")) {
        throw refused("A saved password can only be typed into a password field.");
      }
      const layout = code && input && typeof targetRef === "string" && /^(?:f\d+)?e\d{1,8}$/.test(targetRef)
        ? codeLayout(input, targetRef) : null;
      const codeRefused = (message) => refused(message + (layout ? "; code_layout_before_fill=" + JSON.stringify(layout) : ""));
      const codeResult = (result) => layout ? { ...(result === true ? { codeFilled: true } : result), codeLayout: layout } : result;
      if (code && input) {
        const text = numericBox(input) ? String(value).replaceAll("-", "") : String(value);
        try {
          const group = splitCodeGroup(input, text.length);
          if (group) return codeResult(fillCodeGroup(group, text, saved.origin));
        } catch (error) {
          if (layout && String(error.message).startsWith("Refused: ")) throw codeRefused(error.message.slice(9));
          throw error;
        }
      }
      if (!card && !password && !(input && ["text", "email", "tel"].includes(input.type))) {
        throw code ? codeRefused("A code can only be typed into a text, email, or telephone field.")
          : refused("A saved username can only be typed into a text, email, or telephone field.");
      }
      if (code && !looksLikeCodeBox(input)) {
        throw codeRefused("This field doesn't look like a code box; ask the user to take over.");
      }
      // A numeric box takes the digits of a code written with dashes.
      if (code && numericBox(input)) value = String(value).replaceAll("-", "");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, String(value));
      if (input.value !== String(value)) {
        // A partly accepted login (an email field trimming a username) is not left on the page.
        setter.call(input, "");
        throw refused(card ? "This field didn't accept the card, so it was cleared."
          : code ? "This field didn't accept the code, so it was cleared."
          : "This field didn't accept the saved login, so it was cleared.");
      }
      // Snapshots never show the value again, whatever the page later does with the field.
      input.setAttribute(FILLED, "");
      // Screenshots reach the model too, so a card or a code is drawn as dots, like a password.
      if (card || code) maskCard(input);
      else unmaskCard(input);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // React or an input listener may replace/alter a controlled password after the native setter.
      // Do not report successful delivery (or retry) when its final value is uncertain.
      if (password && (!input.isConnected || input.value !== String(value))) return { loginUncertain: true };
      if (code) {
        // The widget may draw its slots right away or a moment later.
        maskCodeSlots(input, value);
        setTimeout(() => { if (cardMasked.has(input)) maskCodeSlots(input, value); }, 50);
      }
      return codeResult(true);
    },
    payTokenAccount() {
      const blocks = [...document.querySelectorAll(".AiAgentPaymentSteering")]
        .filter((block) => block.querySelector('input[name="link_pay_token"]'));
      if (blocks.length !== 1) return null;
      const holder = blocks[0].matches("[data-stripe-merchant-account]") ? blocks[0]
        : blocks[0].querySelector("[data-stripe-merchant-account]");
      const account = holder?.getAttribute("data-stripe-merchant-account") || "";
      return /^acct_[A-Za-z0-9]{1,64}$/.test(account) ? account : null;
    },
    // The checkout swaps in the wallet's saved card when it sees the token through the native setter.
    setPayToken(token) {
      const inputs = document.querySelectorAll('.AiAgentPaymentSteering input[name="link_pay_token"]');
      if (inputs.length !== 1) return false;
      const el = inputs[0];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(token));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value === String(token);
    },
    hasCardField() {
      return ["cc-number", "cc-exp", "cc-csc"].some((token) => cardFields(token).length > 0);
    },
    findCard(token) {
      const found = cardFields(String(token));
      cardTarget = found.length === 1 ? found[0] : null;
      return found.length;
    },
    // Screenshots reach the model, so the field is drawn as dots before any key lands in it.
    focusCard() {
      const el = cardTarget;
      if (!el?.isConnected) return false;
      maskCard(el);
      el.setAttribute(FILLED, "");
      el.focus();
      el.select();
      return document.activeElement === el;
    },
    cardHolds() {
      return Boolean(cardTarget?.isConnected) && document.activeElement === cardTarget;
    },
    // Card fields add spaces and slashes as they format; only the count of what was kept leaves the page.
    cardTyped(length) {
      return String(cardTarget?.value ?? "").replace(/[^\p{L}\p{N}]/gu, "").length === length;
    },
    emptyCard() {
      const el = cardTarget;
      if (!el?.isConnected || !el.value) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
  };
  return true;
})()
"""


def page_value(result: dict[str, Any]) -> Any:
    """The value of an evaluation in the helper's world, raising the page script's refusals."""
    if result.get("exceptionDetails"):
        details = result["exceptionDetails"]
        # Chromium's text is just "Uncaught"; the reason is the thrown error's first line.
        description = str((details.get("exception") or {}).get("description") or "").split("\n")[0]
        text = description.removeprefix("Error: ") or details.get("text") or "evaluate failed"
        if text.startswith("Refused: "):
            raise Refused(text.removeprefix("Refused: "))
        raise RuntimeError(str(text))
    return (result.get("result") or {}).get("value")


def eval_json(client: CdpClient, session_id: str, expression: str, context_id: int | None = None) -> Any:
    return page_value(client.call("Runtime.evaluate", {
        "expression": expression, "contextId": client.context_id if context_id is None else context_id,
        "returnByValue": True, "awaitPromise": True,
    }, session_id=session_id))


def call_with(client: CdpClient, session_id: str, world: int, function: str, *values: Any) -> Any:
    """`function` called with `values` as arguments, so a secret is never part of any script's source."""
    return page_value(client.call("Runtime.callFunctionOn", {
        "functionDeclaration": function, "executionContextId": world,
        "arguments": [{"value": value} for value in values], "returnByValue": True,
    }, session_id=session_id))


def world_in(client: CdpClient, session_id: str, frame_id: str) -> int:
    """An isolated world bound to this frame and CDP session, never a page-owned context of the same name."""
    client.call("Runtime.enable", session_id=session_id)
    existing = client.find_world_context(WORLD_NAME, frame_id, session_id)
    if existing is None:
        existing = client.call("Page.createIsolatedWorld", {"frameId": frame_id, "worldName": WORLD_NAME},
                               session_id=session_id)["executionContextId"]
    eval_json(client, session_id, EVAL_HELPERS, context_id=existing)
    return existing


def main_frame(client: CdpClient, session_id: str) -> dict[str, Any]:
    return client.call("Page.getFrameTree", session_id=session_id)["frameTree"]["frame"]


def attach(client: CdpClient, target_id: str) -> str:
    """The tab the page browser is on, with the helper in its top frame's isolated world."""
    session_id = client.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]
    client.call("Page.enable", session_id=session_id)
    client.context_id = world_in(client, session_id, main_frame(client, session_id)["id"])
    return session_id


def auto_attach(client: CdpClient, session_id: str) -> list[str]:
    client.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True,
                                         "filter": [{"type": "iframe"}]}, session_id=session_id)
    return client.frame_sessions(session_id)[:MAX_FRAME_SESSIONS]


FRAME_OWNER_VISIBLE = """function () {
  for (let el = this; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
  }
  const box = this.getBoundingClientRect();
  // A frame sized to nothing still draws its border, which is not a page anyone can see.
  return box.width > 1 && box.height > 1 && this.clientWidth > 1 && this.clientHeight > 1;
}"""


def frame_owner_visible(client: CdpClient, session_id: str, backend_node_id: int) -> bool:
    # Resolved in the helper's isolated world, so the page cannot fake the answer; an owner outside it fails.
    node = client.call("DOM.resolveNode", {"backendNodeId": backend_node_id, "executionContextId": client.context_id},
                       session_id=session_id)
    result = client.call("Runtime.callFunctionOn", {"objectId": node["object"]["objectId"],
                                                    "functionDeclaration": FRAME_OWNER_VISIBLE,
                                                    "returnByValue": True}, session_id=session_id)
    return result.get("result", {}).get("value") is True


def payment_frames(client: CdpClient, session_id: str) -> list[tuple[str, str, int]]:
    """Visible frames of a known payment provider that the page itself shows: (session, frame, world).

    Only frames whose owner element is in the page's own documents count, so a provider frame
    inside an ad or other third-party frame on the checkout never receives the card.
    """
    frames = []
    for frame_session in auto_attach(client, session_id):
        try:
            frame = main_frame(client, frame_session)
            if not payment_frame_origin(frame.get("url")):
                continue
            owner = client.call("DOM.getFrameOwner", {"frameId": frame["id"]}, session_id=session_id)
            if not frame_owner_visible(client, session_id, owner["backendNodeId"]):
                continue
            client.call("Page.enable", session_id=frame_session)
            frames.append((frame_session, frame["id"], world_in(client, frame_session, frame["id"])))
        except Exception:  # noqa: BLE001
            continue
    return frames


def frame_eval(client: CdpClient, frames: list[tuple[str, str, int]], expression: str) -> list[Any]:
    """`expression` in each frame, with None for a frame that failed."""
    results = []
    for frame_session, _, world in frames:
        try:
            results.append(eval_json(client, frame_session, expression, context_id=world))
        except Exception:  # noqa: BLE001
            results.append(None)
    return results


def pay_token_frames(client: CdpClient, frames: list[tuple[str, str, int]]) -> list[tuple[str, str, int]]:
    return [frame for frame, origin in zip(frames, frame_eval(client, frames, "location.origin"))
            if origin == PAY_TOKEN_FRAME_ORIGIN]


def focused_frame(client: CdpClient, session_id: str) -> tuple[str, str, int]:
    """The frame whose document holds focus, followed through the frame elements that hold it:
    (session, frame, world). Frames in another process are found through their own sessions."""
    children: dict[str, list[tuple[str, str]]] = {}
    sessions, seen = [session_id], set()
    while sessions and len(seen) < MAX_FRAME_SESSIONS:
        session = sessions.pop(0)
        if session in seen:
            continue
        seen.add(session)
        try:
            if session != session_id:
                client.call("Page.enable", session_id=session)
            sessions += auto_attach(client, session)
            stack = [client.call("Page.getFrameTree", session_id=session)["frameTree"]]
        except Exception:  # noqa: BLE001
            continue
        while stack:
            node = stack.pop()
            frame = node["frame"]
            if frame.get("parentId"):
                children.setdefault(frame["parentId"], []).append((session, frame["id"]))
            stack += node.get("childFrames") or []
    at = (session_id, main_frame(client, session_id)["id"], client.context_id)
    for _ in range(MAX_FRAME_DEPTH):
        session, frame_id, world = at
        owner = client.call("Runtime.evaluate", {"expression": "window.__rakazoPageBrowser.focusedFrame()",
                                                 "contextId": world}, session_id=session)
        object_id = (owner.get("result") or {}).get("objectId")
        if not object_id:
            return at
        backend = client.call("DOM.describeNode", {"objectId": object_id}, session_id=session)["node"]["backendNodeId"]
        inner = None
        for child_session, child_id in children.get(frame_id, []):
            try:
                found = client.call("DOM.getFrameOwner", {"frameId": child_id}, session_id=session)["backendNodeId"]
            except Exception:  # noqa: BLE001
                continue
            if found == backend:
                if child_session != session:
                    client.call("Page.enable", session_id=child_session)
                inner = (child_session, child_id, world_in(client, child_session, child_id))
                break
        if inner is None:
            raise Refused("The focused field is in a frame the page tools cannot reach, so nothing was filled.")
        at = inner
    raise Refused("The focused field is nested in too many frames, so nothing was filled.")


def frame_site_check(client: CdpClient, frame: tuple[str, str, int], step: dict[str, Any]) -> None:
    """A saved login or card goes into a frame only when the frame itself is on its site, an HTTPS page
    inside HTTPS pages. The fill checks the frame's site again in the same evaluation."""
    session, _, world = frame
    found = call_with(client, session, world, "function (origin) { let saved = null; try { saved = new URL(origin)"
                      ".origin; } catch { /* refused below */ } return { origin: location.origin, same: "
                      "location.origin === saved, sandboxed: self.origin !== location.origin, secure: "
                      "location.protocol === 'https:' && window.isSecureContext !== false }; }", step["origin"])
    login = step.get("field") in ("username", "password")
    if not isinstance(found, dict) or not found.get("secure"):
        raise Refused("Website logins can only be filled on HTTPS, and this field's frame is not an HTTPS page "
                      "inside HTTPS pages." if login else
                      "This field's frame is not an HTTPS page inside HTTPS pages, so nothing was filled.")
    if found.get("sandboxed"):
        # Served from its site but run sandboxed, without that site's own origin: not the site's page as such.
        raise Refused("This field is in a sandboxed frame, so nothing was filled.")
    if not found.get("same"):
        raise Refused(f"This field is in a frame from {found.get('origin')}, and this login is saved for "
                      f"{step['origin']}, so nothing was filled." if login else
                      f"This field is in a frame from {found.get('origin')}, not on the site it is meant for, "
                      "so nothing was filled.")


def fill_focused(client: CdpClient, session_id: str, step: dict[str, Any]) -> dict[str, Any] | None:
    """A saved login, or a card detail the bot pointed to, typed into the field the page browser focused."""
    frame = focused_frame(client, session_id)
    if frame[0] != session_id or frame[2] != client.context_id:
        frame_site_check(client, frame, step)
    args = [step["text"], step["origin"], step.get("field")]
    if step.get("field") == "code":
        args.append(step.get("ref"))
    if step.get("field") == "code" and step["origin"] == "https://accounts.zomato.com":
        # Roll back this site's entry mechanism, not the upstream sync. The legacy trusted-key
        # path is primary: never attempt the segmented setter fill, and never retry partial keys.
        frame_site_check(client, frame, step)
        result = call_with(client, frame[0], frame[2], "function (size, origin, ref) { "
                           "return window.__rakazoPageBrowser.prepareLegacyCode(size, origin, ref); }",
                           len(step["text"]), step["origin"], step.get("ref"))
        fill_code_keys(client, frame, step)
    else:
        result = call_with(client, frame[0], frame[2], "function (value, origin, field, ref) { "
                           "return window.__rakazoPageBrowser.fill(value, origin, field, ref); }", *args)
    layout = result.get("codeLayout") if isinstance(result, dict) else None
    if isinstance(result, dict) and result.get("loginUncertain"):
        raise CardFieldUncertain("The password field changed after filling. Do not replay or submit; ask the user to take over.")
    if isinstance(result, dict) and result.get("codePartial"):
        # A secret may already be on the page: never restore its one-shot claim or replay it.
        detail = "; code_layout_before_fill=" + json.dumps(layout, separators=(",", ":")) if layout else ""
        raise CardFieldUncertain("Code entry was partial or uncertain. Do not replay, submit, or request a new code; "
                                 "ask the user to take over." + detail)
    return layout


def fill_code_keys(client: CdpClient, frame: tuple[str, str, int], step: dict[str, Any]) -> None:
    """The old split-code keydown/keyup mechanism, with private-origin and per-box guards.

    Never invoked following a partial fill. Values travel only as CDP arguments/key payloads;
    no page-world reads, clearing pre-existing input, source interpolation or ordinary tool calls.
    """
    session, frame_id, world = frame
    navigations = client.navigations(session, frame_id)
    touched = False
    try:
        for index, char in enumerate(step["text"]):
            if (client.navigations(session, frame_id) != navigations or call_with(
                    client, session, world, "function (index) { return window.__rakazoPageBrowser.codeKeyReady(index); }",
                    index) is not True):
                if not touched:
                    raise Refused("The code group changed before entry; nothing was typed.")
                raise CardFieldUncertain()
            touched = True  # Even a lost response to the first key may have entered a character.
            _press_char(client, session, char)
            time.sleep(0.05)
            if call_with(client, session, world,
                         "function (index, char) { return window.__rakazoPageBrowser.codeKeyAccepted(index, char); }",
                         index, char) is not True:
                raise CardFieldUncertain()
        if (client.navigations(session, frame_id) != navigations or call_with(
                client, session, world, "function (value) { return window.__rakazoPageBrowser.codeKeysDone(value); }",
                step["text"]) is not True):
            raise CardFieldUncertain()
    except Exception:
        if touched:
            # Do not leak a CDP exception which may echo a private key payload.
            raise CardFieldUncertain("Code entry was partial or uncertain. Do not replay, submit, or request a new code; "
                                     "ask the user to take over.") from None
        raise


def find_card_field(client: CdpClient, session_id: str, main_frame_id: str, token: str) -> tuple[str, str, int]:
    """The one field the page shows for this card detail, in the page itself or else in a payment frame."""
    find = f"window.__rakazoPageBrowser.findCard({json.dumps(token)})"
    found = eval_json(client, session_id, find)
    if found == 1:
        assert client.context_id is not None
        return session_id, main_frame_id, client.context_id
    if found:
        raise Refused(CARD_FIELD_AMBIGUOUS)
    matches = [frame for frame in payment_frames(client, session_id)
               for _ in range(eval_json(client, frame[0], find, context_id=frame[2]) or 0)]
    if not matches:
        raise Refused(CARD_FIELD_MISSING)
    if len(matches) > 1:
        raise Refused(CARD_FIELD_AMBIGUOUS)
    return matches[0]


def merchant_check(client: CdpClient, session_id: str, origin: str) -> Any:
    """A check that the top page is still the document it was on now, and on the merchant's origin."""
    if not origin.startswith("https://"):
        raise Refused("A card can only be filled on HTTPS. "
                      "Open the merchant's checkout with browser_navigate, then fill again.")
    top_world = client.context_id
    top = main_frame(client, session_id)
    navigations = client.navigations(session_id, top["id"])

    def on_merchant() -> bool:
        return (client.navigations(session_id, top["id"]) == navigations
                and eval_json(client, session_id, "location.origin", context_id=top_world) == origin)

    if not on_merchant():
        raise Refused(NOT_ON_MERCHANT)
    on_merchant.main_frame_id = top["id"]  # type: ignore[attr-defined]
    return on_merchant


def fill_pay_token(client: CdpClient, session_id: str, step: dict[str, Any]) -> None:
    """Hand an approved pay token to the merchant account's hidden block, in the page or Stripe's frame.

    The token is passed as a call argument, never in script source or the result, and only once the
    top page is still the merchant's and the block names the purchase's merchant account.
    """
    on_merchant = merchant_check(client, session_id, step["origin"])
    account = step["merchantAccountId"]
    lookup = "window.__rakazoPageBrowser.payTokenAccount()"
    targets = []
    if eval_json(client, session_id, lookup) == account:
        assert client.context_id is not None
        targets.append((session_id, on_merchant.main_frame_id, client.context_id))
    else:
        frames = pay_token_frames(client, payment_frames(client, session_id))
        targets = [frame for frame, found in zip(frames, frame_eval(client, frames, lookup)) if found == account]
    if len(targets) != 1:
        raise Refused(PAY_TOKEN_MISSING)
    target_session, _, world = targets[0]
    if not on_merchant() or (target_session != session_id and eval_json(
            client, target_session, "location.origin", context_id=world) != PAY_TOKEN_FRAME_ORIGIN):
        raise Refused(NOT_ON_MERCHANT)
    try:
        taken = call_with(client, target_session, world,
                          "function (token) { return window.__rakazoPageBrowser.setPayToken(token); }", step["text"])
    except Exception:  # noqa: BLE001
        raise Refused("The checkout didn't take the pay token. Take a fresh snapshot before trying again.") from None
    if taken is not True:
        raise Refused("The checkout didn't take the pay token. Take a fresh snapshot before trying again.")


def press_key(client: CdpClient, session_id: str, event: dict[str, Any]) -> None:
    client.call("Input.dispatchKeyEvent", {"type": "keyDown", **event}, session_id=session_id)
    client.call("Input.dispatchKeyEvent", {"type": "keyUp", **event}, session_id=session_id)


def fill_card(client: CdpClient, session_id: str, step: dict[str, Any]) -> None:
    """Type a card detail with trusted input into the field the page or its payment frame marks for it.

    Before every key the top page must still be the merchant's document, the frame its payment
    provider's, and the field focused, so a navigation between finding the field and typing refuses.
    """
    text = step["text"]
    if step["cardField"] == "expiry":
        text = "".join(char for char in text if char.isalnum())
    on_merchant = merchant_check(client, session_id, step["origin"])
    field_session, frame_id, world = find_card_field(client, session_id, on_merchant.main_frame_id,
                                                     CARD_AUTOCOMPLETE[step["cardField"]])
    in_frame = field_session != session_id
    frame_navigations = client.navigations(field_session, frame_id)

    def run(expression: str) -> Any:
        return eval_json(client, field_session, expression, context_id=world)

    def stopped() -> str | None:
        if not on_merchant():
            return NOT_ON_MERCHANT
        if in_frame and (client.navigations(field_session, frame_id) != frame_navigations
                         or not payment_frame_origin(run("location.origin"))):
            return "The payment frame changed, so the card was not typed. Take a fresh snapshot before trying again."
        return None

    if run("window.__rakazoPageBrowser.focusCard()") is not True:
        raise Refused("The card field did not take focus, so nothing was typed.")
    for index, char in enumerate(text):
        inserting = False
        try:
            reason = stopped() or (None if run("window.__rakazoPageBrowser.cardHolds()") is True else
                                   "Focus left the card field, so the card was not typed. Fill it again.")
            if not reason:
                inserting = True
                client.call("Input.insertText", {"text": char}, session_id=field_session)
        except Exception:
            # Part of the card may be in the field, even a first key whose answer was lost: it is
            # emptied before the failure is reported.
            if index or inserting:
                clear_or_uncertain(client, field_session, run, "The card could not be typed in full.")
            raise
        if reason:
            if index:
                clear_or_uncertain(client, field_session, run, reason)
            raise Refused(reason)
    reason = stopped()
    if reason:
        clear_or_uncertain(client, field_session, run, reason)
        raise Refused(reason)
    # Fields often move on to the next one by themselves once complete, so focus is not checked here.
    if run(f"window.__rakazoPageBrowser.cardTyped({sum(char.isalnum() for char in text)})") is not True:
        reason = "This field didn't accept the card, so it was cleared."
        clear_or_uncertain(client, field_session, run, reason)
        raise Refused(reason)


def clear_or_uncertain(client: CdpClient, session_id: str, run: Any, reason: str) -> None:
    if not clear_card(client, session_id, run):
        raise CardFieldUncertain(f"{reason} The field could not be confirmed empty, so check it before continuing.")


def clear_card(client: CdpClient, session_id: str, run: Any) -> bool:
    """Keys erase what the field's own script kept, then its value is emptied directly; True once it is empty."""
    try:
        if run("window.__rakazoPageBrowser.focusCard()") is True:
            press_key(client, session_id, {"key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8})
        run("window.__rakazoPageBrowser.emptyCard()")
        return run("window.__rakazoPageBrowser.cardTyped(0)") is True
    except Exception:  # noqa: BLE001
        return False


def connect(port: int) -> CdpClient:
    client = CdpClient(discover_ws_url(port))
    client.connect()
    return client


def run_step(port: int, target_id: str, step: dict[str, Any]) -> dict[str, Any] | None:
    """One saved-login, card or pay-token step on the tab target_id. Raises Refused when declined."""
    client = connect(port)
    try:
        session_id = attach(client, target_id)
        if step["kind"] == "pay_token":
            fill_pay_token(client, session_id, step)
        elif step.get("ref") is None:
            fill_card(client, session_id, step)
        else:
            return fill_focused(client, session_id, step)
    finally:
        client.close()


def frame_hints(client: CdpClient, session_id: str) -> tuple[bool, str | None]:
    """Whether a payment frame the page shows holds a card field, and the merchant account a pay token
    checkout names inside Stripe's frame: what the snapshot tells the bot about its payment frames."""
    frames = payment_frames(client, session_id)
    card = any(frame_eval(client, frames, "window.__rakazoPageBrowser.hasCardField()"))
    accounts = [found for found in frame_eval(client, pay_token_frames(client, frames),
                                              "window.__rakazoPageBrowser.payTokenAccount()") if found]
    return card, accounts[0] if len(accounts) == 1 else None


def payment_frame_hints(port: int, target_id: str) -> tuple[bool, str | None]:
    client = connect(port)
    try:
        return frame_hints(client, attach(client, target_id))
    finally:
        client.close()


def eval_page(client: CdpClient, session_id: str, expression: str) -> Any:
    """Evaluate in the frame's own page world, where focus and input events are."""
    return page_value(client.call("Runtime.evaluate", {
        "expression": expression, "returnByValue": True,
    }, session_id=session_id))


_CODE_PREPARE = r"""(() => {
  const box = (el) => el && el.tagName === "INPUT" && el.maxLength === 1 && !el.disabled
    && !["hidden", "checkbox", "radio", "button", "submit", "file", "image"].includes((el.type || "text").toLowerCase());
  const groupOf = (el) => {
    if (!box(el)) return null;
    for (let node = el, up = 0; node && up < 4; node = node.parentElement, up++) {
      const boxes = [...node.querySelectorAll("input")].filter(box);
      if (boxes.includes(el) && boxes.length >= 4 && boxes.length <= 8) return boxes;
    }
    return null;
  };
  const focused = (doc) => {
    let el = doc.activeElement;
    if (!el || el === doc.body || el === doc.documentElement) return null;
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      try { if (el.contentDocument) return focused(el.contentDocument); } catch (e) { return null; }
    }
    return el;
  };
  const boxes = groupOf(focused(document));
  if (!boxes) return null;
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  boxes.forEach((field, index) => {
    proto.set.call(field, "");
    field.setAttribute("data-rakazo-code", String(index));
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  boxes[0].focus();
  return { size: boxes.length };
})()"""

_CODE_READ = r"""(() => {
  const docs = [document];
  const walk = (doc) => {
    for (const frame of doc.querySelectorAll("iframe,frame")) {
      try { if (frame.contentDocument) { docs.push(frame.contentDocument); walk(frame.contentDocument); } }
      catch (e) { /* cross-origin */ }
    }
  };
  walk(document);
  for (const doc of docs) {
    const boxes = [...doc.querySelectorAll("[data-rakazo-code]")]
      .sort((a, b) => Number(a.getAttribute("data-rakazo-code")) - Number(b.getAttribute("data-rakazo-code")));
    if (boxes.length) return boxes.map((field) => field.value);
  }
  return null;
})()"""


def _press_char(client: CdpClient, session_id: str, char: str) -> None:
    if char.isdigit():
        code, vk = f"Digit{char}", ord(char)
    elif char.isascii() and char.isalpha():
        code, vk = f"Key{char.upper()}", ord(char.upper())
    else:
        code, vk = "", ord(char) if char.isascii() else 0
    down = {"type": "keyDown", "key": char, "text": char, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
    up = {"type": "keyUp", "key": char, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
    if code:
        down["code"] = up["code"] = code
    client.call("Input.dispatchKeyEvent", down, session_id=session_id)
    client.call("Input.dispatchKeyEvent", up, session_id=session_id)


def _frame_sessions(client: CdpClient, root: str) -> list[str]:
    sessions = [root]
    try:
        sessions += [session for session in auto_attach(client, root) if session not in sessions]
    except Exception:  # noqa: BLE001
        pass
    return sessions[:MAX_FRAME_SESSIONS]


def fill_code_boxes(port: int, target_id: str, text: str) -> None:
    """Type one real key per box of a split code, including in a cross-origin frame, then check each box."""
    if len(text) < 2:
        raise NotACode()
    try:
        client = connect(port)
    except Exception as exc:  # noqa: BLE001
        raise NotACode() from exc
    try:
        root = attach(client, target_id)
        holder: tuple[str, int] | None = None
        for session in _frame_sessions(client, root):
            try:
                if session != root:
                    client.call("Page.enable", session_id=session)
                found = eval_page(client, session, _CODE_PREPARE)
            except Exception:  # noqa: BLE001
                continue
            if isinstance(found, dict) and isinstance(found.get("size"), int) and found["size"] >= 4:
                holder = (session, found["size"])
                break
        if holder is None:
            raise NotACode()
        session, size = holder
        if len(text) != size:
            raise RuntimeError(
                f"This code has {len(text)} characters and the page has {size} boxes. "
                "Check the boxes before asking for a new code."
            )
        for char in text:
            _press_char(client, session, char)
            time.sleep(0.05)
        values = eval_page(client, session, _CODE_READ)
        filled = [str(value) for value in values] if isinstance(values, list) else []
        if "".join(filled) != text:
            present = sum(1 for value in filled if value)
            raise RuntimeError(
                f"The code was not typed into every box ({present} of {size} filled). "
                "Check the boxes before asking for a new code; it may have been only partly typed."
            )
    finally:
        client.close()


_CLICK_LOCAL = r"""(() => {
  const wantRef = __REF__;
  const wantText = __TEXT__;
  const center = (el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
             w: rect.width, h: rect.height, cw: document.documentElement.clientWidth,
             ch: document.documentElement.clientHeight };
  };
  if (wantRef) {
    const el = document.querySelector(`[data-rakazo-click="${wantRef}"]`);
    return el ? center(el) : null;
  }
  const wanted = String(wantText || "").replace(/\s+/g, " ").trim();
  const nodes = [...document.querySelectorAll("a,button,span,div,p,label,[role='button'],[role='link']")];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const text = (nodes[i].innerText || nodes[i].getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (text === wanted) return center(nodes[i]);
  }
  return null;
})()"""

_MARK_FRAME = r"""(() => {
  const frameNo = __FRAME__;
  const clickableText = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName;
    if (["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "FRAME", "HTML", "BODY"].includes(tag)) return "";
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return "";
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return "";
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (!(role === "button" || role === "link" || el.hasAttribute("onclick") || typeof el.onclick === "function"
          || style.cursor === "pointer")) return "";
    return (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  };
  const marks = [];
  let serial = 0;
  for (const el of document.querySelectorAll("span,div,p,label,[role='button'],[role='link']")) {
    const text = clickableText(el);
    if (!text) continue;
    if ([...el.querySelectorAll("span,div,p,label,[role='button'],[role='link']")].some((child) => clickableText(child) === text))
      continue;
    serial += 1;
    const ref = "f" + frameNo + "e" + serial;
    el.setAttribute("data-rakazo-click", ref);
    marks.push({ ref, name: text, role: (el.getAttribute("role") || "button").toLowerCase() });
  }
  return marks;
})()"""


def _iframe_viewport_box(client: CdpClient, parent: str, frame_id: str) -> tuple[float, float, float, float] | None:
    """The iframe element's box in the parent's viewport, scaled into CSS pixels."""
    try:
        owner = client.call("DOM.getFrameOwner", {"frameId": frame_id}, session_id=parent)
        model = client.call("DOM.getBoxModel", {"backendNodeId": owner["backendNodeId"]}, session_id=parent)
        node = client.call("DOM.resolveNode", {"backendNodeId": owner["backendNodeId"]}, session_id=parent)
        size = client.call("Runtime.callFunctionOn", {
            "objectId": node["object"]["objectId"],
            "functionDeclaration": "function () { return { w: this.clientWidth || 0, h: this.clientHeight || 0 }; }",
            "returnByValue": True,
        }, session_id=parent)
    except Exception:  # noqa: BLE001
        return None
    content = model.get("model", {}).get("content")
    if not isinstance(content, list) or len(content) < 8:
        return None
    xs, ys = content[0::2], content[1::2]
    metrics = eval_page(client, parent, "({sx:window.scrollX,sy:window.scrollY,"
                         "scale:(visualViewport&&visualViewport.scale)||1,"
                         "ox:(visualViewport&&visualViewport.offsetLeft)||0,"
                         "oy:(visualViewport&&visualViewport.offsetTop)||0})")
    if not isinstance(metrics, dict):
        return None
    scale = float(metrics.get("scale") or 1)
    left = (min(xs) - float(metrics.get("sx") or 0) - float(metrics.get("ox") or 0)) * scale
    top = (min(ys) - float(metrics.get("sy") or 0) - float(metrics.get("oy") or 0)) * scale
    width = (max(xs) - min(xs)) * scale
    height = (max(ys) - min(ys)) * scale
    inner = (size.get("result") or {}).get("value") or {}
    inner_w = float(inner.get("w") or 0) or width
    inner_h = float(inner.get("h") or 0) or height
    return left, top, width / inner_w, height / inner_h


def cross_origin_clickables(port: int, target_id: str) -> list[dict[str, str]]:
    """Clickable text in cross-origin frames, which a same-origin walk cannot see."""
    try:
        client = connect(port)
    except Exception:  # noqa: BLE001
        return []
    marks: list[dict[str, str]] = []
    try:
        root = attach(client, target_id)
        for index, session in enumerate(_frame_sessions(client, root)):
            if session == root:
                continue
            try:
                client.call("Page.enable", session_id=session)
                found = eval_page(client, session, _MARK_FRAME.replace("__FRAME__", str(index + 1)))
            except Exception:  # noqa: BLE001
                continue
            if isinstance(found, list):
                marks.extend(item for item in found if isinstance(item, dict))
    except Exception:  # noqa: BLE001
        return marks
    finally:
        client.close()
    return marks


def cross_origin_click_point(port: int, target_id: str, *, ref: str | None, text: str | None) -> dict[str, float] | None:
    """Viewport point of a control inside a cross-origin frame, accounting for the frame's box and scale."""
    try:
        client = connect(port)
    except Exception:  # noqa: BLE001
        return None
    try:
        root = attach(client, target_id)
        script = _CLICK_LOCAL.replace("__REF__", json.dumps(ref or "")).replace("__TEXT__", json.dumps(text or ""))
        for session in _frame_sessions(client, root):
            if session == root:
                continue
            try:
                client.call("Page.enable", session_id=session)
                local = eval_page(client, session, script)
                frame_id = main_frame(client, session)["id"]
                box = _iframe_viewport_box(client, root, frame_id)
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(local, dict) or box is None:
                continue
            left, top, sx, sy = box
            return {"x": left + float(local["x"]) * sx, "y": top + float(local["y"]) * sy}
    except Exception:  # noqa: BLE001
        return None
    finally:
        client.close()
    return None


def stripe_pay_token_account(port: int, target_id: str) -> str | None:
    """The merchant account a pay token checkout names inside Stripe's frame, for the snapshot's hint."""
    client = connect(port)
    try:
        session_id = attach(client, target_id)
        frames = pay_token_frames(client, payment_frames(client, session_id))
        accounts = [found for found in frame_eval(client, frames, "window.__rakazoPageBrowser.payTokenAccount()")
                    if found]
        return accounts[0] if len(accounts) == 1 else None
    finally:
        client.close()
