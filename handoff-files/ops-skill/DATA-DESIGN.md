# Data design: storing and rolling up Zomato and Swiggy data for any period

Draft, 12 Nov 2026 (IST); revised 9:30 IST after Aman's push-back (**see §10: platform-computed metrics are now rebuilt from parts wherever possible**). For Aman, Raghav and Engineer - SaaS. **No code depends on this yet.** The weekly-ops branch (`cursor/weekly-ops-review`, local only, not pushed, no PR) is paused until this is agreed.

Sources used. Every point below comes from these files and nothing else. **No live logins were made.** No restaurant values, names, ids, UTRs or customer ids are copied here.

- **Zomato settlement report (xlsx), 26 Oct–1 Nov.** Copies are in `/workspace/live-agentv1/private/{run1-computer-files,live2-downloads}`, `/home/box/Downloads` and several `rakazo-bench` runs.
- **Zomato settlement report for an unfinished cycle, 2–6 Nov.** In `rakazo-bench/zomato/run2`, downloaded on 7 Nov.
- **Swiggy invoice annexure (xlsx), 25–31 Oct.** Three copies saved under different file names, in `live-agentv1/private/{run1-computer-files,live2-downloads,live3a-downloads}`.
- **Zomato Business report CSV exports**, three ranges:
  - 20 Sep–19 Oct, which came out with daily columns;
  - 1 Sep–1 Nov and 1 Sep–1 Dec, which came out with monthly columns.

  These are in `/home/box/Downloads` and `rakazo-bench`.
- **Other material:**
  - `docs/metric-dictionary.md` on main f68c554a;
  - the weekly ops skill and `SKILL-GAPS.md` in this folder;
  - `pr7-verification/REPORT.md`.
- **Not available: any Swiggy business-metrics export.** We only have the dashboard tile list from the skill.

---

## 0. Answers to Engineer - SaaS's questions

**(a) Do the business reports give order-level rows?**
- **Zomato: no.** The Business report CSV has one row per metric and one column per period. It has no order rows, and there are 47 metric rows. A 30-day range (20 Sep–19 Oct) came out as **one column per day**. Ranges of two months or more came out as **one column per calendar month**. The month columns are the platform's own figures, not sums of days.
  - The exact range length where daily columns switch to monthly is unknown. We have 30 days → daily and about 61 days → monthly.
  - A range ending on the 1st of a month did not add a column for that month. A range ending on 1 Dec added a "Nov 2026" column covering only the days to date.
- **Swiggy: still unknown.** Aman says the page has a download option. A live read-only check on 12 Nov did not reach it within budget (§10.1), so we still have no file.
  - **The single read-only fetch that answers it:** on `partner.swiggy.com/food/business-metrics`, with one outlet and Custom dates for one past Monday–Sunday, check whether a download or export button exists. If it does, download it once and note whether it gives day, week or order rows. Do not request an emailed export.

**(b) Do the payout annexures list orders with their order date?** **Yes, both.**
- **Zomato settlement report, "Order Level" sheet.** One row per order. Columns:
  - Order ID;
  - Order Date (date and time);
  - Week No.;
  - Order status, which includes CANCELLED rows as well as DELIVERED;
  - cancellation/rejection reason;
  - every money column;
  - Settlement status (`settled`/`pending`), Settlement date, Bank UTR, Unsettled Amount and Customer ID.
- **Swiggy annexure, "Order Level" sheet.** One row per order. Columns:
  - Order ID and Parent Order ID;
  - Order Date (date and time);
  - **Order Settlement Date**;
  - Order Status;
  - Order Category: Swiggy, Toing, and a train-order category;
  - Cancelled By;
  - all money columns;
  - MFR Accurate? and MFR Pressed?;
  - Long Distance and Last Mile (km);
  - Replicated Order, Base order ID and Cancellation time.

  **There is no customer id column.**

So a month can be rebuilt **by order date** from payout files alone, for the money lines the annexures carry.

**(c) Which numbers are rolling or computed by the platform?** These cannot be rebuilt from parts:
- **Zomato "Average rating".** It is **rolling, not per day**, but the platform's own monthly figure can be rebuilt from the daily snapshots (§10). On 5 of the 30 days, Rated orders was 0 but a rating was still shown, and the value only drifts from day to day. Store it as a snapshot, with the date it was read.
- **Zomato daily rates whose denominator is not given:**
  - **Online %:** the export gives Offline time (hours) but not scheduled hours.
  - **FOR accuracy (%):** no count of orders that used the food-ready button.
  - **KPT (in minutes):** an average with no order count behind it, though delivered orders is a fair weight.
  - **Ads ROI:** it does not equal Sales from ads ÷ Ads spend on the same day (1.81 computed against 2.23 shown), so it is platform-computed.
  - **Market share (%):** zero in every column.
- **Zomato funnel rates:** Impressions to menu %, Menu to cart % and Cart to orders %. Their parts are in the file (Impressions, Menu opens, Cart builds, Placed orders), so store the parts and recompute. The platform's % is kept only as a check.
- **Zomato "Effective discount (%)"** equals Discount given ÷ the column labelled "Orders with offers". In the export, the "Orders with offers" and "Gross sales from offers" labels are **swapped**: the rupee values sit under "Orders with offers". Recompute it from the parts, and map the two columns by their values, not their labels.
- **Swiggy on-screen:** Online Availability %, Kitchen Prep Time, Food Ready Accuracy (MFR) and Net AOV are all platform-computed. Whether a denominator is exported is unknown; the same Swiggy fetch as in (a) answers it.
- **Swiggy annexure "MFR Accurate?" per order.** This makes MFR accuracy **rebuildable from payout files** (count of Yes ÷ orders), at least for the orders in a cycle.
- **Ranking/position:** nothing in any file we have. **Unknown**, and not needed by the current skills.

**(d) Do the raw files contain UTRs or customer phone numbers?**
- **UTRs: yes.**
  - Zomato settlement report: `Bank UTR` on every Order Level row, `Bank UTR` in the Summary sheet, and a UTR list in the hidden `HSummary` sheet.
  - Swiggy annexure: `Bank UTR` in the Summary sheet.
  - The Zomato Business report CSV: no.
- **Customer phone numbers: no**, in any file. A pattern scan only matched Zomato 10-digit Order IDs, which are not phones. No email addresses either.
- **Other identifiers, also yes:**
  - Zomato Order Level has `Customer ID`, an opaque hex id given by the platform.
  - Zomato Summary/HSummary hold legal entity, PAN, GSTIN, MID, address and bank details.
  - The Swiggy Summary holds GSTIN and the outlet address.
- The derived owner reconciliation files (csv/json/md) and the payout-screen JSONs contain **no** UTR-shaped values.

**(e) Any evidence of how many days or cycles later the numbers still change?**
- **Little, and none of it long-range.** What we have:
  1. **Zomato settlement report for 26 Oct–1 Nov:** at least 8 copies saved across runs are **byte-identical** (same sha256). The earliest copy is from 7 Nov, three days after the Wed 4 Nov settlement.
  2. **Swiggy annexure for 25–31 Oct:** three copies, with different file-name dates/ids, are **byte-identical**.
  3. **Zomato monthly Business report, Sep and Oct columns:** downloaded twice on 8 Nov, about 10.5 h apart. Identical except float rounding on one ads line.
  4. **An unfinished Zomato cycle exists.** The 2–6 Nov settlement report, downloaded on 7 Nov, has every order `pending`, Settlement date `NA` and a non-zero `Unsettled Amount`. A pre-settlement file is downloadable and **will** change.
  5. **Both payout files have sections for late corrections:**
     - Zomato: "D) Adjustments from previous weeks".
     - Swiggy: "Adjustments from previous week", "Investments from previous week" and "Unresolved Customer Complaints — Previous Periods".

     All were empty in our sample. This suggests late corrections are **booked into a later cycle as adjustments**, not restated into the old file. This is inferred, not proven.
  6. **Swiggy shows a 48-hour lag banner** on the latest week (from the skill).
  7. **Aman's original skill warns** "exports downloaded too early can be incomplete".
- **Single read-only fetch to settle it.** Re-download the Zomato Business report CSV for the same 20 Sep–19 Oct range, now 3–7 weeks later, and diff it against the 7 Nov copy. That shows whether day figures (complaints, ratings, lost sales) get restated weeks later.
- **For payouts:** re-download the 26 Oct–1 Nov Zomato settlement report and compare sha256 with the stored copy. It is cheap, and both are read-only.

