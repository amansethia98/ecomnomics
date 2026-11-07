#!/usr/bin/env python3
"""The settlement reconciler reads columns by name and ignores broken summary cells."""

import csv
import importlib.machinery
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).parent
loader = importlib.machinery.SourceFileLoader("zomato_reconcile", str(HERE / "rakazo-zomato-reconcile"))
helper = loader.load_module()

HEADER = [
    "S.No.", "Order ID", "Res. name", "Res. ID",
    "Order status (Delivered/ Cancelled/ Rejected)",
    "Subtotal (items total)", "Packaging charge", "Restaurant discount [Promo]",
    "Restaurant Discount [BOGO, Freebies, Gold, Brand pack & others]",
    "Total GST collected from customers",
    "Net order value\n[(1) + (2) + (3) - (4) - (5) + (6) - (7) + (8)]",
    "Service fee & payment mechanism fees\n[(11) + (12)]",
    "Taxes on service & payment mechanism fees\n(B) * 18%",
    "Government charges\n[(13) + (16) + (17) + (18) + (19)]",
    "Other order-level deductions\n[(21) + (22) + (23)]",
    "Net Deductions\n(B) + (C) + (D)",
    "Net Additions \n(cancellation refund)",
    "Order level Payout\n(A) - (E) + (F)",
    "Settlement status", "Settlement date", "Bank UTR", "Unsettled Amount",
]


def order(identity, status, payout, **extra):
    net_order = Decimal(extra.get("net_order", "100"))
    deductions = Decimal(extra.get("net_deductions", "20"))
    additions = Decimal(extra.get("net_additions", "0"))
    row = {
        "Order ID": identity,
        "Res. name": extra.get("name", "North Kitchen"),
        "Res. ID": extra.get("rid", "42"),
        "Order status (Delivered/ Cancelled/ Rejected)": status,
        "Subtotal (items total)": extra.get("subtotal", "80"),
        "Packaging charge": extra.get("packaging", "10"),
        "Restaurant discount [Promo]": extra.get("promo", "5"),
        "Restaurant Discount [BOGO, Freebies, Gold, Brand pack & others]": extra.get("other_discount", "2"),
        "Total GST collected from customers": extra.get("gst", "8"),
        "Net order value\n[(1) + (2) + (3) - (4) - (5) + (6) - (7) + (8)]": str(net_order),
        "Service fee & payment mechanism fees\n[(11) + (12)]": extra.get("fees", "15"),
        "Taxes on service & payment mechanism fees\n(B) * 18%": extra.get("tax", "2"),
        "Government charges\n[(13) + (16) + (17) + (18) + (19)]": extra.get("government", "3"),
        "Other order-level deductions\n[(21) + (22) + (23)]": extra.get("other", "0"),
        "Net Deductions\n(B) + (C) + (D)": str(deductions),
        "Net Additions \n(cancellation refund)": str(additions),
        "Order level Payout\n(A) - (E) + (F)": str(payout),
        "Settlement status": extra.get("settlement", "settled"),
        "Settlement date": extra.get("settled_on", "2026-11-04 05:30:00"),
        "Bank UTR": extra.get("utr", "BANKUTR1,"),
        "Unsettled Amount": extra.get("unsettled", "0"),
    }
    return [row.get(name, "") for name in HEADER]


