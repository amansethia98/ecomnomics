#!/usr/bin/env python3
"""Checkpoint weekly ops readings after each platform-week, then run the calculator.

A live run can die mid-way (capacity error, cap, navigation slip). This helper
writes / merges one platform-week at a time into a single readings JSON so
already-collected figures are not lost and the next step can resume from the
gaps. It does no browser work and no network calls.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ops_review as m  # noqa: E402

DEFAULT_PATH = Path("/home/rakazo/ops-readings.json")
PLATFORMS = ("zomato", "swiggy")
WEEKS = ("this_week", "last_week")


def _default_identity(platform):
    if platform == "zomato":
        return {"outlet_id": "Z-TEST-0001", "outlet_name": "Example Kitchen", "area": "Example Area, City"}
    return {"outlet_id": "S-TEST-0001", "outlet_name": "Example Kitchen", "area": "Example Area, City"}


def empty_payload(today=None, this_week=None, last_week=None):
    if this_week and last_week:
        tw, lw = this_week, last_week
    else:
        tw, lw = m.completed_weeks(today)
    return {
        "weeks": {
            "this_week": {"start": tw[0].isoformat(), "end": tw[1].isoformat()},
            "last_week": {"start": lw[0].isoformat(), "end": lw[1].isoformat()},
        },
        "readings": [],
    }


def load(path):
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"readings file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def _as_dates(pair):
    if not pair:
        return None
    if isinstance(pair, dict):
        return m.parse_iso_date(pair.get("start")), m.parse_iso_date(pair.get("end"))
    start, end = pair
    return (start if isinstance(start, date) else m.parse_iso_date(start),
            end if isinstance(end, date) else m.parse_iso_date(end))


def init(path, today=None, this_week=None, last_week=None, overwrite=False):
    path = Path(path)
    if path.exists() and not overwrite:
        payload = load(path)
        return payload, False
    payload = empty_payload(today=today, this_week=_as_dates(this_week) if this_week else None,
                            last_week=_as_dates(last_week) if last_week else None)
    save(path, payload)
    return payload, True


def _reading(payload, platform, outlet_id=None):
    for item in payload.get("readings") or []:
        if (item.get("platform") or "").casefold() != platform:
            continue
        if outlet_id and str(item.get("outlet_id") or "") != str(outlet_id):
            continue
        return item
    return None


def week_complete(metrics):
    if not isinstance(metrics, dict) or not metrics:
        return False
    # A week is complete once any real field was recorded. null-only is not complete.
    return any(v is not None and v != "" for k, v in metrics.items() if k not in {"lag_banner"})


def status(payload, required_platforms=PLATFORMS):
    slots = []
    for platform in required_platforms:
        item = _reading(payload, platform)
        for week in WEEKS:
            ok = bool(item) and week_complete(item.get(week))
            slots.append({"platform": platform, "week": week, "complete": ok})
    missing = [s for s in slots if not s["complete"]]
    done = [s for s in slots if s["complete"]]
    return {
        "weeks": payload.get("weeks") or {},
        "slots": slots,
        "complete": done,
        "missing": missing,
        "ready": not missing,
        "platforms_started": sorted({
            (item.get("platform") or "")
            for item in payload.get("readings") or []
        }),
    }


def record(payload, platform, week, metrics, outlet_id=None, outlet_name=None, area=None, notes=None):
    platform = (platform or "").strip().casefold()
    week = (week or "").strip()
    if platform not in PLATFORMS:
        raise ValueError("platform must be zomato or swiggy")
    if week not in WEEKS:
        raise ValueError("week must be this_week or last_week")
    if not isinstance(metrics, dict):
        raise ValueError("metrics must be a JSON object")
    identity = _default_identity(platform)
    item = _reading(payload, platform, outlet_id=outlet_id or identity["outlet_id"])
    if item is None:
        item = {
            "platform": platform,
            "outlet_id": str(outlet_id or identity["outlet_id"]),
            "outlet_name": outlet_name or identity["outlet_name"],
            "area": area or identity["area"],
            "this_week": {},
            "last_week": {},
            "notes": [],
        }
        payload.setdefault("readings", []).append(item)
    else:
        if outlet_name:
            item["outlet_name"] = outlet_name
        if area:
            item["area"] = area
        if outlet_id:
            item["outlet_id"] = str(outlet_id)
    existing = item.get(week) or {}
    merged = dict(existing)
    merged.update({k: v for k, v in metrics.items()})
    item[week] = merged
    if notes:
        item.setdefault("notes", [])
        for note in notes if isinstance(notes, list) else [notes]:
            if note and note not in item["notes"]:
                item["notes"].append(note)
    return item


def format_status(info):
    lines = []
    tw = info.get("weeks", {}).get("this_week") or {}
    lw = info.get("weeks", {}).get("last_week") or {}
    lines.append(
        f"Weeks: this {tw.get('start', '?')}–{tw.get('end', '?')}; "
        f"before {lw.get('start', '?')}–{lw.get('end', '?')}"
    )
    for slot in info["slots"]:
        mark = "done" if slot["complete"] else "MISSING"
        lines.append(f"- {slot['platform']} {slot['week']}: {mark}")
    if info["ready"]:
        lines.append("READY: both weeks on all required platforms are checkpointed. Run review.")
    else:
        need = ", ".join(f"{s['platform']} {s['week']}" for s in info["missing"])
        lines.append("NOT READY. Still need: " + need)
        lines.append("Resume from the first missing slot; do not re-read a week already marked done.")
    return "\n".join(lines) + "\n"


def review(path, outlet_map=None, out_dir=".", today=None, allow_partial=False):
    payload = load(path)
    info = status(payload)
    if not info["ready"] and not allow_partial:
        raise SystemExit("NOT READY:\n" + format_status(info))
    if not payload.get("readings"):
        raise ValueError("no platform readings to review")
    map_rows = m.load_outlet_map(outlet_map) if outlet_map else None
    report = m.build_report(payload, map_rows=map_rows, today=today)
    paths = m.write_outputs(report, out_dir)
    return report, paths, info


def _parse_week_flag(value):
    if not value:
        return None
    if ":" in value:
        a, b = value.split(":", 1)
        return a, b
    raise ValueError("week flag must be YYYY-MM-DD:YYYY-MM-DD")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Checkpoint and resume weekly ops readings.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="create an empty readings file for the current two IST weeks")
    p_init.add_argument("--path", default=str(DEFAULT_PATH))
    p_init.add_argument("--today")
    p_init.add_argument("--this-week", dest="this_week", help="YYYY-MM-DD:YYYY-MM-DD")
    p_init.add_argument("--last-week", dest="last_week", help="YYYY-MM-DD:YYYY-MM-DD")
    p_init.add_argument("--overwrite", action="store_true")

    p_status = sub.add_parser("status", help="show which platform-weeks are already checkpointed")
    p_status.add_argument("--path", default=str(DEFAULT_PATH))

    p_rec = sub.add_parser("record", help="merge one platform-week of metrics into the readings file")
    p_rec.add_argument("--path", default=str(DEFAULT_PATH))
    p_rec.add_argument("--platform", required=True, choices=PLATFORMS)
    p_rec.add_argument("--week", required=True, choices=WEEKS)
    p_rec.add_argument("--metrics-json", dest="metrics_json", required=True,
                       help="JSON object of metrics, or @path to a JSON file")
    p_rec.add_argument("--outlet-id", dest="outlet_id")
    p_rec.add_argument("--outlet-name", dest="outlet_name")
    p_rec.add_argument("--area")
    p_rec.add_argument("--note", action="append", default=[])

    p_rev = sub.add_parser("review", help="run the deterministic calculator on the checkpointed file")
    p_rev.add_argument("--path", default=str(DEFAULT_PATH))
    p_rev.add_argument("--outlet-map")
    p_rev.add_argument("--out", default="/home/rakazo")
    p_rev.add_argument("--today")
    p_rev.add_argument("--allow-partial", action="store_true")

    args = parser.parse_args(argv)
    today = date.fromisoformat(args.today) if getattr(args, "today", None) else None

    if args.cmd == "init":
        payload, created = init(
            args.path,
            today=today,
            this_week=_parse_week_flag(args.this_week),
            last_week=_parse_week_flag(args.last_week),
            overwrite=args.overwrite,
        )
        sys.stdout.write(("Created " if created else "Already exists ") + str(args.path) + "\n")
        sys.stdout.write(format_status(status(payload)))
        return 0

    if args.cmd == "status":
        sys.stdout.write(format_status(status(load(args.path))))
        return 0

    if args.cmd == "record":
        raw = args.metrics_json
        if raw.startswith("@"):
            metrics = json.loads(Path(raw[1:]).read_text(encoding="utf-8"))
        else:
            metrics = json.loads(raw)
        path = Path(args.path)
        if not path.exists():
            init(path, today=today)
        payload = load(path)
        record(
            payload,
            args.platform,
            args.week,
            metrics,
            outlet_id=args.outlet_id,
            outlet_name=args.outlet_name,
            area=args.area,
            notes=args.note,
        )
        save(path, payload)
        sys.stdout.write(f"Recorded {args.platform} {args.week}.\n")
        sys.stdout.write(format_status(status(payload)))
        return 0

    if args.cmd == "review":
        report, paths, info = review(
            args.path,
            outlet_map=args.outlet_map,
            out_dir=args.out,
            today=today,
            allow_partial=args.allow_partial,
        )
        sys.stdout.write(format_status(info))
        sys.stdout.write(report["message"])
        sys.stderr.write("Wrote " + ", ".join(paths.values()) + "\n")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
