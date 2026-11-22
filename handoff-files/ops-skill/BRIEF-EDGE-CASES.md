# Daily brief and alerts: edge cases (data, message text, delivery)

PR #27 (`cursor/ops-daily-brief-0fbd`), head **9947f602**. Written 15 Nov 2026, IST.

**Scope (changed by Aman on 15 Nov, 22:51 IST).**
- This file covers data states, message text, notify/delivery and the alert lifecycle.
- The per-rule thresholds and boundaries are **out of scope**. Raghav will define which metrics matter and their Watch/Act now limits (see `ASK-FOR-RAGHAV.md` and `METRIC-TREE-DRAFT.md`).
- Rule names below (sales drop, zero orders, online, …) are used only to describe situations.

**Related files.**
- Metric list: `METRICS-BY-PLATFORM.md`.
- Guide skeleton: `DAILY-BRIEF-GUIDE.md`.

**Sources.**
- `OPS-AGENT-DESIGN.md` §1, §3, §4, §6, §10.
- The PR code: `packages/contracts/src/ops/{rules,alerts,brief,types,format}.ts` and `packages/db/src/ops-daily.ts`.
- The live outputs in `live-agentv1/pr27-test/` and `pr27-test2/`.
- `fetch-job/blankday.py` and its README.
- A read-only look at the local DB. Postgres was started, queried and stopped again; Docker is still running.
- A probe script that runs the PR's own code on synthetic days: `/workspace/tmp/probe/p.ts` (results P1–P15 below).

**Legend for the "Head" column**
- ✅ handles: code and/or an existing test.
- ❌ fails: proven by a live output, the probe, or a direct code read (cited).
- ◐ partial.
- ⬜ not built: runner side, or not in this PR.

All example text is synthetic (outlet "Test") unless it quotes a live output.

---

## 0. Ground facts found while writing this

1. **Swiggy is normally one day behind.** On 15 Nov, stored Swiggy data ran to 13 Nov, and Zomato's 14 Nov column was blank. So at 08:30, Swiggy's D−1 is **usually missing**. That is the steady state, and the brief has to read well every day in that state.
2. **`lag_banner` is never stored.** The DB has 0 rows for that key. Every "lag banner → provisional / capped at Watch" path (`rules.ts:293-294,334`; `brief.ts:204-207`) never runs on real data, so a partial Swiggy day is treated as final.
3. **Zero vs blank is decided in two places that disagree.**
   - The fetch job cuts an all-zero column only if the day is ≤ 3 days old (`blankday.py:9,77`), and stores older zero days as real.
   - The server's `blankDay()` (`rules.ts:731-737`) treats **any** stored all-zero day, **any** 0 % online and **any** 0.00 rating as "not in yet", at any age.
   - So a real closed day, a full-day offline, or a new outlet with no rating can never raise an alert.
4. **Call-outs come from the day's findings, not from alert rows.** `brief.ts:130-137` and `briefStatus` at `64-68` read `finding.severity`. So escalation, snooze, dismiss and the "back again but don't re-notify" rule never reach the text (bug C and others).
5. **Grouping collapses different apps.** `ruleFamily()` returns the rule code (`types.ts:113-117`), and `displayFindings` groups by `outlet:family` (`rules.ts:905-908`). Zomato delayed and Swiggy delayed become one call-out, and the other is hidden (probe P2).

---

## 1. Global rules (one property test each, run over every case below)

