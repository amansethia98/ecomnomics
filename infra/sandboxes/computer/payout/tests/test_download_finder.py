import os, tempfile, time, unittest
from pathlib import Path
from download_finder import find_download, swiggy_pattern, zomato_pattern


class FindDownloadTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup); self.dir = Path(d.name)

    def touch(self, name, age=0.0):
        p = self.dir / name; p.write_bytes(b"x"); t = time.time() - age; os.utime(p, (t, t)); return p

    def test_swiggy_takes_the_newest_annexure_for_the_configured_outlet_only(self):
        self.touch("invoice_Annexure_123_04112026_1.xlsx", 50)
        newest = self.touch("invoice_Annexure_123_04112026_2 (1).xlsx", 10)
        self.touch("invoice_Annexure_999_04112026_3.xlsx", 0)
        self.touch("invoice_Annexure_123_04112026_2-owner-swiggy.xlsx", 0)
        self.touch("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", 0)
        self.touch("Tax_Invoice_123.pdf", 0)
        self.assertEqual(find_download(self.dir, swiggy_pattern("123")), newest)

    def test_swiggy_refuses_an_annexure_older_than_the_job(self):
        self.touch("invoice_Annexure_123_04112026_1.xlsx", 3600)
        with self.assertRaisesRegex(ValueError, "rakazo-wait-download"):
            find_download(self.dir, swiggy_pattern("123"), since=time.time() - 60)

    def test_a_browser_temporary_name_is_never_accepted(self):
        self.touch("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
        with self.assertRaises(ValueError):
            find_download(self.dir, swiggy_pattern("123"))

    def test_zomato_matches_the_settlement_name_and_skips_generated_outputs(self):
        report = self.touch("Zomato_Settlement_Report_24_26 Oct 2026_01 Nov 2026.xlsx", 5)
        self.touch("Zomato_Settlement_Report_24_26 Oct 2026_01 Nov 2026-owner-reconciliation.xlsx", 0)
        self.touch("Zomato_Settlement_Report_245_26 Oct 2026_01 Nov 2026.xlsx", 0)
        self.assertEqual(find_download(self.dir, zomato_pattern("24")), report)


if __name__ == "__main__":
    unittest.main()
