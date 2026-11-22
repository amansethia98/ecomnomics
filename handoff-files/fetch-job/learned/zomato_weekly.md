# Learned recipe: zomato weekly business report

Written by aifallback.py. Used by the scripted runner (no model) when the scripted stage named in `anchor` fails.

- Version 2, status **promoted**, learned 2026-11-16T07:55:38+05:30 (run nightly-20261116-0749-fc45e7-aifb-live).
- Takes over at stage `z1_range`; then the code checks outlet + date range and clicks the submit button.
- Evidence: {"window": "2026-11-09..2026-11-16", "presubmit": "ok", "identity": "ok", "upload": "stored", "fetchId": "${FETCH_ID}", "raw_sha12": "${RAW_SHA12}", "ai_cost_inr": 7.66, "ai_calls": 6, "promoted_from": "candidate v1 (candidate_literal_date)", "promoted_by": "E32 wildcard rule; all checks had passed on that run"}
- Used 1 times; last 2026-11-16T07:57:11+05:30; fails 0

Steps (templates are filled in per window/outlet):
1. click generic "Weekly"
2. click generic "Custom"
3. click generic "Select weeks"
4. click generic "{range_dmy}"
5. click generic "{*} Current week"
6. submit: generic "Generate" (code checks first)

History: 0 older versions; candidates not promoted: 1.