---

## 1. Where I agree and disagree with Engineer - SaaS

| Their point | My view |
|---|---|
| Store additive parts at the finest grain the exports give | **Agree.** Real grains: **payout = order level** (both apps); **Zomato business = day** (CSV, ≤30-day ranges); **Swiggy business = unknown**, probably week/day tiles read on screen. |
| Customers as a salted hash | **Agree, with a caveat.** Only Zomato payout files carry a customer id. It is already an opaque platform id, but hash it with a per-restaurant salt anyway. Swiggy gives none, so distinct customers is **Zomato-only**. For both apps, prefer Zomato's additive New / Repeat / Lapsed user orders over distinct counts. |
| Ratios as numerator + denominator | **Agree where the parts exist.** Where they don't (Zomato rating, Online %, FOR %, KPT, Ads ROI; Swiggy tiles), store the platform's value as `platform_window_only` and **never roll it up**; use the platform's own figure for the longer window instead. |
| Aggregation kind per key | **Agree.** Proposed kinds per key are in §2. |
| Raw files in object storage, sha256 dedupe, parser version, redacted at upload | **Agree.** Redaction list from the real files is in §6. **Flag:** redacting UTRs at upload breaks the bank check unless the last 4 digits are kept (the dictionary already says last 4). Keep the full file only if Aman wants an audit copy; that is a decision for him. |
| Upsert on natural keys; a fetch replaces its declared window; old values superseded, not overwritten | **Agree with the design; flag the cost.** Today `restaurant_metric_values` has a unique index on (outlet, platform, granularity, periodStart, key) and overwrites in place, with no history. "Superseded" needs a schema change (§4). |
| Re-fetch 7 days for business data, 3–4 payout cycles | **Agree as a default.** The evidence supports the payout part; nothing we have shows restatement after 7 days, but nothing rules it out (§4, and the fetch in §0(e)). Add a monthly re-pull of the previous month's Zomato monthly CSV as a cheap check. |
| Order-date and settlement-date views, with a toggle and a gap line | **Agree.** Definitions are in §3. |

---

## 2. (a) Additive and non-additive metrics, and how each rolls up

> **Revised 12 Nov, 9:30 IST:** every `platform_window_only` entry in this section is superseded by **§10**, which rebuilds each one from additive parts. Only market share stays platform-only.

**Aggregation kinds:**
- `sum`: add across days, outlets and apps (when the definitions match).
- `ratio`: store `num` and `den`; any period = Σnum ÷ Σden.
- `weighted_avg`: store `value × weight` and `weight`; that is a ratio with a named weight.
- `snapshot`: a state at a moment (rating as of a date, menu state, commission %). Roll up = latest in the period, or the platform's value for the period.
- `distinct`: needs ids. Roll up by counting distinct hashes across the period, never by adding.
- `platform_window_only`: a figure only the platform can compute for a window. Store it per window it was read for, never add or average it, and fetch the platform's own figure for longer windows.

| Family | Keys (dictionary names) | Kind | How a week / month / custom range is built |
|---|---|---|---|
| Sales, orders | `gross_sales_paise` (payout ST+PC), `ops_sales_paise`, `delivered_orders`, `placed_orders`, `cancelled_orders`, `rejected_orders` | sum | Σ days (or Σ orders by order date). Never mix `gross_` and `ops_` sales. |
| Money lines | `discount_paise`, `ad_spend_paise`, `commission_paise`, `platform_fees_paise`, `taxes_paise`, `net_payout_paise`, `tds/tcs/gst_collected_paise`, `lost_sales_paise`, `cancelled_order_loss_paise` | sum | Σ by order date (accrual) **or** Σ by settlement date (cash); see §3. |
| Bad-order parts | `delayed_orders`, `poor_rated_orders`, `complaints`, `bad_order_complaints`, complaint sub-types | sum | Σ days. **Bad orders % = Σ bad orders ÷ Σ delivered.** That needs a **new key `bad_orders`** (Zomato exports "Bad orders" as a count). |
| Funnel | `impressions`, `menu_opens`, `cart_builds`, `placed_orders` | sum | Rates are recomputed: menu opens ÷ impressions, etc. Retire the stored `%` keys, or keep them as platform checks only. |
| Customer mix | `new_user_orders`, `repeat_user_orders`, `lapsed_user_orders`, meal-slot orders | sum | Σ days. Additive and Zomato-only. |
| AOV, discount %, ads %, payout % | `aov_paise` and the dictionary's derived keys | ratio, derived | Recompute from sums. **Stop storing `aov_paise`** except as a check. |
| Kitchen time | `kpt_minutes` | weighted_avg (Zomato), platform_window_only (Swiggy until a count is found) | Zomato: store `kpt_minutes × delivered_orders` and `delivered_orders`. This is an approximation, because the platform's own weight is unknown, so label it. |
| Rating | `rating`, `rated_orders` | **superseded by §10** (snapshot mean + true star average) | Zomato's daily value is rolling, so **do not average days**. For a week or month, use the platform's figure for that window: the monthly CSV column, or the weekly screen. Show "rating as of <date>" otherwise. `rated_orders` is a plain sum. |
| Availability | `online_pct`, `offline_time_hours` | offline hours = sum; online % = platform_window_only | Recomputing online % needs scheduled hours, which are not exported. Use the platform figure per window. |
| Accuracy | `for_accuracy_pct` (Zomato), `food_ready_accuracy_pct` (Swiggy) | platform_window_only; Swiggy can become a ratio from the annexure | Swiggy: Σ "MFR Accurate? = Yes" ÷ orders from payout rows. This is by order date, a different population than the screen; label it. |
| Ads platform metrics | `ads_roi`, `ads_ctr_pct` | platform_window_only | ROI can also be derived as ads sales ÷ ads spend; keep both, labelled. |
| Distinct customers | (new) `unique_customers` | distinct | Zomato payout rows only (salted hash). **Not available for Swiggy.** |
| Commission % | `commission_pct` on the outlet | snapshot | Effective commission per period = Σ commission ÷ Σ commissionable value (a ratio). |
| Flags | `lag_banner` | snapshot | Any day true → the period is "may still change". |

**Recommendation:**
- Add `num`/`den` support as **paired keys**, for example `bad_orders` + `delivered_orders`, rather than a new column type. Store derived rates nowhere.
- Add an `aggregation` field per key in the dictionary and in `METRIC_KEYS` metadata, so the API and dashboard refuse to sum a `platform_window_only` key.

**Open questions:**
- **Aman/Raghav:** for rating, online % and KPT over a custom range (say 10 days), is "platform figure for the nearest window plus a note" acceptable, or should these simply be hidden for custom ranges?
- **Raghav:** for the owner, is Zomato's KPT weighted by delivered orders close enough, or should we only ever show the platform's weekly/monthly KPT?

## 3. (b) Payout cycles: order-date view and settlement-date view

**Facts from the files:**
- **Zomato cycle: Monday–Sunday by order date.** All 206 rows in the 26 Oct–1 Nov file have order dates in that range and Week No. 44. All were settled on the same date (Wednesday, 3 days later). The hidden summary says "Weekly (Every Wednesday)".
- **Swiggy cycle: Sunday–Saturday** (25–31 Oct, a Sun–Sat in our file). Order Level shows a per-order `Order Settlement Date`, all one date. The Summary sheet's "Payout Settlement Date" is **one day earlier** than the order-level column. The dictionary also says Swiggy **splits a cycle at month end**; that is not seen in our sample.
- **Both apps put restaurant-level deductions** (ads, marketing, co-branded) in separate sheets with their own "Period From/To". These are **not order-dated**.

**Options:**
1. Store cycle totals only. This is today's 11-row calculator output. Simple, but a calendar month can only be approximated.
2. **Store order-level rows from the annexure plus restaurant-level adjustment rows, and roll up both ways.** *(Recommended)*
3. Store daily rows by order date, aggregated at parse time, plus cycle totals. A middle ground: less storage, but you can't re-cut later.

**Recommendation: option 2.**

