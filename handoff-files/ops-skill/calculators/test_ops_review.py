"""Unit tests for the weekly ops review calculator. Synthetic data only."""
from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

import ops_review as m

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
IST = ZoneInfo("Asia/Kolkata")


def zomato_week(**overrides):
    base = {
        "sales": "100000.00",
        "delivered_orders": 200,
        "aov": "500.00",
        "rating": "4.20",
        "bad_orders_pct": "5.00",
        "rejected": 2,
        "delayed": 4,
        "poor_rated": 3,
        "bad_order_complaints": 1,
        "complaints": 2,
        "lost_sales": "800.00",
        "online_pct": "95.00",
        "kpt_minutes": "14.0",
    }
    base.update(overrides)
    return base


def swiggy_week(**overrides):
    base = {
        "sales": "120000.00",
        "delivered_orders": 240,
        "aov": "500.00",
        "cancelled_orders": 4,
        "cancelled_order_loss": "900.00",
        "poor_rated_orders": 3,
        "complaints": 1,
        "online_pct": "96.00",
        "kpt_minutes": "13.5",
        "food_ready_accuracy": "94.00",
        "delayed_orders": 10,
    }
    base.update(overrides)
    return base


def weeks(this=("2026-11-02", "2026-11-08"), last=("2026-10-26", "2026-11-01")):
    return {
        "this_week": {"start": this[0], "end": this[1]},
        "last_week": {"start": last[0], "end": last[1]},
    }


def reading(platform, outlet_id, name, area, this, last, notes=None):
    return {
        "platform": platform,
        "outlet_id": outlet_id,
        "outlet_name": name,
        "area": area,
        "this_week": this,
        "last_week": last,
        "notes": notes or [],
    }


def payload(readings, today="2026-11-10", extra_weeks=None):
    return {
        "weeks": extra_weeks or weeks(),
        "readings": readings,
    }


