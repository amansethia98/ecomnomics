"""All cookie/storage data and identities below are explicitly synthetic."""
import importlib.machinery
import importlib.util
import io
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
loader = importlib.machinery.SourceFileLoader('browser_session', str(Path(__file__).with_name('rakazo-browser-session')))
spec = importlib.util.spec_from_loader(loader.name, loader)
session = importlib.util.module_from_spec(spec)
loader.exec_module(session)

FAKE_COOKIE = {'name': 'SYNTHETIC_COOKIE', 'value': 'SYNTHETIC_TOKEN', 'domain': '.swiggy.com', 'path': '/', 'expires': -1}
FAKE_BUNDLE = {'url': 'https://partner.swiggy.com/synthetic-dashboard', 'origin': 'https://partner.swiggy.com',
               'cookies': [FAKE_COOKIE], 'localStorage': [['SYNTHETIC_AUTH', 'SYNTHETIC_TOKEN']], 'sessionStorage': []}


class FakeCdp:
    def __init__(self, existing=None, needs_login=False, targets=False):
        self.calls = []
        self.existing = existing or []
        self.needs_login = needs_login
        self.targets = targets

    def call(self, method, params=None, **kwargs):
        self.calls.append((method, params))
        if method == 'Storage.getCookies': return {'cookies': self.existing}
        if method == 'Target.getTargets': return {'targetInfos': [{'targetId': 'SYNTHETIC_TAB', 'type': 'page', 'url': FAKE_BUNDLE['url']}] if self.targets else []}
        if method == 'Target.createTarget': return {'targetId': 'SYNTHETIC_NEW_TAB'}
        if method == 'Target.attachToTarget': return {'sessionId': 'SYNTHETIC_SESSION'}
        if method == 'Page.addScriptToEvaluateOnNewDocument': return {'identifier': 'SYNTHETIC_SCRIPT'}
        if method == 'Runtime.evaluate':
            value = {'url': FAKE_BUNDLE['url'], 'needsLogin': self.needs_login, 'visible': True}
            if params['expression'] == session.CAPTURE:
                value = {k: FAKE_BUNDLE[k] for k in ('origin', 'localStorage', 'sessionStorage')}
            return {'result': {'value': value}}
        return {}


class SessionTransport(unittest.TestCase):
    def test_default_off_does_not_read_input_or_connect(self):
        with patch.dict(session.os.environ, {}, clear=True), patch.object(session, 'CdpClient') as client, patch.object(session.sys, 'stdin', None), patch.object(session.sys, 'stdout', io.StringIO()) as output:
            session.main()
        self.assertEqual(output.getvalue().strip(), '{"status":"disabled"}')
        client.assert_not_called()

    def test_platform_suffix_boundary_and_secure_origin(self):
        for url in ['http://partner.swiggy.com/', 'https://swiggy.com.attacker.example/', 'https://accounts.zomato.com/login']:
            with self.assertRaises(ValueError): session.safe_url(url, 'swiggy')
        self.assertEqual(session.safe_url(FAKE_BUNDLE['url'] + '?synthetic=discarded#fake', 'swiggy'), FAKE_BUNDLE['url'])

    def test_only_first_party_unexpired_cookies_and_no_partition_downgrade(self):
        cookies = [FAKE_COOKIE, {**FAKE_COOKIE, 'domain': '.unrelated.example'}, {**FAKE_COOKIE, 'expires': 1}]
        selected = session.cookies_for(cookies, 'swiggy', now=100)
        self.assertEqual(len(selected), 1)
        self.assertNotIn('expires', selected[0])
        with self.assertRaises(ValueError): session.cookies_for([{**FAKE_COOKIE, 'partitionKey': {'topLevelSite': 'https://swiggy.com'}}], 'swiggy')

    def test_capture_never_navigates_and_filters_other_platforms(self):
        cdp = FakeCdp([FAKE_COOKIE, {**FAKE_COOKIE, 'domain': '.zomato.com'}], targets=True)
        captured = session.capture(cdp, 'swiggy')
        self.assertEqual(captured['status'], 'captured')
        self.assertEqual(len(captured['bundle']['cookies']), 1)
        self.assertFalse(any(method in ('Page.navigate', 'Storage.setCookies') for method, _ in cdp.calls))

    def test_login_page_is_not_saved(self):
        self.assertEqual(session.capture(FakeCdp(needs_login=True, targets=True), 'swiggy')['status'], 'proven_login_required')

    def test_current_profile_is_never_overwritten(self):
        cdp = FakeCdp([FAKE_COOKIE])
        self.assertEqual(session.restore(cdp, 'swiggy', FAKE_BUNDLE)['status'], 'use_current_profile')
        self.assertFalse(any(method == 'Storage.setCookies' for method, _ in cdp.calls))

    def test_current_platform_tab_precedes_token_only_restoration(self):
        cdp = FakeCdp(targets=True)
        self.assertEqual(session.restore(cdp, 'swiggy', FAKE_BUNDLE)['status'], 'use_current_profile')
        self.assertFalse(any(method in ('Storage.setCookies', 'Page.navigate') for method, _ in cdp.calls))

    def test_origin_binding_precedes_any_browser_mutation(self):
        cdp = FakeCdp()
        with self.assertRaises(ValueError): session.restore(cdp, 'swiggy', {**FAKE_BUNDLE, 'origin': 'https://attacker.example'})
        self.assertEqual(cdp.calls, [])

    def test_restore_requires_live_verification_and_removes_injection(self):
        cdp = FakeCdp()
        self.assertEqual(session.restore(cdp, 'swiggy', FAKE_BUNDLE)['status'], 'verify_live_page')
        methods = [method for method, _ in cdp.calls]
        self.assertIn('Storage.setCookies', methods)
        self.assertIn('Page.removeScriptToEvaluateOnNewDocument', methods)
        self.assertNotIn('Runtime.callFunctionOn', methods)
        script = next(args['source'] for method, args in cdp.calls if method == 'Page.addScriptToEvaluateOnNewDocument')
        self.assertIn('location.origin !== s.origin', script)

    def test_detected_expiry_chooses_proven_login_and_does_not_type(self):
        cdp = FakeCdp(needs_login=True)
        self.assertEqual(session.restore(cdp, 'swiggy', FAKE_BUNDLE)['status'], 'proven_login_required')
        self.assertFalse(any(method.startswith('Input.') for method, _ in cdp.calls))


if __name__ == '__main__': unittest.main()