**Order-level fact table:**
- **Key:** (platform, outlet, order id).
- **IST order date.**
- **Cycle:** id, start and end.
- **Settlement:** status, date, and UTR **last 4 only**.
- **Status, category and cancelled-by.**
- **Additive money columns** mapped to dictionary keys.
- **Customer hash** (Zomato only).
- **Swiggy MFR flags.**

**Adjustment table:**
- **Key:** (platform, outlet, cycle, adjustment type, invoice/campaign id).
- **Columns:** period from/to, amount and settled amount.

**Views:**
- **Order-date (accrual):** Σ order rows by IST order date in the period. Adjustments are allocated to the period by their own "Period From/To", pro rata by day. They are shown as a separate line; do not hide them inside order money.
- **Settlement-date (cash):** Σ by settlement date in the period, order rows plus adjustments. This ties to bank UTRs.
- **Gap line:** settlement total − order-date total for the same period. It equals orders placed earlier but settled in the period, minus orders placed in the period but not yet settled, plus adjustments booked differently. Show it as one line with a tooltip, and mark "pending" when any row in the period is `pending`.

**Open questions:**
- **Aman:** which view is the default on the dashboard? I suggest order-date for "how did we do", and settlement-date for "what hit the bank".
- **Aman:** Swiggy Toing and train orders are in the same annexure. Include them in Swiggy totals, or split them? (Dictionary question 15.)
- **Raghav:** how should restaurant-level ads/marketing deductions be allocated to a calendar month when their period straddles two months: pro rata by day, or all in the month the period ends?

## 4. (c) Late corrections, re-fetch windows, and no double counting

**What can change:**
- An unfinished payout cycle: pending → settled, with unsettled amount → 0 (seen).
- Adjustments for earlier weeks booked into a later cycle (sections exist, but were empty in our sample).
- Swiggy's latest-week tiles under the 48-hour banner.
- Zomato's rolling rating (by design).
- Business-report day figures possibly restated later; **unknown**, see the fetch in §0(e).

**Recommendation:**
- **Every fetch declares its window:** platform, outlet, granularity, and from/to. Writing replaces **all** values in that window atomically:
  1. Old rows get `supersededAt` and `supersededByFetch`.
  2. New rows are inserted.
  3. Readers only see rows that are not superseded.

  This needs, alongside the existing metric table:
  - a `metric_fetches` table: id, window, source, file sha256, parser version, capturedAt, status;
  - a nullable `fetchId` and `supersededAt` on value rows. The unique upsert index becomes partial (`WHERE supersededAt IS NULL`).
- **Payout order rows:** natural key (platform, outlet, order id). Re-parsing a re-downloaded cycle replaces that cycle's rows, so there's no double count. Because adjustments carry their own cycle id, an adjustment for an earlier week is counted once, in the cycle that booked it. In the order-date view it is allocated by its period.
- **Re-fetch windows:**
  - **Business data:** nightly, the last **7 days**. Zomato is one CSV with daily columns per outlet; Swiggy is per-day screen reads until an export is known.
  - **Monthly check:** on the 3rd, re-pull the previous **month** as Zomato's monthly column, as a check against Σ days. A mismatch above 0.5% raises a note, not an overwrite.
  - **Payouts:** each run re-pulls the last **4 cycles**. Unchanged sha256 → skip parsing (cheap). A `pending` cycle is always re-pulled until settled. A lag-banner Swiggy week is re-read until the banner is gone.
- **Never** store a pending cycle as final. Mark the period "provisional" in both views.

**Open questions:**
- **Aman:** OK to add history (superseded rows)? It roughly multiplies storage by the number of re-fetches. The alternative is to keep only the latest value plus a fetch log with sha256.
- **Raghav:** have you seen Zomato or Swiggy restate a settled week's file, rather than adjusting a later one? That decides whether 4 cycles is enough.

## 5. (d) Timezone and day cut-off, gaps, backfill, outlets added mid-period

**Time:**
- Store `periodStart` as IST midnight (`+05:30`); the API already does.
- Order rows keep the platform's local timestamp converted to IST. The Zomato file shows naive times that read as IST; settlement times show as 05:30, so their source is UTC midnight.
- **Day = IST calendar day by order time**, for both apps. Whether Zomato's business-report day uses order time or delivery time for orders around midnight is unknown. The impact is small; note it as an open question.

**Gaps:**
- The nightly fetch records each (platform, outlet, day) as a fetch row with status. A failed night leaves no values plus a `failed` fetch row, so "missing" is explicit, not zero.
- Readers report missing days by name. The weekly review must say "Zomato 4–5 Nov not stored", never compute a partial week as a full one.

**Backfill:**
- The 7-day re-fetch heals short gaps automatically.
- Longer gaps: Zomato daily CSV takes up to a 30-day range per download, so 30 days is one fetch per outlet.
- Payouts: re-download the missing cycles. They are order-level, so any range can be rebuilt.
- Cap a backfill run (for example 90 days) so cost stays predictable.

**Outlets added mid-period:**
- Period totals only cover days the outlet existed. Comparisons (week vs week) mark "new outlet, no prior week" instead of showing −100% or +∞.
- Store `activeFrom` on the outlet, and use the first day with data if it isn't known.
- A deactivated outlet keeps its history and drops out of "all outlets" from its end date.

**Open question:**
- **Aman:** for a multi-outlet "all outlets" total over a period where one outlet joined mid-way, show it as is (with a note), or like-for-like only?

## 6. (e) Where Zomato and Swiggy definitions differ

See `docs/metric-dictionary.md` (main), especially *Two different "sales" worlds*, *Periods*, *Platform-only*, and *Open questions* 1–15. The real files add these points:
- **Payout cycles:** Zomato Mon–Sun, Swiggy Sun–Sat. A combined payout "week" is never the same days. The order-date view (§3) is the only like-for-like way to compare.
- **Orders in payout files:** Zomato Order Level includes CANCELLED rows. Swiggy includes cancelled rows with "Cancelled By" (customer or Swiggy). Delivered-only counts must filter by status on both.
- **Swiggy annexure is all-channel:** Swiggy, Toing and train orders.
- **Rating:** Zomato only; it is rolling. Swiggy shows no rating on the business screen.
- **Food-ready accuracy:** Zomato FOR % (monthly/daily export only); Swiggy MFR (screen tile, and per-order in the annexure). These are different measures, never combined.
- **Delays:** Zomato "KPT+10 delayed orders"; Swiggy "Delayed Orders (>10 min)". These look alike, but the definitions are unconfirmed (dictionary question 11).
- **Zomato export label swap:** "Orders with offers" and "Gross sales from offers (Rs)" are swapped in the CSV. Map them by value or units, not by label, and add a parser test for it.

## 7. (f) Raw files plus parsed rows, or aggregates only

| Source | Store raw? | Why |
|---|---|---|
| Zomato settlement report, Swiggy annexure (xlsx) | **Yes, redacted, sha256-deduped, with parser version** | Order level and money; re-parse when the mapping changes (for example Toing split, discount mapping). We already have 8 byte-identical copies of one file, so dedupe pays off immediately. |
| Zomato Business report CSV | **Yes** (small, ~50 rows) | Re-parse if label mapping changes (the swap above). Diffing re-downloads is also how restatement is detected (§4). |
| Swiggy business-metrics | **Screen reads: no file, store parsed values only, with a fetch row and a screenshot only on failure.** If an export exists, store it like the Zomato CSV. | Nothing to re-parse. |
| Payout screen readings (paid amount, date, UTR last 4) | Parsed values only | The bank check only needs a few figures. |

**Redaction at upload** (from §0(d)):
- `Bank UTR` → last 4, in Zomato Order Level, Zomato Summary and the Swiggy Summary.
- Drop the `HSummary` UTR list, PAN, bank account and MID cells.
- Hash Zomato `Customer ID` with a per-restaurant salt.
- GSTIN and address are business identifiers: keep or drop per Aman.
- No phone or email columns exist today, but run a pattern check at upload anyway.
- **Keep the original unredacted file nowhere.** If a re-parse needs a redacted column, the parser gets it from the platform again.

**Retention:** raw files for 13 months (one year-on-year comparison), parsed rows indefinitely. **Open: Aman.**

---

## 8. What this changes in the paused weekly-ops work

- **Split agreed (Aman, 8:53):**
  - A nightly **fetch** skill stores data through `/agent/v1`.
  - The weekly **review** reads only stored data and never logs in, and reports missing days.
