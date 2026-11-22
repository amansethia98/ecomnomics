# Ecomnomics data plan: storing Zomato and Swiggy data and showing any period correctly

Merged plan from Engineer - SaaS (app and database) and Engineer - AI agents (fetching), 12 Nov 2026 (IST). Round 4 (~10:15 IST) adds the Swiggy export and the Zomato weekly and monthly validation. Round 5 (~10:20 IST) folds in Engineer - SaaS's review (DATA-DESIGN §10.11). The details and evidence are in DATA-DESIGN.md. Nothing gets built until Aman signs off.

## The idea in one line
A fetch job stores raw facts in the database: business metrics nightly, payouts weekly. Analysis and the dashboard only read the database. Any period is worked out from parts that add up, and no stored average or percentage is ever added or averaged.

## 1. Schema
- **Payout orders:** one row per order from the Zomato settlement report and the Swiggy annexure. The key is platform, outlet and order id. Each row has:
  - the IST order date;
  - cycle id, start and end;
  - settlement status and date, and only the last 4 digits of the UTR;
  - order status, category and cancelled-by;
  - the money columns, as dictionary keys in paise;
  - the Swiggy MFR flags;
  - a salted hash of the customer id, Zomato only.
- **Payout adjustments:** restaurant-level deductions such as ads, marketing and co-branded charges, plus adjustments from earlier weeks. The key is platform, outlet, cycle, type and invoice or campaign id. Each row has its own period from and to.
- **Daily business metrics:** the existing metric table, with one row per outlet, platform, day and key.
  - Zomato comes from its Business report CSV (daily columns for ranges up to 30 days).
  - Swiggy comes from its Business Metrics xlsx (Daily view, last 7 days; Weekly is Sun–Sat, Monthly is calendar). It has the same 74 rows in every view and no personal data. See validation/swiggy/SWIGGY-EXPORT.md.
  - Every Monday the platform's own week figure is also stored for keys that can't be rolled up. The monthly figure is stored on the 3rd.
- **Ratios as paired keys:** stored as a numerator and denominator, for example bad_orders and delivered_orders, or impressions and menu_opens. No rates are stored. New keys: bad_orders, menu_opens, cart_builds, impressions (where missing), unique_customers (Zomato only), and, from the 9:21 revision, rating_snapshot_sum, rating_snapshot_days, (rating_stars_sum: optional, internal), scheduled_hours, online_hours, kpt_weighted_sum, for_accurate_est, mfr_accurate_orders, mfr_eligible_orders, ads_menu_opens, ads_impressions, offer_gross_sales_paise. Round 4 (Swiggy export) adds: swiggy_gmv_paise, discounted_orders, complaint_orders, the order-value bands, the bolt_* keys, the complaint-type keys, the cba_* keys, the menu snapshot keys, top-5 item revenue, plus the platform-only swiggy_*_customers and market_share_pct. Swiggy % columns are stored as whole counts (% × delivered orders), because every Swiggy % has delivered orders as its denominator. See DATA-DESIGN.md §10.7–10.10.
- **Granularity:** `day`, `week_sun_sat`, `week_mon_sun`, `month`, `custom`. The unique index is (outlet, platform, granularity, periodStart, **periodEnd**, key), partial on `supersededAt IS NULL`.
- **Key metadata:** each key has an aggregation kind, `accuracy` (exact | approx), `crossPlatform` (true | false), and for `weighted_avg` keys the name of the weight key. Keys are split per platform wherever the meaning differs (§10.11): `delayed_orders_kpt10`/`delayed_orders_gt10`, `lapsed_user_orders`/`dormant_user_orders`, `restaurant_cancelled_orders`, `swiggy_net_sales_paise`, `swiggy_new/repeat_customer_orders`, `swiggy_funnel_orders`, and the `cpc_*` keys. `mfr_eligible_orders` and `bad_order_complaints` are dropped, and `non_refunded_complaints` is added.
- **Derived counts:** computed per day as round(% × delivered) to an integer, then summed. They are stored with `source = derived:<formula>`, and as 0 when delivered = 0. `swiggy_gmv_paise` is null on ₹0-discount days.
- **platform_check rows:** the platform's own weekly and monthly figures, stored for checking only. Each key has a tolerance, and there is an exclusion list (Swiggy monthly CPC Ads Depth, Zomato offline hours). Every comparison is logged to a **metric_checks** table.
- **platform_window_items:** outlet, platform, periodStart, periodEnd, rank, itemName, revenuePaise, fetchId. This holds Swiggy's top-5 items per window and is never rolled up.
- **Fetch log (metric_fetches):** platform, outlet, window, source, file sha256, parser version, captured time and status. A failed night shows up as an explicit gap, never as zero.
- **Aggregation kind:** every key in the metric dictionary gets one, and the API refuses to roll up a key in a way its kind doesn't allow.

