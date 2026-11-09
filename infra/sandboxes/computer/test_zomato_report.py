#!/usr/bin/env python3
"""Task claim, single-flight lock, and fresh-file processing. No browser and no live site."""

import contextlib
import csv
import fcntl
import importlib.machinery
import importlib.util
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent


def load(name):
    loader = importlib.machinery.SourceFileLoader(name, str(HERE / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


report = load("rakazo-zomato-report")


class LockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = self.home / "state"
        self.previous = {
            key: os.environ.get(key)
            for key in ("HOME", "RAKAZO_ZOMATO_REPORT_STATE", "RAKAZO_RUN_ID")
        }
        os.environ["HOME"] = str(self.home)
        os.environ["RAKAZO_ZOMATO_REPORT_STATE"] = str(self.state)
        os.environ["RAKAZO_RUN_ID"] = "run-1"
        self.calls = 0

        def process_download(kind, directory, options):
            self.calls += 1
            if self.fail:
                raise ValueError("test fixture failure")
            return "computed facts\n"

        self.fail = False
        self.original = report.process_download
        report.process_download = process_download

    def tearDown(self):
        report.process_download = self.original
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def invoke(self, *args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return report.main(list(args))

    def test_duplicate_claim_is_refused(self):
        self.assertEqual(self.invoke("begin", "monthly"), 0)
        self.assertEqual(self.invoke("begin", "monthly"), 2)
        self.assertEqual(self.calls, 0)

    def test_success_is_returned_without_processing_again(self):
        self.assertEqual(self.invoke("begin", "monthly"), 0)
        self.assertEqual(self.invoke("monthly", "--outlet", "42", "--before", "Mar 2026", "--after", "Apr 2026"), 0)
        self.assertEqual(self.invoke("monthly", "--outlet", "42", "--before", "Mar 2026", "--after", "Apr 2026"), 0)
        self.assertEqual(self.calls, 1)

    def test_an_in_flight_call_is_refused(self):
        self.state.mkdir()
        with (self.state / "processing.lock").open("a") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.invoke("begin", "monthly"), 2)
        self.assertEqual(self.calls, 0)

    def test_wrong_kind_is_refused(self):
        self.assertEqual(self.invoke("begin", "monthly"), 0)
        self.assertEqual(self.invoke("payout"), 2)
        self.assertEqual(self.calls, 0)

    def test_processing_without_a_claim_is_refused(self):
        self.assertEqual(self.invoke("monthly", "--outlet", "42", "--before", "Mar 2026", "--after", "Apr 2026"), 2)
        self.assertEqual(self.calls, 0)

    def test_a_missing_task_id_does_no_work(self):
        os.environ.pop("RAKAZO_RUN_ID")
        self.assertEqual(self.invoke("begin", "monthly"), 2)
        self.assertEqual(self.calls, 0)

    def test_a_new_run_can_claim_again(self):
        self.assertEqual(self.invoke("begin", "payout"), 0)
        os.environ["RAKAZO_RUN_ID"] = "run-2"
        self.assertEqual(self.invoke("begin", "payout"), 0)
        self.assertEqual(self.calls, 0)

    def test_failed_processing_allows_one_retry(self):
        self.fail = True
        self.assertEqual(self.invoke("begin", "monthly"), 0)
        self.assertEqual(
            [self.invoke("monthly", "--outlet", "42", "--before", "Mar 2026", "--after", "Apr 2026") for _ in range(3)],
            [2, 2, 2],
        )
        self.assertEqual(self.calls, 2)


class FreshFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.downloads = self.home / "Downloads"
        self.downloads.mkdir()
        self.state = self.home / "state"
        self.env = os.environ.copy()
        self.env.update(
            {
                "HOME": str(self.home),
                "RAKAZO_ZOMATO_REPORT_STATE": str(self.state),
                "RAKAZO_RUN_ID": "fresh-run",
                "RAKAZO_ZOMATO_REPORT_WAIT_S": "2",
                "RAKAZO_ZOMATO_REPORT_POLL_S": "0.05",
            }
        )
        self.script = str(HERE / "rakazo-zomato-report")

    def tearDown(self):
        self.tmp.cleanup()

    def run_report(self, *args):
        return subprocess.run(
            [os.environ.get("PYTHON", "python3"), self.script, *args],
            text=True,
            capture_output=True,
            env=self.env,
            timeout=15,
        )

    def test_a_fresh_monthly_file_is_analysed_once(self):
        claimed = self.run_report("begin", "monthly")
        self.assertEqual(claimed.returncode, 0, claimed.stderr)
        path = self.downloads / "business_report_fixture.csv"
        with path.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                ["Overview", "Restaurant ID", "Restaurant name", "Subzone", "City", "Metric", "Mar 2026", "Apr 2026"]
            )
            pairs = {
                "Delivered orders": ("10", "8"),
                "Sales (Rs)": ("100", "80"),
                "Placed Orders": ("10", "8"),
                "Bad orders": ("1", "1"),
                "Average rating": ("4", "4"),
                "Rated orders": ("5", "4"),
                "Poor rated orders": ("1", "1"),
                "Total complaints": ("1", "1"),
                "Non-refunded complaints": ("0", "0"),
                "Sales from ads (Rs)": ("10", "10"),
                "Ads spend (Rs)": ("5", "5"),
                "Discount given (Rs)": ("1", "1"),
                "New user orders": ("4", "3"),
                "Repeat user orders": ("4", "3"),
                "Lapsed user orders": ("2", "2"),
                "Impressions": ("20", "20"),
                "Menu opens": ("10", "10"),
                "Cart builds": ("5", "5"),
                "KPT (in minutes)": ("12", "12"),
                "FOR accuracy (%)": ("80", "80"),
            }
            for name, (earlier, later) in pairs.items():
                writer.writerow(["Sales", "42", "North Kitchen", "Central", "Test City", name, earlier, later])
        # The waiter needs two looks at a stable file. Touch it before the command.
        os.utime(path, None)
        processed = self.run_report("monthly", "--outlet", "42", "--before", "Mar 2026", "--after", "Apr 2026")
        self.assertEqual(processed.returncode, 0, processed.stderr)
        self.assertIn("FRESH SOURCE:", processed.stdout)
        self.assertIn("Average order value (AOV)", processed.stdout)
        again = self.run_report("monthly", "--outlet", "42", "--before", "Mar 2026", "--after", "Apr 2026")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("Cached successful processing", again.stdout)

    def test_an_old_file_is_not_reused(self):
        path = self.downloads / "business_report_old.csv"
        path.write_text("old\n")
        old = path.stat().st_mtime - 10
        os.utime(path, (old, old))
        self.assertEqual(self.run_report("begin", "monthly").returncode, 0)
        processed = self.run_report("monthly", "--outlet", "42", "--before", "Mar 2026", "--after", "Apr 2026")
        self.assertEqual(processed.returncode, 2)
        self.assertIn("no fresh valid monthly report", processed.stderr)

    def test_commands_do_not_click_the_page(self):
        for name in ("rakazo-zomato-report", "rakazo-zomato-monthly-analysis"):
            text = (HERE / name).read_text()
            self.assertNotIn("xdotool", text)
            self.assertNotIn("mousemove", text)
            self.assertNotRegex(text, r"\b24802\b")


if __name__ == "__main__":
    unittest.main()
