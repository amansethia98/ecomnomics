#!/usr/bin/env python3
"""Deterministic weekly operations review calculator.

Takes screen-read values as JSON for last week and the week before, on
Zomato and/or Swiggy. Computes percentage changes, applies the skill's
flag rules, assigns a status, and renders one owner card per outlet.

All money and rate maths use Decimal. The script never guesses a missing
metric: it prints n/a and does not raise a flag that needs that value.

No network, browser or model calls. Restaurant-specific live readings
do not belong in this file.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_EVEN
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
TWOPLACES = Decimal("0.01")
ONEPLACE = Decimal("0.1")

# Precise definitions for the skill's flag rules. Listed for owner confirmation
# in THRESHOLDS.md. A flag that says "and rising/falling" is raised only when
# both this week and last week are present, so a missing prior value is not a
# guess. ">" and "<" are strict. Equal to the threshold is not a flag.
THRESHOLDS = {
    "sales_drop_pct": Decimal("15"),  # combined sales down by more than 15.00%
    "zomato_bad_orders_pct": Decimal("8"),  # bad orders % > 8.00 and rising
    "swiggy_delayed_pct": Decimal("8"),  # delayed/delivered > 8.00% and rising
    "kpt_minutes": Decimal("16"),  # KPT > 16.0 min and rising, per platform
    "online_pct": Decimal("90"),  # online % < 90.00 and falling, per platform
    "rating_low": Decimal("4.00"),  # rating < 4.00 (even if rising) or falling
    "food_ready_accuracy_pct": Decimal("90"),  # MFR < 90.00 is low (no 'falling' required)
}

# Status: 3+ flags, or zero orders after a week that had orders = Act now;
# 1–2 flags = Needs attention; none = Good.
STATUS_RED = "🔴 Act now"
STATUS_YELLOW = "🟡 Needs attention"
STATUS_GREEN = "🟢 Good"
STATUS_RANK = {STATUS_RED: 0, STATUS_YELLOW: 1, STATUS_GREEN: 2}

# One-line fixes, chosen from this fixed list only, tied to the flags that
# fired. At most two. Shared kitchen issues (KPT on both apps) use one line.
FIX_TEMPLATES = {
    "zero_orders_after_activity": (
        "Confirm the outlet was meant to be open and that no platform or payment issue blocked orders."
    ),
    "sales_down": (
        "Check menu visibility, item out-of-stocks, and whether a discount or ad campaign ended last week."
    ),
    "zomato_bad_orders": (
        "Review rejected, delayed, poor-rated and complaint orders on Zomato; tighten acceptance and prep so food goes out on time."
    ),
    "swiggy_delayed": (
        "Start prep on accept and mark food ready only when it is actually ready, so Swiggy delayed (>10 min) orders fall."
    ),
    "rating": (
        "Follow up on poor-rated and complaint orders and fix the repeating item or packaging issue."
    ),
    "kpt": (
        "Reduce kitchen preparation time by staging high-selling items and assigning a runner at peak hours."
    ),
    "online": (
        "Keep the outlet online during promised hours; investigate long offline stretches before the next rush."
    ),
    "food_ready_accuracy": (
        "Mark food ready only when the order is packed, so food-ready accuracy (MFR) stays reliable."
    ),
}

FIX_PRIORITY = [
    "zero_orders_after_activity",
    "sales_down",
    "zomato_bad_orders",
    "swiggy_delayed",
    "rating",
    "kpt",
    "online",
    "food_ready_accuracy",
]


def q(value, places=TWOPLACES):
    if value is None or value == "":
        return None
    return Decimal(str(value)).quantize(places, rounding=ROUND_HALF_EVEN)


def q_money(value):
    return q(value, TWOPLACES)


def q_pct(value):
    return q(value, TWOPLACES)


def q_kpt(value):
    return q(value, ONEPLACE)


def q_rating(value):
    return q(value, TWOPLACES)


def as_int(value):
    if value is None or value == "":
        return None
    return int(Decimal(str(value)))


def rupee(value):
    if value is None:
        return "n/a"
    amount = q_money(value)
    text = f"{amount:.2f}"
    negative = text.startswith("-")
    text = text.lstrip("-")
    whole, cents = text.split(".")
    tail = whole[-3:]
    head = whole[:-3]
    groups = []
    while head:
        groups.insert(0, head[-2:])
        head = head[:-2]
    grouped = ",".join(groups + [tail]) if groups else tail
    return f"{'-' if negative else ''}₹{grouped}.{cents}"


def fmt_pct_points(value):
    if value is None:
        return "n/a"
    return f"{q_pct(value):.2f}%"


def fmt_kpt(value):
    if value is None:
        return "n/a"
    return f"{q_kpt(value):.1f} min"


def fmt_rating(value):
    if value is None:
        return "n/a"
    return f"{q_rating(value):.2f}"


def fmt_count(value):
    if value is None:
        return "n/a"
    return str(as_int(value))


def percent_change(this, last):
    """Return (quantized percent, display). last=0 and this>0 is 'from 0', not a huge %."""
    if this is None or last is None:
        return None, "n/a"
    this = Decimal(str(this))
    last = Decimal(str(last))
    if last == 0 and this == 0:
        return Decimal("0.00"), "0.00%"
    if last == 0:
        return None, "from 0"
    change = (this - last) / last * 100
    change = q_pct(change)
    if change == 0:
        return change, "0.00%"
    sign = "+" if change > 0 else ""
    return change, f"{sign}{change:.2f}%"


def delayed_rate(delayed, delivered):
    if delayed is None or delivered is None or delivered == 0:
        return None
    return q_pct(Decimal(str(delayed)) / Decimal(str(delivered)) * 100)


def completed_weeks(today=None):
    """Last completed Monday–Sunday IST week, and the week before it."""
    if today is None:
        today = datetime.now(IST).date()
    elif isinstance(today, datetime):
        today = today.astimezone(IST).date()
    # Sunday of the most recently completed Mon–Sun week.
    end = today - timedelta(days=today.weekday() + 1)
    start = end - timedelta(days=6)
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=6)
    return (start, end), (prev_start, prev_end)


def is_monday_to_sunday(start, end):
    if start is None or end is None:
        return False
    return start.weekday() == 0 and end.weekday() == 6 and (end - start).days == 6


def parse_iso_date(value):
    if value is None or value == "":
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    text = str(value).strip()
    return date.fromisoformat(text[:10])


def fmt_day(d):
    return f"{d.day} {d.strftime('%b')} {d.year}"


def fmt_span(start, end):
    if start is None or end is None:
        return "n/a"
    if start.year == end.year and start.month == end.month:
        return f"{start.day}–{end.day} {start.strftime('%b')} {start.year}"
    if start.year == end.year:
        return f"{start.day} {start.strftime('%b')}–{end.day} {end.strftime('%b')} {end.year}"
    return f"{fmt_day(start)}–{fmt_day(end)}"


def norm_text(value):
    return re.sub(r"\s+", " ", (value or "").strip().casefold())


def areas_compatible(a, b):
    na, nb = norm_text(a), norm_text(b)
    if not na or not nb:
        return False
    return na == nb or na in nb or nb in na


@dataclass
class WeekValues:
    sales: Decimal | None = None
    delivered_orders: int | None = None
    aov: Decimal | None = None
    complaints: int | None = None
    online_pct: Decimal | None = None
    kpt_minutes: Decimal | None = None
    rating: Decimal | None = None
    bad_orders_pct: Decimal | None = None
    rejected: int | None = None
    delayed: int | None = None
    poor_rated: int | None = None
    bad_order_complaints: int | None = None
    lost_sales: Decimal | None = None
    offline_time: Decimal | str | None = None
    for_accuracy: Decimal | None = None
    cancelled_orders: int | None = None
    cancelled_order_loss: Decimal | None = None
    poor_rated_orders: int | None = None
    food_ready_accuracy: Decimal | None = None
    delayed_orders: int | None = None
    lag_banner: bool = False
    raw_missing: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, data, platform):
        data = data or {}
        money = ("sales", "aov", "lost_sales", "cancelled_order_loss")
        pcts = ("online_pct", "bad_orders_pct", "for_accuracy", "food_ready_accuracy")
        ints = (
            "delivered_orders",
            "complaints",
            "rejected",
            "delayed",
            "poor_rated",
            "bad_order_complaints",
            "cancelled_orders",
            "poor_rated_orders",
            "delayed_orders",
        )
        values = {}
        for key in money:
            values[key] = q_money(data[key]) if key in data else None
        for key in pcts:
            values[key] = q_pct(data[key]) if key in data else None
        for key in ints:
            values[key] = as_int(data[key]) if key in data else None
        values["kpt_minutes"] = q_kpt(data["kpt_minutes"]) if "kpt_minutes" in data else None
        values["rating"] = q_rating(data["rating"]) if "rating" in data else None
        offline = data.get("offline_time")
        values["offline_time"] = offline if offline not in (None, "") else None
        values["lag_banner"] = bool(data.get("lag_banner") or data.get("this_week_lag_banner"))
        missing = []
        if platform == "zomato":
            for key in (
                "sales",
                "delivered_orders",
                "bad_orders_pct",
                "complaints",
                "lost_sales",
                "online_pct",
                "kpt_minutes",
                "rating",
            ):
                if values[key] is None:
                    missing.append(f"zomato.{key}")
            # Skill: these two are not on the Zomato screen.
            if values["offline_time"] is None:
                missing.append("zomato.offline_time")
            if values["for_accuracy"] is None:
                missing.append("zomato.for_accuracy")
        elif platform == "swiggy":
            for key in (
                "sales",
                "delivered_orders",
                "cancelled_orders",
                "poor_rated_orders",
                "complaints",
                "online_pct",
                "kpt_minutes",
                "food_ready_accuracy",
                "delayed_orders",
            ):
                if values[key] is None:
                    missing.append(f"swiggy.{key}")
            if values["rating"] is None:
                missing.append("swiggy.rating")
            if values["offline_time"] is None:
                missing.append("swiggy.offline_time")
            if values["rejected"] is None:
                missing.append("swiggy.rejected")
        values["raw_missing"] = missing
        return cls(**values)


@dataclass
class PlatformReading:
    platform: str
    outlet_id: str
    outlet_name: str
    area: str
    this_week: WeekValues
    last_week: WeekValues
    notes: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, data):
        platform = (data.get("platform") or "").strip().casefold()
        if platform not in {"zomato", "swiggy"}:
            raise ValueError(f"platform must be zomato or swiggy, got {data.get('platform')!r}")
        return cls(
            platform=platform,
            outlet_id=str(data.get("outlet_id") or "").strip(),
            outlet_name=(data.get("outlet_name") or "").strip(),
            area=(data.get("area") or "").strip(),
            this_week=WeekValues.from_dict(data.get("this_week"), platform),
            last_week=WeekValues.from_dict(data.get("last_week"), platform),
            notes=list(data.get("notes") or []),
        )


@dataclass
class MapRow:
    outlet: str
    locality: str
    zomato_id: str
    swiggy_rid: str
    confirmed: bool = True


def load_outlet_map(path):
    if path is None:
        return []
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"outlet map not found: {path}")
    rows = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        required = {"outlet", "locality", "zomato_id", "swiggy_rid"}
        if reader.fieldnames is None or required - set(reader.fieldnames):
            raise ValueError(
                "outlet map must have columns outlet,locality,zomato_id,swiggy_rid"
            )
        seen_z, seen_s = set(), set()
        for raw in reader:
            row = MapRow(
                outlet=(raw.get("outlet") or "").strip(),
                locality=(raw.get("locality") or "").strip(),
                zomato_id=str(raw.get("zomato_id") or "").strip(),
                swiggy_rid=str(raw.get("swiggy_rid") or "").strip(),
            )
            if not row.outlet:
                continue
            if row.zomato_id and row.zomato_id in seen_z:
                raise ValueError(f"duplicate zomato_id in outlet map: {row.zomato_id}")
            if row.swiggy_rid and row.swiggy_rid in seen_s:
                raise ValueError(f"duplicate swiggy_rid in outlet map: {row.swiggy_rid}")
            if row.zomato_id:
                seen_z.add(row.zomato_id)
            if row.swiggy_rid:
                seen_s.add(row.swiggy_rid)
            rows.append(row)
    return rows


def _flag(code, label, detail):
    return {"code": code, "label": label, "detail": detail, "fix_key": _fix_key(code)}


def _fix_key(code):
    if code in FIX_TEMPLATES:
        return code
    if code.endswith("_kpt"):
        return "kpt"
    if code.endswith("_online"):
        return "online"
    return code


def evaluate_flags(zomato, swiggy):
    """Return (flags, status, status_reason). zomato/swiggy may be None."""
    flags = []
    this_sales = []
    last_sales = []
    this_orders = []
    last_orders = []
    order_gap = False
    for reading in (zomato, swiggy):
        if reading is None:
            continue
        if reading.this_week.sales is not None:
            this_sales.append(reading.this_week.sales)
        if reading.last_week.sales is not None:
            last_sales.append(reading.last_week.sales)
        if reading.this_week.delivered_orders is None or reading.last_week.delivered_orders is None:
            order_gap = True
        else:
            this_orders.append(reading.this_week.delivered_orders)
            last_orders.append(reading.last_week.delivered_orders)

    total_this = sum(this_sales, Decimal("0")) if this_sales else None
    total_last = sum(last_sales, Decimal("0")) if last_sales else None
    sales_change, _ = percent_change(total_this, total_last)
    if sales_change is not None and sales_change < -THRESHOLDS["sales_drop_pct"]:
        flags.append(
            _flag(
                "sales_down",
                "sales down >15%",
                f"combined sales {rupee(total_this)} vs {rupee(total_last)} ({sales_change:.2f}%)",
            )
        )

    if zomato is not None:
        bad = zomato.this_week.bad_orders_pct
        prev = zomato.last_week.bad_orders_pct
        if bad is not None and prev is not None and bad > THRESHOLDS["zomato_bad_orders_pct"] and bad > prev:
            flags.append(
                _flag(
                    "zomato_bad_orders",
                    "Zomato bad orders >8% and rising",
                    f"{bad:.2f}% vs {prev:.2f}% last week",
                )
            )

    if swiggy is not None:
        rate = delayed_rate(swiggy.this_week.delayed_orders, swiggy.this_week.delivered_orders)
        prev_rate = delayed_rate(swiggy.last_week.delayed_orders, swiggy.last_week.delivered_orders)
        if (
            rate is not None
            and prev_rate is not None
            and rate > THRESHOLDS["swiggy_delayed_pct"]
            and rate > prev_rate
        ):
            flags.append(
                _flag(
                    "swiggy_delayed",
                    "Swiggy delayed orders high and rising",
                    f"{rate:.2f}% of delivered vs {prev_rate:.2f}% last week (threshold {THRESHOLDS['swiggy_delayed_pct']:.2f}%)",
                )
            )

    for reading, name in ((zomato, "zomato"), (swiggy, "swiggy")):
        if reading is None:
            continue
        kpt, prev = reading.this_week.kpt_minutes, reading.last_week.kpt_minutes
        if kpt is not None and prev is not None and kpt > THRESHOLDS["kpt_minutes"] and kpt > prev:
            flags.append(
                _flag(
                    f"{name}_kpt",
                    f"{name.title()} KPT >16 min and rising",
                    f"{kpt:.1f} min vs {prev:.1f} min last week",
                )
            )
        online, prev_o = reading.this_week.online_pct, reading.last_week.online_pct
        if (
            online is not None
            and prev_o is not None
            and online < THRESHOLDS["online_pct"]
            and online < prev_o
        ):
            flags.append(
                _flag(
                    f"{name}_online",
                    f"{name.title()} online % <90% and falling",
                    f"{online:.2f}% vs {prev_o:.2f}% last week",
                )
            )

    if zomato is not None:
        rating, prev_r = zomato.this_week.rating, zomato.last_week.rating
        low = rating is not None and rating < THRESHOLDS["rating_low"]
        falling = rating is not None and prev_r is not None and rating < prev_r
        if low or falling:
            if low and falling:
                reason = f"{rating:.2f}, below 4.00 and falling from {prev_r:.2f}"
            elif low:
                reason = f"{rating:.2f}, below 4.00"
            else:
                reason = f"{rating:.2f}, falling from {prev_r:.2f}"
            flags.append(_flag("rating", "rating <4.0 or falling", reason))

    if swiggy is not None:
        acc = swiggy.this_week.food_ready_accuracy
        if acc is not None and acc < THRESHOLDS["food_ready_accuracy_pct"]:
            flags.append(
                _flag(
                    "food_ready_accuracy",
                    "food-ready accuracy low",
                    f"{acc:.2f}% (low if below {THRESHOLDS['food_ready_accuracy_pct']:.2f}%)",
                )
            )

    zero_orders = (
        not order_gap
        and this_orders
        and last_orders
        and sum(this_orders) == 0
        and sum(last_orders) > 0
    )
    if zero_orders:
        flags.append(
            _flag(
                "zero_orders_after_activity",
                "zero orders after a week with orders",
                f"this week 0 orders after last week {sum(last_orders)}",
            )
        )

    if zero_orders or len(flags) >= 3:
        status = STATUS_RED
        if zero_orders and len(flags) < 3:
            reason = "zero orders after a week with orders"
        else:
            reason = f"{len(flags)} flags"
    elif flags:
        status = STATUS_YELLOW
        reason = f"{len(flags)} flag" + ("s" if len(flags) != 1 else "")
    else:
        status = STATUS_GREEN
        reason = "no flags"
    return flags, status, reason


def choose_fixes(flags):
    keys = []
    for flag in flags:
        key = flag["fix_key"]
        if key in FIX_TEMPLATES and key not in keys:
            keys.append(key)
    keys.sort(key=lambda k: FIX_PRIORITY.index(k) if k in FIX_PRIORITY else 99)
    chosen = keys[:2]
    return [FIX_TEMPLATES[k] for k in chosen], chosen


def _vs_money(this, last):
    _, display = percent_change(this, last)
    return f"{rupee(this)} ({display})"


def _vs_count(this, last):
    _, display = percent_change(this, last)
    return f"{fmt_count(this)} ({display})"


def _was_pct(this, last):
    if this is None:
        return "n/a"
    if last is None:
        return f"{fmt_pct_points(this)} (was n/a)"
    return f"{fmt_pct_points(this)} (was {fmt_pct_points(last)})"


def _was_kpt(this, last):
    if this is None:
        return "n/a"
    if last is None:
        return f"{fmt_kpt(this)} (was n/a)"
    return f"{fmt_kpt(this)} (was {fmt_kpt(last)})"


def _was_rating(this, last):
    if this is None:
        return "n/a"
    if last is None:
        return f"{fmt_rating(this)} (was n/a)"
    return f"{fmt_rating(this)} (was {fmt_rating(last)})"


def _bad_orders_phrase(this, last):
    if this.bad_orders_pct is None:
        core = "n/a"
    elif last.bad_orders_pct is None:
        core = f"{fmt_pct_points(this.bad_orders_pct)} (was n/a)"
    else:
        core = f"{fmt_pct_points(this.bad_orders_pct)} (was {fmt_pct_points(last.bad_orders_pct)})"
    breakdown = (
        f"rejected {fmt_count(this.rejected)}, "
        f"delayed {fmt_count(this.delayed)}, "
        f"poor-rated {fmt_count(this.poor_rated)}, "
        f"complaints {fmt_count(this.bad_order_complaints)}"
    )
    return f"{core}; {breakdown}"


def _delayed_phrase(this, last):
    _, display = percent_change(this.delayed_orders, last.delayed_orders)
    rate = delayed_rate(this.delayed_orders, this.delivered_orders)
    rate_text = f"{rate:.2f}% of delivered" if rate is not None else "rate n/a"
    if this.delayed_orders is None:
        return "n/a"
    return f"{fmt_count(this.delayed_orders)} ({display}; {rate_text})"


def _cancelled_phrase(this, last):
    base = _vs_count(this.cancelled_orders, last.cancelled_orders)
    if this.cancelled_order_loss is None:
        return base
    return f"{base}; loss {rupee(this.cancelled_order_loss)}"


def render_zomato_line(reading):
    if reading is None:
        return "Zomato: not on this platform"
    tw, lw = reading.this_week, reading.last_week
    return (
        "Zomato: "
        f"sales {_vs_money(tw.sales, lw.sales)}, "
        f"orders {_vs_count(tw.delivered_orders, lw.delivered_orders)}, "
        f"bad orders {_bad_orders_phrase(tw, lw)}, "
        f"complaints {_vs_count(tw.complaints, lw.complaints)}, "
        f"lost sales {_vs_money(tw.lost_sales, lw.lost_sales)}, "
        f"online {_was_pct(tw.online_pct, lw.online_pct)}, "
        f"KPT {_was_kpt(tw.kpt_minutes, lw.kpt_minutes)}, "
        f"rating {_was_rating(tw.rating, lw.rating)}"
    )


def render_swiggy_line(reading):
    if reading is None:
        return "Swiggy: not on this platform"
    tw, lw = reading.this_week, reading.last_week
    return (
        "Swiggy: "
        f"sales {_vs_money(tw.sales, lw.sales)}, "
        f"orders {_vs_count(tw.delivered_orders, lw.delivered_orders)}, "
        f"cancelled {_cancelled_phrase(tw, lw)}, "
        f"poor-rated {_vs_count(tw.poor_rated_orders, lw.poor_rated_orders)}, "
        f"complaints {_vs_count(tw.complaints, lw.complaints)}, "
        f"online {_was_pct(tw.online_pct, lw.online_pct)}, "
        f"KPT {_was_kpt(tw.kpt_minutes, lw.kpt_minutes)}, "
        f"food-ready accuracy {_was_pct(tw.food_ready_accuracy, lw.food_ready_accuracy)}, "
        f"delayed {_delayed_phrase(tw, lw)}"
    )


def collect_notes(zomato, swiggy, match_note, week_notes):
    notes = []
    notes.extend(week_notes)
    if match_note:
        notes.append(match_note)
    if zomato is not None:
        notes.append(
            "Zomato offline time and FOR accuracy are n/a (not on the Business reports screen)."
        )
        notes.extend(zomato.notes)
    if swiggy is not None:
        notes.append(
            "Swiggy star rating, offline time and rejected count are n/a (not on this reports screen)."
        )
        if swiggy.this_week.lag_banner or any("48" in n.lower() and "lag" in n.lower() for n in swiggy.notes):
            notes.append("Swiggy showed a 48-hour lag banner on the latest week; figures may still change.")
        notes.extend(swiggy.notes)
    # Deduplicate while preserving order.
    seen = set()
    unique = []
    for note in notes:
        if note and note not in seen:
            seen.add(note)
            unique.append(note)
    return unique


def totals(zomato, swiggy):
    this_sales, last_sales, this_orders, last_orders = [], [], [], []
    for reading in (zomato, swiggy):
        if reading is None:
            continue
        if reading.this_week.sales is not None:
            this_sales.append(reading.this_week.sales)
        if reading.last_week.sales is not None:
            last_sales.append(reading.last_week.sales)
        if reading.this_week.delivered_orders is not None:
            this_orders.append(reading.this_week.delivered_orders)
        if reading.last_week.delivered_orders is not None:
            last_orders.append(reading.last_week.delivered_orders)
    sales = sum(this_sales, Decimal("0")) if this_sales else None
    last = sum(last_sales, Decimal("0")) if last_sales else None
    orders = sum(this_orders) if this_orders else None
    last_ord = sum(last_orders) if last_orders else None
    return sales, last, orders, last_ord


def render_card(outlet_name, area, zomato, swiggy, match_note, week_notes):
    flags, status, status_reason = evaluate_flags(zomato, swiggy)
    fixes, fix_keys = choose_fixes(flags)
    sales, last_sales, orders, last_orders = totals(zomato, swiggy)
    _, sales_pct = percent_change(sales, last_sales)
    _, orders_pct = percent_change(orders, last_orders)
    platforms = []
    if zomato is not None:
        platforms.append("Zomato")
    if swiggy is not None:
        platforms.append("Swiggy")
    single = len(platforms) == 1

    lines = [
        f"**{outlet_name} ({area}) – Weekly Operations**",
        f"{status} | Total sales {rupee(sales)} ({sales_pct}), orders {fmt_count(orders)} ({orders_pct})",
    ]
    if zomato is not None:
        lines.append(render_zomato_line(zomato))
    if swiggy is not None:
        lines.append(render_swiggy_line(swiggy))
    if single:
        lines.append(f"This outlet is on {platforms[0]} only.")
    notes = collect_notes(zomato, swiggy, match_note, week_notes)
    if notes:
        lines.append("Notes: " + " ".join(notes))
    if fixes:
        lines.append("Fixes: " + " ".join(fixes))
    else:
        lines.append("Fixes: None needed this week.")
    text = "\n".join(lines)
    return {
        "outlet": outlet_name,
        "area": area,
        "status": status,
        "status_reason": status_reason,
        "flags": flags,
        "fix_keys": fix_keys,
        "fixes": fixes,
        "total_sales": None if sales is None else str(q_money(sales)),
        "total_sales_change": sales_pct,
        "total_orders": orders,
        "total_orders_change": orders_pct,
        "platforms": platforms,
        "single_platform": single,
        "match_note": match_note,
        "notes": notes,
        "card": text,
    }


def parse_weeks(payload):
    weeks = payload.get("weeks") or {}
    this = weeks.get("this_week") or {}
    last = weeks.get("last_week") or {}
    this_span = (parse_iso_date(this.get("start")), parse_iso_date(this.get("end")))
    last_span = (parse_iso_date(last.get("start")), parse_iso_date(last.get("end")))
    notes = []
    for label, span in (("this week", this_span), ("the week before", last_span)):
        start, end = span
        if start and end and not is_monday_to_sunday(start, end):
            notes.append(
                f"Collected {label} {fmt_span(start, end)} is not a Monday–Sunday IST week; figures were still used as given."
            )
    if this_span[0] and last_span[1] and this_span[0] != last_span[1] + timedelta(days=1):
        notes.append(
            "The two collected weeks are not adjacent Monday–Sunday periods; figures were still used as given."
        )
    return {"this_week": this_span, "last_week": last_span, "notes": notes, "raw": weeks}


def _index_readings(readings):
    index = {"zomato": {}, "swiggy": {}}
    unnamed = []
    for reading in readings:
        if reading.outlet_id:
            key = reading.outlet_id
            if key in index[reading.platform]:
                raise ValueError(
                    f"duplicate {reading.platform} reading for outlet_id {key}"
                )
            index[reading.platform][key] = reading
        else:
            unnamed.append(reading)
    return index, unnamed


def join_readings(readings, map_rows):
    """Join Zomato and Swiggy readings using the owner-confirmed outlet map.

    Confirmed map pairs are joined with no uncertainty note. Unmapped
    readings are joined only when the brand name matches exactly (after
    normalising spaces/case) and the areas are compatible. Same brand with
    incompatible areas, or doubtful/multiple candidates, stay as separate
    cards with a 'match uncertain' note. 'The Thali Story by …' will not
    merge with a shorter brand of the same family, because the name must
    match exactly.
    """
    index, leftover = _index_readings(readings)
    used = {"zomato": set(), "swiggy": set()}
    groups = []

    for row in map_rows:
        z = index["zomato"].get(row.zomato_id) if row.zomato_id else None
        s = index["swiggy"].get(row.swiggy_rid) if row.swiggy_rid else None
        if z is None and s is None:
            continue
        if z is not None:
            used["zomato"].add(row.zomato_id)
        if s is not None:
            used["swiggy"].add(row.swiggy_rid)
        groups.append(
            {
                "outlet": row.outlet,
                "area": row.locality,
                "zomato": z,
                "swiggy": s,
                "match_note": None,
                "map_confirmed": True,
            }
        )

    remaining = leftover[:]
    for platform in ("zomato", "swiggy"):
        for oid, reading in index[platform].items():
            if oid not in used[platform]:
                remaining.append(reading)

    # Exact name match, then area compatibility.
    by_name = {}
    for reading in remaining:
        by_name.setdefault(norm_text(reading.outlet_name), []).append(reading)

    consumed = set()
    for name, items in by_name.items():
        pending = [r for r in items if id(r) not in consumed]
        zomato_items = [r for r in pending if r.platform == "zomato"]
        swiggy_items = [r for r in pending if r.platform == "swiggy"]
        if len(zomato_items) == 1 and len(swiggy_items) == 1 and areas_compatible(
            zomato_items[0].area, swiggy_items[0].area
        ):
            z, s = zomato_items[0], swiggy_items[0]
            consumed.add(id(z))
            consumed.add(id(s))
            groups.append(
                {
                    "outlet": z.outlet_name or s.outlet_name,
                    "area": z.area or s.area,
                    "zomato": z,
                    "swiggy": s,
                    "match_note": "Matched by brand name and area; please confirm.",
                    "map_confirmed": False,
                }
            )
        else:
            # Leave each remaining reading as its own card. If the other
            # platform has a same-name leftover, mark the match uncertain.
            counterparts = len(zomato_items) + len(swiggy_items) > 1
            for reading in pending:
                if id(reading) in consumed:
                    continue
                consumed.add(id(reading))
                note = None
                if counterparts or (name and any(
                    norm_text(other.outlet_name) == name
                    and other is not reading
                    for other in remaining
                )):
                    note = "match uncertain – please confirm"
                groups.append(
                    {
                        "outlet": reading.outlet_name or "Unknown outlet",
                        "area": reading.area or "Area not given",
                        "zomato": reading if reading.platform == "zomato" else None,
                        "swiggy": reading if reading.platform == "swiggy" else None,
                        "match_note": note,
                        "map_confirmed": False,
                    }
                )

    return groups


def build_report(payload, map_rows=None, today=None):
    if isinstance(payload, (str, Path)):
        payload = json.loads(Path(payload).read_text(encoding="utf-8"))
    weeks = parse_weeks(payload)
    expected_this, expected_last = completed_weeks(today)
    week_notes = list(weeks["notes"])
    if weeks["this_week"][0] and weeks["this_week"] != expected_this:
        week_notes.append(
            f"Collected this week {fmt_span(*weeks['this_week'])} is not the latest completed Monday–Sunday IST week ({fmt_span(*expected_this)})."
        )
    readings = [PlatformReading.from_dict(item) for item in payload.get("readings") or []]
    if not readings:
        raise ValueError("no platform readings supplied")
    if map_rows is None:
        map_path = payload.get("outlet_map_path")
        map_rows = load_outlet_map(map_path) if map_path else []
    groups = join_readings(readings, map_rows)
    cards = []
    for group in groups:
        card = render_card(
            group["outlet"],
            group["area"],
            group["zomato"],
            group["swiggy"],
            group["match_note"],
            week_notes,
        )
        card["map_confirmed"] = group["map_confirmed"]
        cards.append(card)
    cards.sort(key=lambda c: (STATUS_RANK[c["status"]], c["outlet"].casefold(), c["area"].casefold()))

    this_label = fmt_span(*weeks["this_week"]) if weeks["this_week"][0] else "week not dated"
    last_label = fmt_span(*weeks["last_week"]) if weeks["last_week"][0] else "prior week not dated"
    header = f"Weekly operations {this_label} vs {last_label} (Mon–Sun IST)"
    message_parts = [header, ""]
    for i, card in enumerate(cards):
        message_parts.append(card["card"])
        if i != len(cards) - 1:
            message_parts.append("")
    if len(cards) > 3:
        red = [c for c in cards if c["status"] == STATUS_RED]
        message_parts.append("")
        message_parts.append(
            f"Full set of {len(cards)} outlet cards is in the attached file. "
            + (
                f"{len(red)} outlet(s) marked Act now: " + ", ".join(c["outlet"] for c in red) + "."
                if red
                else "No outlets marked Act now."
            )
        )
    message = "\n".join(message_parts).rstrip() + "\n"
    return {
        "header": header,
        "weeks": {
            "this_week": {
                "start": None if weeks["this_week"][0] is None else weeks["this_week"][0].isoformat(),
                "end": None if weeks["this_week"][1] is None else weeks["this_week"][1].isoformat(),
            },
            "last_week": {
                "start": None if weeks["last_week"][0] is None else weeks["last_week"][0].isoformat(),
                "end": None if weeks["last_week"][1] is None else weeks["last_week"][1].isoformat(),
            },
            "expected_this_week": {
                "start": expected_this[0].isoformat(),
                "end": expected_this[1].isoformat(),
            },
            "expected_last_week": {
                "start": expected_last[0].isoformat(),
                "end": expected_last[1].isoformat(),
            },
        },
        "thresholds": {k: str(v) for k, v in THRESHOLDS.items()},
        "cards": cards,
        "message": message,
        "outlet_count": len(cards),
        "status_order": [c["status"] for c in cards],
    }


def write_outputs(report, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    message_path = out_dir / "owner-message.md"
    json_path = out_dir / "ops-review.json"
    cards_path = out_dir / "ops-review-cards.md"
    message_path.write_text(report["message"], encoding="utf-8")
    cards_path.write_text(report["message"], encoding="utf-8")
    serial = json.loads(json.dumps(report, ensure_ascii=False, default=str))
    json_path.write_text(json.dumps(serial, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"owner_message": str(message_path), "json": str(json_path), "cards": str(cards_path)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a weekly operations review from screen-read JSON.")
    parser.add_argument("readings", help="JSON file of this week and last week readings for each platform")
    parser.add_argument("--outlet-map", dest="outlet_map", help="CSV with outlet,locality,zomato_id,swiggy_rid")
    parser.add_argument("--out", dest="out", default=".", help="directory for owner-message.md and ops-review.json")
    parser.add_argument("--today", dest="today", help="override 'today' as YYYY-MM-DD (IST) for week checks")
    args = parser.parse_args(argv)
    today = date.fromisoformat(args.today) if args.today else None
    map_rows = load_outlet_map(args.outlet_map) if args.outlet_map else None
    report = build_report(args.readings, map_rows=map_rows, today=today)
    paths = write_outputs(report, args.out)
    sys.stdout.write(report["message"])
    sys.stderr.write("Wrote " + ", ".join(paths.values()) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
