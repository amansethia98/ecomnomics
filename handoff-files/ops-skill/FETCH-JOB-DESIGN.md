# Nightly report-download job: design (step 2, "storing numbers properly")

Draft 1, 14 Nov 2026 (IST), by Engineer - AI agents. **This is a design only. No code is written yet, nothing was run live, and nothing was spent.** It needs Engineer - SaaS's review (the open questions are in §14) and then Aman's yes before anything is built.

Based on: `DATA-PLAN.md`, `DATA-PLAN-SUMMARY.md`, `DATA-DESIGN.md` §4–5 and §10.7–10.12, `NOTE-FOR-ENGINEER-SAAS.md`, `step3-fixtures/LAYOUT.md`, the local stack in `/workspace/live-agentv1` (launch_stack.py, the live runners, the opscheck3 prompts and logs, and the live2/run1 results), and `main` at **95ed793b** (read-only worktree on the box at `/workspace/tmp/ecom-95ed`).

---

## 0. The idea in plain words

Every night a script on our side wakes the restaurant's own computer. It reuses the saved Zomato and Swiggy logins in that computer's browser, downloads the same report files a person would download, checks that each file is for the right outlet and the right dates, and posts it to the database. **No AI model is used when everything goes normally**, so a normal night should cost about ₹0 in model spend. The model is only used to log in again when a login has expired, and that path is capped. If something can't be fixed safely, the job stops for that outlet and platform and tells someone. It never guesses and it never stores a doubtful file.

---

## 1. Things found while writing this that block a live test

These were checked read-only on 14 Nov, around 20:35 IST.

1. **Docker is no longer installed on the box.** `docker` isn't there, `/var/lib/docker` doesn't exist, and the box has been up only about 32 minutes. The `/workspace` files have 14 Nov 15:21–15:29 timestamps, so it looks like the workspace was restored onto a fresh machine. The images the stack uses (`ecomnomics/main-app:bbfd54de8`, `main-supervisor:571b069c4`, and the computer image) are gone, so "start the stack" can't work as it is.
2. **The saved Postgres folder is incomplete.** `/workspace/live-agentv1/pgdata` is missing the empty folders Postgres needs: `pg_commit_ts`, `pg_dynshmem`, `pg_replslot`, `pg_serial`, `pg_snapshots`, `pg_stat_tmp`, `pg_tblspc` and `pg_twophase`. Every file is also owned by `box` rather than the Postgres user. It will probably refuse to start until those folders are recreated and the ownership is fixed. Take a copy of the folder before touching it.
3. **The local stack is older than the endpoints this job needs.** Image `bbfd54de8` doesn't have `POST /agent/v1/metric-reports`, `POST /agent/v1/payout-reports`, `GET /agent/v1/metrics` or the `metric_fetches` and `payout_*` tables. Those come from PRs #13–#15 on main. The stack has to be rebuilt from **95ed793b** or later, and its migrations run, before any upload can work.
4. **The browser profile survived.** `data/homes/team-…/.browser-profiles/chromium-bot-d1dc…/Default` still has its Cookies, Local Storage, IndexedDB and Sessions. I only listed the files and read no values. So the Zomato login may still work once the stack is running again.
5. **The outlet rows in the local database need platform ids.** The server rejects a file if the outlet has no `zomatoResId` or `swiggyRid` (`missingPlatformIdReason`). Pawan Putra's outlet row has to have both before the first upload.

These are **prerequisite step P0** in the test plan (§12). They cost ₹0 in model spend but take box time to rebuild the images.

---

## 2. Scope

| In | Out (later) |
|---|---|
| Daily business reports, re-fetched for the last 7 days, Zomato and Swiggy, every outlet | Reviews and menu pages |
| Weekly payouts: the last 4 cycles plus any pending ones, Zomato settlement xlsx and Swiggy annexure xlsx | Ads pages, invoices PDFs |
| Weekly and monthly platform figures, stored as `platform_check` rows (DATA-PLAN §1) | Dashboard and admin screens (step 5) |
| Session reuse, expired-login handling, owner and admin alerts | Hosting off the box (step 4) |

---

## 3. Who does what

