# Backfill edge cases (`--from` / `--to`)

Owner-started history fill for any restaurant. Daily business reports only.
Windows are civil dates in IST. `periodStart` is inclusive; `periodEnd` is the day after the last day (same convention as the nightly plan).

Live run this document was written for: 24 Aug–15 Nov 2026 (12 weeks). The same flags work for any restaurant and any range.

## Range limit per download

| App    | Largest daily chunk | What happens if a window is bigger |
|--------|---------------------|------------------------------------|
| Zomato | 30 days             | The recipe refuses with `z1_window_over_30_days` (never sent to the page). |
| Swiggy | 7 days              | The recipe refuses with `s1_daily_over_7_days`. The identity check also rejects a file longer than 7 days. |

`--from` / `--to` always split the range into these maximum chunks, oldest first, so a window never exceeds the cap. A 12-week span (84 days, 24 Aug–15 Nov inclusive) is 3 Zomato windows (30 + 30 + 24) and 12 Swiggy windows (12 × 7).

Presets such as Zomato's "Last 30 days" are only used when the window ends yesterday and is exactly 7, 14 or 30 days. Historical chunks use Custom dates.

## How far back each app goes

We do not assume a fixed history depth. Each app's calendar disables days it does not have.

- If the requested start day is disabled, the recipe walks forward to the first enabled day in that window, logs a clamp (`z1_clamp` / `s1_clamp`) with `effectivePeriodStart`, and downloads that shorter file. The upload and the identity check use the effective start, so we never claim days the file does not contain.
- If no day in the window is enabled (the whole chunk is older than the app's history, or still in the lag), the recipe raises `HistoryUnavailable` / `NotAvailable`. The window is logged `not_available` / `history_unavailable` or `not_available_yet`. It is **not** sent to the AI (an impossible date must not spend model money) and is **not** put on the 08:00 retry list (retrying later will not create older history).
- Later chunks that start on or after the first available day still run. The live run records the earliest day each app actually allowed. That is the answer to "can a first download pull about 90 days?"

## Overlap with days already stored

A file is posted to `POST /agent/v1/metric-reports` with `rawSha256` (or content sha only, when the blank-day guard trimmed the CSV).

- If that exact file is already stored, `POST /agent/v1/fetches/check` returns `stored` and the job logs `skipped`. Nothing is written twice.
- If the new file covers the same days with **different** numbers (a later fill-in), ingest supersedes the old rows (`planReplaceWindow`). The day still has one current value; it is not double-counted.
- `--from` / `--to` does not skip already-stored days. A chunk that overlaps the last week is one extra file, which either skips or updates fill-in. Gaps inside the range are filled by the chunks that contain them.

The server's own nightly backfill plan is different: it only lists missing days, and it shares a 90-day budget across both apps, so a brand-new restaurant would get about 45 days per app on night one. `--from` / `--to` does **not** use that shared budget, so an owner-started first download can pull the full requested range for both apps in one run (still split into legal chunks).

## Days that are partial or not filled in yet

- Today's civil date is never fetched. If `--to` is today or later, it is clamped to yesterday (the `--date` / IST today, minus one day).
- **Zomato:** real numbers typically arrive about 2 days after the date; fields can keep changing for about 5 days. The blank-day guard already cuts a recent (≤ 3 days old) all-zero / rating-0 column out of the CSV before identity and upload. A file that is only blank days is not posted (`not_in_yet`). The cut day is a gap and will be tried again on a later night.
- **Swiggy:** the calendar usually disables the last ~48 hours. The recipe already clamps the end date to the last enabled day (`s1_clamp`, `effectivePeriodEnd`). The same blank-day guard applies.
- A day that was stored as zeros and later fills in is superseded when a new file contains the real numbers (already seen: Zomato 14 Nov).

## Outlet and date verification

Unchanged from the nightly job, and applied before every backfill download:

- The job reuses the saved session. It only logs in if the session has expired. Swiggy is password-only (never Resend OTP, never a Swiggy OTP). Zomato codes are not requested by this job; a signed-out Zomato session stops that platform and is reported.
- Swiggy: exactly one outlet, matching this restaurant's RID, is ticked before dates are set.
- After dates are set, the page must show exactly this window (Zomato "Selected:" line; Swiggy checked "Custom dd/mm/yyyy - …" radio). Only then does **code** click Generate / Raise a Request. The AI, if used, never clicks those.
- After the file arrives, the local identity precheck (`evaluateBusinessReport`) must agree the file is for this outlet and this period. The server repeats the check and is the final word. A mismatch is not stored.

## Cost cap

- Scripted steps cost ₹0. The AI fallback is the existing one: 15 actions, ₹60 per window, ₹150 per IST day across all runs (`ECOM_AI_CAP_INR`, `ECOM_AI_NIGHT_CAP_INR`, ledger `logs/ai-spend/<date>.json`).
- In `--from` / `--to` mode, if login plus AI spend already on the run reaches the night cap, remaining windows on that platform are not started (`platform_stop` / `cost_cap`). The cap is about ₹150 unless `ECOM_AI_NIGHT_CAP_INR` is set.
- A Swiggy re-login, if the session has expired, is the existing bounded password run (also under the same ₹150 total for this owner-started job). It is allowed outside 05:30–07:30 only with `--login-any-time`.
- Impossible dates (history too old, or not in yet) do not start the AI.

## Other

- `--from` and `--to` must be used together, as `YYYY-MM-DD`. `from` after `to` is an error. They cannot be combined with `--retry-queue`.
- Only daily business reports are generated from the range. Weekly, monthly and payout windows stay on the nightly plan and are not invented from `--from` / `--to`.
- No Playwright. No change to the GitHub repo. Fixes are generic (chunk size and flags), never hard-coded to one restaurant.