def write_map(tmp_path, rows):
    path = tmp_path / "outlet-map.csv"
    lines = ["outlet,locality,zomato_id,swiggy_rid"]
    for row in rows:
        # Use csv-safe quoting for localities with commas.
        locality = row[1]
        if "," in locality:
            locality = f'"{locality}"'
        lines.append(f"{row[0]},{locality},{row[2]},{row[3]}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def two_platform_kitchen(z_this=None, z_last=None, s_this=None, s_last=None, s_notes=None):
    return payload(
        [
            reading(
                "zomato",
                "10001",
                "Test Kitchen",
                "Example Area, City",
                zomato_week(**(z_this or {})),
                zomato_week(**(z_last or {})),
            ),
            reading(
                "swiggy",
                "20002",
                "Test Kitchen",
                "Example Area, City",
                swiggy_week(**(s_this or {})),
                swiggy_week(**(s_last or {})),
                notes=s_notes,
            ),
        ]
    )


def build(data, tmp_path=None, map_rows=None, today=date(2026, 11, 10)):
    rows = []
    if map_rows is not None:
        rows = m.load_outlet_map(write_map(tmp_path, map_rows))
    elif tmp_path is not None:
        rows = m.load_outlet_map(
            write_map(
                tmp_path,
                [("Test Kitchen", "Example Area, City", "10001", "20002")],
            )
        )
    return m.build_report(data, map_rows=rows, today=today)


# --- Week helpers ----------------------------------------------------------

def test_completed_weeks_on_tuesday_ist():
    today = date(2026, 11, 10)  # Tuesday
    this, last = m.completed_weeks(today)
    assert this == (date(2026, 11, 2), date(2026, 11, 8))
    assert last == (date(2026, 10, 26), date(2026, 11, 1))
    assert m.is_monday_to_sunday(*this)
    assert m.is_monday_to_sunday(*last)


def test_completed_weeks_on_monday_uses_previous_week():
    # Monday 9 Nov 2026: last completed week is still 2–8 Nov.
    this, last = m.completed_weeks(date(2026, 11, 9))
    assert this == (date(2026, 11, 2), date(2026, 11, 8))
    assert last == (date(2026, 10, 26), date(2026, 11, 1))


def test_completed_weeks_on_sunday_uses_week_that_just_ended():
    this, last = m.completed_weeks(date(2026, 11, 8))
    assert this == (date(2026, 10, 26), date(2026, 11, 1))
    assert last == (date(2026, 10, 19), date(2026, 10, 25))


def test_is_monday_to_sunday_rejects_sunday_saturday():
    assert not m.is_monday_to_sunday(date(2026, 11, 1), date(2026, 11, 7))


# --- Formatting ------------------------------------------------------------

def test_indian_rupee_grouping():
    assert m.rupee("205291.65") == "₹2,05,291.65"
    assert m.rupee("100000.00") == "₹1,00,000.00"
    assert m.rupee("999.50") == "₹999.50"
    assert m.rupee(None) == "n/a"
    assert m.rupee("-1200.00") == "-₹1,200.00"


def test_percent_change_zero_to_something_is_from_zero():
    change, display = m.percent_change(Decimal("50"), Decimal("0"))
    assert change is None
    assert display == "from 0"


def test_percent_change_zero_to_zero():
    change, display = m.percent_change(0, 0)
    assert change == Decimal("0.00")
    assert display == "0.00%"


def test_percent_change_missing_is_na():
    assert m.percent_change(None, 10) == (None, "n/a")
    assert m.percent_change(10, None) == (None, "n/a")


def test_percent_change_ordinary():
    change, display = m.percent_change(Decimal("85"), Decimal("100"))
    assert change == Decimal("-15.00")
    assert display == "-15.00%"
    change, display = m.percent_change(Decimal("112.5"), Decimal("100"))
    assert display == "+12.50%"


# --- Flags and status ------------------------------------------------------

def test_green_when_no_flags(tmp_path):
    report = build(two_platform_kitchen(), tmp_path)
    assert report["outlet_count"] == 1
    card = report["cards"][0]
    assert card["status"] == m.STATUS_GREEN
    assert card["flags"] == []
    assert card["fixes"] == []
    assert "Fixes: None needed this week." in card["card"]
    assert card["total_sales"] == "220000.00"
    assert card["total_orders"] == 440
    assert card["total_sales_change"] == "0.00%"
    assert "This outlet is on" not in card["card"]


def test_sales_down_more_than_15_flags(tmp_path):
    # Combined last week 220000; this week must fall by more than 15%.
    # 220000 * 0.849 = 186780, so 186779.00 is just over 15%.
    data = two_platform_kitchen(z_this={"sales": "86779.00"}, s_this={"sales": "100000.00"})
    card = build(data, tmp_path)["cards"][0]
    codes = [f["code"] for f in card["flags"]]
    assert "sales_down" in codes
    assert card["status"] == m.STATUS_YELLOW


def test_sales_down_exactly_15_does_not_flag(tmp_path):
    # 220000 * 0.85 = 187000 exactly → -15.00%, skill says >15%.
    data = two_platform_kitchen(z_this={"sales": "87000.00"}, s_this={"sales": "100000.00"})
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "sales_down" for f in card["flags"])
    _, display = m.percent_change(Decimal("187000.00"), Decimal("220000.00"))
    assert display == "-15.00%"


def test_sales_down_uses_combined_not_one_platform(tmp_path):
    # Zomato drops 20%, Swiggy rises enough that combined stays within 15%.
    data = two_platform_kitchen(
        z_this={"sales": "80000.00"},  # -20%
        s_this={"sales": "130000.00"},  # +8.33%; combined 210000 / 220000 = -4.55%
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "sales_down" for f in card["flags"])
    assert card["status"] == m.STATUS_GREEN


