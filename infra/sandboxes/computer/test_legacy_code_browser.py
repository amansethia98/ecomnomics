"""Opt-in offline Chromium regression for the legacy code-key route.

Run inside a --network=none computer-test container with RAKAZO_BROWSER_OFFLINE_TEST=1.
The real site's hostname is resolved to an in-container HTTPS fixture, never the Internet.
Only the DOM structure is captured; its key-driven event behavior is synthetic.
"""
import contextlib
import http.server
import io
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request

HERE = Path(__file__).parent
loader = importlib.machinery.SourceFileLoader("legacy_page_browser", str(HERE / "rakazo-page-browser"))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)
secrets = helper.page_secrets


@unittest.skipUnless(os.environ.get("RAKAZO_BROWSER_OFFLINE_TEST") == "1", "opt-in isolated Chromium fixture")
class LegacyCodeBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        cert, key = root / "cert.pem", root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=offline.example.test", "-keyout", str(key), "-out", str(cert)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        fixture = (HERE / "fixtures/short-code-captured-layout.html").read_bytes()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path == "/favicon.ico":
                    self.send_error(404)
                    return
                if self.headers.get("Host", "").startswith("accounts.zomato.com"):
                    body = fixture
                else:
                    body = (f'<html><head><title>Offline</title></head><body><iframe style="width:900px;height:500px" '
                            'src="https://accounts.zomato.com/verify"></iframe></body></html>').encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        # Use the real auth origin's standard port so exact-origin checks are exercised.
        cls.auth_server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), Handler)
        cls.auth_server.socket = context.wrap_socket(cls.auth_server.socket, server_side=True)
        cls.auth_thread = threading.Thread(target=cls.auth_server.serve_forever, daemon=True)
        cls.auth_thread.start()
        cls.chrome = subprocess.Popen([shutil.which("chromium"), "--headless=new", "--no-sandbox", "--disable-gpu",
                                       "--disable-dev-shm-usage", "--ignore-certificate-errors", "--no-proxy-server",
                                       "--disable-background-networking", "--remote-debugging-port=9222",
                                       "--host-resolver-rules=MAP www.zomato.com 127.0.0.1, MAP accounts.zomato.com 127.0.0.1",
                                       "--user-data-dir=" + str(root / "profile"), "about:blank"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while True:
            try:
                cls.client = secrets.connect(9222)
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError("Offline Chromium did not start") from None
                time.sleep(0.05)
        with urllib.request.urlopen("http://127.0.0.1:9222/json/list") as response:
            cls.target = next(item["id"] for item in json.load(response) if item["type"] == "page")
        cls.session = secrets.attach(cls.client, cls.target)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.chrome.terminate()
        cls.chrome.wait(timeout=10)
        cls.server.shutdown()
        cls.auth_server.shutdown()
        cls.server.server_close()
        cls.auth_server.server_close()
        cls.temp.cleanup()

    def load(self):
        # Both origins are local HTTPS fixtures inside a network-isolated container.
        url = f"https://www.zomato.com:{self.server.server_port}/?load={time.time_ns()}"
        self.ab = helper.AgentBrowser(9222)
        self.ab.use_tab(self.target)
        self.client.call("Page.navigate", {"url": url}, session_id=self.session)
        deadline = time.monotonic() + 10
        while True:
            try:
                if secrets.eval_page(self.client, self.session, "document.readyState === 'complete' && location.href === " + json.dumps(url)) is True:
                    break
            except Exception:
                pass
            if time.monotonic() > deadline:
                self.fail("Offline portal did not load")
            time.sleep(0.05)
        self.client.context_id = secrets.world_in(self.client, self.session, secrets.main_frame(self.client, self.session)["id"])
        self.page = helper.zomato_legacy.load_browser().PageBrowser(9222, self.target, self.ab)
        deadline = time.monotonic() + 15
        while True:
            snapshot = self.page.snapshot(0)
            fields = [node for node in snapshot.get("elements", []) if node.get("role") == "textbox"]
            if len(fields) == 6:
                self.ref = fields[0]["ref"]
                break
            if time.monotonic() > deadline:
                self.fail("Captured six-box fixture did not load: " + json.dumps(snapshot))
            time.sleep(0.05)
        self.ab.batch([["focus", "@" + self.ref]])
        self.frame = secrets.focused_frame(self.client, self.session)

    def evaluate(self, expression):
        session, _, world = self.frame
        return secrets.eval_json(self.client, session, expression, context_id=world)

    def page_evaluate(self, expression):
        session, frame, _ = self.frame
        secrets.eval_json(self.client, session, "true", context_id=self.frame[2])
        context = next(cid for cid, data in self.client._contexts.items()
                       if data.get("_sessionId") == session and (data.get("auxData") or {}).get("frameId") == frame
                       and (data.get("auxData") or {}).get("isDefault"))
        return secrets.eval_json(self.client, session, expression, context_id=context)

    def native(self, command, args):
        # Exercise the actual current entrypoint and its frozen-browser dispatch.
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = helper.run(["rakazo-page-browser", command, json.dumps(args)])
        result = json.loads(output.getvalue())
        self.assertEqual(code, 0 if result.get("ok") else 1)
        return result

    def test_complete_old_type_then_submit_through_current_entrypoint(self):
        self.load()
        snapshot = self.native("snapshot", {})
        fields = [node for node in snapshot["elements"] if node.get("role") == "textbox"]
        self.assertEqual(len(fields), 6)
        # Assert the real captured structural constraints, not maxlength=1 OTP hints.
        layout = self.evaluate("""[...document.querySelectorAll('input')].map(f=>({
          max:f.maxLength, mode:f.inputMode, type:f.type,
          hints:['name','id','aria-label','autocomplete'].filter(k=>f.hasAttribute(k)),
          path:(()=>{let a=[],n=f;while(n){const p=n.parentElement;
            a.unshift(n.localName+'['+(p?[...p.children].indexOf(n):0)+']');n=p;}return a.join('/')})()
        }))""")
        captured = json.loads((HERE / "fixtures/short-code-captured-layout.json").read_text())
        self.assertTrue(captured["inFrame"])
        self.assertEqual(len(layout), captured["inputCount"])
        for actual, observed in zip(layout, captured["completeCapturedFields"]):
            self.assertEqual((actual["path"], actual["max"], actual["mode"], actual["type"], actual["hints"]),
                             (observed["path"], observed["maxlength"], observed["inputmode"], observed["type"], []))
        for index, field in enumerate(layout):
            self.assertEqual((field["max"], field["mode"], field["type"], field["hints"]), (2, "text", "text", []))
            self.assertEqual(field["path"], f"html[0]/body[1]/div[5]/div[0]/div[1]/section[1]/section[0]/div[1]/div[0]/div[0]/input[{index}]")
        result = self.native("act", {"actions": [
            {"kind": "type", "ref": field["ref"], "text": character}
            for field, character in zip(fields, "AB7C9D")
        ]})
        self.assertTrue(result["ok"], result.get("error", "Historical type failed"))
        self.assertEqual(result["completed"], 6)
        self.assertTrue(self.evaluate("[...document.querySelectorAll('input')].map(f=>f.value).join('') === 'AB7C9D'"), str({"lengths": self.evaluate("[...document.querySelectorAll('input')].map(f=>f.value.length)"), "keys": self.page_evaluate("window.keyCount")}))
        self.assertEqual(self.page_evaluate("window.trustedInputCount"), 6)
        self.assertFalse(self.page_evaluate("window.submitted"))
        button = next(node for node in result["elements"] if node.get("role") == "button" and node.get("name") == "Continue")
        submitted = self.native("act", {"actions": [{"kind": "click", "ref": button["ref"]}]})
        self.assertTrue(submitted["ok"], submitted.get("error", "Historical submit failed"))
        self.assertTrue(self.page_evaluate("window.submitted"))

    def test_whole_code_in_first_maxlength_two_box_is_not_a_passing_fixture(self):
        self.load()
        # The old cross-frame keyboard type sends insertText, not one key per box.
        # Keep the failure visible: do not add a magic full-code distributor to the fixture.
        self.native("act", {"actions": [{"kind": "type", "ref": self.ref, "text": "AB7C9D"}]})
        self.assertFalse(self.evaluate("[...document.querySelectorAll('input')].map(f=>f.value).join('') === 'AB7C9D'"))
        self.assertEqual(self.evaluate("[...document.querySelectorAll('input')].map(f=>f.value.length)"), [2, 0, 0, 0, 0, 0])
        self.assertFalse(self.page_evaluate("window.submitted"))

    def test_untrusted_setter_events_do_not_pass_the_fixture(self):
        self.load()
        self.evaluate("""document.querySelectorAll('input').forEach((box, i) => {
          box.value = 'AB7C9D'[i]; box.dispatchEvent(new Event('input', {bubbles:true}));
        })""")
        self.assertTrue(self.evaluate("[...document.querySelectorAll('input')].every(f=>!f.value)"))
        self.assertEqual(self.page_evaluate("window.trustedInputCount"), 0)
        self.assertFalse(self.page_evaluate("window.submitted"))

    def test_private_code_route_is_not_reused_for_zomato(self):
        self.load()
        result = self.native("act", {"actions": [{"kind": "fill", "field": "code", "origin": "https://accounts.zomato.com", "ref": self.ref, "text": "AB7C9D"}]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["completed"], 0)
        self.assertFalse(result["uncertain"])
        self.assertEqual(self.page_evaluate("window.keyCount"), 0)
        self.assertNotIn("AB7C9D", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