def workbook(**overrides):
    delivered = order("1001", "DELIVERED", "80", net_order="100", net_deductions="20")
    cancelled = order("1002", "CANCELLED", "0", net_order="40", net_deductions="10", subtotal="40",
                      packaging="0", promo="0", other_discount="0", gst="0", fees="0", tax="0", government="0")
    pending = order("1003", "DELIVERED", "10", net_order="10", net_deductions="0", settlement="pending",
                    unsettled="10", subtotal="10", packaging="0", promo="0", other_discount="0", gst="0",
                    fees="0", tax="0", government="0")
    sheets = {
        "Summary": [
            ["", "Report Summary"],
            ["", "Pay-out cycle", "#REF!"],
            ["", "Bank UTR", "#REF!"],
            ["", "Res Name", "#REF!"],
        ],
        "HSummary": [["", "26 Oct 2026 - 01 Nov 2026"]],
        "Payout Breakup": [
            ["", "Payout Breakup"],
            ["", "S.No.", "Particular", "Total"],
            ["", "I", "Net Payout ( A - B - C )", overrides.get("net", 0)],
        ],
        "Order Level": [
            ["Order level Breakup"],
            ["A section title, not the header"],
            HEADER,
            ["#REF!", "#REF!", "#REF!"],
            delivered,
            cancelled,
            pending,
        ],
        "Addition Deductions Details": [
            ["Addition/ Deduction Details"],
            ["A) Investments in growth services"],
            ["Type", "Adjusted amount", "Outstanding amount"],
            ["ADS", 8, 0],
            ["ADS", 4, "1.5"],
            ["Total Ads & miscellaneous services", 12, "1.5"],
            ["B) Investments in Hyperpure"],
            ["Type", "Adjusted amount", "Outstanding amount"],
            ["Total Hyperpure", 0, 0],
        ],
    }
    return sheets


class ReconcileTest(unittest.TestCase):
    def test_a_header_below_the_title_and_a_ref_row_still_reconcile(self):
        report = helper.reconcile(workbook())
        self.assertEqual(report["orders"], 3)
        self.assertEqual(report["delivered"], 2)
        self.assertEqual(report["cancelled"], 1)
        # 80 + 0 + 10, minus the 12 of ads. The breakup total is the broken 0, so it is not the net.
        self.assertEqual(report["order_payouts"], Decimal("90.00"))
        self.assertEqual(report["ads"], Decimal("12.00"))
        self.assertEqual(report["net_payout"], Decimal("78.00"))
        self.assertEqual(report["check"], Decimal("0.00"))
        self.assertEqual(report["unsettled"], 1)
        values = {row[1]: row[2] for row in report["rows"]}
        self.assertEqual(values["Outlet"], "North Kitchen (ID 42)")
        self.assertEqual(values["Payout cycle"], "26 Oct 2026 - 01 Nov 2026")
        self.assertEqual(values["Settlement date"], "04 Nov 2026")
        self.assertEqual(values["UTR"], "BANKUTR1")
        self.assertEqual(values["DELIVERED"], "2 orders, payout 90.00")
        self.assertIn("1002 got 0.00", values["Cancelled or rejected orders"])
        self.assertEqual(values["Unsettled orders"], "1")
        self.assertEqual(values["Mismatched delivered orders"], "0")
        self.assertEqual(values["Outstanding for a later payout"], "1.50")
        self.assertIn("Unsettled 1003", [row[1] for row in report["rows"]])
        self.assertIn("Check 0.00", report["summary"])

    def test_a_real_breakup_total_is_what_the_check_compares(self):
        report = helper.reconcile(workbook(net=70))
        self.assertEqual(report["net_payout"], Decimal("70.00"))
        self.assertEqual(report["check"], Decimal("8.00"))

    def test_the_command_writes_the_csv_and_xlsx_beside_the_workbook(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "settlement.xlsx"
            helper.write_workbook(str(source), workbook())
            self.assertEqual(helper.main([str(source)]), 0)
            csv_path = Path(folder) / "settlement-reconciliation.csv"
            xlsx_path = Path(folder) / "settlement-reconciliation.xlsx"
            self.assertTrue(csv_path.is_file())
            self.assertTrue(xlsx_path.is_file())
            with csv_path.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.reader(handle))
            self.assertEqual(rows[0], ["Section", "Item", "Value"])
            self.assertIn(["Header", "Orders in report", "3"], rows)
            loaded = helper.load_workbook(str(xlsx_path))
            self.assertEqual(loaded["Reconciliation"][0][:3], ["Section", "Item", "Value"])
            self.assertIn("78.00", {row[2] for row in loaded["Reconciliation"] if len(row) > 2})

    def test_a_workbook_without_an_order_sheet_fails_clearly(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "empty.xlsx"
            helper.write_workbook(str(source), {"Summary": [["Pay-out cycle", "#REF!"]]})
            self.assertEqual(helper.main([str(source)]), 1)


if __name__ == "__main__":
    unittest.main()
