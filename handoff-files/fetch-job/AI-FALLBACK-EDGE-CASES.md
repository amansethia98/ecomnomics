# AI fallback + learn: edge cases (written 16 Nov 2026 before building)

Rule (Aman, 16 Nov): a fetch bot never just stops when a page step fails. Order per report window:
1. scripted steps (up to 3 tries, each from a fresh page load);
2. a promoted learned recipe for that platform+report+stage (no model, INR 0);
3. the AI (x-ai/grok-4.7, never Gemini) takes over that page from the start of the failing stage, one action at a time;
4. still failing at 05:30: the window goes on the 08:00 retry list; an alert is raised only if the 08:00 retry also fails.

Safety checks stay in code, never decided by the AI: before the Generate/Download click the outlet and the selected date
range shown on the page must match the plan; after download the file's restaurant id and period columns must match
(identity_check / rawSha256 path, unchanged). A learned recipe is saved only after all of these passed and the server stored the rows.

Live diagnosis (16 Nov 07:35 IST, read-only, no Generate): Zomato Weekly > Custom no longer shows a "Select date range"
calendar. It shows a **week list**: a "Select weeks" dropdown whose options are week labels ("Current week" first, then
"9 - 15 Nov 2026", "2 - 8 Nov 2026", ... 12 weeks back) and a "Selected: <label>" line. The "Current week" label is itself
buggy ("16 - 15 Nov 2026"). The daily view still has the calendar. So the weekly recipe was looking for a button that
the weekly view never had (first time the weekly window was ever run was 16 Nov 06:07).