```
Scheduler (Grok Bot routine, 05:30 IST)        ← only wakes the job; stays silent when all is well
   └─ Orchestrator script on the box   /workspace/fetch-job/run_night.py   (no model)
        ├─ preflight: Docker, stack, DB, API health   (starts the stack if stopped)
        ├─ for each restaurant (one after another):
        │     ├─ boot that restaurant's computer        (RPC computer/boot, no model run)
        │     ├─ GET /agent/v1/fetch-plan?outletId=…    (what to fetch)
        │     ├─ docker exec → Fetch runner inside the computer:  rakazo-fetch-reports  (no model)
        │     │      drives the computer's own Chromium through rakazo-page-browser
        │     │      (navigate / snapshot / act / wait_download), finds controls by exact visible text,
        │     │      checks identity locally, checks the sha256, posts to /agent/v1/*-reports
        │     ├─ on SIGNED_OUT → login path (§6): a bounded Grok login run, or an alert
        │     └─ GET /agent/v1/fetches → summary for that restaurant
        └─ writes run summary JSON  → the routine reads it and alerts only if needed (§10)
```

Why it's built this way:
- **Scripted, not an agent.** Two agent runs on the report screens cost ₹177 (Zomato, stopped at its cap) and ₹208 (Swiggy, stuck on the outlet filter) on 12 Nov. The same files downloaded by hand took a few clicks and cost ₹0. The `computer_act` screenshot loop is what made those runs expensive (`e2e/DIAGNOSIS.md`).
- **Not Playwright, and no new browser.** The runner calls `rakazo-page-browser`, the wrapper already in the computer image that the bot's own `browser_act` uses. It drives the Chromium that is already running with the retained profile. It reads no cookies, tokens or password files, and logins are never scripted with Playwright.
- **No fixed-coordinate clicks.** The old xdotool coordinate macros (`pr-bundle/download-workflow.py`) are retired. The runner clicks a control only after finding it in a fresh snapshot by its exact role and visible text, and checks the page state after every step.

---

## 4. Schedule and time window