| ID | Rule | Head |
|---|---|---|
| G1 | Each line's mark (🔴/🟡) equals the stored alert's severity after this run (escalated or de-escalated), never the day's raw level | ❌ `brief.ts:130-137,299-303` (bug C) |
| G2 | The header shows the worst mark among every open, unsnoozed alert displayed anywhere in the brief. Header counts equal the 🔴/🟡 lines, plus "+N more" | ❌ `brief.ts:249-256` counts only the ≤ 3 call-outs |
| G3 | Never 🟢 "Healthy" or "All good" unless **every connected outlet × app** has evaluable data for that date and nothing is open. Swiggy's normal lag gets its own header (MT-03) | ❌ bug A; probes P3, P4, P5, P7 |
| G4 | Each alert (dedupe key) appears in at most one line | ❌ bug B (catch-up repeats); P15 (app and combined sales both shown) |
| G5 | Every number on a line belongs to the date printed on that line. No date = the brief date | ❌ test2 13 Nov: "Thu 12 Nov: Both apps sales down 32.3% … (₹34,328 vs ₹50,711)" shows 13 Nov's figures |
| G6 | A missing day is never zero, and a real zero day never stays "not in yet" for ever | ◐ missing ✅, zero ❌ (fact 3) |
| G7 | Rates stay per outlet × app, never added or averaged across apps, outlets or days | ✅ `rules.ts:833-861`, `ops.test.ts:1074` |
| G8 | Same inputs give the same text, status and alert rows | ✅ `ops.test.ts:639`, `ops-daily.postgres.test.ts:173` |
| G9 | A `ready:false` brief is never pushed to the owner | ❌ `alerts.ts:591-593` notifies on a status change even when not ready (P13) |
| G10 | Ratings shown are only the platform's figure. Nothing in the brief averages them (Aman: a monthly rating = the average of the daily platform figures, for the dashboard and analyst) | ✅ `rules.ts:580-624`; rollups carry no rating |

---

## 2. Data states (per outlet × app × date)

D = the brief's business date (yesterday). Each run evaluates D−1 (catch-up), then D (`ops-daily.ts:100-137`).

