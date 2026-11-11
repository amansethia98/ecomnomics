"""Opt-in offline Chromium regression for the legacy code-key route.

Run inside a --network=none computer-test container with RAKAZO_BROWSER_OFFLINE_TEST=1.
The real site's hostname is resolved to an in-container HTTPS fixture, never the Internet.
Only the DOM structure is captured; its key-driven event behavior is synthetic.
"""
import http.server
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
                                       "--host-resolver-rules=MAP portal.example.test 127.0.0.1, MAP accounts.zomato.com 127.0.0.1",
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
        url = f"https://portal.example.test:{self.server.server_port}/?load={time.time_ns()}"
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
        self.page = helper.PageBrowser(9222, self.target, self.ab)
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

    def act(self):
        # Same native private action that browser_act fill_code produces. No code in argv/tool output.
        return self.page.act([{"kind": "fill", "field": "code", "origin": "https://accounts.zomato.com",
                               "ref": self.ref, "text": "AB7C9D"}])

    def test_captured_structure_uses_legacy_real_keys_not_segmented_setters(self):
        self.load()
        result = self.act()
        self.assertTrue(result["ok"], result.get("error", "Private entry failed"))
        self.assertEqual(result["completed"], 1)
        # Equality stays in Chromium: only a boolean and event counts leave the page.
        self.assertTrue(self.evaluate("[...document.querySelectorAll('input')].map(f=>f.value).join('') === 'AB7C9D'"))
        self.assertEqual(self.page_evaluate("window.keyCount"), 6)
        self.assertNotIn("AB7C9D", json.dumps(result))
        self.assertTrue(self.evaluate("[...document.querySelectorAll('input')].every(f=>f.hasAttribute('data-rakazo-filled') && f.style.getPropertyValue('-webkit-text-security') === 'disc')"))
        layout = json.loads(next(note.split(": ", 1)[1] for note in self.page.notes if note.startswith("Code layout before fill:")))
        self.assertTrue(layout["inFrame"])
        self.assertEqual(layout["inputCount"], 6)
        self.assertEqual(layout["target"], 0)
        for index, field in enumerate(layout["fields"]):
            self.assertEqual(field["path"], f"html[0]/body[1]/div[5]/div[0]/div[1]/section[1]/section[0]/div[1]/div[0]/div[0]/input[{index}]")
            self.assertEqual((field["maxlength"], field["inputmode"], field["autocomplete"], field["shaped"]), (2, "text", [], False))
        # The unchanged generic segmented route would refuse this layout. The rollback bypasses it.
        self.assertTrue(all(not field["singleEligible"] for field in layout["fields"]))

    def test_partial_keys_are_uncertain_and_cannot_be_replayed(self):
        self.load()
        self.evaluate("document.querySelectorAll('input')[0].addEventListener('keyup',()=>document.querySelectorAll('input')[1].readOnly=true)")
        result = self.act()
        self.assertFalse(result["ok"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(self.page_evaluate("window.keyCount"), 1)
        self.assertIn("Do not replay", result["error"])
        self.assertNotIn("AB7C9D", json.dumps(result))
        self.assertFalse(self.act()["ok"])
        self.assertEqual(self.page_evaluate("window.keyCount"), 1)

    def test_prefilled_boxes_are_refused_before_any_key(self):
        self.load()
        self.evaluate("document.querySelectorAll('input')[2].value='X'")
        result = self.act()
        self.assertFalse(result["ok"])
        self.assertFalse(result["uncertain"])
        self.assertEqual(self.page_evaluate("window.keyCount"), 0)


if __name__ == "__main__":
    unittest.main()
