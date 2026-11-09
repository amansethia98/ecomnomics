#!/usr/bin/env python3
"""Synthetic monthly-report maths. No restaurant export is stored in the repo."""

import csv
import importlib.machinery
import importlib.util
import tempfile
import unittest
import zipfile
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).parent
loader = importlib.machinery.SourceFileLoader(
    "zomato_monthly", str(HERE / "rakazo-zomato-monthly-analysis")
)
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
monthly = importlib.util.module_from_spec(spec)
loader.exec_module(monthly)

HEADER = [
    "Overview",
    "Restaurant ID",
    "Restaurant name",
    "Subzone",
    "City",
    "Metric",
    "Mar 2026",
    "Apr 2026",
]
BEFORE = "Mar 2026"
AFTER = "Apr 2026"
OUTLET = "42"


def metric(name, earlier, later, category="Sales"):
    return ["Sales", OUTLET, "North Kitchen", "Central", "Test City", name, earlier, later]


def report_rows():
    # Customer segments sum to placed orders. Poor-rated count rises while its share falls.
    values = {
        "Delivered orders": ("100", "80"),
        "Sales (Rs)": ("1000", "1200"),
        "Placed Orders": ("110", "100"),
        "Bad orders": ("10", "4"),
        "Average rating": ("4.0", "4.2"),
        "Rated orders": ("50", "80"),
        "Poor rated orders": ("10", "12"),
        "Total complaints": ("5", "2"),
        "Non-refunded complaints": ("2", "1"),
        "Sales from ads (Rs)": ("100", "300"),
        "Ads spend (Rs)": ("50", "40"),
        "Ads ROI": ("2", "2.5"),
        "Discount given (Rs)": ("10", "20"),
        "New user orders": ("40", "30"),
        "Repeat user orders": ("50", "40"),
        "Lapsed user orders": ("20", "30"),
        "Impressions": ("1000", "900"),
        "Menu opens": ("100", "80"),
        "Cart builds": ("40", "30"),
        "KPT (in minutes)": ("20", "15"),
        "FOR accuracy (%)": ("90", "80"),
        "Online %": ("95", "90"),
        "Offline time (in hours)": ("0", "2"),
        "KPT+10 delayed orders": ("1", "4"),
        "Orders with offers": ("3", "9"),
        "Menu to cart (%)": ("40", "50"),
        "Cart to orders (%)": ("25", "20"),
    }
    rows = [HEADER]
    rows.extend(metric(name, pair[0], pair[1]) for name, pair in values.items())
    return rows


def write_csv(folder: Path) -> Path:
    path = folder / "business_report.csv"
    with path.open("w", newline="") as handle:
        csv.writer(handle).writerows(report_rows())
    return path