## 2. How each kind rolls up for any week, month or custom range
| Kind | Rule | Examples |
|---|---|---|
| sum | Add up days and orders | sales, orders, discounts, commission, ad spend, net payout, new/repeat/lapsed orders, and the Swiggy counts made from % × delivered (MFR-accurate, delayed, discounted, complaint orders) |
| ratio | Total numerator ÷ total denominator | AOV, discount %, bad orders %, funnel rates, Ads CTR, Zomato Ads ROI (before-discount; 0.21–0.37% weekly, 0.26% monthly), effective commission %, all Swiggy % (MFR, delayed, discounted, RDPO, ads depth, complaints, customer mix: ≤0.23% at day, week and month), (rating received: internal only) |
| weighted_avg | Σ(value × weight) ÷ Σ weight | Zomato FOR (by delivered: passes, 0.04–0.47%); KPT both apps (by delivered: 0.23–0.62%, ≤3 s, labelled approximate); Swiggy Bolt prep (by Bolt orders); online % (by scheduled hours; until then an equal-day mean, which fails 1 of 4 weeks by 0.96%) |
| snapshot | Latest value in the range, shown "as of" a date | live rating, commission % on the outlet, lag banner |
| snapshot_latest | Latest value in the range, with its as-of date; a score of 0 is skipped at parse time | menu scores, menu photo/description % |
| distinct | Count distinct hashes in the range | unique customers (Zomato only) |
| snapshot_mean | Σ daily snapshots ÷ days (both additive) | Zomato platform rating (**exact** to Zomato's weekly and monthly figures) |
| platform_only | Only when no route exists: show the platform figure for the matching window | market share, Zomato offline hours (rounded to whole hours a day, so the days don't add up), Swiggy distinct customers, menu scores, top-5 items; online % until scheduled hours are stored |

- Ratio responses return `coverageDays / expectedDays`. A `platform_only` value is returned only for an exactly matching stored window; otherwise the API returns `not_available`.
- Every response says how much data it covers: days with data out of days expected, missing days by name, partial edge periods, the latest fetch time, and whether anything is still provisional.
- Day boundaries use IST everywhere.
- Monthly rollup tables are only a speed cache and can always be rebuilt from the base rows.

## 3. Re-fetch windows and late corrections, with no double counting
- **HARD RULE: check every file's identity before saving it.**
  - Each downloaded file's outlet id (and name/city), and its date or week columns, must exactly match what the job asked for.
  - On any mismatch the file is **rejected and not stored**. The fetch is logged as `rejected_mismatch` and retried a limited number of times, then marked needs_owner.
  - Why: on 12 Nov, Swiggy twice returned a Delhi restaurant's file with the wrong dates while the panel showed our outlet. This applies to Zomato and the payout files too.
- **Swiggy's Daily view is capped at 7 days per download,** so backfills go in ≤7-day chunks. The nightly 7-day re-fetch is one file.
- **Business data:** every night, re-fetch the last 7 days: one Zomato CSV and one Swiggy Daily xlsx per outlet. **Zomato does restate recent days:** in a re-download, the last 5 days of the earlier file had changed (late ratings, bad orders, last-day KPT, FOR and ads), while older days were unchanged. 7 days covers that.
- **Monthly check:** on the 3rd, re-pull last month's Zomato monthly column and compare it with the sum of the days. A gap over 0.5% raises a note and overwrites nothing.
- **Payouts:** each run re-pulls the last 4 cycles.
  - A file with an unchanged sha256 is skipped.
  - A pending cycle is re-pulled until it settles.
  - A Swiggy week under the 48-hour lag banner is re-read until the banner is gone.
- **Writes:** each fetch declares its window and replaces that window atomically. A re-fetch supersedes each day's rows, and a key missing from the new file is superseded to null. Order rows are upserted on platform, outlet and order id, and adjustments on their own key. Later-week adjustments are counted once, in the cycle that booked them.
- **History (option a, my recommendation):** we keep an old row only when its value actually changed, marked superseded and linked to the fetch that replaced it. Unchanged re-fetches write nothing, so storage barely grows. This needs a nullable fetchId and supersededAt, and the current unique index on metric values becomes partial (where supersededAt is null).
- **History (option b):** keep only the latest value plus the fetch log.
- **Provisional data:** anything inside the re-fetch window, or with a pending settlement, is marked provisional in both views.

## 4. Raw files: keep them, redacted
- **Payout files** (Zomato settlement xlsx, Swiggy annexure xlsx): keep them in object storage. They're deduplicated by sha256 and tagged with the parser version, so we can re-parse when a mapping changes.
- **Zomato Business CSV:** keep it too. Re-downloading and diffing it is also how we spot restated days.
- **Swiggy Business Metrics xlsx:** keep it like the Zomato CSV. It has no personal data, so it is stored unchanged after the scan.
- **Redaction on the computer, before upload:**
  - Cut every Bank UTR to its last 4 digits; the bank check still works.
  - Drop the hidden HSummary UTR list, PAN, bank account and MID.
  - Hash the Zomato customer id with a salt per restaurant.
  - Run a scan for phone numbers and emails anyway.
- **No unredacted original is stored anywhere.**
- **Parser test:** Zomato's CSV swaps the "Orders with offers" and "Gross sales from offers" labels. The parser maps those two columns by their values rather than their labels, and has a test for it.

## 5. The two views
- **Order date ("how did the business do"):** the default on performance pages.
  - Order rows are summed by IST order date.
  - Adjustments are spread over their own period, day by day, and shown as a separate line.
  - A month that changes later shows a "restated" marker.
- **Settlement date ("what reached the bank"):** the default on the Payouts page.
  - Order rows plus adjustments are summed by settlement date, which ties to the UTR's last 4 digits.
- **Gap line:** one line explains the difference between the two views: orders settled from earlier periods, minus orders not yet settled, plus adjustments.
- **Payout weeks:** Zomato's run Mon–Sun and Swiggy's Sun–Sat. Comparing the two platforms like for like only works in the order-date view.
- **Swiggy cancelled orders:** both files include cancelled orders, and Swiggy's also has Toing and train orders, so delivered-only totals filter on status.

## 6. Decisions needed
**Aman**
1. Is the default view order date for performance and settlement date for Payouts? (Recommended: yes.)
2. Should Swiggy Toing and train orders be inside Swiggy totals, or shown separately?
3. Keep history only when a value changes (recommended), or keep only the latest value plus the fetch log?
4. Is it OK for the nightly Zomato fetch to download the Business report CSV for the last 7 days instead of reading the screen tiles?
5. Should GSTIN and address stay in the stored raw files? Is keeping raw files for 13 months OK?
6. In "all outlets" totals, should an outlet that joined mid-period be shown as is with a note, or should totals be like-for-like only?
7. **Decided (Aman, 12 Nov 09:39):** show only the platform's own rating, as it appears in the report (snapshot mean for a range). "Ratings received" is dropped from the UI and stays internal and optional. Online %, KPT, FOR, MFR and Ads ROI are rebuilt from parts; only market share stays platform-only.

8. **Fixtures (raised by Engineer - SaaS, round 5):** the validation files (`validation/swiggy/*`, `validation/zomato/*`) hold the real restaurant ids (Swiggy ${SWIGGY_RID}, Zomato ${ZOMATO_RES_ID}), name and area. Should the repo fixtures keep them, or replace them with fake ids and names before they go in as parser tests? They contain no customer data either way.

**Raghav**
1. Have you ever seen a settled week restated, rather than corrected in a later cycle? That tells us whether 4 cycles is enough.
2. Should ads and marketing deductions that cross a month boundary be split by day, or all go into the month the period ends?
3. Is Zomato KPT weighted by orders good enough, or should we only show the platform's own figures?
4. Should Zomato bad orders be shown as counts (as in the CSV) or as the percentage on the weekly screen?
5. Do Zomato business-report days go by order time or delivery time?

**Read-only checks, not yet run (Engineer - AI agents)**
1. Is there a Swiggy business-metrics export, and how detailed is it? Three agent runs on 12 Nov cost ₹295 in total and got no file. The third logged in by password but got stuck on the outlet filter. **Roll-up tested 12 Nov ~10:25 IST** with October Daily vs Swiggy's weeks and month (DATA-DESIGN §10.12). Everything passes except one unexplained Net Sales gap (a flagged Net Sales gap on one week) and online % (needs scheduled hours). **Answered 12 Nov ~10:05 IST:** yes, with Daily, Weekly (Sun–Sat) and Monthly views, one row per metric and no order level. It was downloaded by hand in the box browser (₹0). Every Swiggy rate rebuilds; see DATA-DESIGN §10.7. Still open: a Daily file that lines up with a whole Swiggy week or month, to test the roll-up directly.
4. Do the Zomato and Swiggy reviews pages list per-order stars, and do the outlet timings pages give scheduled hours per day?
5. Download the Zomato daily CSV for 2–31 Oct and compare it with the Oct monthly column, to measure the KPT, FOR, online % and rating gaps. The agent run on 12 Nov (₹177) downloaded 5–11 Nov instead. **Done 12 Nov (round 4, files downloaded by hand, ₹0):** see DATA-DESIGN §10.8–10.9. Rating is exact, FOR and Ads ROI pass, KPT is within 3 s, online % needs scheduled hours, and offline hours can't be summed.
2. ~~Re-download Zomato's 20 Sep–19 Oct CSV and compare it with the old copy.~~ **Answered by the 1–31 Oct file:** yes, the last ~5 days of a download get restated, and older days don't.
3. Re-download Zomato's 26 Oct–1 Nov settlement report and compare its sha256, to see whether a settled cycle changes.

## Build order after sign-off (Engineer - SaaS)
1. Add the aggregation kinds, paired keys and new keys to the dictionary and the API contract.
2. Add the fetch log and history columns, and make the unique index partial.
3. Add the payout order and adjustment tables, and their ingestion endpoints in /agent/v1.
4. Add a read API that rolls up by date range, with either basis, and reports coverage.
5. Build the dashboard toggle and gap line, as part of M1/M2.
