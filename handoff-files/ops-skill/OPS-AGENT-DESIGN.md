# Always-on ops agent: design (step 3, rescoped)

Status: **draft for agreement. No code or PRs until it is agreed.**
Author: Engineer - SaaS. Date: 15 Nov 2026 (IST). Repo base: `main` at `d61dc31b` (#26 merged).
This supersedes the scope of `WEEKLY-OPS-REVIEW-DESIGN.md` (kept unchanged). Its rules engine, metric dictionary (§2), message rules (§4), Excel (§5) and conflicts (§9) carry over **by reference** unless this doc changes them.
Authority: Aman's addendum (Q14, Q15, Q18) > Raghav's answers (15 Nov) > repo `main` > older docs.
**All numbers here are synthetic. All outlet names and ids are fake.**

Ecomnomics vs the reference product: Friday by Numerize is loose inspiration only (daily brief, severity feed, chat, custom alerts). Nothing is copied: no wording, layout or rule set. We stand apart in three ways:
- **Owner-approved actions.** Every call-out can become an `Action` in `proposed` (existing table), and the owner approves it.
- **Fresh data.** Every brief is stamped "data as of HH:MM" from the 05:30 ingest.
- **A combined view.** One view covers both apps and every outlet, built from the same dictionary rules as the dashboard.

---

## 0. Decisions in one screen

| # | Decision |
|---|---|
| D1 | One **rules engine** (pure TypeScript in `packages/contracts/src/ops/`) has three rule sets: **daily**, **weekly** (unchanged from the weekly doc §3) and **payout**. Same inputs → same output. No model, ₹0. |
| D2 | **Daily brief** for D−1 ("yesterday"), compared with **D−8 (same weekday last week)**, per app and combined. Ready by **09:00 IST**. When nothing fires it is a short "all good". |
| D3 | **Daily call-outs** run the daily rule set. Severity is **Act now / Watch / Healthy**, with **one fix** each. Daily thresholds are **looser than weekly** and have volume guards (§2). |
| D4 | **Alert state** lives in a new `ops_alerts` table. There is one open alert per **dedupe key** = `cadence:rule:outlet:platform`, with first/last seen, consecutive days, escalation (Watch held **3** evaluable days → Act now) and auto-resolve after **2** clear evaluable days (§3). |
| D5 | **Weekly review** runs Monday 10:00 IST as designed. The **Thursday payout check** reuses the stored payout `metric_checks` (₹1 = `PAISE_SUM_TOLERANCE` for money, exact for counts) and adds paid-vs-statement, late-settlement, missing-orders and commission-drift checks (§5). |
| D6 | SaaS **computes and stores** every brief, review and check as a report. The runner **triggers** runs, **delivers** them and **records sends** (`ops_report_deliveries`). Delivery is in-app until step 4, then WhatsApp Business at hosting. |
| D7 | The **data analyst** (§8) and **"alert me when" rules** (§9) are the only parts with model cost. The analyst calls **typed read tools**, never raw SQL. A server-side **number check** rejects any answer whose numbers aren't in the tool results. Default model **grok-4.3**, never Gemini. |
| D8 | All 11 earlier open questions are resolved with defaults (§12), except the daily thresholds, Q13 and the Aman-only cost and data decisions (§13). |
| D9 | **2 PRs** for steps 1–3 (§11). The analyst and custom rules are designed so they can move earlier as PR C/PR D with no dependency on PR B. |

---

## 1. Schedule and dependencies

| IST | Who | What |
|---|---|---|
| 05:30–07:30 | runner (AI agents) | Nightly ingest D−7…D−1 (FETCH-JOB §4). Monday: Zomato week check. Tuesday: Swiggy week check. Thursday: payouts. Second pass ≈ 06:45. |
| 08:30 | runner → SaaS | `POST /agent/v1/ops/runs {kind:"daily", date:D−1}`. SaaS computes, upserts alerts and stores the report (idempotent). |
| 09:00 | runner | Delivers the brief (in-app notification now; WhatsApp at hosting) and records the delivery. |
| Mon 10:00 | runner → SaaS | `kind:"weekly"` for the last Mon–Sun week (weekly doc §1.2, retries 12:00, last send 14:00). |
| Thu 09:30 | runner → SaaS | `kind:"payout_check"` after the Thursday payout fetch. Its call-outs also appear in Friday's brief "ongoing" line if they're unresolved. |
| 11:00 (only if needed) | runner → SaaS | Re-run `daily` if the 08:30 run had retryable blockers. The report is upserted with `version+1`. It is re-delivered only if the severity changed (`deliver.shouldNotify`). |

**Ingest failed or held:** SaaS reads `metric_fetches` and `fetch_holds` for D−1.
- One app failed (`signed_out`, `download_failed`, `layout_changed`, `fetch_held`, `needs_owner`): the brief still goes out at 09:00 with the other app. The failed app's line reads, for example, "Swiggy: not updated this morning (login expired, we're reconnecting)". That app's rules aren't evaluated, its open alerts are **frozen** (no escalation, no resolve) and combined rules are skipped and labelled "Zomato only".
- Both apps failed: a one-line brief, "No new data this morning; we'll update this when it lands". `ready:false` with retryable blockers, and the runner re-runs at 11:00.
- A `fetch_held` (identity mismatch) is never retryable. The runner alerts the admins as today.

