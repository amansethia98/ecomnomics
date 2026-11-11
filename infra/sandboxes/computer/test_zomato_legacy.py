"""Offline dispatch and immutable source-provenance checks; no site requests."""
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

import zomato_legacy as legacy


class ZomatoLegacyTest(unittest.TestCase):
    def test_exact_auth_origin_only(self):
        for url in ("https://accounts.zomato.com/login", "https://accounts.zomato.com:443/otp"):
            self.assertTrue(legacy.auth_page(url))
        for url in ("http://accounts.zomato.com", "https://accounts.zomato.com.evil.test", "https://accounts.zomato.com:444", "https://www.zomato.com"):
            self.assertFalse(legacy.auth_page(url))

    def test_non_zomato_bypasses_without_browser_attachment(self):
        with patch.object(legacy.page_secrets, "connect", side_effect=AssertionError("Must not attach")):
            self.assertFalse(legacy.login_present(9222, "tab", "https://partner.swiggy.com"))
            self.assertIsNone(legacy.dispatch("snapshot", {}, 9222, lambda _: ("tab", "https://example.test")))

    def test_unrelated_commands_never_use_the_frozen_runtime(self):
        for command in ("purchase_check", "hold", "finish", "tabs", "unknown"):
            self.assertIsNone(legacy.dispatch(command, {}, 9222, lambda _: self.fail("unexpected lookup")))

    def test_frozen_module_has_its_own_old_secret_helper(self):
        browser = legacy.load_browser()
        self.assertIsNot(browser.page_secrets, legacy.page_secrets)
        self.assertFalse(hasattr(browser.page_secrets, "fill_code_keys"))
        self.assertIs(__import__("page_secrets"), legacy.page_secrets)

    def test_frozen_sources_are_exact_246c11b_blobs(self):
        root = Path(__file__).parent
        expected = {
            "zomato_browser_246c11b.py": "1b884ffbaf31416bd3e10f2ab9da4ab24f134521dc7d091d214a3669159d447d",
            "zomato_secrets_246c11b.py": "79e3fa05da52fb7b8cc7db424f5a4a98c5451a330b488ba58374e8691678f2ba",
        }
        for filename, digest in expected.items():
            self.assertEqual(hashlib.sha256((root / filename).read_bytes()).hexdigest(), digest)
