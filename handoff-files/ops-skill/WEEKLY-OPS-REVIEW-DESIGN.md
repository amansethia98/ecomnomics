# Weekly ops review: design (step 3)

Status: **draft for agreement. No code until this is agreed.**
Author: Engineer - SaaS. Date: 15 Nov 2026 (IST). Repo base: `main` at `d61dc31b` (#26 merged).
Authority order: (1) Aman's addendum `RAGHAV-ANSWERS-ADDENDUM-20261115.md` (Q14, Q15, Q18); (2) Raghav's answers `RAGHAV-ANSWERS-20261115.docx`; (3) the repo on main (`metric-dictionary.ts`, owner-metrics read, agent API); (4) older docs (`restaurant-weekly-ops-review-SKILL.md`, `THRESHOLDS.md`, `calculators/ops_review.py`, `DATA-DESIGN.md`, `FETCH-JOB-DESIGN.md`). Where they disagree, the higher one wins, and §9 lists every conflict.

All numbers in this doc are **synthetic**, made up for illustration only.

---

## 0. Decisions in one screen

| # | Decision | Source |
|---|---|---|
| D1 | Week = **Monday 00:00 to Sunday 23:59 IST**, built from stored **daily** rows. API window `from` = Monday, `to` = next Monday (exclusive). | Skill, `ops_review.completed_weeks`, Zomato ISO weeks, agent API date rule |
| D2 | The review **reads only stored data** through SaaS. It never logs in or reads screens. SaaS computes every number, warning and status, and renders the message text and the Excel file. The runner only fetches, sends and records. | DATA-DESIGN §8 split (Aman, 8:53) |
| D3 | Delayed-order warning only when delayed **> 5.00 %** of delivered orders, **on each app separately** (Zomato KPT+10, Swiggy >10 min). Exactly 5.00 % does not warn. There's no "and rising" condition. | Q1, Q6 |
| D4 | Sales-drop warning when net sales fall **more than 15.00 %** week on week: **combined, and Zomato and Swiggy separately**. | Q3 (B) |
| D5 | Prep time (KPT) gives **one** warning. If only one app slips, the warning names that app. If both slip, it's one combined warning. KPT values are still **shown per app**, with no blended KPT figure. | Q4 (B), Q27 (A) |
| D6 | Zomato KPT uses **only Zomato's official weekly figure** (the stored `week_mon_sun` platform-check row). It is never the daily rebuild. | Q28 (B) |
| D7 | Bad-order lines show **count and % of delivered** (Zomato rejected, KPT+10 delayed, poor-rated, complaints; Swiggy delayed, restaurant-cancelled, poor-rated, complaints). | Q8, Q9 (C) |
| D8 | **Order totals include cancelled and rejected orders.** Rates still use delivered orders as the denominator. | Q16 (B) |
| D9 | **Gross Sales = Zomato payout "Total Sales"** (`gross_sales_paise`: item total + packaging, before restaurant-funded discounts, commission and fees). The Business Report "Sales" (`ops_sales_paise`) is post-discount and is labelled **Net sales**. | Q14 (addendum) |
| D10 | **Swiggy Net Sales** (`swiggy_net_sales_paise`) = item total + packaging − restaurant-funded discounts, before GST, commission, PG fees and ads. **Swiggy Net AOV** = Net Sales ÷ delivered orders. It is directly comparable with Zomato AOV (`ops_sales_paise ÷ delivered_orders`). | Q15, Q18 (addendum), Q17 |
| D11 | **"Taxes" = only the 18 % GST on platform fees** (`taxes_paise`). Customer GST (`gst_collected_paise`), TDS and TCS are separate lines. This only appears in the Excel payout block. | Q21 |
| D12 | Swiggy food-ready accuracy warns **whenever it's below 90 %**, even when it is improving. | Q2 |
| D13 | Swiggy's latest days under the 48-hour banner: **use the numbers and add a note.** | Q5 (A) |
| D14 | Missing baseline week: compare with the **most recent older complete week** (looking back at most 4 weeks), and label which week was used. | Q7 (B) |
| D15 | Multi-outlet restaurants get a short summary message plus an **Excel attachment**. A single outlet gets the full card and no attachment. | Q12 (B) |
| D16 | Swiggy restaurant-cancelled and Zomato rejected stay **separate**. Each app shows **its own rating**, with no combined rating. Swiggy cancelled-order loss (₹) is shown next to the cancelled count. | Q19, Aman, Q11 |
| D17 | **No migrations.** The review is computed on read from existing tables. | §6 |

---

## 1. Inputs

### 1.1 Stored data the review reads (per outlet, per platform)

| Data | Table / key (repo names) | Platform | Arrives |
|---|---|---|---|
| Daily business metrics | `restaurant_metric_values` (`MetricValue`), `granularity='day'`, `rowRole='fact'`, `supersededAt IS NULL` | both | nightly 05:30 IST, D−7…D−1 (FETCH-JOB §4) |
| Zomato official week figures | `MetricValue`, `granularity='week_mon_sun'`, `rowRole='platform_check'` for `kpt_minutes`, `online_pct`, `for_accuracy_pct`; `rowRole='fact'` for `offline_time_hours` (`platform_only`) | Zomato | Monday "week check" run |
| Swiggy week figures | `week_sun_sat` platform-check rows | Swiggy | Tuesday. **Not used for display**, because a Sun–Sat week ≠ Mon–Sun |
| Swiggy lag banner | key `lag_banner` (`snapshot_latest`) → `OwnerMetricsResponse.lagBanner` | Swiggy | nightly |
| Payout orders | `payout_orders` (`PayoutOrder`), order-date basis, `pendingFields` | both | Thursday payout run |
| Payout cycle totals | `PayoutCycle` (checks only) | both | Thursday |
| Fetch health | `metric_fetches` (`status`: stored / signed_out / download_failed / layout_changed / rejected_mismatch / needs_owner …), `fetch_holds` | both | every run |
| Label state | `MetricValue.state` (`ok` / `pending_label` / `label_unrecoverable`) → owner read `status: 'updating'`, `updatingDates`; payout `pendingFields` | both | after #24/#26 |
| Outlets | `outlets` (`active`, `zomatoResId`, `swiggyRid`, name, city) | — | — |

The review calls the **existing owner-metrics assembler** (`assembleOwnerMetrics`) with `basis='order_date'`, `grain='week_mon_sun'`, `from = weekStart − 28 days`, `to = weekStart + 7 days`. That's one call for 5 weeks (this week plus 4 possible baselines), once per outlet and once with all outlets. Sums, ratios from summed parts, `updating`, `not_available`, `missingDates`, `partialDates`, `coverageDays/expectedDays`, `provisional` and `restated` all come from that read unchanged. Only two reads are new:
1. **Zomato official week values.** A direct read of the `week_mon_sun` `platform_check` row for that exact Mon–Sun window (D6). If the row is missing, the value is `not_available` with the reason "Zomato's weekly figure isn't stored yet", and there is no fallback to the rebuild.
2. **Fetch health** for the week from `metric_fetches` and `fetch_holds`, so the message can say *why* something is missing.

### 1.2 Week, timing, baseline
- **Week:** Mon–Sun IST (D1). `weekStart` must be a Monday, and `weekStart + 7 days ≤ today (IST)`. Otherwise it's a 400 or 409 error.
- **Swiggy:** Swiggy's native week is Sun–Sat. We roll the Mon–Sun week up from Swiggy **daily** rows (the derived-count rule: round per day, then sum). So Swiggy's own weekly tiles are not shown. KPT and online % on Swiggy are therefore `accuracy: approx` (DATA-DESIGN §10.12: ≤0.04 min KPT; online % is an approximation until scheduled hours are stored).
- **Send time (proposal, OQ3):** Monday **10:00 IST**, after the 05:30 nightly fetch and the Zomato week check. If `readiness.ready=false` with a retryable blocker, the runner retries at 12:00 and sends by 14:00 at the latest, with the gaps named.
- **Baseline:** the previous Mon–Sun week. Per metric, if that week is `not_available`, `updating` or incomplete (coverage < 7/7), use the most recent older **complete** week, up to 4 weeks back (D14, OQ11). The cell carries `baseline.weekStart`, and the text says "vs week of 26 Oct" whenever it isn't last week. If there's no complete baseline in 4 weeks, there is no change % and no rising/falling warning. Threshold-only warnings (delayed > 5 %, FRA < 90 %, rating < 4.0) still run.

### 1.3 Missing, updating, not_available and partial data

| Owner-read state | Shown as | Warnings on it | Note line |
|---|---|---|---|
| `ok`, coverage 7/7 | value | yes | — |
| `ok`, coverage < 7/7 (`missingDates`) | value + "(5 of 7 days)" | **Sums** (sales, orders): no change % and no warning. **Ratios** (delayed %, FRA, bad %): only if ≥ 5 of 7 days, computed on covered days | "Zomato 12–13 Nov not stored (login expired)", with the reason from `metric_fetches` |
| `updating` (`updatingDates`, i.e. `pending_label` or payout `pendingFields`) | "Updating" (or the known part + "updating") | **none** on that metric | "Zomato renamed a report column; we're re-reading those days." |
| `not_available` (`label_unrecoverable`, `platform_only` mismatch, Zomato week row absent, key not on that platform) | "n/a" | none | the `reason` string, shortened |
| `provisional` / `lagBanner=true` (Swiggy) | value | yes (D13) | "Swiggy figures for 14–15 Nov may change within 48 hours." |
| Whole platform missing for the week | platform line replaced by the reason | none for that app; combined sales use only the present app and are labelled "Zomato only" | from `metric_fetches` status: `signed_out` → "Swiggy login expired; we're reconnecting", `fetch_held` → "paused for a check" |

Rule: **never a guessed zero.** A null stays null all the way to the message (dictionary rule). `provisional` is true for every value in the last 7 days by design (`owner-metrics.md`), so it doesn't trigger a note by itself. Only `lagBanner` does.

### 1.4 Multi-outlet aggregation
- **Per outlet:** every metric, warning and status (as in the skill: one card per outlet).
- **Restaurant total ("All outlets"):** sums add up. Ratios and weighted averages are rebuilt from summed parts (the assembler does this when `outletIds` is omitted). `snapshot_mean`, `platform_only` and official-week values (Zomato rating, Zomato KPT, Zomato online %, offline hours) are **per outlet only**. The All-outlets cell shows "per outlet", so we never invent a blended platform figure (D6, Q27).
- **Cross-app combining:** the API's `platform='all'` adds only `crossPlatform:true` keys (`delivered_orders`, payout keys). The review adds **net sales** (`ops_sales_paise` + `swiggy_net_sales_paise`) and builds a combined AOV explicitly, because Q17 makes them comparable (conflict C8). Nothing else is added across apps.
- **Outlet joined mid-period** (`outlets[].partial`): it's shown, but **excluded from change % and warnings** for the restaurant total (`likeForLike=true` for the baseline comparison). The note says "New outlet X, no prior week."
- **Single-platform outlet:** one line, with "On Zomato only."
- **Outlet matching** uses `outlets.zomatoResId` / `swiggyRid` on one outlet row. Name matching from the old calculator is retired.

---

## 2. Metric dictionary for the review

`Z` = Zomato, `S` = Swiggy, `C` = combined (both apps). Money is integer paise in the API and ₹ with no paise in the message.

| Metric (label) | Formula | Z source key | S source key | Combined rule | Shown |
|---|---|---|---|---|---|
| **Net sales** | Σ daily | `ops_sales_paise` (BR "Sales", post-discount) | `swiggy_net_sales_paise` (Q15) | Z + S | msg + xlsx |
| **Gross Sales** | Σ payout orders by order date | `gross_sales_paise` (payout "Total Sales", Q14) | `gross_sales_paise` (Item Total + Packaging) | API `all` (crossPlatform) | xlsx. Message only if complete (OQ3) |
| **Delivered orders** | Σ daily | `delivered_orders` | `delivered_orders` | API `all` | msg + xlsx |
| **Total orders (incl. cancelled/rejected)** | see note | `placed_orders` (BR funnel "Placed Orders") | `payout_orders` when payout covers 7/7 days; else `delivered_orders + restaurant_cancelled_orders`, labelled (OQ4) | Z + S | msg + xlsx |
| **AOV** | net sales ÷ delivered | `aov_paise` (Z: ops_sales/delivered) | `aov_paise` (S: Net AOV) | (Z+S net) ÷ (Z+S delivered) | msg + xlsx |
| Bad orders | count; % = ÷ delivered | `bad_orders`, `bad_orders_pct` | — | — | msg + xlsx |
| Rejected | count, % | `rejected_orders` | — | separate from S cancelled (Q19) | msg + xlsx |
| Delayed | count, % | `delayed_orders_kpt10` | `delayed_orders_gt10`, `delayed_orders_gt10_pct` | never added (different definitions) | msg + xlsx |
| Restaurant-cancelled | count, % | — | `restaurant_cancelled_orders` | — | msg + xlsx |
| Cancelled-order loss | Σ ₹ | — | `cancelled_order_loss_paise` | — | msg + xlsx (Q11) |
| Poor-rated | count, % | `poor_rated_orders` | `poor_rated_orders` | not added (crossPlatform false) | msg + xlsx |
| Complaints | count, % | `complaints` (total) | `complaints` | not added | msg + xlsx |
| Lost sales | Σ ₹ | `lost_sales_paise` | — | — | xlsx |
| Online % | Z official week; S Σ online h ÷ Σ scheduled h (approx) | `online_pct` week row | `online_pct` rebuild | none (Q27) | msg + xlsx |
| Prep time (KPT) | Z official week; S Σ(KPT×delivered) ÷ Σ delivered (approx) | `kpt_minutes` week row (D6) | `kpt_minutes` | none (Q27) | msg + xlsx |
| Rating | Z mean of daily snapshots | `rating` (`snapshot_mean`) | n/a (not in Swiggy's report) | none | msg + xlsx |
| Food-ready accuracy | S accurate ÷ delivered | (Z FOR: `for_accuracy_pct` week row, info only, OQ10) | `food_ready_accuracy_pct` | none | msg + xlsx |
| Rated orders | Σ | `rated_orders` | `rated_orders` | not added | xlsx |
| Offline time | Z platform week figure | `offline_time_hours` (`platform_only`) | n/a | — | xlsx |
| Payout block | Σ by order date | `discount_paise`, `commission_paise`, `platform_fees_paise`, `taxes_paise` (= GST on fees only, D11), `tds_paise`, `tcs_paise`, `gst_collected_paise`, `net_payout_paise` | same | `all` where crossPlatform | xlsx only, when complete |
| Swiggy Toing / train | payout `categories` | — | `categories[]` | **outside** Swiggy totals (Aman), see C6 | xlsx |

Change % = (this − baseline) ÷ baseline × 100, to 1 dp. Baseline 0 and this > 0 → "new". Rates are compared in **percentage points** ("7.1 % vs 4.0 %"), not as a % of a %.

---

## 3. Warning rules

All comparisons are strict (`>`/`<`, Q6) and evaluated on unrounded values; display is rounded. "Rising/falling" means strictly vs the baseline (§1.2).

| Code | Scope | Fires when | Guard (proposed, OQ6) | Counts as |
|---|---|---|---|---|
| `sales_drop_combined` | outlet; also restaurant total if ≥ 2 outlets | Z+S net sales change < −15.00 % | baseline > 0; both weeks complete for each present app | sales family = **1 flag** (OQ5) |
| `sales_drop_zomato` / `sales_drop_swiggy` | outlet | that app's net sales change < −15.00 % | baseline ≥ ₹5,000 on that app | (same family) |
| `delayed_zomato` | outlet | `delayed_orders_kpt10 / delivered_orders` > 5.00 % | ≥ 20 delivered on Zomato that week | 1 |
| `delayed_swiggy` | outlet | `delayed_orders_gt10 / delivered_orders` > 5.00 % | ≥ 20 delivered on Swiggy | 1 |
| `bad_orders_zomato` | outlet | `bad_orders_pct` > 8.00 % **and** rising (carried from the skill, OQ9) | ≥ 20 delivered | 1 |
| `prep_time` | outlet | any app: KPT > 16.0 min **and** rising. Both apps → one combined warning; one app → one app-named warning (D5) | Z needs the official week row | **1**, even when both apps slip |
| `online_zomato` / `online_swiggy` | outlet | online % < 90.00 **and** falling | — | 1 each (OQ7) |
| `rating_zomato` | outlet | rating < 4.00, **or** falling (2-dp compare) | — | 1 |
| `food_ready_swiggy` | outlet | `food_ready_accuracy_pct` < 90.00 (always, Q2) | ≥ 20 delivered | 1 |
| `zero_orders` | outlet | delivered = 0 on every present app, last week > 0, no missing days | — | forces 🔴 |

**Status** (unchanged from the skill): 🔴 *Act now* = 3 or more flags, or `zero_orders`. 🟡 *Needs attention* = 1–2 flags. 🟢 *Good* = none. Restaurant status = the worst outlet. API: `red | amber | green` (matches `POST /agent/v1/reports.status`).

**Wording** (fixed templates, filled by SaaS; the runner never rewrites them):
- `sales_drop_combined`: "Sales down {x}% on both apps combined ({₹this} vs {₹base})." If an app also dropped, it's appended: " Zomato down {y}%." / " Swiggy down {z}%."
- per-app only: "Zomato sales down {y}% ({₹this} vs {₹base}), even though the total held."
- `delayed_*`: "{App} delayed orders {n} of {delivered} delivered ({p}%), above 5%."
- `bad_orders_zomato`: "Zomato bad orders {p}% (was {q}%), above 8% and rising."
- `prep_time` (one app): "{App} prep time {m} min (was {k}), above 16 min and rising." (both): "Prep time slipping on both apps: Zomato {m1} min, Swiggy {m2} min (above 16 min and rising)."
- `online_*`: "{App} online {p}% (was {q}%), below 90% and falling."
- `rating_zomato`: "Zomato rating {r}{, below 4.0}{, down from {s}}."
- `food_ready_swiggy`: "Swiggy food-ready accuracy {p}%, below 90%."
- `zero_orders`: "No orders this week after {n} last week. Check that the outlet was open on both apps."
- Fix lines: max 2, from the existing fixed `FIX_TEMPLATES` list in `ops_review.py` (ported as is), ordered by the existing priority. The prep family gives one fix line.

---

## 4. Owner message (WhatsApp and in-app text)

**Rules:** plain text with WhatsApp `*bold*` only. ₹ uses Indian grouping (₹1,02,400) with no paise. % to 1 dp, minutes to 1 dp. Dates read "9–15 Nov". No UTRs at all (and if one ever appears, only `utrLast4`). No customer ids, phone numbers or order ids. One message, plus one attachment for multi-outlet.
**Length:** single outlet ≤ **1,200 chars**. Multi-outlet summary ≤ **1,600 chars**. The hard ceiling is WhatsApp's 4,096. If the summary would exceed 1,600 chars, outlet lines collapse to 🔴/🟡 outlets only, plus "+N outlets 🟢 Good (see Excel)". The in-app report stores the same text.

**Structure, single outlet:** header (outlet, week, baseline) → status → sales line → orders + AOV line → warnings (⚠️, max 5, ordered by severity) → Zomato line → Swiggy line → fixes (≤ 2) → notes (missing, updating, 48 h) → nothing else.

**Sample, single outlet (SYNTHETIC numbers, fake outlet):**
```
*Weekly review · Sample Kitchen (Salt Lake)*
9–15 Nov (Mon–Sun) vs 2–8 Nov
🟡 Needs attention · 2 warnings

Net sales ₹1,02,400 (−18.1%) · Zomato ₹61,200 (−24.4%) · Swiggy ₹41,200 (−6.4%)
Orders 236 delivered · 246 total incl. 10 cancelled/rejected · AOV ₹434 (Z ₹443 · S ₹420)

⚠️ Sales down 18.1% on both apps combined (₹1,02,400 vs ₹1,25,000). Zomato down 24.4%.
⚠️ Swiggy delayed orders 7 of 98 delivered (7.1%), above 5%.

Zomato: 138 delivered · bad 9 (6.5%): rejected 1 (0.7%), delayed 4 (2.9%), poor-rated 3 (2.2%), complaints 2 (1.4%) · online 98.2% · prep 11.4 min · rating 4.21
Swiggy: 98 delivered · rest.-cancelled 3 (3.1%), loss ₹1,350 · poor-rated 2 (2.0%) · complaints 1 (1.0%) · delayed 7 (7.1%) · online 99.1% · prep 12.8 min · food ready 93.0%

Fix: Check menu visibility, item out-of-stocks, and whether a discount or ad campaign ended last week. Start prep on accept and mark food ready only when it is actually ready.
Note: Swiggy figures for 14–15 Nov may change within 48 hours. Swiggy total orders exclude customer cancellations until Thursday's payout.
```
(Synthetic check: 61,200 + 41,200 = 1,02,400; baseline 81,000 + 44,000 = 1,25,000; 7 ÷ 98 = 7.1 %. The sales family counts as 1 flag, so 2 flags = 🟡.)

**Sample, multi-outlet summary (SYNTHETIC):**
```
*Weekly review · Sample Foods (3 outlets)*
9–15 Nov (Mon–Sun) vs 2–8 Nov · 🔴 1 · 🟡 1 · 🟢 1

All outlets: net sales ₹3,10,500 (−4.2%) · 702 delivered · 731 total · AOV ₹442

🔴 Park Street: 3 warnings. Swiggy food ready 84.0%, Zomato delayed 6.3%, prep slipping on both apps
🟡 Salt Lake: sales down 18.1% (Zomato −24.4%)
🟢 New Town: no warnings

Full figures per outlet and app are in the attached Excel.
Note: Swiggy figures for 14–15 Nov may change within 48 hours.
```

---

## 5. Excel attachment (multi-outlet only)

File: `ecomnomics-weekly-ops-<restaurant-slug>-<weekStart>.xlsx`, built by SaaS with `exceljs` 4.4.0 (already a dependency of `apps/api` and `contracts`). It holds **values only, no formulas**, so the numbers can't drift from the message. It has no customer data, no UTRs and no platform passwords or ids beyond the outlet's public name and city.

| Sheet | Rows | Columns |
|---|---|---|
| **Summary** | Row 2 = **All outlets** (bold, shaded), then one row per outlet ordered 🔴→🟡→🟢 → name | Status, Outlet, City, Apps, Net sales, Δ%, Zomato net sales, Δ%, Swiggy net sales, Δ%, Delivered, Total orders, AOV, Warnings (n), Top warning |
| **Zomato** | All outlets, then outlets | For each metric a group: *This week · Baseline · Δ* (count metrics add *% of delivered*). Metrics: Net sales, Gross Sales, Delivered, Total orders (placed), AOV, Bad orders, Rejected, Delayed (KPT+10), Poor-rated, Complaints, Lost sales, Online %, Prep (official week), Rating, FOR % (info), Offline h, Rated orders |
| **Swiggy** | All outlets, then outlets | Net sales, Gross Sales, Delivered, Total orders, Net AOV, Restaurant-cancelled, Cancelled loss ₹, Poor-rated, Complaints, Delayed >10 min, Online % (approx), Prep (approx), Food-ready %, Rated orders, Toing orders, Train orders |
| **Warnings** | one row per warning | Outlet, Scope (Zomato / Swiggy / Combined), Rule code, Value, Threshold, Baseline (and its week), Text |
| **Payout** | All outlets + outlets × app; only filled when payout coverage is 7/7, otherwise one line "Payout figures arrive after Thursday's payout run" | Gross Sales, Restaurant discount, Commission, Other fees, Taxes (GST on fees only), TDS, TCS, Customer GST collected, Net payout |
| **Data** | long format: outlet × app × metric | Outlet, App, Metric key, Label, Value, Unit, Status, Coverage (d/7), Baseline week, Baseline value, Δ, Source (`daily` / `zomato_week` / `payout`), Accuracy, Reason |
| **About** | key/value | Restaurant, week, baseline rule, generated at (IST), `rulesVersion`, threshold table, definitions (Gross vs Net sales, Taxes, totals incl. cancelled/rejected), "Swiggy KPT/online are approximations" |

Formatting: header row frozen, first two columns frozen, autofilter on. ₹ format `[>=10000000]"₹"##\,##\,##\,##0;[>=100000]"₹"##\,##\,##0;"₹"##,##0`. % `0.0"%"` (stored as the number, not a fraction, so it matches the message). Minutes `0.0`. A cell that fired a warning gets a light red fill and a cell note with the rule. `updating` / `n/a` cells are blank with grey italic text "Updating" / "n/a" and the reason as a cell note. All-outlets cells for per-outlet-only metrics read "per outlet". Column widths are fixed. The file is ≤ 1 MB (≈ 50 outlets).

---

## 6. API and data contract (SaaS ↔ runner)

### 6.1 Ownership
| Engineer - SaaS | Engineer - AI agents |
|---|---|
| Stored data, metric reads, review engine (metrics, baseline, warnings, status, fixes), message text, Excel, endpoints, docs, tests | Nightly fetch (unchanged), the weekly scheduled job, readiness retry policy, sending to the owner's channel (WhatsApp / in-app), recording the report and run, alerting on failure, skill/guide updates (retire the screen-reading skill for this task) |

### 6.2 Endpoints (new, read-only, agent token scoped to its restaurant; RLS as for `/agent/v1/metrics`)
- `GET /agent/v1/ops-review?weekStart=YYYY-MM-DD[&outletId=…]` → JSON below. 400 if not a Monday; 409 `week_not_finished`; 404 for an unknown outlet.
- `GET /agent/v1/ops-review/workbook?weekStart=YYYY-MM-DD` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. 404 `single_outlet` when the restaurant has one active outlet.
- Owner twins for in-app: `GET /api/v1/restaurants/:restaurantId/ops-review` and `/ops-review/workbook` (same query, session auth). The agent token isn't accepted there.
- Both are **pure reads**: there's no write and no send. The same inputs give byte-identical text, and `generatedAt` is the only field that changes.

### 6.3 Response shape
```ts
interface OpsReviewResponse {
  restaurantId: string;
  weekStart: string;               // Monday, IST civil date
  weekEnd: string;                 // next Monday (exclusive)
  generatedAt: string;             // ISO with +05:30
  rulesVersion: string;            // "ops-review/2026-11-15.1"
  readiness: {
    ready: boolean;                // false if any blocker
    blockers: Array<{ outletId: string; platform: "zomato" | "swiggy";
      code: "days_missing" | "signed_out" | "fetch_held" | "zomato_week_missing" | "updating";
      dates: string[]; retryable: boolean }>;
  };
  status: "red" | "amber" | "green";
  multiOutlet: boolean;
  restaurant: OpsBlock | null;     // All outlets; null when single outlet
  outlets: Array<OpsBlock & { outletId: string; name: string; city: string;
    platforms: Array<"zomato" | "swiggy">; newOutlet: boolean }>;
  message: { text: string; chars: number };
  workbook: { available: boolean; fileName: string | null };
}
interface OpsBlock {
  status: "red" | "amber" | "green";
  flagCount: number;
  metrics: { zomato: OpsCell[] | null; swiggy: OpsCell[] | null; combined: OpsCell[] };
  warnings: Array<{ code: string; scope: "zomato" | "swiggy" | "combined";
    value: number; threshold: number; baseline: number | null; baselineWeek: string | null; text: string }>;
  fixes: string[];
  notes: Array<{ code: "days_missing" | "updating" | "lag_banner" | "not_available" | "new_outlet"
    | "single_platform" | "swiggy_orders_partial" | "payout_pending"; text: string }>;
}
interface OpsCell {
  key: string;                     // dictionary key or review key ("net_sales_paise", "total_orders")
  label: string;
  unit: "paise" | "count" | "pct" | "minutes" | "decimal";
  value: number | null;
  pctOfDelivered: number | null;   // count metrics (D7)
  status: "ok" | "updating" | "not_available" | "partial";
  reason?: string;
  coverageDays: number; expectedDays: number;
  missingDates: string[]; updatingDates: string[];
  baseline: { weekStart: string; value: number | null } | null;
  changePct: number | null;        // money/count; null for rates
  changePoints: number | null;     // rates
  source: "daily" | "zomato_week" | "payout" | "mixed";
  accuracy: "exact" | "approx";
  warned: boolean;
}
```

### 6.4 Runner flow (for Engineer - AI agents to build)
1. Monday 10:00 IST: `GET /agent/v1/ops-review?weekStart=<last Monday>`.
2. If `readiness.ready=false` and every blocker is `retryable`, retry at 12:00. At 14:00, send anyway (the text already names the gaps). Blockers that aren't retryable (`fetch_held`, `signed_out` not fixed) are sent at once, with the runner's own owner/admin alert as today.
3. Send `message.text` as is. If `workbook.available`, `GET …/workbook` and attach it.
4. Record it with the existing `POST /agent/v1/reports`: `type:"weekly-ops"`, `outletId:null`, `periodStart/End` = week at `+05:30`, `status` = response `status`, `summaryMarkdown` = `message.text`, `files:[{name: workbook.fileName, contentType: xlsx}]` (or `[]`), `clientNonce:"weekly-ops-<weekStart>"`. Then PUT the bytes to the signed link.
5. `POST /agent/v1/runs` start/finish as for the nightly job.
6. Never recompute, round or reword numbers. Never use Gemini. Never include UTRs.

---

## 7. Test plan (synthetic fixtures only)

Fixtures: fake restaurant "Sample Foods", outlets "Sample Kitchen", "Park Street", "New Town", fake ids (`zomatoResId: "Z-TEST-0001"`, `swiggyRid: "S-TEST-0001"`), generated numbers. **No Pawan Putra values, ids or files in git.** A guard test fails if a fixture contains a known real id (the list lives outside git, checked by CI env) or a 12–22-char UTR-like token.

**Unit (contracts, pure engine)**
- Delayed: 5.00 % → no warning; 5.01 % → warning; Zomato and Swiggy independent; no "rising" needed.
- Sales: −15.00 % → none; −15.01 % → combined; Zomato −30 % with Swiggy +20 % and the total −5 % → per-app only; sales family = 1 flag.
- Prep: one app → app-named; both → one combined warning, 1 flag; Zomato week row missing → n/a, never the rebuild.
- FRA 89.9 % improving from 85 % → warns. Rating 3.99 rising → warns; 4.20→4.19 → warns.
- Bad orders 8.5 % rising → warns; 8.5 % falling → no warning.
- Q7 baseline: last week missing → uses 2 weeks back, labelled; 5 weeks missing → no change %, threshold rules still run.
- `updating` metric → shown as "Updating", no warning. `not_available` → "n/a" with reason. Coverage 4/7 → no sum warning and no ratio warning; 5/7 → ratio warning allowed.
- Min-volume: 19 delivered with 2 delayed → no warning; 20 with 2 delayed (10 %) → warning.
- `zero_orders` → 🔴 even with 0 other flags. Status thresholds 0/1/2/3 flags.
- Totals: Zomato `placed_orders`; Swiggy payout 7/7 → `payout_orders`, else delivered + restaurant-cancelled with a note.
- Combined AOV = Σ net sales ÷ Σ delivered (not the mean of the AOVs).
- Rendering: golden files for the 2 samples above (synthetic). Single ≤ 1,200, multi ≤ 1,600 with 12 outlets (collapse rule). Indian ₹ grouping. No paise. No UTR or order-id patterns.

**Postgres (API)**: seed synthetic daily rows, Zomato week rows, payout orders with `pendingFields`, `pending_label` rows, `label_unrecoverable` rows, a `signed_out` fetch and a hold. Check readiness codes, IST week edges (Sunday 23:59 vs Monday 00:00), a new outlet mid-week excluded from the restaurant change %, Toing/train outside Swiggy totals, tenant isolation (restaurant A's token can't read B), the owner route rejecting the agent token, 400/404/409.

**Workbook**: open the generated file with exceljs in the test. Check sheet names and order, header columns, All-outlets row from summed parts, "per outlet" cells, number formats, red fills only on warned cells, no formulas, no UTR-like strings.

**Parity**: the old `calculators/ops_review.py` encodes superseded rules (C1–C4), so its tests are **not** ported as they stand. Only the fix templates and the ₹ formatter are carried over, with their own tests.

---

## 8. Open questions (each with a recommendation)

1. **Q13: source screens for the "missing" metrics (still open).** Since the questionnaire was written, the exports have answered most of it: Zomato FOR accuracy (`for_accuracy_pct`) and offline time (`offline_time_hours`) are in the Zomato Business report; Swiggy number of ratings (`rated_orders`), orders from ads (`cpc_orders`, `cba_orders`) and the full funnel (`impressions` → `menu_opens` → `cart_builds` → `swiggy_funnel_orders`) are in the Swiggy export. Still missing: **Swiggy star rating, Swiggy offline time, Swiggy rejected orders** (we have `restaurant_cancelled_orders`, kept separate per Q19).
   Options: (A) re-ask Raghav the same question in simpler words; (B) mark the remaining three "Not available" and move on; (C) close Q13 with this mapping and send Raghav **one narrow ask**: "Where in the Swiggy partner app do you see your star rating and offline time? A screenshot is enough."
   **Recommend C.** Until he answers, those three show "n/a (not in Swiggy's report)".
2. **Which sales drive the 15 % rule and AOV?** Net sales (Z BR Sales + S Net Sales, both post-discount, complete on Monday) or Gross Sales (payout, complete Thursday for Zomato and a week later for Swiggy's Sunday). **Recommend net sales.** That's like for like with Q17/Q18, matches the existing skill and calculator, and is available on Monday. Gross Sales is shown in the Excel and dashboard.
3. **Send day and time.** (A) Monday 10:00 IST on business data, with Gross Sales and payout block "after Thursday"; (B) Thursday after payouts (Swiggy's Sunday is still missing then). **Recommend A.** Gross Sales and the payout block belong to the existing Thursday `weekly-payout` report.
4. **Swiggy total orders on Monday.** The Swiggy business export only has restaurant-cancelled, not customer- or Swiggy-cancelled. (A) Show delivered + restaurant-cancelled with a note, and switch to `payout_orders` once payouts cover the week; (B) show Swiggy total orders only from payouts ("n/a until Thursday"). **Recommend A.**
5. **Flag counting for the status.** Q3 and Q4 can produce several sales warnings for one fall. **Recommend:** the sales family counts as 1 flag and prep counts as 1, so a single sales slide can't push an outlet to 🔴 on its own.
6. **Minimum-volume guards (new, not in any source).** Rates need ≥ 20 delivered orders on that app that week, and a per-app sales drop needs a baseline ≥ ₹5,000. **Recommend adopting these**, so 1 delayed order out of 8 doesn't warn. Raghav or Aman should confirm the numbers.
7. **Online %: one warning or per app?** The original Q4 asked about prep time *and* online %. Raghav's recorded answer only mentions prep time. **Recommend per app for online %** (as now), and confirm with Raghav.
8. **Toing/train orders** (conflict C6). **Recommend** following Aman (outside Swiggy totals) in a small SaaS PR that changes the owner read for both the dashboard and the review.
9. **Zomato bad orders > 8 % and rising.** Raghav changed only the delayed rule. **Recommend keeping it** as in the skill.
10. **Zomato FOR accuracy.** It's now available (official weekly). **Recommend** showing it as information without a warning until Raghav says whether the 90 % rule (Q2) applies to Zomato too.
11. **Q7 look-back limit.** **Recommend 4 weeks.** Older than that, there's no comparison.

(R1 OpenRouter funding and R2 Pawan Putra server remain open with Aman. They don't block this design.)

---

## 9. Conflicts found (sources vs code/docs)

| # | Conflict | Resolution here |
|---|---|---|
| C1 | `THRESHOLDS.md`, `ops_review.py`, SKILL: Swiggy delayed **> 8 % and rising**, Swiggy only | Q1: **> 5 %, both apps, no rising** (D3) |
| C2 | Same files: sales drop on the **combined total only** | Q3: combined **and** per app (D4) |
| C3 | Same files: KPT flagged **per app** (two flags) | Q4: one prep warning (D5) |
| C4 | Same files: missing last week → **no rising/falling flag** | Q7: use the most recent older week (D14) |
| C5 | SKILL / SKILL-GAPS: Zomato FOR and offline "not available"; Swiggy rated count absent | The exports have them (OQ1, OQ10) |
| C6 | `owner-metrics.md` / assembler: Swiggy train and Toing orders **stay inside Swiggy totals** (also listed on `categories`) | Aman's decision in Raghav's doc: **shown separately, outside Swiggy totals**. Needs a SaaS change (OQ8) |
| C7 | Owner read returns Zomato `kpt_minutes` as the **daily rebuild** (weighted avg) for any range | Q28: official weekly/monthly only. The review reads the `week_mon_sun` platform-check row. The dashboard needs the same change later |
| C8 | Dictionary `aov_paise` is `crossPlatform:false` | Q17: comparable. The review computes combined AOV from summed net sales ÷ delivered and leaves the dictionary flag alone |
| C9 | Dictionary text for `swiggy_net_sales_paise`, `ops_sales_paise`, `aov_paise` doesn't carry the Q14/Q15/Q18 meanings | Wording update in the docs PR (no key change) |
| C10 | Dictionary: `delivered_orders` is "the ops orders figure" | Q16: the review's "Total orders" includes cancelled/rejected (`placed_orders` / `payout_orders`). Delivered stays the rate denominator |
| C11 | Q14/Q16 come from the **dashboard** section of the questionnaire, while the review is mostly Q1–Q13 | They're applied to the review too, as instructed, with the timing limits in OQ2–OQ4 |
| C12 | Payouts arrive Thursday (FETCH-JOB §4), and the Swiggy cycle is Sun–Sat | A Monday review can't show Gross Sales or Swiggy payout totals (OQ3, OQ4) |
| C13 | Swiggy official weekly tiles are Sun–Sat | Mon–Sun Swiggy KPT and online % are rebuilt from days and labelled approx. A one-week Swiggy Net Sales gap between daily and weekly was seen once (DATA-DESIGN §10.12) and shows up as `metric_checks`, not in the review |

---

## 10. Proposed PR split (SaaS; each needs Aman's yes to merge; no migrations)

1. **PR A: review engine (contracts, pure).** `packages/contracts/src/ops-review/`: thresholds and `rulesVersion`, baseline picker, metric block builder, warnings, status, fixes, text renderer. Unit tests and golden files on synthetic fixtures. No DB, no endpoint.
2. **PR B: read + endpoints.** `packages/db` reads: the assembler call over 5 weeks, Zomato `week_mon_sun` platform-check reader, fetch-health summary. `GET /agent/v1/ops-review` and the owner twin. OpenAPI and `docs/restaurant-agent-api.md`, `docs/weekly-ops-review.md`. Postgres tests including tenant isolation.
3. **PR C: Excel workbook.** exceljs builder, `/ops-review/workbook` (agent and owner), workbook tests.
4. **PR D (small, can go in parallel, needs Aman's call on OQ8):** Toing/train outside Swiggy totals in the owner read, plus the dictionary wording for Q14, Q15, Q18 and Q21 (C6, C9).
5. **Runner side (Engineer - AI agents, after PR B):** the weekly job, readiness retries, sending, `POST /agent/v1/reports` (`weekly-ops`), and retiring the screen-reading weekly-ops skill and guide.

Order: A → B → C. D is independent. The runner work can start against PR B's contract (§6) as soon as this doc is agreed.