def test_zomato_bad_orders_high_and_rising(tmp_path):
    data = two_platform_kitchen(
        z_this={"bad_orders_pct": "8.50"},
        z_last={"bad_orders_pct": "8.10"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert any(f["code"] == "zomato_bad_orders" for f in card["flags"])
    assert card["status"] == m.STATUS_YELLOW


def test_zomato_bad_orders_high_but_falling_does_not_flag(tmp_path):
    data = two_platform_kitchen(
        z_this={"bad_orders_pct": "8.50"},
        z_last={"bad_orders_pct": "9.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "zomato_bad_orders" for f in card["flags"])


def test_zomato_bad_orders_exactly_8_does_not_flag(tmp_path):
    data = two_platform_kitchen(
        z_this={"bad_orders_pct": "8.00"},
        z_last={"bad_orders_pct": "7.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "zomato_bad_orders" for f in card["flags"])


def test_swiggy_delayed_high_and_rising(tmp_path):
    # 24 delayed / 240 delivered = 10% this week; last week 12/240 = 5%.
    data = two_platform_kitchen(
        s_this={"delayed_orders": 24, "delivered_orders": 240},
        s_last={"delayed_orders": 12, "delivered_orders": 240},
    )
    card = build(data, tmp_path)["cards"][0]
    assert any(f["code"] == "swiggy_delayed" for f in card["flags"])


def test_swiggy_delayed_high_but_not_rising(tmp_path):
    data = two_platform_kitchen(
        s_this={"delayed_orders": 24, "delivered_orders": 240},
        s_last={"delayed_orders": 30, "delivered_orders": 240},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "swiggy_delayed" for f in card["flags"])


def test_swiggy_delayed_uses_rate_not_raw_count(tmp_path):
    # Count rises 10 → 15 but volume also rises, rate falls 10/100=10% to 15/200=7.5%.
    data = two_platform_kitchen(
        s_this={"delayed_orders": 15, "delivered_orders": 200},
        s_last={"delayed_orders": 10, "delivered_orders": 100},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "swiggy_delayed" for f in card["flags"])


def test_kpt_high_and_rising_is_per_platform(tmp_path):
    data = two_platform_kitchen(
        z_this={"kpt_minutes": "16.5"},
        z_last={"kpt_minutes": "16.2"},
        s_this={"kpt_minutes": "16.8"},
        s_last={"kpt_minutes": "16.1"},
    )
    card = build(data, tmp_path)["cards"][0]
    codes = [f["code"] for f in card["flags"]]
    assert "zomato_kpt" in codes
    assert "swiggy_kpt" in codes
    # Two KPT flags share one fix line.
    assert card["fix_keys"] == ["kpt"]


def test_kpt_high_but_falling_does_not_flag(tmp_path):
    data = two_platform_kitchen(
        z_this={"kpt_minutes": "17.0"},
        z_last={"kpt_minutes": "18.0"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all("kpt" not in f["code"] for f in card["flags"])


def test_online_low_and_falling(tmp_path):
    data = two_platform_kitchen(
        s_this={"online_pct": "88.00"},
        s_last={"online_pct": "91.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert any(f["code"] == "swiggy_online" for f in card["flags"])


def test_online_low_but_rising_does_not_flag(tmp_path):
    data = two_platform_kitchen(
        s_this={"online_pct": "88.00"},
        s_last={"online_pct": "85.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "swiggy_online" for f in card["flags"])


def test_rating_below_4_even_if_rising(tmp_path):
    data = two_platform_kitchen(
        z_this={"rating": "3.90"},
        z_last={"rating": "3.70"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert any(f["code"] == "rating" for f in card["flags"])
    assert "below 4.00" in card["flags"][0]["detail"]


def test_rating_falling_even_if_still_above_4(tmp_path):
    data = two_platform_kitchen(
        z_this={"rating": "4.10"},
        z_last={"rating": "4.20"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert any(f["code"] == "rating" for f in card["flags"])
    assert "falling" in card["flags"][0]["detail"]


def test_rating_exactly_4_and_flat_does_not_flag(tmp_path):
    data = two_platform_kitchen(
        z_this={"rating": "4.00"},
        z_last={"rating": "4.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "rating" for f in card["flags"])


def test_food_ready_accuracy_low_even_if_rising(tmp_path):
    data = two_platform_kitchen(
        s_this={"food_ready_accuracy": "89.99"},
        s_last={"food_ready_accuracy": "80.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert any(f["code"] == "food_ready_accuracy" for f in card["flags"])


def test_food_ready_accuracy_exactly_90_does_not_flag(tmp_path):
    data = two_platform_kitchen(
        s_this={"food_ready_accuracy": "90.00"},
        s_last={"food_ready_accuracy": "95.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "food_ready_accuracy" for f in card["flags"])


def test_three_flags_is_act_now(tmp_path):
    data = two_platform_kitchen(
        z_this={"sales": "50000.00", "bad_orders_pct": "9.00", "rating": "3.80"},
        z_last={"bad_orders_pct": "8.20", "rating": "4.10"},
        s_this={"sales": "50000.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert len(card["flags"]) >= 3
    assert card["status"] == m.STATUS_RED
    assert len(card["fixes"]) == 2
    assert card["fix_keys"][0] == "sales_down"


def test_zero_orders_after_a_week_with_orders_is_act_now(tmp_path):
    data = two_platform_kitchen(
        z_this={"sales": "0.00", "delivered_orders": 0, "lost_sales": "0.00", "bad_orders_pct": "0.00"},
        s_this={
            "sales": "0.00",
            "delivered_orders": 0,
            "delayed_orders": 0,
            "cancelled_orders": 0,
            "cancelled_order_loss": "0.00",
            "poor_rated_orders": 0,
        },
    )
    card = build(data, tmp_path)["cards"][0]
    codes = [f["code"] for f in card["flags"]]
    assert "zero_orders_after_activity" in codes
    assert "sales_down" in codes  # 100% drop also flags
    assert card["status"] == m.STATUS_RED
    assert "Confirm the outlet was meant to be open" in card["card"]


def test_zero_orders_after_zero_orders_does_not_trigger(tmp_path):
    empty_z = {"sales": "0.00", "delivered_orders": 0, "lost_sales": "0.00", "bad_orders_pct": "0.00"}
    empty_s = {
        "sales": "0.00",
        "delivered_orders": 0,
        "delayed_orders": 0,
        "cancelled_orders": 0,
        "cancelled_order_loss": "0.00",
        "poor_rated_orders": 0,
    }
    data = two_platform_kitchen(
        z_this=empty_z, z_last=empty_z, s_this=empty_s, s_last=empty_s
    )
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "zero_orders_after_activity" for f in card["flags"])
    assert all(f["code"] != "sales_down" for f in card["flags"])
    assert card["status"] == m.STATUS_GREEN


# --- Missing metrics, single platform, 0-to-something ----------------------

def test_missing_metric_is_na_and_does_not_guess_a_flag(tmp_path):
    z_this = zomato_week()
    del z_this["bad_orders_pct"]
    del z_this["rating"]
    data = two_platform_kitchen(z_this=z_this)
    # Override the this-week zomato reading after helper built defaults — redo manually.
    data["readings"][0]["this_week"] = z_this
    card = build(data, tmp_path)["cards"][0]
    assert "bad orders n/a" in card["card"]
    assert "rating n/a" in card["card"]
    assert all(f["code"] not in {"zomato_bad_orders", "rating"} for f in card["flags"])


def test_missing_prior_week_metric_cannot_confirm_rising(tmp_path):
    z_last = zomato_week()
    del z_last["bad_orders_pct"]
    data = two_platform_kitchen(z_this={"bad_orders_pct": "12.00"}, z_last=z_last)
    data["readings"][0]["last_week"] = z_last
    card = build(data, tmp_path)["cards"][0]
    assert all(f["code"] != "zomato_bad_orders" for f in card["flags"])
    assert "bad orders 12.00% (was n/a)" in card["card"]


def test_single_platform_zomato_only(tmp_path):
    data = payload(
        [
            reading(
                "zomato",
                "10001",
                "Z-Only Cafe",
                "North Side",
                zomato_week(),
                zomato_week(),
            )
        ]
    )
    card = build(data, tmp_path, map_rows=[("Z-Only Cafe", "North Side", "10001", "")])["cards"][0]
    assert card["single_platform"] is True
    assert card["platforms"] == ["Zomato"]
    assert "This outlet is on Zomato only." in card["card"]
    assert "Swiggy:" not in card["card"]
    assert card["total_sales"] == "100000.00"
    assert card["total_orders"] == 200


def test_single_platform_swiggy_only(tmp_path):
    data = payload(
        [
            reading(
                "swiggy",
                "20002",
                "S-Only Cafe",
                "South Side",
                swiggy_week(),
                swiggy_week(),
            )
        ]
    )
    card = build(data, tmp_path, map_rows=[("S-Only Cafe", "South Side", "", "20002")])["cards"][0]
    assert card["single_platform"] is True
    assert "This outlet is on Swiggy only." in card["card"]
    assert "Zomato:" not in card["card"]


def test_zero_to_something_change_on_card(tmp_path):
    data = two_platform_kitchen(
        z_this={"lost_sales": "500.00", "complaints": 4},
        z_last={"lost_sales": "0.00", "complaints": 0},
        s_this={"cancelled_orders": 5, "cancelled_order_loss": "100.00"},
        s_last={"cancelled_orders": 0, "cancelled_order_loss": "0.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert "lost sales ₹500.00 (from 0)" in card["card"]
    assert "complaints 4 (from 0)" in card["card"]
    assert "cancelled 5 (from 0)" in card["card"]
    # Must not invent a percentage such as +inf or a huge made-up figure.
    assert "+inf" not in card["card"].lower()
    assert "from 0" in card["card"]


def test_swiggy_lag_banner_is_noted(tmp_path):
    data = two_platform_kitchen(s_this={"lag_banner": True})
    # swiggy_week doesn't pass unknown keys into helper correctly if we only
    # put lag_banner in overrides — it should, because **overrides.
    card = build(data, tmp_path)["cards"][0]
    assert any("48-hour lag" in n for n in card["notes"])


def test_card_mentions_platform_na_gaps(tmp_path):
    card = build(two_platform_kitchen(), tmp_path)["cards"][0]
    assert "Zomato offline time and FOR accuracy are n/a" in card["card"]
    assert "Swiggy star rating, offline time and rejected count are n/a" in card["card"]


# --- Outlet map and name/area join ----------------------------------------

def test_owner_map_joins_confirmed_pair_without_uncertainty(tmp_path):
    # Different area labels, same mapped IDs — must still join, no uncertainty.
    data = payload(
        [
            reading("zomato", "10001", "Test Kitchen", "Area One", zomato_week(), zomato_week()),
            reading("swiggy", "20002", "Test Kitchen", "Area Two, Other Label", swiggy_week(), swiggy_week()),
        ]
    )
    report = build(
        data,
        tmp_path,
        map_rows=[("Test Kitchen", "Example Area, City", "10001", "20002")],
    )
    assert report["outlet_count"] == 1
    card = report["cards"][0]
    assert card["map_confirmed"] is True
    assert card["match_note"] is None
    assert "match uncertain" not in card["card"]
    assert card["area"] == "Example Area, City"
    assert "Zomato:" in card["card"] and "Swiggy:" in card["card"]


def test_unmapped_same_name_compatible_area_asks_for_confirmation(tmp_path):
    data = payload(
        [
            reading("zomato", "111", "Ridge Cafe", "Salt Lake, City", zomato_week(), zomato_week()),
            reading("swiggy", "222", "Ridge Cafe", "Salt Lake", swiggy_week(), swiggy_week()),
        ]
    )
    report = build(data, tmp_path, map_rows=[])
    assert report["outlet_count"] == 1
    card = report["cards"][0]
    assert card["map_confirmed"] is False
    assert card["match_note"] == "Matched by brand name and area; please confirm."


def test_unmapped_same_name_incompatible_area_stays_separate(tmp_path):
    data = payload(
        [
            reading("zomato", "111", "Ridge Cafe", "Elgin", zomato_week(), zomato_week()),
            reading("swiggy", "222", "Ridge Cafe", "South Kolkata", swiggy_week(), swiggy_week()),
        ]
    )
    report = build(data, tmp_path, map_rows=[])
    assert report["outlet_count"] == 2
    assert all(c["match_note"] == "match uncertain – please confirm" for c in report["cards"])
    assert {c["platforms"][0] for c in report["cards"]} == {"Zomato", "Swiggy"}


def test_similar_but_different_brand_is_not_merged(tmp_path):
    data = payload(
        [
            reading("zomato", "111", "Family Kitchen", "Lakeside", zomato_week(), zomato_week()),
            reading(
                "swiggy",
                "222",
                "The Thali Story by Family Kitchen",
                "Lakeside",
                swiggy_week(),
                swiggy_week(),
            ),
        ]
    )
    report = build(data, tmp_path, map_rows=[])
    assert report["outlet_count"] == 2
    names = {c["outlet"] for c in report["cards"]}
    assert "Family Kitchen" in names
    assert "The Thali Story by Family Kitchen" in names
    assert all(c["single_platform"] for c in report["cards"])


def test_duplicate_map_ids_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="duplicate zomato_id"):
        m.load_outlet_map(
            write_map(
                tmp_path,
                [
                    ("A", "One", "1", "10"),
                    ("B", "Two", "1", "11"),
                ],
            )
        )


# --- Card order, message, CLI ---------------------------------------------

def test_cards_are_ordered_red_then_yellow_then_green(tmp_path):
    data = payload(
        [
            reading("zomato", "1", "Green Place", "A", zomato_week(), zomato_week()),
            reading(
                "zomato",
                "2",
                "Yellow Place",
                "B",
                zomato_week(rating="4.10"),
                zomato_week(rating="4.30"),
            ),
            reading(
                "zomato",
                "3",
                "Red Place",
                "C",
                zomato_week(
                    sales="10000.00",
                    bad_orders_pct="12.00",
                    rating="3.50",
                    online_pct="80.00",
                    kpt_minutes="18.0",
                ),
                zomato_week(
                    sales="100000.00",
                    bad_orders_pct="8.50",
                    rating="4.20",
                    online_pct="95.00",
                    kpt_minutes="14.0",
                ),
            ),
        ]
    )
    report = build(data, tmp_path, map_rows=[])
    assert [c["outlet"] for c in report["cards"]] == ["Red Place", "Yellow Place", "Green Place"]
    assert report["status_order"] == [m.STATUS_RED, m.STATUS_YELLOW, m.STATUS_GREEN]
    # Message itself is in that order too.
    positions = [report["message"].index(name) for name in ("Red Place", "Yellow Place", "Green Place")]
    assert positions == sorted(positions)


def test_green_card_format_is_stable(tmp_path):
    report = build(two_platform_kitchen(), tmp_path)
    card = report["cards"][0]["card"]
    expected = """\
**Test Kitchen (Example Area, City) – Weekly Operations**
🟢 Good | Total sales ₹2,20,000.00 (0.00%), orders 440 (0.00%)
Zomato: sales ₹1,00,000.00 (0.00%), orders 200 (0.00%), bad orders 5.00% (was 5.00%); rejected 2, delayed 4, poor-rated 3, complaints 1, complaints 2 (0.00%), lost sales ₹800.00 (0.00%), online 95.00% (was 95.00%), KPT 14.0 min (was 14.0 min), rating 4.20 (was 4.20)
Swiggy: sales ₹1,20,000.00 (0.00%), orders 240 (0.00%), cancelled 4 (0.00%); loss ₹900.00, poor-rated 3 (0.00%), complaints 1 (0.00%), online 96.00% (was 96.00%), KPT 13.5 min (was 13.5 min), food-ready accuracy 94.00% (was 94.00%), delayed 10 (0.00%; 4.17% of delivered)
Notes: Zomato offline time and FOR accuracy are n/a (not on the Business reports screen). Swiggy star rating, offline time and rejected count are n/a (not on this reports screen).
Fixes: None needed this week."""
    assert card == expected
    assert report["message"].startswith("Weekly operations 2–8 Nov 2026 vs 26 Oct–1 Nov 2026 (Mon–Sun IST)\n")


def test_fixes_come_from_template_and_cap_at_two(tmp_path):
    data = two_platform_kitchen(
        z_this={"sales": "50000.00", "bad_orders_pct": "9.00", "rating": "3.80", "kpt_minutes": "18.0"},
        z_last={"bad_orders_pct": "8.20", "rating": "4.10", "kpt_minutes": "16.5"},
        s_this={"sales": "50000.00", "online_pct": "80.00", "food_ready_accuracy": "85.00"},
        s_last={"online_pct": "92.00"},
    )
    card = build(data, tmp_path)["cards"][0]
    assert len(card["flags"]) >= 3
    assert len(card["fixes"]) == 2
    assert set(card["fix_keys"]) <= set(m.FIX_TEMPLATES)
    assert card["fix_keys"] == ["sales_down", "zomato_bad_orders"]
    for line in card["fixes"]:
        assert line in m.FIX_TEMPLATES.values()


def test_cli_writes_owner_message_and_json(tmp_path):
    source = tmp_path / "readings.json"
    source.write_text(json.dumps(two_platform_kitchen()), encoding="utf-8")
    map_path = write_map(tmp_path, [("Test Kitchen", "Example Area, City", "10001", "20002")])
    out = tmp_path / "out"
    assert m.main([str(source), "--outlet-map", str(map_path), "--out", str(out), "--today", "2026-11-10"]) == 0
    message = (out / "owner-message.md").read_text(encoding="utf-8")
    data = json.loads((out / "ops-review.json").read_text(encoding="utf-8"))
    assert "Weekly operations 2–8 Nov 2026" in message
    assert data["cards"][0]["status"] == m.STATUS_GREEN
    assert data["thresholds"]["sales_drop_pct"] == "15"


def test_non_monday_sunday_week_is_noted_but_still_calculated(tmp_path):
    data = two_platform_kitchen()
    data["weeks"] = weeks(this=("2026-11-01", "2026-11-07"), last=("2026-10-25", "2026-10-31"))
    report = build(data, tmp_path)
    assert any("not a Monday–Sunday IST week" in n for n in report["cards"][0]["notes"])
    assert report["cards"][0]["total_orders"] == 440


def test_swiggy_delayed_rate_undefined_when_zero_delivered(tmp_path):
    data = two_platform_kitchen(
        s_this={"delivered_orders": 0, "delayed_orders": 0, "sales": "0.00"},
        # Zomato still has orders, so not a zero-orders-after-activity case.
    )
    card = build(data, tmp_path)["cards"][0]
    assert "delayed 0 (-100.00%; rate n/a)" in card["card"]
    assert all(f["code"] != "swiggy_delayed" for f in card["flags"])