| ID | Situation | Expected text / rule · alert state · notify | Head | Test to write |
|---|---|---|---|---|
| DS-01 | Normal: both apps stored | `*Good morning · Test*` / `Sat 14 Nov vs Sat 7 Nov · 🟢 Healthy` / `Net sales ₹40,000 (+0.0%) · Zomato ₹20,000 (0.0%) · Swiggy ₹20,000 (0.0%)` / `80 delivered · AOV ₹500` / `Week so far (Mon–Sat): …` / `All good on both apps. Data as of Sun 15 Nov, 05:48.` · notify (first ready) | ◐ the "Data as of" date is wrong (MT-10) | golden file |
| DS-02 | Quiet but real day, below the volume guards | Guarded rules are **held**, not cleared. Figures shown. Note once: `Too few orders on Zomato yesterday to judge rates.` · open alerts frozen | ◐ hold ✅ (`rules.ts:649`); no note | 14 vs 15 delivered: alert frozen, note shown |
| DS-03 | Real closed day (all zeros, the owner was shut) | Still zero once the day is ≥ `{blank.waitDays}` old → real: `🔴 Zomato had no orders on Sat 14 Nov (usually 40). Fix: confirm the outlet was open and visible on Zomato that day.` Late-check alert with its own date · notify | ❌ `rules.ts:736` treats it as blank for ever. The existing test (`ops.test.ts:343-347`) uses ₹5,000 sales with 0 orders, which isn't a real closed day | all-zero day at age 0/1/2/3 |
| DS-04 | Blank day cut by the fetch job (gap recorded) | `Zomato's figures for Sat 14 Nov aren't in yet; we'll check them tomorrow.` Header never 🟢 · Zomato and combined frozen · 11:00 retry | ❌ test2 `gap-2026-11-14.json`: `Sat 14 Nov · 🟢 Healthy` … `All good on both apps.` (bug A; `brief.ts:84-86,105-107,288-292`) | one app gap; both apps gap |
| DS-05 | Blank file never posted (every column blank → no fetch row) | Same text as DS-04 | ❌ probe P7: Zomato counts as "failed" with no reason, there's **no note**, and the brief says `🟢 Healthy … All good on Swiggy.` | no row and no fetch → note, not 🟢 |
| DS-06 | Blank day stored anyway (zeros in the DB) | Same as DS-04 | ❌ no note for Zomato `lag_missing` (`brief.ts:215-223` only notes Swiggy); probe P4 shows 🟢 | — |
| DS-07 | Online 0 % on a day **with** orders (feed glitch) | Only `online_pct` is marked n/a; every other rule runs. Note `Zomato online time not reported for Sat.` | ❌ `rules.ts:734` drops the whole app-day (P3) | online 0 with 40 orders |
| DS-08 | Genuine full-day offline (online 0 %, 0 orders) | After the wait window, as DS-03: `🔴 Zomato was offline all day Sat 14 Nov (0 orders, usually 40).` · Act now · notify | ❌ (bug D) `rules.ts:734`; and the online rule is also guarded by ≥ 15 delivered (`rules.ts:517`), so a low-order offline day is hidden too (P6) | — |
| DS-09 | Swiggy D missing at 08:30 (normal 48 h lag) | Header `Sat 14 Nov vs Sat 7 Nov · 🟢 Zomato healthy · Swiggy pending`. Note: `Swiggy's figures for Sat 14 Nov aren't in yet (Swiggy can take up to 48 hours); we'll check them tomorrow.` Swiggy D−1 catch-up lines **kept** · Swiggy frozen | ❌ the special lag form (`brief.ts:29,313-323`) drops catch-up, ongoing, resolved and week lines, and sets amber while saying "All good on Zomato" | Swiggy missing + Swiggy Act-now catch-up → line kept, header 🔴 |
| DS-10 | Swiggy D present but partial | `Note: Swiggy figures for Sat may change within 48 hours.` Sales drop and zero orders capped at Watch (provisional), re-checked next run | ❌ in practice (fact 2). Fix: store `lag_banner`, or treat Swiggy D as provisional by default | ingest stores the banner; Swiggy D with no banner → provisional |
| DS-11 | Zomato partial day (some columns filled) | Zomato has no banner. Proposed: delivered < `{partial.ratio}` of D−8 before 07:30 → provisional, re-check at 11:00 and the next day | ❌ no detection; fires Act now | half-day at 08:30 |
| DS-12 | Revision to D−1 (Zomato restates, Swiggy fills late) | Alert value and text update. No second notify unless it got worse (see AL-12) | ✅ `alerts.ts:361-400` | restate lower / higher |
| DS-13 | Revision to D−2…D−5 | Stored facts change. Alerts don't move. The week line uses the new numbers | ◐ by design: only D−1 is re-evaluated | — |
| DS-14 | Fetch failed, retryable (`download_failed`) | `Zomato: not updated this morning (the download failed).` Never 🟢 · frozen · 11:00 retry | ◐ the note ✅ (`brief.ts:210-213`); the header can be 🟢 (G3) | one failed, other clean → not 🟢 |
| DS-15 | Login expired (`signed_out`) | `Swiggy: not updated this morning (login expired, we're reconnecting).` Same rules as DS-14 | ◐ same header gap | — |
| DS-16 | `layout_changed` | `Zomato: not updated this morning (Zomato changed its report; we're fixing it).` Not retried at 11:00; team alerted | ◐ the blocker code is `days_missing` (`types.ts:57-61`), so the runner can't tell it from a missing day | distinct blocker code |
| DS-17 | Held fetch (identity mismatch) | `Swiggy: updates paused while we double-check the account; our team is on it.` Never retried | ◐ ✅ never retried (`ops.test.ts:389`); the text "the fetch is held" is jargon | wording golden |
| DS-18 | `needs_owner` | `Zomato: not updated this morning. We need you to {action}; we'll message you.` | ◐ the text "the account needs the owner" | — |
| DS-19 | Metric `updating` (renamed column) | That rule held. Note: `Zomato prep time is being re-read after a report change.` | ❌ no `updating` note (design §1 asks for one) | updating KPT → note |
| DS-20 | Metric `not_available` | Held; "n/a" in the payload; no daily nag | ◐ held silently | — |
| DS-21 | Only one app connected | `… 🟢 Healthy` / `Zomato ₹20,000 (0.0%)` … `All good on Zomato.` No combined rules, no "Swiggy not in" note | ✅ `rules.ts:78-80`, `brief.ts:105-107`, `ops.test.ts:916` | — |
| DS-22 | Neither app connected | No owner brief, `ready:false`, no notify. In-app: `Connect Zomato or Swiggy to get your morning brief.` | ◐ stores "No new data this morning" (`brief.ts:28,84-86`) | — |
| DS-23 | New restaurant, no D−8 or D−15 | `Sat 14 Nov · 🟢 Healthy` (no "vs"). Comparison rules held. Note once: `Comparisons start once we have a week of history.` | ◐ held ✅; no note | — |
| DS-24 | New outlet with no rating yet (0.00) | Rating marked n/a; the day is otherwise normal | ❌ `rules.ts:734` drops the whole day (P5) | — |
| DS-25 | First-ever run | No catch-up lines and no "back to normal" lines | ❌ test2 first run (8 Nov) printed `Sat 7 Nov: Swiggy complaints 4 of 70 delivered (5.7%).` | empty alert table → no catch-up |
| DS-26 | Comparison day (D−8) missing, D−15 present | `vs Sat 31 Oct (two weeks back)` | ❌ probe P11: "vs last Saturday" (`rules.ts:295`); the header uses Zomato's baseline date only (`brief.ts:114`) | — |
| DS-27 | Comparison day itself partial | Not used as a baseline | ◐ under-guard and failed days skipped (`rules.ts:663-672`); a partial one is used (live 11 Nov: Swiggy +180.4 %) | — |
| DS-28 | Row with only `lag_banner` and no metrics | Not stored → not in | ❌ `ops-daily.ts:611-614` marks it stored → "All good" | — |
| DS-29 | Fact + platform_check rows for one key | The fact wins | ✅ `ops-daily.ts:604-606` | — |
| DS-30 | A failed fetch after a stored one for the same day | The stored data wins | ✅ `ops-daily.ts:642-650` (the DB has this for Swiggy 1–8 Nov) | order test |
| DS-31 | D not finished yet | 409 `not_finished` | ✅ `ops-daily.postgres.test.ts:596` | — |
| DS-32 | Both apps failed/blank | `No new data this morning; we'll update this when it lands.` `ready:false`, no notify, 11:00 retry | ◐ ✅ when both failed; ❌ when the cause is a gap (DS-04) | — |