| # | Edge case | Expected outcome | Test |
|---|-----------|------------------|------|
| E01 | Scripted step fails once (slow page, glitch) | reload + redo, up to 3 scripted tries; success on try 2/3 stores normally, no AI, INR 0 | test_e01_scripted_retry_then_ok |
| E02 | Element renamed / different picker (week selector instead of calendar) | 3 scripted tries fail at the same stage, AI takes over at the start of that stage, sets the range, code checks pass, file stored, recipe learned | test_e02_ai_solves_and_learns; live test |
| E03 | Promoted learned recipe exists for the failing stage | after 1 scripted failure at that stage the learned steps run (no further scripted retries, no AI, INR 0) | test_e03_learned_used_before_ai |
| E04 | Learned recipe goes stale (a step's control is missing) | recipe marked `stale` (fails+1), AI runs; on AI success a new version is promoted, old one kept in history | test_e04_stale_learned_then_ai_new_version |
| E05 | Learned step was a one-off popup close ("Close", "Got it", "Not now"...) and the popup is absent | that step is skipped on replay, the rest runs | test_e05_optional_dismiss_step_skipped |
| E06 | Modal or popup blocks the page during the AI run | AI may close it (guarded click); scripted tries already reloaded the page | prompt rule + test_e06_ai_can_dismiss_popup |
| E07 | Session expires mid-step (login page appears during scripted/learned/AI steps) | SignedOut raised, window returns `signed_out`; run_night runs the normal re-login path once (Swiggy password login; Zomato not auto) and redoes the window once; else `signed_out` rows as before | test_e07_signed_out_mid_ai; test_e07_relogin_mid_window |
| E08 | AI picks the wrong dates (e.g. "2 - 8 Nov" or the buggy "Current week") | pre-submit range check fails, nothing generated, AI is told which check failed (max 2 corrections), then fail -> 08:00 list | test_e08_wrong_range_blocked |
| E09 | AI picks the wrong outlet (multi-outlet account) | pre-submit outlet check fails (another outlet of this restaurant shown / ours not shown); if a file still came through, the file identity check rejects it, file deleted, `local_mismatch` logged, no second AI run | test_e09_wrong_outlet_blocked; test_e09_ai_identity_mismatch_no_rerun |
| E10 | AI loops (same action 3 times, or page unchanged 4 actions running) | stop with `ai_loop`, alert path (08:00) | test_e10_loop_detected |
| E11 | AI hits its step cap (15 actions, ECOM_AI_MAX_STEPS) | stop with `ai_step_cap`, 08:00 list | test_e11_step_cap |
| E12 | Cost cap: per-window AI cap INR 60 (ECOM_AI_CAP_INR) or night cap INR 150 shared by 05:30 + 08:00 runs (ECOM_AI_NIGHT_CAP_INR) | the next model call is not made if it could cross the cap; stop with `ai_cost_cap`/`ai_night_cap`; spend logged in logs/ai-spend/<date>.json | test_e12_cost_caps |
| E13 | AI clicks a forbidden control (email/SMS/share/phone numbers/online toggle/logout/settings/OTP) or a link that leaves the page | refused in code, AI told why; 3 refusals -> fail | test_e13_forbidden_refused |
| E14 | Page leaves the platform's partner site | stop with `ai_left_site` | test_e14_left_site |
| E15 | AI says ready but its submit control is not a generate/download button | refused (submit text must be Generate / Download / Raise a Request / Export) | test_e15_bad_submit_refused |
| E16 | File never downloads after submit | `download_failed`, nothing learned, 08:00 list | test_e16_no_file |
| E17 | File identity mismatch (restaurant id / week columns) after AI or learned path | file deleted, `local_mismatch` logged, candidate dropped (learned recipe marked stale), no AI re-run that night, alert | test_e09_ai_identity_mismatch_no_rerun; test_e17_learned_mismatch_marks_stale |
| E18 | Learned steps contain a literal date that can't be turned into a template | rows still stored (all checks passed) but recipe saved as `candidate_literal`, NOT promoted; AI used next time | test_e18_literal_date_not_promoted |
| E19 | Learned recipe works for any restaurant/outlet/week | texts stored as templates ({range_dmy}, {outlet_name}, {platform_id}, {start_d}...), file per platform+report (learned/<platform>_<report>.json), never per restaurant | test_e19_templates_generic |
| E20 | Zomato vs Swiggy | separate stage lists, login-URL patterns, site domains and learned files per platform; same engine | test_e20_platform_rules |
| E21 | Model is Gemini / no model key / model API error / malformed JSON | Gemini refused (`model_not_allowed`); no key -> `no_model_key`; API error retried once then `model_error`; 3 malformed replies -> `ai_bad_reply`; all go to 08:00 list | test_e21_model_guards |
| E22 | Learned file corrupt | ignored, moved aside to .corrupt, AI path used | test_e22_corrupt_learned_file |
| E23 | AI reports "not available yet" (days greyed out) | not trusted as a clean skip: logged and put on the 08:00 list | test_e23_ai_not_available_goes_to_retry |
| E24 | Everything fails at 05:30 | window `ui_changed` with `retry: "08:00"`, entry in logs/retry-queue/<date>-<slug>.json, summary `alerts_deferred`; no alert yet | test_e24_retry_queue_written |
| E25 | 08:00 retry run (`--retry-queue`) | runs only pending windows; success -> `resolved`; failure -> `failed_after_retry` + summary `alerts`; window no longer planned -> `resolved`; empty queue -> exits before booting the computer | test_e25_retry_mode |
| E26 | Report not scripted at all (Zomato monthly, Swiggy weekly/monthly) | unchanged by default (`ui_changed`, 08:00 list); AI only if ECOM_AI_UNSCRIPTED=1 (off: avoids surprise spend) | test_e26_unscripted_off_by_default |
| E27 | Two windows of the same report in one night (backfill) | the second one replays the recipe the first just promoted (no second AI run) | test_e27_second_window_reuses |
| E28 | Payout windows (Z2/S2) | keep their own recipe; 3 scripted tries and the 08:00 list; AI fallback for payouts not in this pass (icon-only buttons) | test_e28_payout_retry_queue |
| E29 | Snapshot helper fails during AI | one retry, then `snapshot_failed` -> 08:00 list | test_e29_snapshot_failure |
| E30 | Logs never hold page text, codes or credentials | AI transcripts (logs/ai-runs/) keep action, role and templated control text only; outlet name -> {outlet_name}; everything through scrub() | test_e30_ai_log_scrubbed |
| E31 | Existing behaviour unchanged when the script works | same steps, same checks, INR 0; all 50 earlier tests still pass | full suite |
| E32 | (found in the live test) A step's control text holds a date tied to *today*, not to the window: Zomato pre-ticks "Current week" (label "16 - 15 Nov 2026 Current week") and the AI unticks it | the date part becomes a wildcard, `{*} Current week`, only when a fixed label of 3+ letters remains; replay matches it by pattern; the code range check still decides. Pure dates (e.g. "2 - 8 Nov 2026") stay `literal_date` (not promoted) | test_e32_today_label_wildcard |

## Results (16 Nov 2026)
- Offline: tests/test_aifallback.py 34 tests, one or more per case above; full suite 84 passed (the 50 earlier tests unchanged).
- Live 1 (07:49 IST, run nightly-20261116-0749-fc45e7-aifb-live): scripted 3/3 failed at z1_open_calendar. The AI then clicked Weekly, Custom, Select weeks,
  "9 - 15 Nov 2026", and unticked the pre-ticked "Current week", then said ready. The code presubmit passed, Generate was clicked, and the file came back with identity ok (47 rows).
  The server stored it (fetch ${FETCH_ID}). It took 6 model calls, INR 7.66. The recipe was first saved as candidate_literal_date (the "Current week" label holds today's date). E32 was
  added with a test, and that verified candidate was promoted as v2.
- Live 2 (07:55 IST, run nightly-20261116-0755-91797a-aifb-learned): scripted try 1 failed, then the learned v2 recipe was replayed (5 steps), the presubmit passed and Generate was clicked.
  The file was byte-identical (sha ${RAW_SHA12}), identity ok, and the sha check skipped it as already stored. Model cost INR 0.