class MonthlyAnalysisTest(unittest.TestCase):
    def setUp(self):
        self.rows = report_rows()

    def analyze(self, rows=None, **kwargs):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "business_report.csv"
            with path.open("w", newline="") as handle:
                csv.writer(handle).writerows(rows or self.rows)
            return monthly.analyze(
                [path],
                kwargs.get("before", BEFORE),
                kwargs.get("after", AFTER),
                kwargs.get("outlet", OUTLET),
            )

    def metrics(self, report=None):
        report = self.analyze() if report is None else report
        return {item["metric"]: item for item in report["metrics"]}

    def test_directions_denominators_and_separate_rates(self):
        values = self.metrics()
        self.assertEqual(values["Sales (Rs)"]["after"], Decimal("1200"))
        self.assertEqual(values["Average order value (AOV)"]["after"], Decimal("15"))
        self.assertEqual(values["Average order value (AOV)"]["verdict"], "Improved")
        self.assertEqual(values["Bad order rate"]["before"], Decimal("10"))
        self.assertEqual(values["Bad order rate"]["after"], Decimal("5"))
        self.assertEqual(values["Bad order rate"]["denominator"], "Delivered orders")
        self.assertEqual(values["Bad order rate"]["verdict"], "Improved")
        self.assertEqual(values["Repeat user orders share of placed orders"]["denominator"], "Placed Orders")
        self.assertEqual(values["FOR accuracy (%)"]["verdict"], "Declined")
        self.assertEqual(values["Poor rated orders"]["verdict"], "Declined")
        self.assertEqual(values["Poor-rated share"]["verdict"], "Improved")
        self.assertEqual(values["Online %"]["verdict"], "Declined")
        self.assertEqual(values["KPT (in minutes)"]["verdict"], "Improved")
        self.assertEqual(values["KPT+10 delayed orders"]["verdict"], "Declined")
        self.assertEqual(values["Orders with offers"]["direction"], "ambiguous")
        self.assertIsNone(values["Offline time (in hours)"]["change_pct"])
        self.assertEqual(values["Offline time (in hours)"]["verdict"], "Declined")
        self.assertNotEqual(values["Ads ROI"]["after"], values["Derived ad-sales/spend ROAS"]["after"])
        self.assertEqual(values["Derived ad-sales/spend ROAS"]["after"], Decimal("7.5"))

    def test_two_copies_do_not_conflict(self):
        with tempfile.TemporaryDirectory() as folder:
            first = write_csv(Path(folder))
            second = Path(folder) / "copy.csv"
            second.write_bytes(first.read_bytes())
            report = monthly.analyze([first, second], BEFORE, AFTER, OUTLET)
        self.assertEqual(self.metrics(report)["Delivered orders"]["after"], Decimal("80"))

    def test_missing_metric_fails(self):
        rows = [row for row in self.rows if len(row) < 6 or row[5] != "Bad orders"]
        with self.assertRaises(ValueError):
            self.analyze(rows)

    def test_duplicate_conflict_fails(self):
        clash = self.rows[1].copy()
        clash[-1] = "99"
        with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
            self.analyze(self.rows + [clash])

    def test_customer_denominator_mismatch_fails(self):
        rows = [row.copy() for row in self.rows]
        next(row for row in rows if len(row) > 5 and row[5] == "Placed Orders")[-1] = "1"
        with self.assertRaisesRegex(ValueError, "Customer-segment"):
            self.analyze(rows)

    def test_zero_denominator_fails(self):
        rows = [row.copy() for row in self.rows]
        next(row for row in rows if len(row) > 5 and row[5] == "Delivered orders")[-1] = "0"
        with self.assertRaisesRegex(ValueError, "Zero denominator"):
            self.analyze(rows)

    def test_wrong_outlet_fails(self):
        with self.assertRaises(ValueError):
            self.analyze(outlet="999")

    def test_missing_month_fails(self):
        rows = [row.copy() for row in self.rows]
        rows[0] = rows[0].copy()
        rows[0][-1] = "May 2026"
        with self.assertRaises(ValueError):
            self.analyze(rows)

    def test_nonfinite_fails(self):
        rows = [row.copy() for row in self.rows]
        rows[1] = rows[1].copy()
        rows[1][-1] = "NaN"
        with self.assertRaisesRegex(ValueError, "Non-finite"):
            self.analyze(rows)

    def test_xlsx_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.xlsx"
            monthly.write_xlsx(source, [("Report", self.rows)])
            from_sheet = monthly.analyze([source], BEFORE, AFTER, OUTLET)
            from_csv = self.analyze()
            self.assertEqual(from_sheet["metrics"], from_csv["metrics"])
            dest = Path(folder) / "analysis.xlsx"
            monthly.write_xlsx(
                dest,
                [("Analysis", [[item["metric"], item["after"], item["verdict"]] for item in from_sheet["metrics"]])],
            )
            with zipfile.ZipFile(dest) as archive:
                self.assertIsNone(archive.testzip())
            self.assertEqual(len(monthly.read_rows(dest)), len(from_sheet["metrics"]))


if __name__ == "__main__":
    unittest.main()
