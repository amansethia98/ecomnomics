import importlib.machinery
import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "agent-v1-post"
loader = importlib.machinery.SourceFileLoader("agent_v1_post", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
agent = importlib.util.module_from_spec(spec)
loader.exec_module(agent)


class AgentV1PostTest(unittest.TestCase):
    def test_paise_rounds_half_up_and_treats_blank_as_missing(self):
        self.assertIsNone(agent.paise(None))
        self.assertIsNone(agent.paise(""))
        self.assertIsNone(agent.paise("  "))
        self.assertEqual(agent.paise("0"), 0)
        self.assertEqual(agent.paise("1,234.50"), 123450)
        self.assertEqual(agent.paise("1,23,456.78"), 12345678)
        self.assertEqual(agent.paise("10.005"), 1001)
        self.assertEqual(agent.paise("0.004"), 0)
        self.assertEqual(agent.paise("-0.00"), 0)
        with self.assertRaises(ValueError) as raised:
            agent.paise("-40.00", "Net Payout")
        self.assertIn("Nothing sent", str(raised.exception))
        self.assertNotIn("4000", str(raised.exception))

    def test_outlet_match_is_one_platform_id(self):
        outlets = [
            {"outletId": "a", "zomato": {"resId": "111"}, "swiggy": None},
            {"outletId": "b", "zomato": None, "swiggy": {"rid": "222"}},
            {"outletId": "c", "zomato": {"resId": "333"}, "swiggy": {"rid": "333"}},
        ]
        self.assertEqual(agent.match_outlet(outlets, "zomato", "111"), "a")
        self.assertEqual(agent.match_outlet(outlets, "swiggy", 222), "b")
        self.assertEqual(agent.match_outlet(outlets, "swiggy", "333"), "c")
        with self.assertRaises(LookupError):
            agent.match_outlet(outlets, "zomato", "222")
        outlets.append({"outletId": "d", "zomato": {"resId": "111"}, "swiggy": None})
        with self.assertRaises(LookupError):
            agent.match_outlet(outlets, "zomato", "111")

    def test_calculator_rows_include_commission_and_repeat_posts_omit_started_at(self):
        result = {
            "outlet_id": "111",
            "period": ["2026-01-05", "2026-01-11"],
            "paid_match": True,
            "platform_net": "900",
            "rows": {
                "Orders": "3",
                "ST+PC": "1000.00",
                "Merchant Discount Burn": "10",
                "CV": "990",
                "Ads": "5",
                "Comm.+PG+GST": "80.50",
                "Net Payout": "904.50",
            },
        }
        values = agent.metric_values(result, {"paid_amount": "900.00"})
        self.assertEqual(values["commission_pg_gst_paise"], 8050)
        self.assertEqual(values["payout_orders"], 3)
        self.assertEqual(values["gross_sales_paise"], 100000)
        self.assertEqual(values["paid_amount_paise"], 90000)
        body, start, end = agent.metrics_body("run-1", "zomato", "outlet", result, {}, "2026-01-12T00:00:00.000Z")
        keys = [row["key"] for row in body["rows"]]
        self.assertIn("commission_pg_gst_paise", keys)
        self.assertEqual(start, "2026-01-05T00:00:00.000+05:30")
        self.assertEqual(end, "2026-01-12T00:00:00.000+05:30")
        self.assertTrue(all(row["granularity"] == "week_mon_sun" for row in body["rows"]))
        swiggy, _, _ = agent.metrics_body("run-1", "swiggy", "outlet", result, {}, "2026-01-12T00:00:00.000Z")
        self.assertTrue(all(row["granularity"] == "week_sun_sat" for row in swiggy["rows"]))
        started = agent.start_body("run-1", "zomato")
        self.assertIn("startedAt", started)
        finished = agent.finish_body("run-1", "zomato", "succeeded", outletId="outlet", error=None)
        failed = agent.finish_body("run-1", "swiggy", "failed", error="stopped")
        self.assertNotIn("startedAt", finished)
        self.assertNotIn("startedAt", failed)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(failed["skill"], "payout-swiggy")

    def test_negative_net_payout_is_not_stored_as_a_credit(self):
        result = {
            "rows": {
                "Orders": "1",
                "ST+PC": "100",
                "Merchant Discount Burn": "0",
                "CV": "100",
                "Ads": "120",
                "Comm.+PG+GST": "20",
                "Net Payout": "-40.00",
            }
        }
        with self.assertRaises(ValueError) as raised:
            agent.metric_values(result, {})
        message = str(raised.exception)
        self.assertIn("Net Payout", message)
        self.assertIn("Nothing sent", message)
        self.assertNotIn("4000", message)

    def test_printed_errors_drop_the_token(self):
        previous = agent.TOKEN
        agent.TOKEN = "test-token"
        try:
            self.assertEqual(agent.redact("bearer test-token end"), "bearer [redacted] end")
            self.assertNotIn("test-token", agent.redact("test-token"))
        finally:
            agent.TOKEN = previous
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("ecom_agent_", source)