**`updating` / `not_available` / partial** (same as weekly doc §1.3). A rule whose input is `updating` (pending label) or `not_available` is **not evaluated**. Its alert is frozen, and the brief adds one note per cause. A day missing from storage is never treated as zero.

**Swiggy 48-hour lag (Q5):** at 09:00, Swiggy's D−1 is under the lag banner and can be **missing or partial**.
- **D−1 missing for Swiggy:** the brief shows Zomato for D−1 and says "Swiggy's figures for yesterday aren't in yet (Swiggy can take up to 48 hours)". Combined figures and combined rules are labelled "Zomato only". Swiggy D−1 is evaluated in **tomorrow's** run as a catch-up day, and those call-outs carry their own date ("Swiggy, Sat 14 Nov: …").
- **D−1 present with `lagBanner=true`:** figures are shown with "may change within 48 hours". Rules that can only get **worse** as late data arrives (delayed, complaints, poor-rated, food-ready, cancellations) run normally. Rules a partial day can falsely trigger (**sales drop, zero orders**) are capped at **Watch** and marked provisional, then re-checked in the next run before they can become Act now.
- **Catch-up window:** each daily run evaluates **D−1 and D−2**. Zomato restates up to about 5 days, and ratings and complaints arrive late. A D−2 result updates an alert's `last_value` but never sends a second notification for the same day.

---

## 2. Daily rule set (proposed; thresholds need Raghav, §13)

Baseline: D−8, the same weekday last week. If D−8 isn't evaluable (missing, updating, below the guard), use D−15. If that fails too, there is no comparison and only threshold rules run (Q7, applied daily, max 2 weeks back). Strict `>`/`<` (Q6). Rates use delivered orders as the denominator. Counts are shown with % (Q8/Q9). The sources are the same keys as weekly doc §2. Zomato daily KPT is Zomato's own daily figure (Q28 forbids only our weekly/monthly rebuild).

**Daily guards (an app-day is evaluable only if):** data stored and not `updating`; **sales rules:** baseline net sales ≥ ₹3,000 on that scope; **rate rules:** ≥ 15 delivered orders that day on that app **and** the numerator ≥ 2 orders; **zero-orders rule:** baseline ≥ 5 delivered.

| Code | Scope | Watch when | Act now when | Weekly equivalent |
|---|---|---|---|---|
| `d_sales_drop` | combined, Zomato, Swiggy | net sales vs D−8 down > 25 % | down > 40 % | > 15 % w/w |
| `d_zero_orders` | per app | 0 delivered, baseline ≥ 5, data stored | (always Act now) | zero orders |
| `d_delayed` | per app (Z KPT+10, S >10 min) | > 8 % of delivered | > 15 % | > 5 % |
| `d_bad_orders` | Zomato | `bad_orders_pct` > 12 % | > 20 % | > 8 % and rising |
| `d_cancel_reject` | Z `rejected_orders`, S `restaurant_cancelled_orders` | ≥ 3 orders and > 5 % | ≥ 6 orders or > 10 % | (shown, no rule) |
| `d_complaints` | per app | ≥ 3 and > 5 % of delivered | ≥ 6 and > 10 % | (shown) |
| `d_food_ready` | Swiggy | `food_ready_accuracy_pct` < 85 % | < 75 % | < 90 % |
| `d_online` | per app | online % < 85 % | < 70 % | < 90 % and falling |
| `d_prep` | one call-out for both apps (Q4) | KPT > 18 min **and** ≥ 2 min above D−8 | > 22 min | > 16 min and rising |
| `d_rating` | Zomato (rolling snapshot) | falls below 4.00, or down ≥ 0.05 vs D−8 | below 3.80 | < 4.0 or falling |

**Families (one call-out shown, flags counted once):** `d_sales_drop` combined + per app; `d_prep` both apps. Within a family the highest severity is shown, and the other members are attached as detail.

**Severity mapping:**
- **Act now:** any Act-now alert, an escalated Watch, or (weekly) 3+ flags or zero orders.
- **Watch:** any Watch, or (weekly) 1–2 flags.
- **Healthy:** no open, unsnoozed alerts for that outlet.
- **Mapping:** restaurant = the worst outlet. API `status`: `red|amber|green`. Weekly 🔴/🟡/🟢 = Act now/Watch/Healthy.

**Fixes:** exactly one per call-out, from a fixed template table keyed by `fix_key` (the weekly `FIX_TEMPLATES` plus the daily ones below). The engine fills only numbers and app names.
- `d_cancel_reject` → "Check stock and staffing at peak; mark items out of stock instead of rejecting."
- `d_complaints` → "Read yesterday's complaints in the partner app; fix the repeating item or packing issue."
- `d_online` → "Check the outlet stayed online through promised hours; look at the offline log."
- `d_zero_orders` → "Confirm the outlet was open and visible on {App} yesterday."
- Each fix offers **"Propose action"**, which creates an `Action` (`type:"other"`, `proposed`) for owner approval.

---

## 3. Alert state and dedupe

**Dedupe key:** `"{cadence}:{rule_code}:{outlet_id | 'restaurant'}:{platform}"`, for example `daily:d_delayed:out_123:swiggy`. The date is **not** in the key. A family's members keep their own keys and share a `family` column for display.

