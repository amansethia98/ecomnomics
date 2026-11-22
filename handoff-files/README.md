# Handoff working files (non-secret)

This folder is the **code, training, prompts, design notes, and tests** that lived on the old Grok Bot box and were not already in the public product tree. It was added to branch `handoff/2026-11-22` on 22 Nov 2026 (Asia/Calcutta) after Aman's yes: "Yes add non secret working files."

It is **not** a running stack and **not** a data backup. A new Engineer - AI agents should read this README, then restore secrets and data as described below.

On the old box, restore by copying the trees back to their original paths (or keep this folder and point scripts at it). Fetch-job tests in this copy import from their parent directory, so you can run them from `handoff-files/fetch-job` without the old `/workspace/live-agentv1/fetch-job` path. Scripts that talk to the fetch computer still assume the computer user's home is `/home/rakazo` (that is the path inside the computer container).

## What is deliberately not included

These stay off GitHub. The new account gets them as follows:

| Left out | Why | How the new account gets it |
| --- | --- | --- |
| Postgres, `pgdata`, raw CSVs, payout figures, validation files, `FILL-IN-TIMING.*`, `JOURNEY.md` | Live restaurant data | Encrypted nightly backup in Google Drive folder `Ecomnomics backups` (id `1ZfuKiLNVitrByCJJBNYMByY9DET8gqQi`). Aman keeps the passphrase in `ECOMNOMICS_BACKUP_PASS`. Decrypt with `backup.sh` after restoring the script. |
| Logins, passwords, OTPs, cookies, browser sessions, `ACCESS.txt`, `config.env`, `private/*.bcrypt`, live `restaurants/*.json` | Secrets and session state | Re-log in to Zomato (OTP via the new account's Gmail connector) and Swiggy (**password login only**, never Resend OTP). Recreate preview basic-auth from `PREVIEW_LINK_PASSWORD`. Fill a restaurant config from the template below. |
| Saved routine objects on the old Grok account | Account-bound | Recreate from `ROUTINES-EXACT.md` in this folder, or Appendix R of `docs/HANDOFF-2026-11-22.md`, with the same schedule. |
| `bin/caddy`, `bin/cloudflared`, `web-dist*`, logs, `*.bak*`, `*.out`, `__pycache__`, `rakazo-fetch-snap*` | Binaries, builds, noise | Reinstall Caddy and cloudflared; rebuild `web-dist` from a green #33 head; do not copy logs. |
| Box `payment-reconciliation-SKILL.md` and `restaurant-weekly-ops-review-SKILL.md` | Worked examples include live payout figures | Use the in-repo generic skill: `restaurant-templates/payouts/skills/payout-reconciliation/SKILL.md`. |
| `ops-skill/e2e/TEST-PLAN.md`, `e2e/backup-recon-bot-instructions.txt`, `ops-skill/guides/installed-ops-review-instructions.md` | Soaked in live outlet ids | Recreate a test plan with placeholder ids after restore. Design of the review itself is in `WEEKLY-OPS-REVIEW-DESIGN.md`. |
| `/home/box/agent-data/workflows` (faceless-explainer, micro-thriller, etc.) | Unrelated to Ecomnomics | Skip. |

Do not later commit the excluded files into this public repo.

## Bot training (do not lose this)

The live fetch training lived at `/workspace/live-agentv1/fetch-job` on the old box (not in git, and there is no SKILL.md there). Everything below is the training the new bot needs, with live ids, hashes, and evidence redacted.

### Learned recipes (the scripted AI-fallback memory)

| File | Original box path | What it teaches |
| --- | --- | --- |
| `fetch-job/learned/zomato_weekly.json` | `/workspace/live-agentv1/fetch-job/learned/zomato_weekly.json` | Machine-readable promoted recipe: after scripted stage `z1_range` fails, click Weekly → Custom → Select weeks → `{range_dmy}` → `{*} Current week` → Generate. Version 2, promoted 16 Nov 2026. |
| `fetch-job/learned/zomato_weekly.md` | `/workspace/live-agentv1/fetch-job/learned/zomato_weekly.md` | Human-readable form of the same recipe, including that the first AI run cost INR 7.66 / 6 calls and the replay was INR 0. Live `fetchId` and `raw_sha12` are placeholders. |

Put new learned files in `fetch-job/learned/` the same way. Do not paste live fetch ids or file hashes into git.

### Playbooks, edge cases, and how the runner thinks

| File | Original box path | What it teaches |
| --- | --- | --- |
| `fetch-job/README.md` | `/workspace/live-agentv1/fetch-job/README.md` | How to run `run_night.py`, tests, auto re-login, AI fallback caps, and the 16 Nov weekly lesson. |
| `fetch-job/AI-FALLBACK-EDGE-CASES.md` | `/workspace/live-agentv1/fetch-job/AI-FALLBACK-EDGE-CASES.md` | When a scripted step fails: retry, then bounded `x-ai/grok-4.7` fallback, then learn/promote a recipe. Never Gemini. Caps ~₹60/window, ₹150/night. |
| `fetch-job/BACKFILL-EDGE-CASES.md` | `/workspace/live-agentv1/fetch-job/BACKFILL-EDGE-CASES.md` | How backfill chooses windows and when not to refetch. |
| `fetch-job/recipes.py` | `/workspace/live-agentv1/fetch-job/recipes.py` | Scripted clicks for Zomato/Swiggy daily, weekly, and payout reports. |
| `fetch-job/aifallback.py` | `/workspace/live-agentv1/fetch-job/aifallback.py` | The fallback loop: one action per model call, promote a recipe only after checks pass. |
| `fetch-job/aifb_probe.py` | `/workspace/live-agentv1/fetch-job/aifb_probe.py` | Read-only probe of the Zomato Weekly generator. Set `RESTAURANT_CONFIG` to a local (not committed) config file. |
| `fetch-job/auto_login.py` | `/workspace/live-agentv1/fetch-job/auto_login.py` | One bounded Swiggy **password** re-login per night. Env names only; never logs the password; never Resend OTP. |
| `fetch-job/ui.py`, `pb.py`, `explore.py`, `show.py` | `/workspace/live-agentv1/fetch-job/` | Page-control helpers and a small explorer. `explore.py` needs `FETCH_COMPUTER_CONTAINER`. |
| `fetch-job/identity.py`, `identity_check.mjs` | same | Reject a file if the restaurant id, name, or city does not match the expected outlet. |
| `fetch-job/run_night.py`, `retryq.py`, `blankday.py`, `backfill.py`, `convert.py`, `scrub.py`, `swg_dl.py`, `swg_filter.py` | same | Nightly orchestrator, retry queue, blank-day handling, backfill, Swiggy xlsx→csv, log scrubber, Swiggy download/filter helpers. `swg_filter.py` needs `FETCH_COMPUTER_CONTAINER` and `SWIGGY_RID`. |
| `fetch-job/tests/test_*.py` | `/workspace/live-agentv1/fetch-job/tests/` | T1 identity, held/mismatch, payout, scrub, AI fallback, backfill, blank-day, Swiggy-fix drills. From `fetch-job/`: `python3 -m pytest -q tests`. |
| `fetch-job/restaurants/example-restaurant.template.json` | sanitized stand-in for `/workspace/live-agentv1/fetch-job/restaurants/<slug>.json` | Structure only. Fill `${FETCH_BOT_ID}`, `${TEAM_HOME}`, `${STACK_TOKEN_ENV_FILE}`, `${SESSION_FILE}`. Credential **names** (`SWIGGY_USERNAME` / `SWIGGY_PASSWORD`) stay as env vars. |

### Login prompts and runners (how auto_login talks to the model)

Original box path: `/workspace/live-agentv1/`. In this folder: `stack/login-prompts/`.

| File | What it teaches |
| --- | --- |
| `live_runner_login.py`, `deliver_private_env.py`, `budget_guard.py` | Coordinator that starts a capped login run and delivers username/password through a private card (`fill_secret` only). |
| `login-swiggy-prompt.txt`, `swiggy-prompt.txt` | Swiggy: Login with Password only; never request or resend an OTP. |
| `zomato-prompt.txt` | Zomato: one email code, never resend; wait for the coordinator; type six characters into six boxes; never print the code. Owner email is `${APP_EMAIL}`. |
| `opscheck-swiggy-prompt.txt`, `opscheck3-swiggy-prompt.txt`, `opscheck3-zomato-prompt.txt` | Earlier ops-check login/read prompts used to prove the flow. |

### Ops-agent and fetch design notes (training for product behaviour)

Original box path: `/workspace/ops-skill/`. In this folder: `ops-skill/`.

Read in this order if you are coming in cold: `README.md`, `FETCH-JOB-DESIGN.md`, `OPS-AGENT-DESIGN.md`, `DATA-DESIGN.md`, `DAILY-BRIEF-GUIDE.md`, `BRIEF-EDGE-CASES.md`, `WEEKLY-OPS-REVIEW-DESIGN.md`. The others (`DATA-PLAN.md`, `DATA-PLAN-SUMMARY.md`, `METRIC-*`, `METRICS-BY-PLATFORM.md`, `THRESHOLDS.md`, `HOSTING-PICK.md`, `COST-ESTIMATE.md`, `SKILL-GAPS.md`, `NOTE-FOR-ENGINEER-SAAS.md`) are supporting design and estimates. Live platform ids in those notes were replaced with `${ZOMATO_RES_ID}` / `${SWIGGY_RID}` (and two out-of-scope Swiggy rid placeholders). `HOSTING-PICK.md` is superseded by Aman's later Hostinger KVM 2 month-by-month decision — see the handoff document.

Calculators and fixtures (`calculators/`, `fixtures/example-readings.json`, `e2e/budget-limits.example.json`, `e2e/owner-prompt.txt`, `e2e/DIAGNOSIS.md`, `pytest.ini`) are generic examples and cost-cap notes. Default outlet fallbacks in `ops_collect.py` now use `Z-TEST-0001` / `S-TEST-0001`.

### Exact routine prompts

`ROUTINES-EXACT.md` is a copy of the four saved routine bodies (plus the paused payout re-check). Same text as Appendix R of the handoff document. Recreate them on the new account. Box paths inside the prompts still name the old box; adjust after restore. Do not edit this file to "clean" those paths — it must stay verbatim.

### Skills already in this repo (not recopied)

- `restaurant-templates/payouts/skills/payout-reconciliation/SKILL.md`
- `restaurant-templates/reviews-replier/skills/reply-to-review/SKILL.md`
- `restaurant-templates/menu-manager/skills/update-menu/SKILL.md`

## Other trees in this folder

### `preview-link/` — original `/workspace/preview-link/`

Private preview: Caddy on :8787, cloudflared quick tunnel, basic auth user `aman` plus the app owner login. `/admin` is 404. Sign-up is 403. The verify listener is local-only (127.0.0.1:8789) and must never be on the tunnel; start/stop it with `start-verify.sh` / `remove-verify.sh`.

| File | What it does / how to run |
| --- | --- |
| `README.md` | Operator notes for the preview link. |
| `Caddyfile` | Gateway config. The basic-auth hash is `${BASIC_AUTH_BCRYPT}` — put the real hash in `private/basic.bcrypt` (not in git) and regenerate, or run `start.sh` with `PREVIEW_LINK_PASSWORD`. |
| `config.env.example` | Placeholder keys only. Copy to `config.env` (mode 600) and fill from the environment. |
| `start.sh`, `stop.sh`, `repoint.sh` | Start/stop the gateway and tunnel; repoint the upstream after a web-dist rebuild. |
| `start-verify.sh`, `remove-verify.sh`, `generate-caddyfile.sh` | Local verify listener and Caddyfile generation. |
| `test-public.sh`, `test-safari-assets.sh`, `prove-10min.sh` | Public checks. `test-public.sh` needs `RESTAURANT_ID` in the environment (no default live id). |
| `access.py`, `apply-creds.py`, `set-app-password.mjs` | Write ACCESS.txt keys; hash basic-auth; set the app password for `${APP_EMAIL}`. |
| `bin/*` | Watchdog, cloudflared wrapper, local DNS / CONNECT helpers (scripts only; no caddy or cloudflared binaries). |

There is no `preview-link/rebuild.sh`. Stack rebuild is `stack/rebuild.sh` (original `/workspace/live-agentv1/rebuild.sh`).

### `stack/` — original `/workspace/live-agentv1/`

| File | What it does / how to run |
| --- | --- |
| `backup.sh` | Encrypted gpg backup and Drive upload. Needs `ECOMNOMICS_BACKUP_PASS`. Do not commit archives or the passphrase. |
| `rebuild.sh` | Rebuild and start the local docker stack. Default commit on the script should be confirmed before use. |
| `compose.yml` | Compose file; already uses `${…}` placeholders for secrets. |
| `login-prompts/` | See training section above. |

## Sanitization applied in this copy

These files are not byte-identical to the box originals:

- `preview-link/Caddyfile` — live bcrypt hash replaced with `${BASIC_AUTH_BCRYPT}`.
- `preview-link/config.env` was not copied; `config.env.example` has placeholders.
- Emails next to login/password flows (`start.sh`, `apply-creds.py`, `set-app-password.mjs`, `zomato-prompt.txt`) use `${APP_EMAIL}`.
- `preview-link/test-public.sh` — live restaurant cuid and report-figure needles removed; requires `RESTAURANT_ID`.
- `fetch-job/learned/*` and `AI-FALLBACK-EDGE-CASES.md` — live `fetchId` / `raw_sha12` are `${FETCH_ID}` / `${RAW_SHA12}`. The AI cost INR 7.66 is kept as a model-test result.
- `fetch-job/restaurants/` is a template only. The live config was not copied.
- `aifb_probe.py`, `explore.py`, `swg_filter.py` — no hard-coded computer or outlet ids; they read env vars.
- Fetch-job tests import the parent folder instead of `/workspace/live-agentv1/fetch-job`.
- Design notes: live Zomato/Swiggy outlet ids replaced with `${ZOMATO_RES_ID}` / `${SWIGGY_RID}` (and two out-of-scope rid placeholders).
- `ops-skill/calculators/ops_collect.py` default outlet is the example kitchen, not a live restaurant.

`ROUTINES-EXACT.md` is unchanged (verbatim prompts).