- **What should change in that design:**
  - **Zomato fetch:** download the Business report CSV for the last 7 days, one file per outlet, instead of reading tiles. It gives daily columns, needs no screen reading, and is cheaper and more exact. This needs Aman's OK, because the old skill says to read from the screen ("exports downloaded too early can be incomplete"). The 7-day re-fetch covers that.
  - **Weekly review roll-up:** my paused draft averaged daily rating, KPT and online % weighted by orders. **That is wrong for rating**, which is rolling. Per §2, the review should:
    - use sums and num/den for additive keys;
    - use the platform's own week figure (or "as of" snapshot) for rating, online % and FOR/MFR.
  - So the nightly fetch must also store the **week** figure for those keys every Monday.
  - **New keys likely needed:**
    - `bad_orders` (count);
    - `menu_opens`, `cart_builds`, `impressions` (some already listed);
    - `unique_customers` (Zomato only);
    - order-level and adjustment tables, which are **not** metric keys and need an Engineer - SaaS schema change.
- **State:** the local branch `cursor/weekly-ops-review` has uncommitted work:
  - a GET `/agent/v1/metrics` read-back endpoint, with tests;
  - ops calculators, CLIs and tests;
  - starter bot and skill files.

  **Nothing has been pushed, and no PR is open.**

## 9. All open questions

**Aman**
1. Default dashboard view: order date or settlement date? (§3)
2. Toing and train orders: inside Swiggy totals, or split out? (§3, §6)
3. OK to keep superseded history, or latest value plus a fetch log? (§4)
4. OK for the nightly Zomato fetch to download the Business report CSV instead of reading tiles? (§8)
5. Keep GSTIN/address in stored raw files? Retention of 13 months? (§7)
6. For "all outlets" totals with a mid-period new outlet: show as is, or like-for-like? (§5)
7. Rating, online % and KPT over custom ranges: platform window plus a note, or hide? (§2)

**Raghav**
1. Ever seen a settled week restated, rather than adjusted in a later cycle? (§4)
2. Allocating straddling ads/marketing deductions to a month: pro rata, or by period end? (§3)
3. Is order-weighted Zomato KPT acceptable, or platform figures only? (§2)
4. Zomato "Bad orders" breakdown: counts, as the CSV shows, or % on the weekly screen? (Dictionary question 11; the CSV says counts.)
5. Do Zomato business-report days use order time or delivery time? (§5)

**Single read-only fetches that would close the remaining unknowns** (none run):
1. **Swiggy business-metrics export:** does one exist, and at what grain? (§0(a), (c))
2. **Zomato Business report CSV for 20 Sep–19 Oct, again:** diff it against the 7 Nov copy to find out whether day figures are restated. (§0(e))
3. **Zomato 26 Oct–1 Nov settlement report, again:** compare sha256 to find out whether a settled cycle changes. (§0(e))

---

## 10. Rebuilding platform-computed metrics from parts (revision, 12 Nov, after Aman's push-back)

Aman's rule: **do not give up on calculated metrics.** Every metric we had called `platform_window_only` gets a route from parts that add up. His example is rating = sum of all stars ÷ count of rated orders. The platform's own figure is kept only as a **check**, and only metrics with no route at all fall back to it.

### 10.1 Swiggy business-metrics export (live check)

Two read-only runs on the existing stack, image = main c2364233 tree, Grok 4.7, saved browser session, no Playwright:
- **Run 1, ₹75.7.** Already signed in. It filtered to the one outlet and was setting the Custom date range when my ₹75 per-run cap stopped it. **No file was downloaded.**
- **Run 2, ₹10.9.** Swiggy now showed the sign-in page. Run 1 had been signed in, and the cap stop of the app containers may have ended that session. A password login would not fit the remaining budget, so it stopped. **No login and no OTP.**

- **Run 3 (12 Nov, 09:41–09:49 IST), ₹208.4, loose ₹220 backstop.** Swiggy had signed us out again. Password login worked first time (mobile number, then "Login with Password"; no OTP requested, Resend never clicked). The agent then spent about 7 minutes and 83 model calls fighting the **multi-select outlet filter** (search found the outlet, but "Clear all" would not clear the other outlets). I stopped it at ₹208 before it reached the date picker. **No file was downloaded.**

> **Superseded 12 Nov ~10:05 IST (round 4):** the export was downloaded by hand in the box browser (₹0). See §10.7.

**Result (as of round 3):** the export's grain, columns and personal data are **still unconfirmed** after ₹295 over three runs. Agent navigation of this page is the problem, not the export. Next step options: (a) Aman downloads one week himself (2 Nov–8 Nov, his outlet only) and shares the file, which costs ₹0; or (b) a scripted, generic helper for the outlet filter and date range before any further agent attempt. No more agent attempts without one of these.

### 10.2 Zomato rating: what the daily CSV really holds

**The daily "Average rating" is the outlet's rolling rating, not that day's average:**
- It changed on days with **0** rated orders.
- One day had 6 rated orders, 3 of them poor-rated (1–2 stars). Its day average could not exceed 3.5, yet the shown value was 3.9.
- So **rating × rated orders is NOT a usable daily star sum**, and Aman's formula needs the per-order stars.

**The platform's monthly "Average rating" ≈ the simple mean of the daily snapshots:**
- **Sep:** the 11 days we have give a mean within **0.12%** of the September figure.
- **Oct:** the month figure implies the 12 days we don't have averaged 4.320, and the last days we do have sit at 4.315–4.325. That is consistent to about **0.1%**.
- **Wrong method:** weighting the days by rated orders gives a figure **3.7% off**.

**Rating display (Aman, 12 Nov 09:39 IST): show only the platform's own rating, as it appears in the report.** "Ratings received this period" (Σ stars ÷ rated orders) is **not shown to users**. It stays an optional internal series, only if the reviews page ever gives per-order stars cheaply.

| Series | Formula | Parts to store | Source | Shown to users |
|---|---|---|---|---|
| **Platform rating** | Σ daily snapshots ÷ days with a snapshot (any range); the latest snapshot for "as of today" | `rating_snapshot_sum`, `rating_snapshot_days` (both additive), plus the daily snapshot itself | Zomato daily CSV | **Yes, the only rating shown** |
| Ratings received in the period (internal, optional) | Σ stars ÷ rated orders | `rating_stars_sum`, `rated_orders` | reviews page, not seen live | No |

### 10.3 Every platform-computed metric

Accuracy is measured against the platform's own figure on the 30 days of Zomato daily CSV (20 Sep–19 Oct) wherever the parts and the figure exist together.

