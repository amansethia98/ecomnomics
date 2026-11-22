Note for Engineer - SaaS, data plan round 5 (12 Nov 2026, ~10:20 IST). Your review points 1–10 are accepted and folded into DATA-DESIGN.md §10.11 and DATA-PLAN.md §1–3. Point 11 (fake ids in the fixtures) is with Aman (DATA-PLAN §6 Aman 8). Nothing to build until Aman signs off.

1. **Split keys** (full table in §10.11).
   - These are the ones you named: `delayed_orders_kpt10` / `delayed_orders_gt10` (+ `bolt_delayed_orders_gt5`), `lapsed_user_orders` / `dormant_user_orders`, `restaurant_cancelled_orders` vs `cancelled_orders`, and `ops_sales_paise` (Zomato) vs `swiggy_net_sales_paise`.
   - **More collisions found:**
     - Zomato new+repeat+lapsed = **placed** orders (49/49 days), while Swiggy's are a % of **delivered**. So add `swiggy_new_customer_orders` and `swiggy_repeat_customer_orders`.
     - Swiggy "Orders Placed" is always below delivered, so it becomes `swiggy_funnel_orders`.
     - Swiggy ads are CPC/CBA-specific, so they become `cpc_*` and `cba_*`.
   - Every key gets `crossPlatform`. Only `delivered_orders` and the payout keys are `true` for now.
2. **Granularity and index:** `day | week_sun_sat | week_mon_sun | month | custom`, and the unique index adds `periodEnd`. `platform_only` values are returned only for an exactly matching window; otherwise `not_available`.
3. **New table `platform_window_items`:** (outlet, platform, periodStart, periodEnd, rank, itemName, revenuePaise, fetchId).
4. **Derived counts:**
   - per day, round(% × delivered), then sum;
   - `source = derived:<formula>`;
   - 0 when delivered = 0;
   - the platform % is kept as a check row;
   - `swiggy_gmv_paise` is null on ₹0-discount days;
   - ratios return `coverageDays / expectedDays`.
5. **MFR:** `mfr_eligible_orders` is dropped; the denominator is `delivered_orders`.
6. **Kinds:**
   - new `snapshot_latest` (menu scores and photo/description %, with an as-of date; a 0 score is skipped at parse time);
   - every `weighted_avg` names its weight key (KPT and FOR → delivered_orders, Bolt prep → bolt_orders, online → scheduled_hours).
7. **`accuracy: exact | approx`** on every key. approx = KPT, Bolt prep, online %, FOR.
8. **Checks:**
   - `platform_check` rows for the platform's weekly and monthly figures;
   - per-key tolerance (0.5% default, 0.05 pts for 1-dp %, 0.05 min for KPT, 0 for sums);
   - an exclusion list (Swiggy monthly CPC Ads Depth, Zomato offline hours);
   - a `metric_checks` log table.
9. **Replace-window:** a re-fetch supersedes each day's rows, and a key missing from the new file is superseded to null. The window is 7 days on both platforms.
10. **Impressions** keep their decimals.

**`bad_order_complaints` is resolved: don't map it.** Zomato Bad orders = distinct orders that were rejected, KPT+10 delayed, poor-rated, or had any complaint, refunded or not.
- Bad orders ≤ the sum of those 4 on 49/49 days, and equal on 34.
- With non-refunded complaints instead, the bound breaks on 6 days.
- The overlap isn't exported, so there's no complaint slice to store. Keep `bad_orders` and `complaints`, and add `non_refunded_complaints`.

**Round 6 additions (12 Nov ~10:25 IST; see DATA-DESIGN §10.12 and DATA-PLAN §3):**
11. **HARD RULE, file identity check before save.**
    - The fetch job must verify each file's outlet id (and name/city) and its date columns against the request.
    - On a mismatch: reject it, don't store it, log `rejected_mismatch` in metric_fetches, and retry with a limit, then needs_owner.
    - Swiggy twice returned a Delhi outlet's file with the wrong dates today, while the panel showed ours.
    - The ingestion endpoint should re-check the same thing server-side.
12. **Swiggy Daily is capped at 7 days per download,** so backfills go in ≤7-day chunks.
13. **The Swiggy October roll-up passes:**
    - every count is exact;
    - the derived counts are exact, so the round-then-sum rule is confirmed;
    - all rates are ≤0.23% off;
    - KPT ≤0.39% off (weighted by delivered).

    Exceptions:
    - online % needs scheduled hours;
    - Swiggy's monthly CPC depth is wrong;
    - one ₹3,254 Net Sales and 1 rated-order gap in 18–24 Oct, which should surface as a `metric_checks` failure, not an overwrite.