**Lifecycle (per evaluation of a business date):**

| Rule result | No open alert | Open alert |
|---|---|---|
| fires | create (`first_seen=last_seen=date`, `consecutive_days=1`) and notify | `last_seen=date`, `occurrences+1`, `consecutive_days+1` if the previous evaluable day was the last one, else reset to 1. Not re-notified |
| clear (evaluable) | — | `clear_days+1`. At **2** → `resolved` (`resolved_reason:'cleared'`), noted once in the next brief: "✓ Swiggy delays back to normal" |
| not evaluable (missing/updating/guard) | — | frozen. After **7** days with no evaluable day → `resolved` (`'stale'`) |

- **Escalation:** a Watch on **3 consecutive evaluable days** → Act now (`escalated_at`, reason "held 3 days"), and it is notified again. An Act now alert whose value sits at Watch level for 2 days → de-escalated silently.
- **Cooldown and flapping:** an alert that resolved less than **7 days** ago and fires again is **reopened** (same row, `reopen_count+1`), at its previous severity. It's notified as "back again" only if 3+ days have passed since `last_notified_at`, otherwise it goes on the ongoing line only.
- **Brief display:** new and escalated alerts get a full call-out (max **3**, Act now first). Other open ones get one line: "Ongoing: Swiggy food ready below 85% (day 3)".
- **Owner controls:** **Snooze** (1/3/7 days) hides a Watch, but escalation to Act now still shows. **Dismiss** = resolve with `'owner_dismissed'` and a 7-day reopen suppression.

**Migration sketch (PR A, `20261216120000_ops_alerts`, after `20261215190000`):**
```prisma
model OpsAlert {                      // @@map("ops_alerts"), RLS by spaceId like restaurant_reports
  id String @id @default(cuid())
  restaurantId String; spaceId String; outletId String?       // null = restaurant-level
  platform String                     // zomato | swiggy | combined
  cadence String                      // daily | weekly | payout | owner_rule
  ruleCode String; family String?; ownerRuleId String?
  dedupeKey String
  severity String                     // act_now | watch
  status String @default("open")      // open | snoozed | resolved
  firstSeenDate DateTime @db.Date; lastSeenDate DateTime @db.Date
  occurrences Int @default(1); consecutiveDays Int @default(1); clearDays Int @default(0)
  reopenCount Int @default(0)
  escalatedAt DateTime?; snoozedUntil DateTime?
  resolvedAt DateTime?; resolvedReason String?   // cleared | stale | owner_dismissed
  lastValue Decimal? @db.Decimal(20,4); threshold Decimal? @db.Decimal(20,4); baselineValue Decimal? @db.Decimal(20,4)
  evidence Json                       // the OpsCells used (key, platform, window, value, status)
  fixKey String; text String @db.Text
  lastNotifiedAt DateTime?; notifiedSeverity String?
  createdAt DateTime @default(now()); updatedAt DateTime @updatedAt
  @@index([restaurantId, status, lastSeenDate])
  // SQL: CREATE UNIQUE INDEX ops_alerts_open_key ON ops_alerts(restaurant_id, dedupe_key) WHERE status <> 'resolved';
}
model OpsAlertEvent {                 // @@map("ops_alert_events"), append-only audit
  id String @id @default(cuid()); alertId String; spaceId String
  businessDate DateTime @db.Date
  kind String                         // opened | seen | escalated | deescalated | resolved | reopened | snoozed | notified
  severity String?; value Decimal? @db.Decimal(20,4); reportId String?; actor String?   // system | owner:<userId>
  createdAt DateTime @default(now())
}
// restaurant_reports (existing Report) gains:
//   kind String?  (daily_brief | weekly_review | payout_check), businessDate DateTime? @db.Date,
//   payload Json? (the structured brief), version Int @default(1), dataAsOf DateTime?
//   unique (restaurantId, clientNonce) already exists: nonce = "<kind>-<date>"
model OpsReportDelivery {             // @@map("ops_report_deliveries")
  id String @id @default(cuid()); reportId String; spaceId String; reportVersion Int
  channel String                      // in_app | whatsapp
  status String                       // sent | failed | skipped
  runId String; externalId String?; error String? @db.Text; sentAt DateTime
}
```
No phone numbers are stored here. WhatsApp recipients come from the hosting-time channel binding (step 4).

---

## 4. Daily brief format

Rules: plain text with `*bold*` only. ₹ uses Indian grouping, no paise. % to 1 dp. **≤ 700 chars when all good, ≤ 1,200 with call-outs.** Multi-outlet: one restaurant line + one line per outlet that isn't Healthy, + "N outlets healthy". No UTRs, customer ids or order ids. Sections: header (date vs baseline, status) → sales/orders/AOV → per-app split → call-outs (≤ 3) → ongoing (1 line) → resolved (1 line) → week-to-date (Mon…D−1 vs same days last week; skipped on Monday) → notes → "data as of".

**All good (SYNTHETIC):**
```
*Good morning · Sample Kitchen*
Sat 14 Nov vs Sat 7 Nov · 🟢 Healthy
Net sales ₹18,400 (+6.2%) · Zomato ₹11,200 (+4.7%) · Swiggy ₹7,200 (+8.6%)
42 delivered · AOV ₹438
Week so far (Mon–Sat): ₹1,02,300 (+2.1%)
All good on both apps. Data as of 05:48.
```
(Check: baselines ₹10,700 + ₹6,630 = ₹17,330; 18,400 ÷ 17,330 = +6.2 %; 18,400 ÷ 42 = ₹438.)