| Metric | Rebuild formula | Parts to store | Source | Accuracy |
|---|---|---|---|---|
| Zomato rating (platform) | Σ daily rating ÷ days | `rating_snapshot_sum`, `rating_snapshot_days` | daily CSV | ~0.1% (month); see 10.2 |
| Zomato rating (received), internal only, not shown | Σ stars ÷ rated orders | `rating_stars_sum`, `rated_orders` | reviews page | not measured; dropped from the UI (Aman, 09:39) |
| Swiggy rating | platform figure as shown (snapshot; snapshot mean for a range if Swiggy gives a daily series) | `rating_snapshot_sum`, `rating_snapshot_days` | Swiggy export or screen | not on the business screen or in the annexure; not measured yet |
| Zomato online % | Σ(online %ᵈ × scheduled hoursᵈ) ÷ Σ scheduled hours; = mean of days if the hours are equal | `online_hours` (= online % × scheduled), `scheduled_hours` | daily CSV + outlet timings page | not measurable yet. **`offline_time_hours` cannot be used:** 3 days were under 100% with 0 offline hours, and one day was 76% with 2.0 h. |
| Swiggy availability % | same | same | export (if daily) + timings | unknown |
| Zomato KPT | Σ(KPTᵈ × delivered) ÷ Σ delivered | `kpt_weighted_sum`, `delivered_orders` | daily CSV | approximation. No per-order prep times in any file. Gap measurable with one Oct 1–31 daily CSV against the Oct column. |
| Swiggy prep time | same | same | export | unknown |
| Zomato FOR accuracy | Σ(FOR %ᵈ × delivered) ÷ Σ delivered | `for_accurate_est`, `delivered_orders` | daily CSV | approximation; not measured |
| Swiggy MFR accuracy | accurate orders ÷ eligible orders | `mfr_accurate_orders`, `mfr_eligible_orders` | annexure per order ("MFR Accurate?", "MFR Pressed?") | not measured. "Pressed" is almost always No, so the right denominator must be checked against the tile before use. |
| Zomato Ads ROI | (Σ ads sales + Σ discount × ads orders ÷ delivered) ÷ Σ ads spend; ROI uses ads sales **before** discount | `ads_sales_paise`, `ad_spend_paise`, `ad_orders`, `discount_paise`, `delivered_orders` | daily CSV | **Daily: median 0.58%, max 2.86%. 7-day: 0.04–0.48%.** Plain sales ÷ spend is 17–26% off. |
| Zomato Ads CTR | ads menu opens ÷ ads impressions | `ads_menu_opens`, `ads_impressions` | daily CSV | ≤0.05 points (rounding) |
| Zomato funnel % (3) | menu opens ÷ impressions, carts ÷ menu opens, placed ÷ carts | `impressions`, `menu_opens`, `cart_builds`, `placed_orders` | daily CSV | **exact** (0.0 points) |
| Zomato effective discount % | discount ÷ gross sales from offers (the column mislabelled "Orders with offers") | `discount_paise`, `offer_gross_sales_paise` | daily CSV | **exact** |
| Bad orders % | Σ bad orders ÷ Σ delivered | `bad_orders`, `delivered_orders` | daily CSV | exact. The count is **not** the sum of its parts (7–10 of 30 days differ), so store the platform's count. |
| AOV (both) | Σ sales ÷ Σ delivered | existing keys | CSV / export | exact by definition |
| Market share % | needs the market total | none | — | **cannot be rebuilt.** It is 0 on every day in our file; keep the platform figure only. |
| Other Swiggy tiles (Net AOV, cancelled loss, delayed, complaints) | counts and money are sums; rates are num ÷ den | as listed | Swiggy export | unknown until the export is seen |

### 10.4 Still not rebuildable, so the platform figure stays

> **Round 4 update:** see §10.9 for the current list. Swiggy rates are now rebuilt (§10.7), and KPT, FOR and rating were tested on a full month (§10.8).

- **Market share.** No market total is exposed anywhere.
- **Online % until scheduled hours are stored.** With hours from the outlet timings page it becomes rebuildable.
- **KPT and FOR accuracy are only approximate.** The platform's own weighting is unknown and there are no per-order timestamps. They are kept as weighted sums, labelled "approximation", until the Oct 1–31 test measures the gap.
- **Every Swiggy rate until the export is seen.**

### 10.5 The cheapest checks that would close the gaps (read-only, not run)