---

## 3. Business situations (not thresholds)

| ID | Situation | Expected | Head | Test |
|---|---|---|---|---|
| BS-01 | Multiple outlets: rates per outlet | Every rate rule runs per outlet × app. Call-outs are prefixed `Park Street: …` | ✅ `rules.ts:74-112`, `brief.ts:133-135` | — |
| BS-02 | Multiple outlets: one outlet's app missing | The restaurant sales line says what's left out: `Net sales ₹52,000 (+3.1%, excl. New Town Zomato, not in yet)`. That outlet isn't counted in "N outlets healthy" | ❌ `brief.ts:108-110` counts an outlet with missing data as healthy, and there's no exclusion note | 2 outlets, 1 failed |
| BS-03 | Multiple outlets: one line per outlet that isn't Healthy (design §4) | `New Town: 🟡 1 · Park Street: 🔴 2` then `3 outlets healthy` | ◐ only the name prefix on call-outs | golden |
| BS-04 | Same alert type on both apps (Zomato delayed + Swiggy delayed) | Two lines, or one line naming both apps; neither is hidden | ❌ probe P2: only the Swiggy line is shown (fact 5) | — |
| BS-05 | App sales drop and combined sales drop on the same day | One call-out for the sales family (design §2), with the app named: `🔴 Zomato sales down 60.0% vs last Saturday (total down 42.5%)` | ❌ probe P15: two call-outs, plus "visible on Both apps" | — |
| BS-06 | Festival or holiday as D or as the D−8 baseline (Diwali was Sun 8 Nov 2026) | Proposed: a holiday list; when D or D−8 is on it, the sales comparison is labelled `(festival week)` and capped at Watch | ⬜ no calendar | needs Aman (Q3) |
| BS-07 | Week-so-far with missing days | Like-for-like pairs only (same day **and** same app in both weeks). The label names the days actually used: `Week so far (Mon–Fri, Sat not in yet): ₹1,94,770 (+7.4%)` | ❌ bug A part 2: always "Mon–{D}" (`brief.ts:170-175`); probe P14 printed "Mon–Sat" using only Wed and Fri; it mixes apps per day (`ops-daily.ts:714-724`), so a Zomato-only D is compared with last week's two apps | — |
| BS-08 | Week-so-far on Monday | No week line | ✅ `brief.ts:152` | — |
| BS-09 | Week-so-far on Sunday | `Week so far (Mon–Sun)` | ✅ live 8 Nov | — |
| BS-10 | Month or year boundary (Sun 1 Nov vs Sun 25 Oct; Thu 31 Dec vs Thu 24 Dec) | Dates and baselines are plain civil days | ✅ `format.ts` ISO-day maths | 31 Dec / 1 Jan golden |
| BS-11 | Outlet deactivated or app disconnected while alerts are open | Those alerts resolve with reason `scope_removed`, silently | ❌ never touched (`alerts.ts:196-215` only freezes connected scopes), so they stay open for ever | — |
| BS-12 | Steady state: Swiggy findings arrive a day late every day | Swiggy lines always carry their date: `🟡 Fri 13 Nov · Swiggy food ready 78.0%. Fix: …` and count in the header | ◐ dated catch-up lines exist, but they come through the buggy `carryForward` (AL-08) and are dropped by the lag form (DS-09) | — |

