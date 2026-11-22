# Weekly operations review bot (offline build)

This folder is the first, offline build of Ecomnomics’ weekly operations review bot, in the same style as the payout reconciliation bot. It reads Zomato and Swiggy operations figures for last week and the week before (Monday to Sunday, IST), scores them, and writes one consolidated owner message — one card per outlet, 🔴 then 🟡 then 🟢.

**This phase is offline only.** No live bot run, no model spend, no dashboard visit, and no OTP request has been started from here. Live tests wait for Aman to approve a budget.

## Layout

| Path | What it is |
|---|---|
| `restaurant-weekly-ops-review-SKILL.md` | The co-founder skill this bot follows |
| `guides/installed-ops-review-instructions.md` | Goal-level installed bot guide |
| `calculators/ops_collect.py` | Checkpoint / resume helper: init, status, record, review |
| `calculators/ops_review.py` | Deterministic maths, flags, status and card text |
| `calculators/test_ops_review.py` | pytest suite on synthetic data |
| `calculators/outlet-map.example.csv` | Outlet-map format (synthetic example only) |
| `THRESHOLDS.md` | Precise flag rules, including choices that need a yes |
| `COST-ESTIMATE.md` | Per-run and 5+1 cost estimate, from recon actuals |
| `SKILL-GAPS.md` | Things the skill does not spell out |
| `e2e/TEST-PLAN.md` | Plan for 5 live runs + 1 end-to-end run |
| `e2e/run_ops_review_trial.py` | Harness; plan-only unless a budget is approved |
| `e2e/verify_ops_review.py` | Offline grader for a finished trial folder |
| `e2e/owner-prompt.txt` | Exact end-to-end prompt: `give me the weekly ops review` |
| `fixtures/example-readings.json` | Synthetic readings for offline smoke checks |

Run the unit tests (local venv, no network):

```
.venv/bin/python -m pytest calculators/test_ops_review.py -q
```

Run the offline self-check (unit tests + example card + grader):

```
.venv/bin/python e2e/run_ops_review_trial.py --self-check
```

The live path (`--live`) will refuse unless `e2e/BUDGET-APPROVED.json` is present.

## Keep restaurant data off GitHub

Do not commit live readings, trial folders, dashboard exports, OTPs, credentials, or `BUDGET-APPROVED.json`. Unit tests and examples use made-up outlets only. The installed guide names the test outlet IDs because the restaurant computer needs them; live numbers still stay out of the repo.