1. **Swiggy business-metrics:** download one Mon–Sun week, plus 30 days if cheap. Gives grain, columns and ids. Budget about ₹150.
2. **Zomato Business report CSV for 1–31 Oct:** compare it with the Oct monthly column. This measures the gaps for KPT, FOR, online % and rating in one file. If 31 days comes out monthly, use 2–31 Oct plus 1 Oct.
3. **Zomato and Swiggy reviews pages:** check whether per-order stars and dates are listed or exportable (Aman's rating formula).
4. **Zomato and Swiggy outlet timings pages:** scheduled hours per day (online %).

### 10.6 Validation run, 12 Nov (round 3): rebuilt figure vs the platform's own figure

> **Round 4 update:** the pending weekly and monthly rows below are now tested in §10.8 and §10.9.

Script: `validation/validate_zomato.py` (any range, any period column) and `validation/daily_check.py` (per day). Data: Zomato daily CSVs for 20 Sep–19 Oct (30 days, already held) and **5–11 Nov (7 days, new from this run)**, plus the Sep/Oct monthly CSV. Pass = gap ≤ 0.5%, or ≤ 0.05 points where the platform rounds a % to 1 decimal.

**What this round's live checks returned:**
- **Swiggy, ₹208.4:** login OK, stuck on the outlet filter, no file (10.1).
- **Zomato, ₹177.4:** still signed in, no code asked. The agent did not set 2–31 Oct; it downloaded **5–11 Nov daily** (and 11 Nov twice) before the ₹175 backstop stopped it. So **the Oct 1–31 test did not happen.**
- A 1-day CSV (11 Nov) is identical to the same day in the 7-day CSV, so daily values don't depend on the range requested.

| Metric | Rebuild | Daily (37 Zomato days) | Weekly | Monthly | Verdict |
|---|---|---|---|---|---|
| Impressions → menu % | menu opens ÷ impressions | max 0.049 pts (rounding) | no platform weekly figure in any file | not tested (no full month of days) | **Pass** (daily) |
| Menu → cart % | carts ÷ menu opens | max 0.046 pts | – | – | **Pass** (daily) |
| Cart → orders % | placed ÷ carts | max 0.047 pts | – | – | **Pass** (daily) |
| Ads CTR % | ads menu opens ÷ ads impressions | max 0.048 pts | – | – | **Pass** (daily) |
| Effective discount % | discount ÷ gross sales from offers (swapped label) | 0.000% | – | – | **Pass, exact** |
| Ads ROI | (ads sales + discount × ads orders ÷ delivered) ÷ spend | median 0.59%, max 2.86% | – | – | **Pass on median, fails 0.5% on worst days**: approximation label stays. Plain sales ÷ spend is 19.5% off (wrong) |
| Zomato platform rating | mean of daily snapshots | n/a (the daily value is the platform's) | – | Sep: 0.12% on 11 of 30 days | **Provisional pass**; full-month test pending |
| KPT | Σ(KPT × delivered) ÷ Σ delivered | n/a (daily value is the platform's) | – | **not tested** | Pending |
| FOR accuracy | Σ(FOR × delivered) ÷ Σ delivered | n/a | – | **not tested** | Pending |
| Online % | Σ(online % × scheduled h) ÷ Σ scheduled h | n/a | – | **not tested** | Pending (also needs scheduled hours) |
| Bad orders %, AOV | num ÷ den | no platform rate in the CSV (counts only) | – | – | Exact by definition; nothing to test against |
| Market share | – | 0 on every day | – | – | **Not rebuildable** |
| Every Swiggy metric (incl. MFR) | see 10.3 | **not tested**: no Swiggy business export yet | – | – | Pending |

**Why weekly and monthly are mostly untested:**
- No file we hold has a platform weekly figure.
- The only full months with platform figures (Sep, Oct) are each covered by only 11 and 19 days of daily data.

**Cheapest way to close it:** Aman downloads, by hand (₹0):
- Zomato Business report, Daily, 2–31 Oct. We already hold 1 Oct.
- Zomato Business report, Weekly view, October. This only works if the generator offers a weekly view.
- One Swiggy business-metrics export for 2–8 Nov.

`validate_zomato.py --daily <2–31 Oct> zomato_daily_20sep_19oct.csv --period zomato_monthly_sep_oct.csv --period-col "Oct 2026" --from 2026-10-01 --to 2026-10-31` then gives the monthly gaps for every row above in one go. Agent navigation of these report generators cost ₹175–₹210 per attempt today and failed both times, so it should get a scripted helper first.

### 10.7 Swiggy business-metrics export: found and parsed (round 4, 12 Nov ~10:05 IST)

Aman's pointer was right. **Swiggy has a download with Daily, Weekly (Sun–Sat) and Monthly views.** Files, the full column list and the key mapping are in `validation/swiggy/SWIGGY-EXPORT.md`. The script is `validation/swiggy/validate_swiggy.py`, and its output is in `VALIDATION-OUTPUT.md`.

- **Shape:** an xlsx with one sheet, one row per metric (74) and one column per period. It is **not order level**. Values are text such as "₹…", "…%" and "… min".
- **Personal data: none.** There are no customer, phone, bank or tax fields, so the files are kept unchanged.
- **Every Swiggy % has delivered orders as its denominator.** The tell: % × delivered is a whole number within rounding for MFR, delayed >10 min, discounted orders, new/repeat customer orders and complaint orders, in all 17 columns at all three grains. So each becomes an **additive whole count** plus `delivered_orders`.
- **Hidden parts recovered:**
  - Swiggy GMV = RDGMV ÷ Discount GMV %;
  - Bolt sales = Bolt AOV × Bolt orders;
  - Bolt prep minutes = Avg prep × Bolt orders;
  - item revenue = item % × top-5 revenue.
- **Exact identities:** the 5 order-value bands add up to delivered orders, and the 5 complaint types add up to non-refunded + refunded, at every grain.
- **Gaps and oddities:**
  - **No rating value** (only rated and poor-rated counts).
  - **CPC spend is ₹0** everywhere even with CPC sales, so ROAS shows 0% and ad spend has to come from payout adjustments.
  - **The monthly "CPC Ads Depth" is wrong on Swiggy's side** (0.8–6% vs 19–39% from its own parts; the daily and weekly figures match exactly).
  - **Menu scores are 0** on days and the running week, which means not computed.
  - **New/Repeat/Dormant Customers are distinct people**, so they can't be added across days.
  - **The top-5 item rows depend on the requested range.**
- **Roll-ups:** the daily file (2–8 Nov) and the weekly file (1–7 Nov) share only 6 days, and the weekly file only covers 11–31 Oct of October. So **no full Swiggy roll-up test was possible.**
- **Residual test instead:** week minus 6 days = implied 1 Nov, and October minus 3 weeks = implied 1–10 Oct.
  - Every additive part comes out non-negative and typical: 1 Nov has 52 orders against 53 on Sunday 8 Nov, and KPT 9.95 min, MFR 92%, AOV ₹502.
  - 1–10 Oct runs at 30 orders a day, KPT 10.52 and online 99.37%.
  - Nothing contradicts "week = sum of days".
- **To test properly:** one Daily download that lines up with a whole Swiggy week and month, for example 1–30 Nov in December, or Daily 1–31 Oct now (₹0 by hand).

### 10.8 Zomato roll-up test: daily summed to Zomato's own weekly and monthly (round 4)

Files and notes: `validation/zomato/README.md`. Script: `validation/zomato/validate_zomato_rollups.py` → `VALIDATION-OUTPUT.md`.

- **Data:** daily 1–31 Oct, plus 28–30 Sep from the old 20 Sep–19 Oct file; weekly W40–W44 (ISO Mon–Sun); monthly Sep and Oct.
- **Tested:** W40–W43 (all 7 days held) and October (31/31).
- **Untestable:** W44 needs 1 Nov, which we don't hold. Implied-1-Nov residuals are plausible (31 orders, KPT 11.6). September is untestable too, with only 11 of 30 days held.
- **Every count and money row sums exactly** to the weekly and monthly figure (0.00%), except **Offline time (hours)**. Zomato rounds that to whole hours per day, so the days add to 3 h where October says 5 h. **It can't be summed.**
- **Zomato rating = simple mean of the daily snapshots: exact** (0.0000 gap) for W40–W43 and for October. Weighting by rated orders is 0.9% off for October.
- **KPT** (weighted by delivered orders): 0.23%, 0.36%, 0.40% and 0.62% for W40–W43, and 0.32% for October. The rebuild is always slightly high, by ≤0.05 min (3 seconds); W43 misses the 0.5% bar by 0.002 min. A simple mean of days fails (up to 5.6%). Keep the "approximation" label.
- **FOR accuracy** (weighted by delivered): 0.04–0.08% for W41–W43 and 0.07% for October, so it passes. W40 is 0.47% (0.38 pts), passing on % but the loosest.
- **Online %, equal day weights:** it passes for W40, W41 (exact), W43 (0.06%) and October (0.43%), but **fails W42 by 0.96%** (94.82 vs 93.92). That week had 3 part-offline days. Weighting by orders or impressions fixes W42 and breaks W43. **It needs scheduled hours per day.** Until then: approximation, and show Zomato's own weekly or monthly figure where one exists.
- **Ads ROI** (before-discount formula): 0.21–0.37% weekly and 0.26% for October, so it **passes**. Plain sales ÷ spend is 17–26% off.
- **Funnel % ×3 and Ads CTR:** all within 0.05 pts. Zomato rounds these to 1 dp, so the relative gap can reach 0.72% (CTR, October) and still be rounding. **Pass.**
- **Effective discount %: exact.**
- **Restatement (new):** re-downloaded days 15–19 Oct (the last 5 days of the earlier download) had changed. Rated, poor and bad orders rose, and on the last day KPT, FOR and ads changed. Days older than 5 days were unchanged.
  - The nightly **7-day re-fetch** covers this.
  - The **monthly check on the 3rd** stays as the safety net, because ratings can arrive late.

### 10.9 Combined pass/fail (round 4). Pass = ≤0.5%, or ≤0.05 pts where the platform rounds

| Metric | Rebuild | Zomato weekly (W40–43) | Zomato Oct | Swiggy day / week / month (same file) | Swiggy roll-up | Verdict |
|---|---|---|---|---|---|---|
| All counts and money | Σ days | exact | exact | identities exact | residual plausible | **Sum** |
| Funnel % ×3 | Σ num ÷ Σ den | ≤0.05 pts | ≤0.03 pts | ≤0.005 pts | – | **Pass** |
| AOV / Net AOV | sales ÷ delivered | exact | exact | 0.00% | – | **Pass** |
| Zomato effective discount % | discount ÷ offer gross sales | exact | exact | – | – | **Pass** |
| Swiggy RDPO, Discounted orders %, Discount GMV % | ÷ delivered; RDGMV ÷ derived GMV | – | – | ≤0.01% | – | **Pass** |
| Ads ROI (Zomato) | (ads sales + discount × ads orders ÷ delivered) ÷ spend | 0.21–0.37% | 0.26% | Swiggy ROAS untestable (spend ₹0) | – | **Pass** (Zomato) |
| Ads CTR (Zomato) | ads menu opens ÷ ads impressions | ≤0.05 pts | 0.05 pts | – | – | **Pass** |
| Swiggy CPC Ads Depth | CPC sales ÷ GMV | – | – | 0.02% / 0.02% / **fails monthly** (Swiggy's figure is wrong) | – | **Pass**; ignore Swiggy's monthly figure |
| Zomato platform rating | mean of daily snapshots | **exact** | **exact** | no rating in the Swiggy export | – | **Pass** |
| KPT | Σ(KPT × delivered) ÷ Σ delivered | 0.23–0.62% (W43 fails by 0.002 min) | 0.32% | n/a (daily figure is Swiggy's) | untestable; plausible | **Approximate pass** (≤3 s) |
| FOR accuracy (Zomato) | Σ(FOR × delivered) ÷ Σ delivered | 0.04–0.47% | 0.07% | – | – | **Pass** |
| Swiggy MFR | accurate orders (% × delivered) ÷ delivered | – | – | ≤0.01% all grains | sum of counts | **Pass** |
| Delayed %, complaint orders %, new/repeat order %, Bolt %, Bolt <6 min % | count ÷ delivered (or ÷ Bolt orders) | – | – | ≤0.23% all grains | sum of counts | **Pass** |
| Online % | equal-day mean now; Σ online h ÷ Σ scheduled h later | 3 of 4 pass, **W42 fails 0.96%** | 0.43% | untestable (all 100%) | plausible | **Approximation** until scheduled hours |
| Offline hours (Zomato) | – | fails W42 | fails (3 vs 5 h) | – | – | **Can't sum**: show the platform figure only |
| Market share | – | 0 every day | 0 | platform figure only | – | **Not rebuildable** |
| Swiggy New/Repeat/Dormant Customers (people) | – | – | – | – | not additive | **Platform figure per window**; sum the *orders* versions instead |
| Swiggy top-5 items, menu scores | – | – | – | – | – | **Per window / snapshot** |

**What can simply be summed across days:**
- **Sum as-is:** orders, sales, discounts, ads sales, spend, orders, impressions and menu opens, the funnel counts, rated, poor-rated and bad orders, complaints and every complaint type, delayed counts, new/repeat/lapsed user orders, meal-slot orders, lost sales and cancelled loss, the Swiggy order-value bands, and Bolt orders.
- **Sum after turning the % into a whole count first (Swiggy):** MFR-accurate orders, delayed >10 min, discounted orders, new/repeat/dormant customer orders, orders with complaints, and Bolt fast-prep orders. Also these money parts: Bolt sales, Swiggy GMV and item revenue.

**What needs a formula (never sum or average the % itself):**
- **Ratio of sums:** every %, AOV, RDPO, Ads ROI, CTR, discount %, ads depth.
- **Weighted average (approximation):** KPT, Bolt prep, FOR.
- **Mean of daily snapshots:** Zomato rating.

**No route, so the platform figure stays:** market share, Zomato offline hours, Swiggy distinct customers, menu scores, top-5 items. Online % joins this list until scheduled hours are stored.

### 10.10 Key mapping (round 4)

> **Superseded by §10.11 (round 5):** the key names below are replaced wherever the platforms' meanings differ.

**Swiggy:** every row is mapped in `validation/swiggy/SWIGGY-EXPORT.md`.

New keys it needs:
- `orders_band_lt250`, `orders_band_250_450`, `orders_band_450_650`, `orders_band_650_850`, `orders_band_gt850`
- `bolt_orders`, `bolt_sales_paise`, `bolt_prep_wsum`, `bolt_fast_prep_orders`, `bolt_delayed_orders`
- `swiggy_gmv_paise`, `discounted_orders`, `complaint_orders`
- `complaints_missing`, `complaints_quality`, `complaints_quantity`, `complaints_wrong`, `complaints_packaging`
- `cba_sales_paise`, `cba_orders`, `cba_spend_paise`, `cba_impressions`, `cba_menu_opens`
- `swiggy_new_customers`, `swiggy_repeat_customers`, `swiggy_dormant_customers` (platform-only per window)
- `market_share_pct` (platform-only)
- `menu_score`, `menu_category_score`, `menu_item_score`, `menu_addon_score`, `menu_combo_score`, `menu_photo_pct`, `menu_desc_pct` (snapshot)
- `top5_items_revenue_paise`, plus item revenue rows

Reused keys:
- `ops_sales_paise`, `delivered_orders`, `cancelled_orders`, `cancelled_order_loss_paise`
- `rated_orders`, `poor_rated_orders`
- `impressions`, `menu_opens`, `cart_builds`, `placed_orders`
- `new_user_orders`, `repeat_user_orders`, `lapsed_user_orders` (= Swiggy "dormant")
- `ads_sales_paise`, `ad_orders`, `ad_spend_paise`, `ads_menu_opens`
- `discount_paise`, `online_pct`, `kpt_weighted_sum`, `mfr_accurate_orders`, `mfr_eligible_orders` (= delivered), `delayed_orders`, `complaints`

**Zomato (unchanged from §10.3, now validated):**

| Column | Key |
|---|---|
| Delivered orders | `delivered_orders` |
| Sales (Rs) | `ops_sales_paise` |
| Average rating | `rating_snapshot_sum` / `rating_snapshot_days` |
| Rated orders | `rated_orders` |
| Bad orders | `bad_orders` |
| Rejected orders | `rejected_orders` |
| KPT+10 delayed orders | `delayed_orders` |
| Poor rated orders | `poor_rated_orders` |
| Total complaints | `complaints` |
| Non-refunded complaints | `bad_order_complaints` (to confirm) |
| Complaint types | `complaints_packaging` / `_quality` / `_wrong` / `_missing` |
| Self logs other ors | new `self_logged_ors` |
| Lost sales | `lost_sales_paise` |
| Online % | `online_pct` (+ `online_hours` / `scheduled_hours`) |
| Offline time | `offline_time_hours` (platform-only per window) |
| KPT | `kpt_weighted_sum` |
| FOR | `for_accurate_est` |
| Funnel | `impressions`, `menu_opens`, `cart_builds`, `placed_orders` |
| New / Repeat / Lapsed user orders | `new_user_orders` / `repeat_user_orders` / `lapsed_user_orders` |
| Meal-slot orders | new `breakfast_orders`, `lunch_orders`, `snacks_orders`, `dinner_orders`, `late_night_orders` |
| Ads | `ads_sales_paise`, `ads_impressions`, `ads_menu_opens`, `ad_orders`, `ad_spend_paise` |
| Offers (labels swapped) | `offer_gross_sales_paise`, new `offer_orders` |
| Discount given | `discount_paise` |
| Market share | `market_share_pct` |

**Zomato and Swiggy keys with the same name are never added together across platforms when the definitions differ:** net sales, delayed orders (KPT+10 vs >10 min), and lapsed vs dormant.

### 10.11 Round 5: Engineer - SaaS review folded in (accepted by Engineer - AI agents, 12 Nov ~10:20 IST)

**(1) Separate keys wherever the meaning differs.** I checked the whole mapping against the files. A key is shared across platforms only when its meaning is the same. Each key also gets `crossPlatform: true|false`, and the API adds Zomato and Swiggy together only for `true` keys.

| Concept | Zomato key (column) | Swiggy key (column) | Why they're split |
|---|---|---|---|
| Sales | `ops_sales_paise` ("Sales (Rs)"), now Zomato only | **`swiggy_net_sales_paise`** ("Net Sales") | different definitions; AOV is derived per platform |
| Delays | **`delayed_orders_kpt10`** ("KPT+10 delayed orders") | **`delayed_orders_gt10`** (% × delivered); **`bolt_delayed_orders_gt5`** (Bolt) | different thresholds and definitions. `delayed_orders` is retired |
| Lapsed vs dormant | `lapsed_user_orders` | **`dormant_user_orders`** (% × delivered) | different definitions |
| New / repeat orders | `new_user_orders`, `repeat_user_orders` | **`swiggy_new_customer_orders`**, **`swiggy_repeat_customer_orders`** | **Different base, found in the files.** Zomato new+repeat+lapsed = **placed** orders on all 49 days. Swiggy new+repeat+dormant is a % of **delivered** orders and leaves ~6% unclassified |
| Cancellations | `cancelled_orders` = all cancellations (payout rows, both apps) | **`restaurant_cancelled_orders`** ("Restaurant Cancelled Orders") | the Swiggy export counts restaurant-cancelled orders only |
| Funnel orders | `placed_orders` ("Placed Orders", **above** delivered) | **`swiggy_funnel_orders`** ("Orders Placed", always **below** delivered, by 1–13 a day) | not the same population |
| Ads | `ads_sales_paise`, `ad_orders`, `ad_spend_paise`, `ads_menu_opens`, `ads_impressions` (all Zomato ads) | **`cpc_sales_paise`, `cpc_orders`, `cpc_spend_paise`, `cpc_menu_opens`**, plus the `cba_*` keys | Swiggy splits CPC and CBA, and its CPC spend is ₹0 in the export |
| Accuracy | `for_accurate_est` (FOR) | `mfr_accurate_orders` (MFR) | already separate |
| Customers (people) | (`unique_customers` from payout hashes) | `swiggy_new_customers`, `swiggy_repeat_customers`, `swiggy_dormant_customers` (platform-only) | distinct, not additive |
| Complaint types | `complaints_packaging`, `_quality`, `_wrong`, `_missing` | same 4, plus Swiggy-only `complaints_quantity` | Swiggy's packaging type includes spillage; `crossPlatform:false` |
| Shared, `crossPlatform:false` until a definition is confirmed | `rated_orders`, `poor_rated_orders`, `complaints`, `non_refunded_complaints`, `discount_paise` (Zomato "Discount given": is it restaurant-funded only? to confirm), `impressions` (Swiggy has decimals), `menu_opens`, `cart_builds`, `kpt_weighted_sum`, `online_hours`, `market_share_pct` | same | the same label, but the platform definitions aren't confirmed |
| Shared, `crossPlatform:true` | `delivered_orders`, and payout keys (gross_sales, commission, fees, taxes, net payout, TDS/TCS) | same | the same meaning in the payout files |

**`bad_order_complaints`, resolved from the files.**
- Zomato exports no "bad-order complaints" column. Its **Bad orders** count is the distinct orders that were rejected, KPT+10 delayed, poor-rated, **or had any complaint (refunded or not)**.
- **Evidence over 49 days:**
  - Bad orders ≤ rejected + KPT+10 + poor-rated + **total** complaints on **49/49** days, and equal on 34. The 15 smaller days are orders that were, for example, both poor-rated and complained about.
  - Using **non-refunded** complaints instead breaks the bound on 6 days. For example, 23 Oct: bad 1, with only a refunded complaint.
  - "Self logs other ORs" is not part of it (9 Oct: bad 3 = 3 delayed, with 1 self-log).
- **So the complaint slice inside bad orders can't be isolated:** the overlap isn't exported.
- **Decision:** `bad_order_complaints` is **not mapped** (retire it, or leave it unused). Store `bad_orders` (platform count, exact sum), `complaints` (= Total complaints) and new `non_refunded_complaints`.

**(2) Granularity and index.**
- Fixed granularities: `day`, `week_sun_sat`, `week_mon_sun`, `month`, plus **`custom`**.
- The unique index adds `periodEnd`: (outlet, platform, granularity, periodStart, periodEnd, key), partial on `supersededAt IS NULL`.
- A `platform_only` value is returned **only when the requested window matches a stored window exactly**. Otherwise the API returns `not_available` with the reason.

**(3) `platform_window_items` table.**
- Columns: outlet, platform, periodStart, periodEnd, rank, itemName, revenuePaise, fetchId.
- It holds Swiggy's top-5 items per downloaded window. It is never rolled up, because the list depends on the window.

**(4) Derived counts.**
- Compute them at **daily** grain as round(% × denominator) to an integer, then sum.
- The platform % is kept as a `platform_check` row. The derived row carries `source = "derived:<formula>"`, e.g. `derived:round(mfr_pct*delivered_orders/100)`.
- When delivered = 0, store 0.
- `swiggy_gmv_paise` is **null on ₹0-discount days**, because it can't be derived. Ratios that need it report the missing days.
- Every ratio response returns `coverageDays / expectedDays`.

**(5) MFR.** `mfr_eligible_orders` is dropped. MFR = Σ `mfr_accurate_orders` ÷ Σ `delivered_orders`.

**(6) Kinds.**
- New kind **`snapshot_latest`** for the menu scores and the photo/description %. It returns the latest value in the range, with its as-of date.
- A menu score of **0 is skipped at parse time**, because 0 means not computed.
- Each `weighted_avg` key names its weight key:
  - `kpt_weighted_sum` → `delivered_orders`;
  - `for_accurate_est` → `delivered_orders`;
  - `bolt_prep_wsum` → `bolt_orders`;
  - `online_hours` → `scheduled_hours`.

**(7) Accuracy flag.** Every key gets `accuracy: exact | approx`.
- **approx:** KPT (both apps), `bolt_prep_wsum`, online % (until scheduled hours are stored), and FOR (it passes, but its daily % is rounded to 1 dp).
- **exact:** everything else, including the derived counts, which are integers within rounding.

**(8) Platform checks.**
- The platform's weekly and monthly figures are stored as `platform_check` rows, with the same window and key and kind `platform_check`. They are never used for display, except by `platform_only` keys.
- Per-key tolerance:
  - 0.5% by default;
  - 0.05 pts for 1-dp % (Zomato funnel, CTR, FOR);
  - 0.05 min for KPT;
  - 0 for sums.
- Exclusion list: Swiggy monthly **CPC Ads Depth** (Swiggy's figure is wrong) and Zomato **offline hours** (rounded daily).
- Every comparison is logged to **`metric_checks`**:
  - outlet, platform, key, window, rebuilt value, platform value, gap, tolerance, pass;
  - fetchId and checkedAt.

**(9) Replace-window.**
- A re-fetch **supersedes every row of each day in its window**. A key that is missing from the new file is superseded to **null**, not left stale.
- **The re-fetch window is 7 days on both platforms.** Zomato restates up to ~5 days back (§10.8).

**(10) Impressions** keep their decimals as they are.

**(11) Fake ids in the fixtures:** this is Aman's decision (DATA-PLAN §6).

### 10.12 Swiggy roll-up test: October daily summed to Swiggy's own weeks and month (12 Nov ~10:25 IST)

**Data:** five Daily files for 1–31 Oct (`validation/swiggy/swiggy_daily_{01oct_07oct,08oct_14oct,15oct_21oct,22oct_28oct,29oct_31oct}`, downloaded by hand, ₹0). Each was checked for Restaurant ID ${SWIGGY_RID} and the expected date columns. No personal data.
**Compared with:** the weekly file (the 3 full October Sun–Sat weeks: 11–17, 18–24, 25–31 Oct) and the October column of the monthly file.
**Script:** `validation/swiggy/validate_swiggy_rollups.py`, which writes `ROLLUP-OUTPUT.md`. Derived counts are rounded per day and then summed (the round-5 rule).

| Metric | 11–17 Oct | 18–24 Oct | 25–31 Oct | Oct | Verdict |
|---|---|---|---|---|---|
| Counts (delivered, placed, funnel, Bolt, CPC, poor-rated, cancellations, complaints and all 5 types, the 5 order bands) | exact | exact | exact | exact | **Sum** |
| ₹ sums (RDGMV, CPC sales, cancelled loss) | within ₹0.04 (2-dp rounding) | same | same | same | **Sum** |
| Net Sales | exact | **₹3,254 (1.79%) above** | exact | **0.56% above** (the same ₹3,254) | **Fail in one week, see below** |
| Rated orders | exact | **1 fewer** (25 vs 26) | exact | 1 fewer | **Fail in one week** |
| Derived counts (MFR-accurate, delayed >10, discounted, new/repeat customer orders, complaint orders, Bolt <6 min) | 0 orders off | 0 | 0 | 0 | **Pass, exact** |
| Funnel % ×3, Bolt %, discounted %, MFR, delayed %, new/repeat %, complaints %, Bolt <6 min %, RDPO, Discount GMV %, Bolt AOV, Bolt prep | ≤0.04% | ≤0.10% | ≤0.23% | ≤0.05% | **Pass** |
| Net AOV | 0.00% | 1.79% (only because of the Net Sales gap) | 0.00% | 0.56% | **Pass where sales tie** |
| CPC Ads Depth (CPC sales ÷ Σ derived GMV) | 0.01% | 0.00% | 0.00% | 590% (Swiggy's monthly figure is wrong) | **Pass**; monthly excluded |
| KPT, Σ(KPT × delivered) ÷ Σ delivered | 0.28% | 0.37% | 0.39% | 0.19% | **Pass** (≤0.04 min). A simple mean of days fails (up to 4.3%) |
| Online %, equal-day mean | **1.08% (fail)** | 0.00% | 0.00% | 0.44% | **Approximation**: needs scheduled hours, the same as Zomato |
| Market share, Σ orders ÷ Σ (orders ÷ daily share) | 0.12% | 0.39% | 0.03% | 1.21% (0.013 pts) | **Approximate route** (2-dp shares). Still shown as platform-only |
| New Customers (people) summed over days | 1 off | 0 | 0 | 2 off | Almost additive, but not guaranteed. **Platform-only** |
| Repeat Customers (people) summed over days | 17% over | 14% | 4% | 31% | **Not additive** (confirmed). Platform-only |

**The one real gap (18–24 Oct):**
- The summed days give ₹3,254 more Net Sales and 1 fewer rated order than Swiggy's week. Swiggy's October column shows the same gap, so its week and month agree with each other and the daily split is what differs.
- Delivered orders tie exactly, so this looks like a value change on one order (a refund or edit) that is booked to a different day in the Daily view, or applied between downloads. The weekly and monthly files were downloaded about 10:04 IST and the daily files about 10:16–10:20 IST.
- **Design consequence:** this is what the `metric_checks` log is for. A weekly or monthly `platform_check` mismatch on a sum key raises a note and overwrites nothing. A re-download of that week can tell timing apart from attribution.
- **Earlier residual estimate, now checkable:** the October-minus-weeks estimate in §10.7 said 1–10 Oct had 297 orders. The new daily files give **exactly 297**.

**Design findings from today's manual downloads:**
- **(a) Swiggy's Daily view caps a custom range at 7 days.** October needed five files: 7+7+7+7+3 days.
  - Any backfill must be fetched in **≤7-day chunks**.
  - The nightly 7-day re-fetch fits in one file.
  - The Weekly and Monthly views are not capped the same way: 4 weeks and 6 months came in one file each.
- **(b) Swiggy twice returned a different outlet's file** (a Delhi restaurant, with the wrong dates) while the panel showed our outlet. **Hard rule:**
  - Before saving, the fetch job **must** check each file's Restaurant ID (and name/city) against the outlet it asked for.
  - It must also check that the date columns exactly equal the requested days.
  - On any mismatch it **rejects the file, doesn't store it, logs a `metric_fetches` row with status `rejected_mismatch`, and retries** (with a limit, then needs_owner).
  - The same check applies to Zomato (Restaurant ID and date or week columns) and to the payout files.