| What | When (IST) | Window fetched | Files per outlet |
|---|---|---|---|
| Business, daily | every night, start **05:30**, hard stop **07:30** | D−7 … D−1, where D is today in IST; today's partial day is never fetched | Zomato: 1 CSV (daily columns). Swiggy: 1 xlsx (Daily view, 7 days, which is the cap) |
| Zomato week check | Monday | the last ISO week, Mon–Sun | 1 CSV (Weekly view) |
| Swiggy week check | **Tuesday** (Swiggy's 48-hour lag banner covers Sun and Mon) | the last week, Sun–Sat | 1 xlsx (Weekly view) |
| Monthly check | the 3rd | the previous calendar month | Zomato 1 CSV (Monthly), Swiggy 1 xlsx (Monthly) |
| Payouts | **Thursday** (Zomato pays on Wednesday, Swiggy around Tue–Wed) | the last 4 paid cycles, any cycle `fetch-plan` lists as pending or under the lag banner, and never the current open cycle | up to 4–6 xlsx per platform |
| Backfill (new outlet or a long gap) | the same nightly window, after the normal work | Zomato in ≤30-day chunks, Swiggy Daily in **≤7-day** chunks, at most 90 days per night | – |

Why 05:30:
- Late-night orders are finished by then.
- The box is otherwise idle.
- There are two hours for one retry pass before the owner's morning.
- Alerts go out at 08:00, not in the middle of the night (§10).

**Second pass:** anything that failed for a reason other than identity or login (a timeout or a page error) is tried once more at about 06:45.

**Date rule:** `periodStart` is the first day and `periodEnd` is the day *after* the last day, which is how main's `expectedPeriods` works (to be confirmed, Q7). All dates are IST calendar days, worked out by the orchestrator and never by the computer's clock.

---

## 5. Order of steps for each restaurant, outlet and platform

Restaurants run **one at a time**, because each computer takes 2 CPUs and 3 GB and the box has about 2–5 GB free. Within a restaurant, Zomato runs first and then Swiggy. Outlets run one after another on the same login.

**Night preflight (once):**
1. Check Docker, the stack containers, `pg_isready` and the API health. If the stack is stopped, start it with `launch_stack.py` and wait up to 5 minutes for it to be healthy.
2. Record the image tags actually running, because the `RAKAZO_GIT_SHA` label is known to be wrong.
3. If any check fails, stop the night with `stack_down` and send an admin alert.

**For each restaurant:**
1. `computer/status`. If an owner or an agent is using the computer (a takeover or an active run), skip it for now and retry in the second pass.
2. `computer/boot` and wait until it is ready. The idle stop (15 minutes) is fine, because the runner keeps the computer busy while it works.
3. `GET /agent/v1/fetch-plan?outletId=` for each outlet. It gives the windows to fetch, the missing days and the pending cycles. Until that helper ships, the orchestrator computes the same thing from §4.
4. `GET /agent/v1/fetches?outletId=&since=now−24h`. If any outlet and platform already has **3 identity mismatches**, or is in `needs_owner`, skip it (§8).

**For each platform (Zomato, then Swiggy):**
1. **Session probe.** Navigate to the platform's report URL in the existing tab. If the address is a login page (`partner.swiggy.com/food/login`, or a Zomato login or verification redirect), report `SIGNED_OUT` for this platform and go to §6. The job never types anything on a login page.
2. **For each outlet, and for each report in the plan:**
   1. Select exactly this outlet (§7) and check it is the only one selected.
   2. Set the view and dates, then trigger the download (§7).
   3. Wait for the file with `rakazo-wait-download --since <step start>`. Accept the file by its content, not its name (§7, Swiggy).
   4. Run the **local identity precheck** (§8). On a mismatch, don't upload, log it and retry (§9).
   5. Work out the sha256 of the raw file and ask the check-by-sha256 helper. If it's already stored, log `skipped` and move on.
   6. For Swiggy business files, convert the xlsx to CSV (one sheet, displayed text values, as `validation/swiggy/load.py` does) unless the server learns to take the xlsx itself (Q6).
   7. POST to `/agent/v1/metric-reports` (`csv`) or `/agent/v1/payout-reports` (`fileBase64`), with `outletId`, `platform`, `report`, `periodStart`, `periodEnd`, `runId`, `source="nightly-fetch/<version>"` and `capturedAt`. The server runs `checkObservedIdentity` again and is the final word.
   8. Delete the downloaded file from the computer once the server has answered `stored` or `skipped`. Payout files contain customer ids, PAN and UTRs, so they must not pile up in Downloads.
   9. Wait at least 20 seconds before the next download, so the job looks like a person working steadily.

**Wrap-up:** `GET /agent/v1/fetches` for the summary, then write `summary-<date>.json`. The computer is left to stop on its own idle timer and is never removed.

---

## 6. Session reuse and expired logins

**Reuse:** the job always opens the report URL in the existing tab first. Today's state:
- **Zomato:** reuse is proven. Runs on 8, 11 and 12 Nov reused the saved session without a code, and the login cookie runs until 11 Nov 2027.
- **Swiggy:** reuse is **unproven, and the evidence is mixed.** The live2 payout run on 12 Nov reused the session. But the first opscheck run the same day landed on `/food/login`, and opscheck3 needed a password login. The 14 Nov audit found no Swiggy cookies in the profile, so Swiggy probably keeps its login in browser storage, which may not survive a browser or computer restart. That's what test T3 checks (§12).

**When a login has expired**, the runner stops that platform at once (`SIGNED_OUT`) and the orchestrator chooses:

| Platform | Who can supply the secret | What happens |
|---|---|---|
| **Zomato** (the email code goes to the restaurant's email) | Pawan Putra: Aman's Gmail, read through the `user-Gmail--${APP_EMAIL}` connector by the Grok Bot routine. Other restaurants: only their owner | **One bounded Grok login run** (x-ai/grok-4.7) using the tested owner-reply flow: one email code requested, never resent, typed into the boxes, and never printed or logged. The routine reads the code from Gmail and passes it to the coordinator's private endpoint, the same way as `live_runner_opscheck3.py`. Capped at about **₹60**. Afterwards the scripted downloads carry on. With no code within 7 minutes → `needs_owner` and an alert |
| **Swiggy** | The saved username and password, delivered privately to the run as now (`fill_secret`), never seen in plain text | **One bounded Grok login run**: fill the username, ignore the OTP boxes, click **"Login with Password"**, fill the password and submit **once**. The run **never** clicks "Resend OTP" and never requests or enters a Swiggy OTP. If the password fails, or the site insists on an OTP, it stops with `needs_owner` and no retry. Capped at about **₹60** |

Rules for the login path:
- There is at most **one** login attempt per platform per restaurant per night.
- There is no login at all outside 05:30–07:30 IST, unless the owner starts one.
- The login run does only the login. Downloads stay scripted.
- If T3 shows Swiggy logs out every night, a nightly password login costs model money every night. Before building, we'd decide between:
  - a scripted password login through `rakazo-page-browser`'s `fill_secret`, which isn't Playwright, never touches the OTP, and still needs Aman's yes;
  - or accepting the login run's cost.

**Re-authenticating a non-Aman owner (product):** the app shows "Your Zomato/Swiggy login expired". The owner opens the bot's computer through the existing takeover (`computer/takeover`) and logs in themselves, or types the code into the in-app card. The job only resumes on the next night or when they press "Fetch now".

---

## 7. Scripted download method for each report

Each recipe is a short list of states. A step clicks **only** a control found in a fresh snapshot by its role and exact visible text, then checks the expected state before going on. If an expected control isn't found, the step fails with `ui_changed:<step>`, and there is no hunting around. Labels marked *(confirm in T2)* weren't recorded word for word on 12 Nov and get recorded during the first live run.

All recipes use these **shared guards:**
- Never click email, SMS, share or envelope controls, or anything like "send report to mail".
- Never touch the Online toggle, settings, ads or feedback.
- Close a Spark or support drawer only through its labelled Close control.
- Never open a second tab or browser.

### Z1. Zomato business report (daily, weekly or monthly)
What worked on 12 Nov (by hand, ₹0) and in the opscheck3 run:
1. Navigate to `https://www.zomato.com/partners/onlineordering/reporting/?selected_tab=tab_daily&selected_view=view_business_reports&business_reports_type=table`.
2. If the outlet dialog appears, select the outlet whose text contains `ID: <zomatoResId>`, Apply, and check it.
3. Make sure the **Business reports** tab is showing, not Live tracking.
4. Click **"Generate report"**. This is the report generator panel, not the table's date picker, and the URL's own dates don't set the file's dates.
5. Choose the view (**Daily**, **Weekly** or **Monthly**) and check the radio button actually changed.
6. Set the dates:
   - Daily: Custom, from–to, at most 30 days. Check the shown range.
   - Weekly: a range covering the ISO weeks.
   - Monthly: "Select months", with exactly the wanted months ticked and the current month unticked. Check the chips.
7. Click **"Generate"**. The CSV downloads by itself, and Zomato may also email a copy (that's harmless, and we never ask for it).
8. Wait for `business_report_*.csv`. The number in the file name **isn't** the restaurant id (14044911 compared with ${ZOMATO_RES_ID}), so identity comes only from the content.

### S1. Swiggy business metrics (Daily, Weekly or Monthly)
What worked on 12 Nov (by hand, ₹0); opscheck3 failed at step 2:
1. Navigate to `https://partner.swiggy.com/food/business-metrics`.
2. **Outlet filter.** The account can see several outlets: One China in Pune is the default, plus The Thali Story, a separate listing. The filter starts with **all outlets selected**, and that is what caused the wrong-outlet files.
   1. Open the filter and use **Clear all** *(confirm in T2: opscheck3's first Clear all "didn't take")*.
   2. Check that the selected count is 0.
   3. Search for `<swiggyRid>`, tick only the row whose text has that RID, and Apply.
   4. Check that the filter summary shows exactly one outlet with that RID.
   5. If any of this check fails, **don't download.**
3. Choose the view (Daily, Weekly or Monthly), then Custom dates. Daily is at most 7 days, so a longer range has to be split. Confirm or Apply, and check the shown range.
4. Use the page's own **download or export** control *(exact label: confirm in T2)*. If the only choice emails the file, stop with `ui_changed:email_only`.
5. Wait for the `.xlsx` (Apache POI, one sheet called "Business Metrics Report").

### Z2. Zomato payout (settlement report)
Agent-run path that passed 5/5 (8 Nov) and passed again on 11–12 Nov, now scripted:
1. Navigate to `https://www.zomato.com/partners/onlineordering/finance/payouts`. Do the outlet dialog as in Z1.
2. Let the list load **once**, without reloading again and again.
3. In **past cycles**, find the row whose dates match the cycle from `fetch-plan`. A paid cycle has a UTR, and the current open cycle (no UTR) is skipped.
4. Click that row's **"Download report"**. Don't open UTR reports, Invoices or Fees.
5. Wait for `Zomato_Settlement_Report_*.xlsx`, then check it's a complete zip.

### S2. Swiggy payout (invoice annexure)
1. Navigate to `https://partner.swiggy.com/food/finance`, then **Past Payouts**. A guessed `/payouts` lands on the Help Center, so the job never uses it.
2. Select the outlet as in S1, step 2.
3. Find the cycle row (Sun–Sat, and split at the end of a month) and its **Download Reports** control. Choose the **annexure** (xlsx) *(confirm in T2)*. Never take an emailed option.
4. Wait for `invoice_Annexure_*.xlsx`. **Known quirks from live2:**
   - the download stalled and was saved under a random UUID name;
   - one extra PDF came down too.

   So the runner takes the newest complete `.xlsx` saved after the step started, opens it, and confirms it's an annexure (Summary sheet with `Rest. ID - …`). It ignores PDFs and never renames a file to make it fit.

**Finding files:** downloads are matched by `--since <step start>`, and the file is moved into a per-run folder straight away, so a stale or earlier file can't be picked up.

---

## 8. Identity checks (the hard rule)

There are two checks, and both have to pass. The **server's check is the final word**; the local check is there to retry fast and to avoid uploading another restaurant's file.

| File | Outlet id must equal | Dates must equal | Warnings only |
|---|---|---|---|
| Zomato business CSV | Restaurant ID column, the **same on every row** (a file with more than one restaurant is rejected) | the date, week or month column labels, exactly the requested periods in order | name, city |
| Swiggy business xlsx/CSV | Restaurant ID column (read as a float, `${SWIGGY_RID}.0`), the same on every row | the column labels (`2nd Nov 2026`, `11th - 17th Oct2026`, …), exactly the requested days. Daily is at most 7 days | name, area, city |
| Zomato settlement xlsx | `HSummary!F2` / Summary "Res id" **and** every Order Level `Res. ID` | `HSummary!E2` period, and the dates in the file name | Res name |
| Swiggy annexure xlsx | Summary `Rest. ID - <rid>`, the only place the id appears | Summary "Payout Period" (it has no year, so the year comes from the `_DDMMYYYY_` in the file name). Watch December–January | name, city |

- The local check calls the same logic as `checkObservedIdentity` on main (packages/contracts `metric-parse.ts`). It is ported into the runner, or shared as a tiny module so the two can't drift apart (Q6).
- The fixtures `step3-fixtures/*-wrong-outlet.xlsx` (999001/999002) and the step-1 business fixtures (900001/900002) are the reject tests.
- If an outlet has no platform id saved, the job doesn't download at all and logs `missing_platform_id`.

---

## 9. Retries, and the stop after 3 mismatches

| Failure | Retry | Then |
|---|---|---|
| **Identity mismatch** (local or server) | Navigate fresh, re-select the outlet, re-set the dates and re-download. That's **at most 3 attempts in total** for that outlet, platform and report | After the **3rd mismatch within 24 hours** for that outlet and platform (any window, counted from `GET /agent/v1/fetches`): stop **every** download for that outlet and platform, mark `needs_owner`, and send an admin alert. Other outlets and the other platform carry on. It stays stopped until an admin clears it, so it doesn't pick up 3 fresh mismatches every night on new windows (Q4) |
| Signed out | none in the scripted path | §6 login path, once a night |
| Control not found (`ui_changed`) | 1 fresh navigate and retry | Stop that report, alert the admin (not the owner), and don't fall back to an agent. An agent fallback capped at ₹150 a night is only switched on with Aman's yes |
| Download didn't arrive in 120 s, or is incomplete | 1 retry (the same click once more, only if no file at all appeared) | Retry in the second pass at 06:45, then log `download_failed` |
| Page error or 5xx | 1 retry after 60 s | Second pass |
| Upload network error, or API 5xx | 3 tries, 10 / 30 / 90 s apart. It's safe to repeat because of the sha256 check | Keep the file in the run folder, then retry in the second pass |
| API 4xx other than an identity error (for example `invalid_body`) | none | Log it and alert the admin, because it's a bug |
| Stack or computer won't start | 1 retry after 2 minutes | `stack_down` and an admin alert |

Main counts mismatches **per exact window for all time** (`FILE_IDENTITY_ATTEMPT_LIMIT = 3`), and the `attempt` the job sends overrides the count. The job will **not** send `attempt` itself, so the server's count is the one that counts. Q4 asks for a 24-hour count per outlet and platform instead.

---

## 10. Owner alert (today `needs_owner` is only stored in the database)

There are two audiences:
- the **admin**, which is Aman now and later the admin panel;
- the **restaurant owner**.

**Now, with one restaurant and Aman as the operator:**
- The 05:30 Grok Bot routine reads `summary-<date>.json`. **If everything is `stored` or `skipped`, it says nothing.**
- If something needs a person, it sends Aman **one short message at 08:00 IST**, once per problem per day, and never in the night. For example: "Swiggy login expired for Pawan Putra. I'll try the saved password tonight" / "Swiggy sent another outlet's file 3 times. Downloads paused until you check".
- The same lines go into the 11 PM summary.
- Other bots never message Aman directly, and the message never contains codes, passwords or phone numbers.

**Product, for many restaurants (needs Engineer - SaaS, Q5):**
- A `needs_owner` fetch also creates an **owner attention item** saying what to do ("Log in to Swiggy again", with a button that opens the computer takeover).
- That item is delivered through whatever the app can already send without email: a message in the restaurant bot's thread, which uses the existing push and `NotificationPreference.help`, and WhatsApp or Telegram if the owner has linked one. Email is added once `EMAIL_PROVIDER` is set.
- The **admin panel** (step 5) lists every restaurant with an expired login, the failed nights, mismatches and the cost per night.
- Missing days are always shown as missing in reads and are never filled with zero. That already holds on main.

---

## 11. What gets logged (and what never does)

**Logged** (on the box, `/workspace/fetch-job/logs/<date>.jsonl`, kept 30 days), one line per step:
- run id, restaurant and outlet **internal** ids, platform, report kind, window;
- the recipe step name, how long it took, and the result code (`ok`, `signed_out`, `ui_changed:<step>`, `mismatch:<reason>`, `download_failed`, `skipped`, …);
- the file's size and the first 12 characters of its sha256;
- the server's `fetchId` and status;
- the stack's image tags;
- model cost in ₹ for any login run (OpenRouter key-meter delta × ₹85 per $, as now).

**Never logged** (and scrubbed by a regex pass before writing, just in case):
- OTPs and email codes;
- passwords and usernames;
- **phone numbers** (the Swiggy username is a phone number);
- email addresses;
- cookies, tokens, agent tokens and full URLs carrying query tokens;
- page snapshots or page text. A step logs only the allowlisted control text it matched;
- file contents, customer ids, UTRs (not even the last 4), PAN, GSTIN and bank details.

The login run's own thread is saved with user input replaced, exactly as `live_runner_opscheck3.py` does today (`[private]`, `[user input omitted]`).

---

## 12. Live test plan (nothing here has been run; each live step needs Aman's yes)

| # | Test | Model ₹ | Pass when |
|---|---|---|---|
| **P0** | Prerequisites, done once:<br>• reinstall Docker on the box<br>• rebuild the images from **95ed793b**<br>• copy `pgdata`, then recreate the missing Postgres folders, fix ownership, start the database and run the migrations<br>• set Pawan Putra's `zomatoResId`/`swiggyRid`<br>• fix the version label | ₹0 | Stack healthy; `GET /agent/v1/restaurant` answers; the old 246c11b benchmark stack is left untouched |
| T1 | Offline: run the recipe state machines against saved snapshots, the identity precheck on the real-layout fixtures and the wrong-outlet fixtures, the sha-skip, the xlsx→CSV conversion, and the log scrubber (with planted fake phones and codes) | ₹0 | All reject cases rejected; no secret survives the scrubber |
| T2 | **First live scripted run, observed:** Z1 Daily (7 days), S1 Daily (7 days), Z2 and S2 for one cycle each, on Pawan Putra. This records the *(confirm in T2)* labels, and uploads use dry-run if helper 4 exists | ₹0 if signed in; at most ₹60 per platform if a login run is needed | 4 files stored, or exact `ui_changed` steps found; no wrong-outlet file stored |
| **T3** | **Swiggy session-reuse proof**, after a known signed-in state (T2):<br>(a) stop the computer as the idle timer does, boot it, and probe;<br>(b) the next night, 12 hours or more later;<br>(c) 3 nights in a row;<br>(d) after a full stack restart.<br>Each probe only opens business-metrics and checks it isn't `/food/login`. Never log out and never clear data | ₹0 per probe | **Proven** if 3/3 nights and the restart all stay signed in. If not, record which step logs it out, then decide between a nightly password login (scripted `fill_secret`, or a login run) with Aman |
| T4 | Signed-out drill without touching the real login: point one run at an **empty test profile**, so it hits the login page | ₹0 | The job stops with `signed_out`, types nothing, and the 08:00 alert text comes out right |
| T5 | Mismatch drill with the fixture files fed in as if downloaded (we don't deliberately download another outlet) | ₹0 | 3 mismatches → that outlet and platform stops, `needs_owner` is set, and the other platform carries on |
| T6 | 7 unattended nights (05:30), including one Monday, one Tuesday and one Thursday | ₹0 expected; login runs at most ₹60 each, at most ₹150 a night | ≥6/7 nights complete, 0 wrong files stored, re-fetched days supersede as designed, and unchanged files are skipped |
| T7 | Backfill: Zomato 30 days in one go, Swiggy 30 days as 5 chunks | ₹0 | Matches the 12 Nov hand downloads cell for cell (same sha or the same parsed values) |

Every live run keeps a cap of about **₹150**, reports its cost in ₹, uses Grok x-ai/grok-4.7 only for logins (never Gemini), and never uses Playwright for the logins.

---

## 13. Cost per night per restaurant (only what has a real basis)

- **A normal night, logged in:** **about ₹0 in model spend.** The downloads are scripted and use no model at all. The 12 Nov hand downloads of these exact files cost ₹0. *This is a design estimate; T6 measures it.*
- **A night that needs a login:** **not known yet.** No login has been measured on its own. The closest real figures are:
  - whole agent runs that included a Swiggy password login and then got stuck: ₹208;
  - Zomato payout agent runs: ₹99–126 each.

  The design caps each login run at about **₹60** and the whole night at **₹150**. T2 and T3 measure the real number.
- **If downloads fell back to an agent** (off by default): from real runs, ₹99–126 per payout file per platform and ₹177–208 per business-report attempt. That's why the fallback is off.
- **The scheduler (Grok Bot routine):** it uses some of Aman's Grok Bot usage every night. The usage page shows only a share of the week, not ₹, so its cost is **unknown in ₹**. T6 measures it as a percentage.
- **Box compute:** no extra ₹ while we stay on this box. Hosting cost is step 4.
- **Time:** not known. Each scripted report should take seconds to a minute or two, so a restaurant with one outlet on both platforms should be well within the window. T2 measures it.

---

## 14. Open questions for Engineer - SaaS

1. **`fetch-plan` shape.**
   - Can it return exact windows per report kind: the daily 7 days, the weekly and monthly checks on their days, payout cycles with platform cycle dates, and `pending` or `lag_banner` flags?
   - Can it split backfills into Swiggy ≤7-day and Zomato ≤30-day chunks, capped at 90 days a night?
   - Should the server or the job own the calendar in §4? I'd like the server to own it.
2. **What check-by-sha256 hashes.** `ingestBusinessReport` hashes the **CSV text**, and a Swiggy xlsx turned into CSV changes its hash if the converter changes. Can the helper key on the **raw downloaded bytes** (a new `rawSha256` field on both POSTs), per outlet, platform, kind, window and parser version?
3. **A log-only fetch row.** Can we have `POST /agent/v1/fetches` to record `signed_out`, `download_failed`, `ui_changed` and `local_mismatch` *without* uploading a file?
   - It means a failed night is an explicit gap row, as DATA-DESIGN §5 says.
   - Another restaurant's payout file (customer ids, PAN, UTRs) never has to be sent to our server just to be counted.
4. **Mismatch counting.** Today it's per exact window and for all time.
   - Business parse failures count towards the limit, payout parse failures don't, and a client `attempt` overrides the count.
   - Can it become identity mismatches only, per outlet and platform over a rolling 24 hours, with a `needs_owner` hold that stays until an admin clears it?
   - Should the local mismatches from Q3 count too?
5. **Owner and admin alert channel** when `EMAIL_PROVIDER` is empty. Can a `needs_owner` fetch create an attention item and post in the restaurant bot's thread, which uses the existing push and `NotificationPreference.help`? Which linked channels (WhatsApp or Telegram) can a server-side event use? Where will the admin panel read "expired logins / failed nights / mismatches / cost per night"?
6. **Swiggy upload format.** Should the server accept the Swiggy **xlsx** (base64) and convert it itself, so there's one parser and one identity check? Otherwise the job converts it to CSV. Can `checkObservedIdentity` and the period-label parser go in a small module the in-computer runner can import, so the local precheck can never drift from the server's?
7. **Is `periodEnd` exclusive** on both POSTs and on `fetch-plan` (the day after the last day)? And how should a Swiggy cycle split at the end of a month be expressed?
8. **One profile per restaurant.** Today the profile key is `sha256(botId)` and home folders are per team (`data/homes/team-<id>`).
   - Do we give each restaurant its own space and its own fetch bot, so their computers, homes and profiles never mix?
   - Can the orchestrator call `computer/boot`, `computer/status` and `GET /agent/v1/*` with an **operator or service token** instead of the owner session cookie it uses now?
   - Is `RESTAURANT_AGENT_TOKEN` in the computer scoped to one restaurant?
9. **Days with no data.** If Zomato or Swiggy leaves out a day column (for example the outlet was closed all day), the strict period check rejects the file as a mismatch. Should the identity check tell "missing day column" apart from "wrong dates" and store the rest with a gap? I'll check whether this happens in T6.
10. **Raw-file retention locally.** `OBJECT_STORAGE_BUCKET` isn't set, so redacted payout and business files aren't kept, while DATA-PLAN §4 keeps them for 13 months. Should the job keep the server-redacted copy on the box until hosting (step 4)? Or should we accept that there are no raw files until then?
11. **Scheduling later.** When we move to hosting, should the schedule become a worker cron, so it doesn't need a Grok Bot routine, and the runner a supervisor job that doesn't count as a bot run?
12. **Swiggy accounts with several outlets.** One login sees several outlets, one of which is the default, from another city. Confirm the outlet table holds `swiggyRid` per outlet and that `fetch-plan` lists only our outlets. The job never downloads an outlet that isn't in our table.

---

## 15. What goes in the repo and what stays on the box

| In the repo (generic, works for any restaurant, no restaurant data) | On the box only (never in the repo) |
|---|---|
| `infra/sandboxes/computer/rakazo-fetch-reports`: the in-computer runner, with the Z1/S1/Z2/S2 recipes keyed by visible text, the local identity precheck, the sha check, the uploads, and download hygiene | `/workspace/fetch-job/run_night.py`: orchestrator, second pass, summary (moves into the worker at step 4) |
| Unit tests on **fake-id fixtures** (900001/900002, and wrong-outlet 999001/999002) and saved, scrubbed page snapshots | Stack secrets, the operator session, the OpenRouter key, private login delivery |
| The `/agent/v1` helpers: fetch-plan, the sha check, fetches, and dry-run (Engineer - SaaS) | Browser profiles (cookies and storage), the outlet settings files with real ids, Downloads |
| The log scrubber and its tests; a doc page on the recipes and their guards | Logs, run summaries, the cost ledger |
| — | The Grok Bot routine (05:30) and the Gmail access for Zomato codes |

The repo must never contain restaurant ids, names, credentials, admin emails, OTPs or real files.

---

## 16. Edge cases covered (checklist)

**Outlets and identity**
- Wrong outlet's file (§8, §9).
- Swiggy's default outlet being someone else's (§7 S1).
- A Swiggy login with several outlets (Q12).
- An outlet with no platform id (§8).
- A new outlet with less than 7 days of history (fetch-plan from `activeFrom`, partial-edge coverage is already on main).

**Dates and periods**
- Today's partial day is never fetched (§4).
- Zomato restating the last ~5 days, covered by the 7-day re-fetch, with the 3rd-of-month check as a safety net.
- Swiggy's 7-day cap (§4, §7).
- Swiggy's 48-hour lag banner (Tuesday week check; payouts re-read until the banner is gone).
- The Swiggy annexure has no year, which matters over December–January (§8).
- Swiggy cycles split at the end of a month (Q7).
- Zomato's current open cycle is skipped (§7 Z2).
- A pending cycle is re-pulled until it settles.
- A day column missing because the outlet was closed (Q9).

**Downloads**
- A stalled download, or one saved under a random name, plus an extra PDF (§7 S2).
- Stale files in Downloads (§7, the `--since` rule).
- Payout files deleted after upload (§5).
- An unchanged file is skipped (sha).

**Login and access**
- Login expired (§6).
- Swiggy asking for an OTP (stop, never resend).
- The owner using the computer at the time (§5, skip and retry).

**Platform and infrastructure**
- The platform is down (second pass).
- A UI change (`ui_changed`, no wandering).
- The box restarting, as happened today, with Docker gone (preflight → `stack_down` alert).
- A version label that doesn't match the images (recorded in the log).
- Memory (restaurants run one at a time).
- Anti-bot pacing (20 s between downloads, one tab).

**Money**
- Cost runaway: no model on the normal path, logins capped at ₹60, the night at ₹150, using the existing key-meter guard (`budget_guard.py`).
