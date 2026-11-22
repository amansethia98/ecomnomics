"""Tests for ops readings checkpoints and resume. Synthetic data only."""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

import ops_collect as c
import ops_review as m
import test_ops_review as t


def test_init_uses_monday_sunday_ist_weeks(tmp_path):
    path = tmp_path / "ops-readings.json"
    payload, created = c.init(path, today=date(2026, 11, 10))
    assert created is True
    assert payload["weeks"]["this_week"] == {"start": "2026-11-02", "end": "2026-11-08"}
    assert payload["weeks"]["last_week"] == {"start": "2026-10-26", "end": "2026-11-01"}
    assert payload["readings"] == []
    # Second init without overwrite keeps the file.
    payload["readings"].append({"platform": "zomato"})
    c.save(path, payload)
    again, created = c.init(path, today=date(2026, 11, 10))
    assert created is False
    assert again["readings"]


def test_record_one_week_does_not_wipe_the_other(tmp_path):
    path = tmp_path / "ops-readings.json"
    c.init(path, today=date(2026, 11, 10))
    payload = c.load(path)
    c.record(payload, "zomato", "this_week", t.zomato_week())
    c.record(payload, "zomato", "last_week", t.zomato_week(sales="90000.00"))
    c.save(path, payload)
    loaded = c.load(path)
    item = loaded["readings"][0]
    assert item["this_week"]["sales"] == "100000.00"
    assert item["last_week"]["sales"] == "90000.00"
    assert item["outlet_id"] == "Z-TEST-0001"


def test_status_and_resume_lists_only_missing_slots(tmp_path):
    path = tmp_path / "ops-readings.json"
    payload, _ = c.init(path, today=date(2026, 11, 10))
    info = c.status(payload)
    assert info["ready"] is False
    assert [s["platform"] + "." + s["week"] for s in info["missing"]] == [
        "zomato.this_week",
        "zomato.last_week",
        "swiggy.this_week",
        "swiggy.last_week",
    ]
    c.record(payload, "zomato", "this_week", t.zomato_week())
    c.record(payload, "zomato", "last_week", t.zomato_week())
    info = c.status(payload)
    assert [s["platform"] + "." + s["week"] for s in info["missing"]] == [
        "swiggy.this_week",
        "swiggy.last_week",
    ]
    text = c.format_status(info)
    assert "zomato this_week: done" in text
    assert "Still need: swiggy this_week, swiggy last_week" in text
    assert "do not re-read" in text


def test_empty_metrics_do_not_count_as_complete():
    payload = c.empty_payload(today=date(2026, 11, 10))
    c.record(payload, "swiggy", "this_week", {"sales": None, "delivered_orders": None})
    info = c.status(payload)
    assert any(s["platform"] == "swiggy" and s["week"] == "this_week" and not s["complete"] for s in info["slots"])


def test_cli_record_resume_and_review(tmp_path):
    path = tmp_path / "ops-readings.json"
    out = tmp_path / "out"
    cmap = tmp_path / "map.csv"
    cmap.write_text(
        'outlet,locality,zomato_id,swiggy_rid\nTest Kitchen,"Example Area, City",10001,20002\n',
        encoding="utf-8",
    )
    assert c.main(["init", "--path", str(path), "--today", "2026-11-10"]) == 0
    z_this = tmp_path / "z-this.json"
    z_this.write_text(json.dumps(t.zomato_week()), encoding="utf-8")
    assert (
        c.main(
            [
                "record",
                "--path",
                str(path),
                "--platform",
                "zomato",
                "--week",
                "this_week",
                "--outlet-id",
                "10001",
                "--outlet-name",
                "Test Kitchen",
                "--area",
                "Example Area, City",
                "--metrics-json",
                "@" + str(z_this),
            ]
        )
        == 0
    )
    # Review must refuse until both platforms are in.
    with pytest.raises(SystemExit) as raised:
        c.review(path, outlet_map=cmap, out_dir=out, today=date(2026, 11, 10))
    assert "NOT READY" in str(raised.value)
    for week in ("this_week", "last_week"):
        if week == "this_week":
            continue
        assert (
            c.main(
                [
                    "record",
                    "--path",
                    str(path),
                    "--platform",
                    "zomato",
                    "--week",
                    week,
                    "--outlet-id",
                    "10001",
                    "--outlet-name",
                    "Test Kitchen",
                    "--area",
                    "Example Area, City",
                    "--metrics-json",
                    json.dumps(t.zomato_week()),
                ]
            )
            == 0
        )
    for week, metrics in (
        ("this_week", t.swiggy_week()),
        ("last_week", t.swiggy_week()),
    ):
        assert (
            c.main(
                [
                    "record",
                    "--path",
                    str(path),
                    "--platform",
                    "swiggy",
                    "--week",
                    week,
                    "--outlet-id",
                    "20002",
                    "--outlet-name",
                    "Test Kitchen",
                    "--area",
                    "Example Area, City",
                    "--metrics-json",
                    json.dumps(metrics),
                ]
            )
            == 0
        )
    assert (
        c.main(
            [
                "review",
                "--path",
                str(path),
                "--outlet-map",
                str(cmap),
                "--out",
                str(out),
                "--today",
                "2026-11-10",
            ]
        )
        == 0
    )
    message = (out / "owner-message.md").read_text(encoding="utf-8")
    assert "Test Kitchen" in message
    assert "🟢 Good" in message


def test_allow_partial_single_platform(tmp_path):
    path = tmp_path / "ops-readings.json"
    payload, _ = c.init(path, today=date(2026, 11, 10))
    c.record(payload, "zomato", "this_week", t.zomato_week(), outlet_id="10001", outlet_name="Z-Only Cafe", area="North Side")
    c.record(payload, "zomato", "last_week", t.zomato_week(), outlet_id="10001", outlet_name="Z-Only Cafe", area="North Side")
    c.save(path, payload)
    cmap = tmp_path / "map.csv"
    cmap.write_text("outlet,locality,zomato_id,swiggy_rid\nZ-Only Cafe,North Side,10001,\n", encoding="utf-8")
    report, paths, info = c.review(
        path, outlet_map=cmap, out_dir=tmp_path / "out", today=date(2026, 11, 10), allow_partial=True
    )
    assert info["ready"] is False
    assert "This outlet is on Zomato only." in report["cards"][0]["card"]