---

## 4. Alert lifecycle

Alert rows: `alerts.ts`. The windows (3 days to escalate, 2 clear days to resolve, 7 days to go stale or reopen, 3 days for "back again") are placeholders too, in `config.ts:127-134`.

| ID | Situation | Expected | Head | Test |
|---|---|---|---|---|
| AL-01 | Opens | A new row; notify; a full call-out | ✅ `alerts.ts:261-283` | ✅ `ops.test.ts:481` |
| AL-02 | Dedupe | One open row per `daily:rule:outlet:app` | ✅ unique index, `ops.test.ts:639` | — |
| AL-03 | Watch held 3 evaluable days → Act now | Escalated once; notify; the brief shows 🔴 with `(held 3 days)` | ◐ the state ✅ `alerts.ts:298-307`; the brief shows 🟡 (bug C; live 11 Nov: food ready escalated on 10 Nov, shown 🟡) | — |
| AL-04 | After a held escalation, still at Watch level | **Stays Act now** until it clears. De-escalation only for an alert that went to Act now on its level and has since fallen to Watch level | ❌ probe P1: flaps Act now → Watch → Act now every 3 days, **re-notifying each time** (`alerts.ts:298-317`) | 9-day Watch run: 1 escalation notify |
| AL-05 | De-escalation (Act-now level → Watch level for 2 days) | Silent; the line shows 🟡 from then on | ✅ state `alerts.ts:308-317` | ✅ `ops.test.ts:481` |
| AL-06 | Resolves after 2 clear evaluable days | `✓ Swiggy delays back to normal.` once | ✅ `alerts.ts:402-434`, `ops-daily.ts:146-150` | ✅ |
| AL-07 | Stale after 7 days with no evaluable day | Resolved `stale`, silently; in-app note `Stopped tracking … (no data for 7 days)` | ◐ resolves ✅ `alerts.ts:436-460`; no in-app note | ✅ `ops.test.ts:499` |
| AL-08 | Catch-up (D−1 newly evaluated in today's run) | Only alerts **opened or escalated by today's D−1 step** (`earlierStep.notify`), each with the D−1 finding's own text, mark and date | ❌ bug B: `carryForward` repeats every alert notified yesterday, with the latest text (`brief.ts:349-383`, `ops-daily.ts:138-144`) | yesterday's call-out not repeated; a late Swiggy D−1 opener shown once |
| AL-09 | Ongoing line | Every open, unsnoozed alert not shown above, **including frozen ones** (for example Swiggy waiting), each with a mark and its last-seen date if that isn't D: `Ongoing: 🔴 Swiggy food ready 73.1% (Thu, day 4)` | ❌ only alerts that fired today are listed (`alerts.ts:218-225`), so frozen Swiggy alerts disappear; no marks | — |
| AL-10 | Reopen within 7 days | Same row, `reopen_count+1`, at the previous severity (design §3). Notified "back again" only if ≥ 3 days since the last notify, **otherwise ongoing line only** | ◐ reopens ✅ (`ops.test.ts:528`); uses the new severity (`alerts.ts:498`); the brief still shows a full call-out because call-outs come from findings | — |
| AL-11 | A frozen day | No escalation, no clear count; streak kept | ✅ `alerts.ts:436-468` | ✅ |
| AL-12 | A re-run the same day (11:00) | No double count; severity can only go up; text updates; version per MT/ND rules | ✅ `alerts.ts:82-84,361-400` | ✅ `ops.test.ts:639` |
| AL-13 | Out-of-order run or backfill of an older date | Alert rows don't move (✅). The older brief's ongoing and catch-up lines are built from rows **as of that date**, or are left out | ◐ rows ✅ (`alerts.ts:80-81`, `ops.test.ts:701`); its text uses today's rows | — |
| AL-14 | Revision after notifying makes the rule clear for that same date (for example a partial Zomato day filled in) | Alert withdrawn (`resolved_reason:'revised'`); next brief: `Correction: Sat's Zomato sales are now ₹19,800 (−1.0%); the earlier alert is withdrawn.` | ❌ `alerts.ts:403` ignores a clear on an already-evaluated date, so the false alert stays open | — |
| AL-15 | Snooze a Watch | Hidden from the brief and the feed until the snooze ends; escalation still shows | ❌ in the brief: call-outs come from findings, so a snoozed alert is still printed. The alerts list ✅ (`alerts.ts:249-259`) | — |
| AL-16 | Snooze an Act now | Not allowed (design §3: snooze hides a Watch) | ◐ `snoozeAlert` accepts any severity (`alerts.ts:230-236`) | API rejects |
| AL-17 | Dismiss | Resolved `owner_dismissed`; not shown or reopened for 7 days | ◐ row ✅ (`alerts.ts:487`); the brief still prints the finding | — |
| AL-18 | Alerts beyond the 3 call-out cap | Opened, but the brief says `+2 more in the app`, and they count in the header | ❌ live 12 Nov: 5 alerts opened, 3 printed, and the header said "Act now (2) · Watch (1)" | — |

---

## 5. Message text

| ID | Situation | Expected | Head | Test |
|---|---|---|---|---|
| MT-01 | Mark = alert severity | See G1 | ❌ | per-line check |
| MT-02 | Header counts = lines | See G2 | ❌ | — |
| MT-03 | Header when an app is pending or failed | `🟢 Zomato healthy · Swiggy pending`, `🟡 Watch (1) · Swiggy not updated`. Never a bare `🟢 Healthy` | ❌ `brief.ts:249-256` | — |
| MT-04 | Closing line | `All good on both apps.` only under G3. Otherwise `All good on Zomato; Swiggy pending.` | ❌ `brief.ts:288-292` (bug A) | — |
| MT-05 | No duplicates | See G4. No alert in both a call-out and the ongoing line (✅ `brief.ts:376`), nor in both catch-up and a call-out | ◐ | — |
| MT-06 | No repeats of yesterday | Yesterday's call-outs are not printed again. The only dated older line is a genuine late re-check, with that day's numbers | ❌ bug B | — |
| MT-07 | Words tied to "yesterday" | Rule texts use the day name, never "yesterday": `Zomato online 68.0% on Sat.`, `no delivered orders on Sat` | ❌ `rules.ts:335,532` say "yesterday", which is wrong in catch-up and backfill lines | — |
| MT-08 | Comparison wording | `vs last Saturday` only for D−8; `vs Sat 31 Oct` for D−15 | ❌ (DS-26) | — |
| MT-09 | Wording for combined | `Total sales down 32.3%`, never `Both apps sales`. Fix: `confirm the outlets were open and visible on both apps` | ❌ `types.ts:123-127`, live 13 Nov | — |
| MT-10 | "Data as of" | The capture date and time in IST: `Data as of Sun 15 Nov, 05:48 IST`. If unknown, leave the stamp out | ❌ live: `Data as of 8 Nov, 17:15.` for data captured on 15 Nov (`brief.ts:294-297` uses the business date) | — |
| MT-11 | Dates in IST | All civil dates come from IST; DB timestamps are UTC midnight of the IST day | ✅ `ops-daily.ts:608` (`indiaCivilDate`) | — |
| MT-12 | Week label | See BS-07 | ❌ | — |
| MT-13 | Length caps (≤ 700 all good, ≤ 1,200 with call-outs) | When trimming, drop lines in this order: resolved, ongoing detail, week. Keep the header, call-outs, notes and data stamp | ◐ `brief.ts:329-337` pops lines from the end, so the notes and data stamp go first | 4 outlets × 3 alerts |
| MT-14 | Numbers | ₹ with Indian grouping and no paise; % to 1 dp; a minus sign | ✅ `format.ts`, `ops.test.ts:760` | — |
| MT-15 | Negative or odd sales (refunds bigger than sales) | Treated as a data error: held, with note `Zomato sales look wrong for Sat; we're checking.` | ❌ would print `down 104.0%` | — |
| MT-16 | No UTRs, customer ids or order ids | — | ✅ `ops.test.ts:1142` | — |
| MT-17 | A placeholder threshold baked into fix text | Fix text takes its numbers from config: `…under {prep.actNow} minutes` | ❌ `types.ts:107` hard-codes "18 minutes" | — |
| MT-18 | The "lag only" form | Removed. The normal brief with the MT-03 header covers it | ❌ `brief.ts:29,313-323` | — |

---

## 6. Notify and delivery

The runner side (schedules, sending, recording) is AI-agents' work and isn't in this PR. Rules for both sides:

| ID | Situation | Expected | Head | Test |
|---|---|---|---|---|
| ND-01 | When it sends | Download at 05:30, build at 08:30, send at 09:00 IST | ⬜ runner | — |
| ND-02 | First ready brief | `shouldNotify:true, reason:first` | ✅ `alerts.ts:584-590` | ✅ `ops.test.ts:1039` |
| ND-03 | 08:30 not ready (both apps missing) | Stored, not sent; retried at 11:00 | ✅ `ready:false` → no notify | ✅ |
| ND-04 | 11:00 retry now ready | Sent (`first`) | ✅ `alerts.ts:594-596` | ✅ |
| ND-05 | 11:00 retry still not ready | Not sent. The in-app brief shows the no-data form | ◐ sends if the status changed (G9, P13) | — |
| ND-06 | 11:00 retry, the same status but a **new Act-now alert** | Sent again ("Update: …"). The reason is any new or escalated alert, not just a changed colour | ❌ `alerts.ts:591-597` only looks at the colour | — |
| ND-07 | 11:00 retry, the text changes but no alert changes | Version bumped and stored; not re-sent | ❌ the version stays the same while the text is overwritten (`alerts.ts:597`, `ops-daily.ts:178-190`), so deliveries can't be tied to the text the owner saw | — |
| ND-08 | Severity goes down at 11:00 | Not re-sent; the in-app copy updates | ◐ a colour change from red to amber re-sends | — |
| ND-09 | Idempotency | The same run twice → same version, no second send; the runner records each send per version | ✅ `ops-daily.postgres.test.ts:173` | — |
| ND-10 | Held fetch / layout_changed | Not retried at 11:00; the team is alerted | ✅ retryable flag; ⬜ alerting | — |
| ND-11 | Shadow mode (Aman A5: 2 weeks in-app only for Pawan Putra) | Nothing pushed; everything stored | ⬜ runner switch | — |
| ND-12 | Two runs at the same moment | Serialised | ✅ advisory lock `ops-daily.ts:114` | — |

---

## 7. Count and status at head 9947f602

**102 cases**: 10 global + 32 data + 12 business + 18 lifecycle + 18 text + 12 delivery.

| Head | Cases |
|---|---|
| ✅ handles | 27 |
| ◐ partial | 26 |
| ❌ fails | 46 |
| ⬜ not built (runner) | 3 |

Current head handles 27 and fails 72, counting partial as fail.

**Top gaps, in fix order (all one-place fixes):**
1. Build the brief from **alert rows**, not raw findings. That fixes bug C, snooze, dismiss, reopen and the header counts (G1, G2, AL-03, AL-10, AL-15, AL-17, AL-18).
2. One readiness check per outlet × app feeds the header and the closing line. That fixes bug A, P7 and the lag form (G3, DS-04/05/06/09, MT-03/04/18).
3. Catch-up = only `earlierStep.notify`, with D−1's own finding text (bug B, G5, DS-25).
4. Zero/blank: decide in one place with a wait window. A day still zero after the window is real (DS-03, DS-07, DS-08, DS-24; bug D).
5. Stop the escalation flapping (AL-04).
6. Group call-outs by outlet + app + rule, not outlet + rule (BS-04, BS-05).
7. Like-for-like week line with true labels (BS-07).
8. Store Swiggy's `lag_banner`, or treat Swiggy D as provisional (DS-10).
9. Small text fixes: the "Data as of" date, D−15 wording, "yesterday" wording, "Both apps" wording (MT-07–10).
10. Delivery: never send a not-ready brief; re-send on a new or escalated alert; bump the version on any text change (ND-05/06/07).

---

## 8. Open questions (for Aman or Raghav)

1. **Wait window for zero days.** How many days after a zero or offline day do we call it real and alert? Proposed: 2 days (the fetch job uses 3). *Raghav.*
2. **Header wording when Swiggy is pending** (every day, in practice): `🟢 Zomato healthy · Swiggy pending`, OK? *Aman.*
3. **Festivals and holidays.** Keep a list and soften comparisons on those days? Who keeps the list? *Raghav.*
4. **Corrections.** When late data withdraws an alert we already sent, should the owner get a "Correction" line in the next brief (proposed) or a separate message? *Aman.*
5. **Re-send at 11:00** when a new Act-now alert appears but the colour doesn't change: OK to send an "Update" message? *Aman.*
6. **An escalated "held 3 days" alert:** keep it at Act now until it clears (proposed), rather than dropping back to Watch? *Raghav.*

---

## 9. Added by Engineer - SaaS (review, 15 Nov, 23:05 IST)

| ID | Situation | Expected | Test |
|---|---|---|---|
| X-01 | Guard split: few delivered vs few bad orders | Delivered below the volume guard → rate rules **held** (DS-02). Delivered at or above the guard but bad-order count below its minimum → **clear** (counts toward the 2 clear days). Both paths in one test | 14 delivered/0 bad = held; 40 delivered/1 bad = clear |
| X-02 | Gap day older than the wait window and still no data | Not zero, not Healthy. Note `Zomato's figures for Sat 14 Nov never came in.` once; alerts for that scope keep the frozen/stale clock (AL-07) | gap recorded at age 0…8 |
| X-03 | Server wait window vs fetch-job cut window | One config key `blank.waitDays`; default equals the fetch job's 3 days so the two never disagree (Q1 later changes both) | config default = 3 |
| X-04 | Mixed connections across outlets (outlet A both apps, outlet B Zomato only) | B never shows "Swiggy pending"; combined rules for B don't run; the restaurant total says nothing about B's Swiggy | 2-outlet golden |
| X-05 | Config/threshold change while an alert is open | No flap: the alert is re-judged with the new config on the next evaluable day only; `configVersion` stored on the event; no extra notify unless it escalates | override mid-streak |
| X-06 | Call-out order | Deterministic: Act now before Watch, then by outlet name, app, rule. Same order in the brief and the alerts feed | shuffled inputs → same text |
| X-07 | Zero denominator (0 delivered with a rate metric present) | Rate shown as n/a, never `NaN%`/`Infinity%`; rule held | 0 delivered |
| X-08 | Outlet renamed while an alert is open | Lines use the current outlet name; dedupe key uses outlet id, so no new alert | rename mid-alert |

Defaults for §8 (all configurable, so a later answer is a config change only): Q1 `blank.waitDays` = 3 (see X-03); Q2 header `🟢 Zomato healthy · Swiggy pending`; Q3 holiday list = empty (feature off until Raghav supplies one); Q4 Correction line in the next brief; Q5 send an "Update" at 11:00 on any new or escalated Act now; Q6 held escalation stays Act now until it clears.