**With call-outs (SYNTHETIC):**
```
*Good morning · Sample Kitchen*
Sat 14 Nov vs Sat 7 Nov · 🔴 Act now (2) · 🟡 Watch (1)
Net sales ₹12,900 (−25.6%) · Zomato ₹5,700 (−46.7%) · Swiggy ₹7,200 (+8.6%)
33 delivered · AOV ₹391

🔴 Zomato sales down 46.7% vs last Saturday (₹5,700 vs ₹10,700). Fix: confirm the outlet was open and visible on Zomato through dinner.
🔴 Zomato online 68.0% yesterday. Fix: check the outlet stayed online through promised hours; look at the offline log.
🟡 Swiggy delayed orders 2 of 18 delivered (11.1%). Fix: start prep on accept and mark food ready only when it is.
Ongoing: Swiggy food ready below 85% (day 2).
Note: Swiggy figures for Sat may change within 48 hours. Data as of 05:48.
```
(Check: 5,700 + 7,200 = 12,900 vs 17,330 = −25.6 %; the combined drop is in the sales family, so one call-out shows. 12,900 ÷ 33 = ₹391.)

**Swiggy day missing (SYNTHETIC):** "Swiggy's figures for Sat 14 Nov aren't in yet (Swiggy can take up to 48 hours); we'll check them tomorrow. *Zomato only:* net sales ₹11,200 (+4.7%) · 26 delivered. All good on Zomato."

---

## 5. Monday weekly review and Thursday payout check

**Weekly review:** unchanged from `WEEKLY-OPS-REVIEW-DESIGN.md` §1–§5 (rules, message, Excel), with three changes:
- (a) It is produced by `POST /agent/v1/ops/runs {kind:"weekly"}` and stored as a report with `kind:'weekly_review'`, replacing the planned standalone `GET /agent/v1/ops-review`. That read survives as `GET …/ops/reports/:id`.
- (b) Weekly warnings are written to `ops_alerts` with `cadence:'weekly'` (dedupe across weeks the same way: escalate after 2 consecutive weeks, resolve after 1 clear week).
- (c) The defaults in §12 are applied.

**Thursday payout check** (`kind:"payout_check"`), per outlet × app × each cycle stored or changed since the last check:

| Check | Source | "Short / mismatch" when | Severity |
|---|---|---|---|
| P1 paid vs statement | `PayoutCycle.paidAmountPaise` vs `platformNetPayoutPaise` | paid < statement by **> ₹1** (`PAISE_SUM_TOLERANCE` 100 paise) | Act now if the gap ≥ ₹500 or ≥ 1 % of statement; else Watch. Overpaid > ₹1 → Watch (info) |
| P2 statement vs rebuild | stored `metric_checks` for that payout fetch (`platform_net_payout_paise`, `net_payout_paise` per order, `gross_sales_paise`, fees, taxes, TDS/TCS; counts exact) | any `pass=false` that isn't `skipped` | same ₹ bands on the summed gap. The number of failed orders is shown |
| P3 late settlement | cycle `settlementStatus='pending'` past the expected day (Zomato Wed, Swiggy Wed) | 1 day late → Watch; ≥ 3 days → Act now | — |
| P4 orders missing from payout | business `delivered_orders` for the cycle days vs payout rows with a delivered status | gap > max(2, 2 %) | Watch |
| P5 commission drift | Σ `commission_paise` ÷ Σ `cv_paise` vs `outlets.zomatoCommissionPct` / `swiggyCommissionPct` | differs by > 0.5 pts | Watch |
| skipped | checks with `skipped:true, reason:'pending_label'` | — | "Can't check yet: a payout column was renamed (updating)." No alert |

Cycles follow the platform: Zomato Mon–Sun, Swiggy Sun–Sat. Q22 says settled weeks never change, so a passed cycle is checked once and re-checked only if a new payout fetch changes its sha. UTRs show as **last 4 only** (`utrLast4`).

**Sample (SYNTHETIC):**
```
*Payout check · Sample Kitchen*
Zomato 2–8 Nov: paid ₹71,240 on Wed 11 Nov (UTR …4821). Matches the statement ✓ · commission 18.0% (agreed 18.0%)
Swiggy 1–7 Nov: paid ₹38,905, statement ₹39,605 → 🔴 short ₹700 (1.8%). Fix: raise a payout ticket in the Swiggy partner app with the cycle dates.
```
The Thursday report also carries **Gross Sales** (Q14) and the payout block (weekly doc §2/§5), including **Taxes = GST on fees only** (Q21).

---

## 6. API contract

All endpoints use RLS through `runAsTenant`. Agent routes use the restaurant-scoped agent token, and owner routes use the session. The agent token is refused on owner routes, as today.

**Runner (Engineer - AI agents calls):**
- `POST /agent/v1/ops/runs` with `{ kind: "daily"|"weekly"|"payout_check", date?: "YYYY-MM-DD", weekStart?: "YYYY-MM-DD", runId }`. Computes, upserts alerts, stores the report, idempotent per `(kind, date)`. Returns `OpsRunResult`. Errors: 400 bad date or not a Monday; 409 the period isn't finished.
- `GET /agent/v1/ops/reports/:id` · `GET /agent/v1/ops/reports/:id/workbook` (weekly, multi-outlet; xlsx).
- `POST /agent/v1/ops/reports/:id/deliveries` with `{ reportVersion, channel, status, runId, externalId?, error?, sentAt }` → 201. **The runner records every send.**
- `GET /agent/v1/ops/alerts?status=open` (for the runner's own admin alerts).
- `POST /agent/v1/runs` (existing) for job start and finish.

**Owner UI (SaaS frontend calls):**
- `GET /api/v1/restaurants/:rid/ops/feed?from&to&kind` → report summaries (newest first).
- `GET /api/v1/restaurants/:rid/ops/reports/:id` (+ `/workbook`).
- `GET /api/v1/restaurants/:rid/ops/alerts?status&severity&outletId`.
- `POST /api/v1/restaurants/:rid/ops/alerts/:id/snooze {days: 1|3|7}` · `/dismiss {reason?}` · `/propose-action` → creates an `Action` in `proposed`.
- Custom rules (§9) and analyst (§8) routes.

```ts
interface OpsRunResult {
  reportId: string; version: number; kind: "daily_brief"|"weekly_review"|"payout_check";
  businessDate: string; status: "red"|"amber"|"green"; dataAsOf: string | null;
  readiness: { ready: boolean; blockers: Array<{ outletId: string; platform: "zomato"|"swiggy";
    code: "days_missing"|"signed_out"|"fetch_held"|"updating"|"lag_missing"|"zomato_week_missing";
    dates: string[]; retryable: boolean }> };
  message: { text: string; chars: number };
  workbook: { available: boolean; fileName: string | null };
  deliver: { shouldNotify: boolean; reason: "first"|"severity_changed"|"unchanged" };
  alerts: { opened: string[]; escalated: string[]; resolved: string[]; ongoing: string[] };
}
interface OpsReport {                 // GET reports/:id; payload is the same for in-app and runner
  id: string; kind: OpsRunResult["kind"]; businessDate: string; periodStart: string; periodEnd: string;
  version: number; status: "red"|"amber"|"green"; dataAsOf: string | null; text: string;
  restaurant: OpsBlock | null; outlets: Array<OpsBlock & { outletId: string; name: string }>;
  deliveries: Array<{ channel: string; status: string; sentAt: string; reportVersion: number }>;
}
interface OpsAlertView {
  id: string; dedupeKey: string; cadence: string; ruleCode: string; family: string | null;
  outletId: string | null; platform: "zomato"|"swiggy"|"combined";
  severity: "act_now"|"watch"; status: "open"|"snoozed"|"resolved";
  firstSeenDate: string; lastSeenDate: string; consecutiveDays: number; occurrences: number;
  lastValue: number | null; threshold: number | null; baselineValue: number | null;
  text: string; fix: string; evidence: OpsCell[]; snoozedUntil: string | null;
}
// OpsBlock and OpsCell are as in WEEKLY-OPS-REVIEW-DESIGN.md §6.3, plus OpsCell.window {from,to}.
```

---

## 7. Ownership

| Engineer - SaaS | Engineer - AI agents |
|---|---|
| Rules engine (daily, weekly, payout), thresholds config, alert state, report storage, text and Excel rendering, read/run APIs, owner UI (feed, alerts, snooze, propose action), analyst **tool layer + number check + answer storage + UI**, custom-rule storage and evaluation | Nightly ingest, schedules (08:30 daily, Mon 10:00, Thu 09:30, 11:00 retry), triggering `ops/runs`, delivery (in-app notification now, WhatsApp at hosting), recording deliveries and runs, admin alerts on blockers, analyst **model loop** (prompt, model config, evals), the custom-rule **text → rule parser** prompt, retiring the screen-reading weekly skill |

---

## 8. Data analyst (full design; can ship before PR B)

**Goal:** owners ask in free form ("why did Zomato drop last Saturday?", "compare Park Street and Salt Lake this month", "Swiggy vs Zomato AOV over 8 weeks") and get an answer grounded **only in their own stored data**. The answer has numbers, an optional small table or chart, and the reasoning shown. It is read-only. **It never invents a figure.**

### 8.1 Data access: typed tools (recommended) vs guarded SQL views
- **Option 1, typed tools (recommended):** a small set of SaaS read tools wrap the existing owner-metrics assembler. Every rollup rule therefore holds automatically: ratios from summed parts, `snapshot_mean`, `platform_only` only for an exact window, cross-platform adds only for `crossPlatform:true`. So do `updating`/`not_available`/coverage and `runAsTenant`.
- **Option 2, read-only SQL over guarded views:** more flexible, but the model could `SUM` or `AVG` a rating, AOV or % and break the dictionary rules. It needs a SQL parser allowlist, statement timeouts, a read-only role and row limits, and the number check can't tell a right sum from a wrong one.
- **Decision: Option 1.** The model never writes SQL and never does arithmetic. Any derived figure (difference, %, share, rank) comes from a tool.

### 8.2 Tools (all `POST /agent/v1/analyst/tools/<name>`; restaurant from the token; outletIds validated against scope)
Every result carries `resultId`, and every number carries a `ref` (`resultId#path`), `key`, `platform`, `outletId|null`, `window {from,to}`, `basis`, `status` and `accuracy`.

| Tool | Input | Output |
|---|---|---|
| `list_scope` | — | outlets (id, name, city, apps, active, first data date), latest stored date per app, open holds |
| `describe_metrics` | `{ search?: string, keys?: string[] }` | dictionary entries: key, label, unit, kind, crossPlatform, platforms, definition, accuracy (Q14/Q15/Q18/Q21 wording) |
| `get_metrics` | `{ keys[≤20], from, to, platform: zomato\|swiggy\|all, outletIds?, grain?: day\|week_mon_sun\|month, basis?: order_date\|settlement_date }` | the owner-metrics response, trimmed: values, series, status, coverage, missing/updating dates, lagBanner |
| `compare_periods` | `{ keys[≤10], a:{from,to}, b:{from,to}, platform, outletIds? }` | per key: a, b, `deltaAbs`, `deltaPct` (money/count), `deltaPoints` (rates), status of each side; no delta when either side isn't `ok` |
| `breakdown` | `{ key, by: outlet\|platform\|weekday\|day, from, to, platform?, outletIds? }` | members with values and `share` (sums only); the total comes from the rollup. Non-summable keys get no share and no total across members unless the dictionary allows it |
| `explain_change` | `{ key: net sales\|delivered_orders\|<rate key>, a, b, platform, outletIds? }` | deterministic drivers. Sales → orders effect vs AOV effect, per app and per outlet contribution. Rates → numerator vs denominator change. Co-movers ranked by change: online %, KPT, delayed %, cancellations, discount, ad spend, funnel steps (impressions → menu → cart → orders) |
| `get_alerts` / `get_reports` | `{ from, to, status?, kind? }` | stored call-outs and briefs (text + evidence) |
| `get_payouts` | `{ from, to, basis, platform, outletIds? }` | payout keys, gap lines, cycle check results. **No UTRs, not even last 4**, and no customer hashes |
| `get_top_items` | `{ outletId, from, to }` | Swiggy `platform_window_items` for an exact stored window only, else `not_available` |
| `get_data_health` | `{ from, to }` | per day × app: stored / missing (+ fetch status reason) / updating |

**"Which dishes lose money?"** We store no item-level cost or margin. Zomato and Swiggy item reports aren't ingested, and only Swiggy's top-5 revenue exists. The analyst answers: "I can't tell yet: Ecomnomics doesn't have your dish costs or item-level sales." It shows the top items we do have, if any. That needs an Aman decision (§13 A3).

### 8.3 Answer format (model must return JSON; the UI renders it)
```ts
interface AnalystAnswer {
  text: string;                       // ≤ 900 chars markdown; every figure written via {{n1}} placeholders
  numbers: Array<{ id: string; ref: string; display: string }>;   // filled by the server from ref, not by the model
  reasoning: string[];                // 2–5 short steps, each naming the tool result used
  table?: { columns: string[]; rows: Array<Array<string | { ref: string }>> };   // ≤ 10 rows × 6 cols
  chart?: { type: "bar" | "line"; title: string; x: string[];                   // ≤ 60 points, ≤ 3 series
            series: Array<{ label: string; key: string; platform: string; points: Array<{ ref: string }> }> };
  sources: Array<{ key: string; platform: string; outletId: string | null; from: string; to: string; basis: string }>;
  caveats: string[];                  // updating / missing / approx / lag notes, copied from tool statuses
  refusal?: { reason: "no_data" | "out_of_scope" | "not_stored" | "unsafe"; detail: string };
}
```
The model writes **placeholders, not digits**. The server renders each `{{n}}` from the referenced tool value with the standard formatter (₹ Indian grouping, % 1 dp), so the source key, app and window travel with each number (hover in the UI; a footnote line in WhatsApp later).

### 8.4 Guardrails
- **Tenant scope:** tools run under `runAsTenant` for the token's restaurant. The model never sends a restaurantId, and outletIds outside scope → 403. A read-only DB role is used for the analyst routes.
- **Number check (server, before anything is shown):**
  - (1) Every `ref` must exist in this question's tool results, with `status:'ok'` (or `updating` with the known part and a caveat).
  - (2) A scan of `text`, table and chart for raw numerals. Any number not produced by a placeholder must be a date in a referenced window, a count of returned members, or a number in the owner's question. Anything else fails.
  - (3) Unit and `kind` check: no `share` or total for a non-summable key.
  - On failure: one repair turn with the error list. A second failure returns the tool table only, with "I couldn't verify a written answer, here are the figures."
- **Missing data:** if the needed values are `not_available` or `missing`, the analyst refuses with what's missing and why (`get_data_health`). `updating` → "Zomato renamed a column; those days are being re-read". Approximate metrics (Swiggy KPT, online %) carry an "approx" caveat.
- **Secrets:** no credentials, tokens, UTRs, phone numbers, emails or customer hashes are in any tool output. An output regex scan (UTR-like 12–22 alphanumerics, phone, email) blocks the answer. Item names are treated as data, never as instructions.
- **Limits:** ≤ 6 tool calls and ≤ 45 s per question; ≤ 40k input tokens; 30 questions per owner per day, 6 per minute; a monthly ₹ cap per restaurant (default ₹500, §13 A2). At the cap: "monthly analyst limit reached".
- **Model:** **grok-4.3** (xAI, through the existing OpenRouter path), `reasoning: low`. There's no automatic upgrade to a bigger model when a check fails; it falls back to the table. **Never Gemini**, enforced by a model allowlist in config.
- **Storage:** `analyst_questions` (PR C): id, restaurantId, spaceId, userId, question, answer Json, toolCalls Json (names, inputs, resultIds), check pass/fail, model, tokens in/cached/out, costPaise, createdAt. Kept 13 months. Logged costs use `JobRun` (`costUsdMicros`, `fxRate`).

### 8.5 Cost per question (₹85/USD as in COST-ESTIMATE.md; xAI list prices 10 Oct 2026 per 1M tokens: grok-4.3 $1.25 in / $0.20 cached / $2.50 out; grok-4.7 $2.00 / $0.50 / $6.00; +5.5 % OpenRouter credit fee assumed)
Token assumptions:
- **Typical question = 3 model calls.** System prompt + tool schemas + dictionary summary ≈ 6k tokens (cached after the first call) + question/history 1k + tool results 1.5–3k. Total **25.5k input (18k cached, 7.5k uncached)**, **2.8k output** (1.3k visible + 1.5k low reasoning).
- **Heavy question = 5 calls.** 50k input (35k cached, 15k uncached), 6k output.

| Model | Typical | Heavy | Blend (80 % typical / 20 % heavy) |
|---|---|---|---|
| grok-4.3 | $0.0200 → **₹1.8** | $0.0408 → **₹3.7** | **₹2.2** |
| grok-4.7 | $0.0408 → **₹3.7** | $0.0835 → **₹7.5** | **₹4.5** |

Monthly per restaurant (30 days): **5 questions/day = 150/month** → grok-4.3 **≈ ₹330**, grok-4.7 ≈ ₹675. **20 questions/day = 600/month** → grok-4.3 **≈ ₹1,320**, grok-4.7 ≈ ₹2,700. Number-check repairs add about 10 %. The briefs, call-outs, weekly review and payout check stay ₹0. Prices must be re-checked at build time.

---

## 9. "Alert me when" custom rules

- **Flow:** the owner types "tell me if Swiggy delayed orders go above 10% at Park Street". One model call (grok-4.3, ≈ ₹0.3) turns it into a structured rule. SaaS validates it against the dictionary. The owner sees the rule in plain words and confirms. From then on it's evaluated by the **rules engine** in the daily (or weekly) run at **₹0**.
- **Rule shape (`ops_owner_rules`, PR D):**
```ts
interface OwnerRule {
  id: string; name: string; enabled: boolean;
  scope: { outletIds: string[] | "all"; platform: "zomato" | "swiggy" | "combined" };
  metric: string;                     // dictionary key or review key (net_sales_paise)
  window: "day" | "week_mon_sun";
  condition: { op: "gt" | "lt" | "drop_pct_gt" | "rise_pct_gt"; value: number;
               baseline?: "same_weekday_last_week" | "last_week" | "absolute" };
  guard: { minDelivered?: number };   // defaults from §2
  severity: "watch" | "act_now";
  createdBy: string; createdFromText: string;
}
```
- **Validation:** the key exists on that platform; `combined` only for `crossPlatform:true` keys or the review's combined net sales; `pct` rules only on rate keys; `platform_only` keys only with `week_mon_sun` where the platform publishes them. Max **10 rules per restaurant**.
- **State:** firing writes an `ops_alerts` row with `cadence:'owner_rule'` and `dedupeKey = owner_rule:<ruleId>:<outlet>:<platform>`, with the same lifecycle as §3. Its call-out is tagged "Your alert".
- **Routes:** `POST /api/v1/restaurants/:rid/ops/rules/parse {text}` → `{draft, explanation}` (the model loop is AI agents', called through SaaS) · `GET/POST/PATCH/DELETE /api/v1/restaurants/:rid/ops/rules`.

---

## 10. Test plan (synthetic fixtures only)

Fixtures: "Sample Foods" with outlets "Sample Kitchen", "Park Street", "New Town", fake ids `Z-TEST-0001` / `S-TEST-0001`, generated numbers. **No Pawan Putra data in git.** A guard test fails on known real ids (list kept outside git) and on UTR-like tokens.
- **Daily rules:** each threshold at, just above and just below its value; every guard (14 vs 15 delivered, numerator 1 vs 2, baseline ₹2,999 vs ₹3,000); D−8 → D−15 fallback; families show one call-out; Zomato daily KPT used, the weekly rebuild never used.
- **Lag:** Swiggy D−1 missing → Zomato-only brief + next-day catch-up call-out with its own date; lag-banner sales drop capped at Watch, then Act now after the re-check; D−2 restatement updates the value without re-notifying.
- **State machine** (table-driven over a 14-day synthetic calendar): open → seen → escalate on day 3 → de-escalate → resolve after 2 clear days; frozen on missing/updating days; stale after 7; reopen within 7 days; snooze hides Watch but not Act now; dismiss; the unique open index; idempotent re-run of the same date (no double occurrences); version bump and `shouldNotify` only on a severity change.
- **Ingest failure:** one app `signed_out` → brief with the other app; both apps failed → one-line brief, `ready:false`; `fetch_held` not retryable.
- **Weekly:** the weekly doc §7 suite, plus writes to `ops_alerts` with weekly dedupe.
- **Payout check:** gap ₹1.00 passes, ₹1.01 fails; ₹499 = Watch, ₹500 = Act now; 1 % band; `skipped` pending-label checks don't alert; late settlement day 1/3; missing orders max(2, 2 %); commission 0.5 pts; last 4 of the UTR only.
- **Rendering:** golden files for the §4/§5 samples; length caps; Indian grouping; no paise.
- **API/RLS** (Postgres): tenant isolation on every new route; agent token refused on owner routes; deliveries recorded per version.
- **Analyst (PR C):** tool contract tests (non-summable keys never get share or total; `platform_only` exact windows); number-check unit tests (a rogue numeral, a wrong ref, a share on AOV, a date inside the window allowed); a refusal when data is missing; a recorded-response eval set of 40 synthetic questions with expected tool calls (no live model in CI); a cost meter test.
- **Custom rules (PR D):** validation matrix; the parse endpoint with a mocked model; evaluation reuses the daily state tests.

---

## 11. PR split

- **PR A: rules engine, alert state, daily brief and call-outs.**
  - `packages/contracts/src/ops/`: daily and weekly rule sets, thresholds config, families, severity, fixes, renderers.
  - Migration `20261216120000_ops_alerts`: `ops_alerts`, `ops_alert_events`, `ops_report_deliveries`, and the new `restaurant_reports` columns.
  - `POST /agent/v1/ops/runs` (`daily`), the report, alert and delivery routes (agent and owner), snooze/dismiss/propose-action.
  - Tests per §10 (daily, lag, state, ingest failure, RLS).
- **PR B: weekly review, Thursday payout check and Excel.**
  - `kind:"weekly"` and `kind:"payout_check"`; the Zomato official-week reader (Q28); the exceljs workbook; Toing/train outside Swiggy totals in the owner read (C6); dictionary wording for Q14/Q15/Q18/Q21.
  - No new migration.
- **Later, movable earlier:** **PR C, analyst** (tool routes, number check, `analyst_questions` migration, UI), which depends only on main plus PR A's report reads. **PR D, custom rules** (`ops_owner_rules` migration, parse and CRUD routes), which depends on PR A.
- **Runner work (AI agents), in parallel after PR A:** schedules, triggering runs, delivery, recording sends, the analyst model loop and the rule parser prompt.

Each PR is merged only after Aman's yes.

---

## 12. Earlier open questions: resolved with defaults

| # | Earlier question | Default now |
|---|---|---|
| 1 | Q13 source screens | **Still open → §13 R2** |
| 2 | Which sales drive the drop rule | **Net sales** (Z BR Sales + S Net Sales). Gross Sales goes in the Thursday payout report and Excel |
| 3 | Weekly send time | **Monday 10:00 IST.** Gross Sales and the payout block come in Thursday's payout check |
| 4 | Swiggy total orders on Monday | delivered + restaurant-cancelled, labelled; switches to `payout_orders` once payouts cover the week |
| 5 | Flag counting | sales family = 1 flag; prep = 1 flag |
| 6 | Weekly volume guards | ≥ 20 delivered for rates; per-app sales baseline ≥ ₹5,000 (Raghav may override, folded into R1) |
| 7 | Online %, one warning or per app | **per app** (Raghav's Q4 answer only covers prep) |
| 8 | Toing/train | **Outside Swiggy totals**, as Aman decided. Implemented in PR B |
| 9 | Zomato bad orders > 8 % and rising | **keep** |
| 10 | Zomato FOR accuracy | **shown as info, no warning** |
| 11 | Q7 look-back | weekly 4 weeks; daily 2 same-weekdays |

---

## 13. Open questions that need Aman or Raghav

**Raghav**
- **R1. Daily thresholds and guards (§2), plus the payout severity bands (§5).** Recommend approving §2 as is for a 2-week **shadow period**: alerts stored and shown in-app with a "trial" tag, then tuned on real hit rates before WhatsApp.
- **R2. Q13: Swiggy star rating, offline time and rejected orders.** Everything else Q13 asked about is now in the exports. Recommend one narrow ask: "Where in the Swiggy partner app do you see your star rating and offline time? A screenshot is enough." Until then these show "n/a".

**Aman**
- **A1. Analyst model and when to build.** Recommend grok-4.3 at low reasoning (≈ ₹2.2 per question) over grok-4.7 (≈ ₹4.5), and moving PR C right after PR A.
- **A2. Analyst budget and limits per restaurant.** Recommend a ₹500/month cap and 30 questions/owner/day for the trial. That's ≈ ₹330 at 5 questions/day and ≈ ₹1,320 at 20/day on grok-4.3. Also needed: whether it's included in the plan or a paid tier. It needs OpenRouter funding (R1 in Raghav's doc).
- **A3. "Which dishes lose money".** Recommend adding item-level ingest (Zomato/Swiggy item sales reports) and owner-entered dish costs as a later step. Until then the analyst says it can't answer.
- **A4. Custom rules.** Recommend 10 rules per restaurant, in-app only until WhatsApp. The parse call (≈ ₹0.3) is counted against the same analyst cap.
- **A5. Shadow mode before owners see daily alerts.** Recommend 2 weeks in-app only for Pawan Putra, then turn on notifications.
