# Restaurant agent API

The computer for one restaurant calls this API with that restaurant's token. One token can read and write only that restaurant. Money is an integer number of paise.

Definitions of each metric, and which Zomato or Swiggy field it comes from, are in [docs/metric-dictionary.md](metric-dictionary.md).

A machine-readable copy of these routes is [docs/restaurant-agent-api.openapi.json](docs/restaurant-agent-api.openapi.json).

## Token

Mint a token for a space that should become a restaurant, or for one that already is:

```sh
pnpm --filter @rakazo/api restaurant:mint-token -- --space <space id> --name "<restaurant name>"
```

`--timezone` defaults to `Asia/Kolkata`. The command prints one line on stdout:

```text
RESTAURANT_AGENT_TOKEN=ecom_agent_...
```

That value is shown once. The database stores only its hash for authentication. The plaintext is encrypted in the restaurant's vault as the platform-managed variable `RESTAURANT_AGENT_TOKEN`, next to `RESTAURANT_AGENT_API_BASE_URL`. Neither is written into the container. Each shell command loads them fresh and masks them in command output. A reused machine does not keep a token that was revoked or that belongs to another restaurant.

When a restaurant and its computer both exist, the server mints the token. The command above is the fallback: `--rotate` writes the new value and revokes the previous hash immediately, and `--revoke` revokes the hash, deletes the vault entries, and leaves nothing for a later command on that machine to inherit. Do not set the token on the API process, copy it into a skill or a bot prompt, or reuse it for another restaurant.

Send it on every request:

```text
Authorization: Bearer $RESTAURANT_AGENT_TOKEN
```

`--rotate` revokes the current token and prints a new one. `--revoke` revokes it and prints nothing secret. A missing, wrong, or revoked token is `401` with the same body.

## Errors

Every error is JSON: `{ "error": "<sentence>", "code": "<code>" }`.

| HTTP | code                          | When                                                                                                                  |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 401  | `unauthorized`                | No token, or the token is unknown or revoked.                                                                         |
| 400  | `invalid_body`                | The JSON does not match the shape below.                                                                              |
| 400  | `unknown_metric_key`          | A metric row uses a key that is not in the list. The sentence names the key and the allowed keys. Nothing is written. |
| 422  | `unknown_outlet`              | `outletId` is missing or belongs to another restaurant. Both cases use the same sentence.                             |
| 422  | `file_identity`               | A business-report file is not the requested outlet or window. Nothing from that file is stored.                       |
| 422  | `unknown_message`             | `chatMessageId` is not a message in this restaurant.                                                                  |
| 404  | `not_found`                   | The action or file is not in this restaurant.                                                                         |
| 409  | `invalid_transition`          | The action status is not a legal next step.                                                                           |
| 409  | `approval_required`           | The action is not approved by a message a person in this restaurant sent.                                             |
| 409  | `idempotency_conflict`        | `clientNonce` was already used for a different file list.                                                             |
| 413  | `invalid_body`                | An uploaded file is larger than 20 MB.                                                                                |
| 503  | `object_storage_unconfigured` | The request includes files and this server has no object storage. Nothing is created.                                 |

## Restaurant

`GET /agent/v1/restaurant`

```json
{
  "restaurantId": "ck...",
  "name": "Kitchen",
  "timezone": "Asia/Kolkata",
  "outlets": [
    {
      "outletId": "ck...",
      "name": "Indiranagar",
      "city": "Bengaluru",
      "zomato": { "resId": "123", "commissionPct": 18.5 },
      "swiggy": null,
      "active": true
    }
  ]
}
```

`zomato` is `null` when the outlet has no Zomato restaurant id. Otherwise it is `{ "resId", "commissionPct" }` and `commissionPct` may be `null`. `swiggy` is the same shape with `rid`.

```sh
curl -sS -H "Authorization: Bearer ecom_agent_example" "$API/agent/v1/restaurant"
```

## Metrics

Dates in `from`, `to`, and a business-report window are civil dates in Asia/Kolkata, written `YYYY-MM-DD`. `to` and `periodEnd` are exclusive.

`granularity` is `day`, `week_sun_sat` (Sunday–Saturday), `week_mon_sun` (Monday–Sunday), `month`, or `custom`. There is no `week` value.

`GET /agent/v1/metrics?outletId&platform&from&to&basis&keys`

This calls the same read as the owner dashboard, described in [owner-metrics.md](owner-metrics.md). `platform=combined` means `all`. One `outletId` selects that outlet. Omit `keys` to return every dictionary key for that outlet. Sending `keys` is limited to 100. A range longer than 400 days is rejected with `A date range can be at most 400 days.` More than 100 keys is rejected with `Send at most 100 metric keys.`

`platform` is `zomato`, `swiggy`, or `combined`. `basis` is `order_date` (the default) or `settlement_date`.

Sums add the daily parts. A ratio or weighted average is computed from those summed parts, never by averaging daily percentages. `snapshot_mean` is the sum of daily snapshots divided by days with a snapshot. `snapshot_latest` includes `asOf`, the day the figure comes from. A `platform_only` value is returned only when `from` and `to` are exactly a stored day, week, or month. Otherwise the value is null, `status` is `not_available`, and `reason` is `Not available for this date range. The platform only publishes this figure for a matching day, week, or month.`

Every value includes `accuracy` (`exact` or `approx`), `coverageDays`, and `expectedDays`. `all` adds a key across platforms only when that key is marked cross-platform. Every other key comes back once per platform.

Adjustments are spread day by day across their own period and returned on `adjustments`. They are not added into the order totals, and they are not subtracted from the settlement net. A key that is not part of the settlement-date payout is `not_available` with `This figure is not part of the settlement-date payout.` The bank paid amount is Zomato's Amount Settled or Swiggy's summary total payout, on the payout settlement date. A file with neither is `not_available` with `This payout file has no settled amount.` On an order-date read the paid amount and the platform cycle total are `not_available` with `The platform's cycle total is a settlement figure.` The response includes `gap`: `settledFromEarlierPaise` (settled in this window from an earlier order date), `notYetSettledPaise` (pending order nets in the window), and `adjustmentsPaise`. A pending settlement sets `provisional` to true. Distinct customers on Zomato are the count of salted customer hashes. On Swiggy the reason is `Distinct customers are counted from Zomato payout orders.` When a Zomato order in the window has no stored hash, the reason is `Distinct customers need the stored customer hash.` Until payout orders exist, distinct customers stay `Distinct customers are counted from payout orders, which are not stored yet.` Online percentage weights each day by its scheduled hours. A day without scheduled hours counts as one day, and that result is approximate. If a day has neither hours nor a daily percentage, and no platform figure is stored for this exact window, the reason is `Online percentage needs each day's scheduled hours. No platform figure is stored for this exact window.`

`PUT /agent/v1/metrics`

Writes payout and other caller-supplied facts. A row whose value changed is kept, and the previous row is marked superseded. An unchanged value is not written again. Omitted keys are left as they are. A batch is all or nothing, and at most 500 rows. `upserted` is the number of rows written.

`POST /agent/v1/metric-reports`

Sends one Swiggy or Zomato business-report CSV. The server rejects the file when its platform outlet id does not match the id stored for that outlet, or when its date or week columns are not the requested window. Nothing from a rejected file is stored, and the attempt is logged with status `rejected_mismatch`. After 3 mismatches for the same request the status is `needs_owner`. The response is 422 with code `file_identity`. A different restaurant name, city, or area is stored with the file and written as a warning on that fetch. An outlet with no platform id is rejected with `This outlet has no Swiggy restaurant id. The file was not stored.` or the Zomato sentence. The name is not used as a fallback.

A daily file replaces each day in its window for that platform. A key missing from the new file is superseded to null. A weekly or monthly file stores the platform's own figures for that window and does not overwrite daily facts. When those figures disagree with the rebuilt days, the disagreement is logged and the stored days stay as they are.

Swiggy Daily accepts at most 7 days per file. Split a backfill into chunks of 7 days or fewer.

```json
{
  "outletId": "ck...",
  "platform": "swiggy",
  "report": "daily",
  "periodStart": "2026-11-02",
  "periodEnd": "2026-11-09",
  "csv": "Restaurant ID,Restaurant name,...",
  "runId": "fetch-1",
  "source": "business-report",
  "capturedAt": "2026-11-09T05:00:00.000Z"
}
```

`POST /agent/v1/payout-reports`

Sends one Swiggy invoice annexure or Zomato settlement workbook, base64-encoded. The server reads the outlet and the cycle from the file, then rejects it when the platform outlet id or the cycle dates do not match the request. Nothing from a rejected file is stored, and the attempt is logged with status `rejected_mismatch`. After 3 mismatches for the same request the status is `needs_owner`. The response is 422 with code `file_identity`. A different restaurant name or city is stored with the file and written as a warning. Orders are upserted on platform, outlet, and order id. A changed settlement replaces the current row and keeps the previous one. Adjustments for that cycle are replaced together. A check that misses the platform's own total is logged and does not change the stored order. The bank reference is stored as the last four characters. Zomato customer ids are stored only as a salted hash. If `CUSTOMER_HASH_SALT` is not set, the warning is `Customer hashes were not stored because CUSTOMER_HASH_SALT is not set.`

```json
{
  "outletId": "ck...",
  "platform": "zomato",
  "periodStart": "2026-11-02",
  "periodEnd": "2026-11-09",
  "fileBase64": "...",
  "runId": "payout-1",
  "source": "payout-file",
  "capturedAt": "2026-11-12T05:00:00.000Z"
}
```

`PUT /agent/v1/metrics` body:

```json
{
  "runId": "payout-2026-01-06",
  "source": "payout-export",
  "capturedAt": "2026-01-07T05:00:00.000Z",
  "rows": [
    {
      "outletId": "ck...",
      "platform": "zomato",
      "granularity": "day",
      "periodStart": "2026-01-06T00:00:00.000+05:30",
      "periodEnd": "2026-01-07T00:00:00.000+05:30",
      "key": "net_payout_paise",
      "value": 150000
    }
  ]
}
```

`platform` is `zomato` or `swiggy`. Times on this call are ISO-8601 with an offset. The same instant written with two different offsets is one period.

Response: `{ "upserted": 1 }`.

`value` may be `null`. Null means the figure is missing. Do not send `0` for a figure the screen did not show.

### Metric keys

`orders` is not a key. Send `delivered_orders` for the ops card and `payout_orders` for the payout file. `delayed_orders`, `bad_order_complaints`, and `mfr_eligible_orders` are retired.

These names are computed, not stored: `effective_discount_pct` (`discount_paise / gross_sales_paise`), `ads_pct` (`ad_spend_paise / gross_sales_paise`), `payout_pct` (`net_payout_paise / gross_sales_paise`), `burn_pct` (`1 - payout_pct`), `ops_aov_paise` (`ops_sales_paise / delivered_orders`), `gross_aov_paise` (`gross_sales_paise / delivered_orders`), and `fees_incl_gst_paise` (`commission_paise + platform_fees_paise + taxes_paise`). A combined fee tile uses `fees_incl_gst_paise` because Zomato's fee row includes GST on fees and Swiggy's does not. `commission_pg_gst_paise` is stored: it is the calculator's Comm.+PG+GST row as printed, and Swiggy's printed row excludes GST on fees. `aov_paise` is the on-screen average and is stored. The two computed AOV figures are not.

Paise and counts are non-negative integers. A `pct` value on this call is from 0 to 100 with at most 2 decimal places. `rating` is from 0 to 5 with at most 2 decimal places. `kpt_minutes` has at most 1 decimal place. Hours and `ads_roi` are non-negative with at most 4 decimal places; `ads_roi` is not capped at 100. Impressions keep their decimals. `lag_banner` is `true`, `false`, or `null`. Any known key accepts `null`. A business-report file may contain a rating above 5 or a percent above 100; those numbers are stored as printed. This call does not.

- `gross_sales_paise` (paise, sum, exact, crossPlatform true): Item total plus packaging (ST+PC), before GST and before restaurant-funded discounts.
- `net_payout_paise` (paise, sum, exact, crossPlatform true): Owner Net Payout: commissionable value minus ads minus commission, other fees, and GST on fees.
- `platform_net_payout_paise` (paise, sum, exact, crossPlatform true): The platform's own net payout figure, before comparing it to the bank.
- `commission_paise` (paise, sum, exact, crossPlatform true): Platform commission or base service fee only, not long-distance, payment-gateway, or GST on fees.
- `platform_fees_paise` (paise, sum, exact, crossPlatform true): Other platform fees besides commission, excluding GST on fees.
- `taxes_paise` (paise, sum, exact, crossPlatform true): 18% GST on platform fees only. Not customer GST, and not TDS or TCS.
- `tds_paise` (paise, sum, exact, crossPlatform true): Tax deducted at source and withheld from the payout. A tax credit, not a cost.
- `tcs_paise` (paise, sum, exact, crossPlatform true): Tax collected at source, including TCS IGST where it is present.
- `cv_paise` (paise, sum, exact, crossPlatform true): Commissionable value: item total plus packaging, minus the restaurant-funded discount.
- `paid_amount_paise` (paise, sum, exact, crossPlatform true): Amount the bank paid. Zomato's Amount Settled, or Swiggy's summary total payout.
- `payout_orders` (count, sum, exact, crossPlatform true): Payout-file orders: delivered plus cancelled or rejected, for the payout period.
- `commission_pg_gst_paise` (paise, sum, exact, crossPlatform false): The payout calculator's Comm.+PG+GST row as printed. Swiggy's row excludes GST on fees.
- `gst_collected_paise` (paise, sum, exact, crossPlatform false): GST collected from customers. Not restaurant revenue on delivery orders.
- `complaints_cancellation_charges_paise` (paise, sum, exact, crossPlatform false): Complaint refunds and cancellation charges deducted from the payout.
- `discount_paise` (paise, sum, exact, crossPlatform false): Discounts the restaurant pays for. Zomato's business-report Discount given is not confirmed as the same figure.
- `ad_spend_paise` (paise, sum, exact, crossPlatform false): Ads charged to the restaurant for that period, counted once. Swiggy's export spend is not this payout figure.
- `delivered_orders` (count, sum, exact, crossPlatform true): Orders delivered. This is the ops orders figure, and the denominator of most rates.
- `ops_sales_paise` (paise, sum, exact, crossPlatform false): Zomato business-report sales, stored apart from payout ST+PC and from Swiggy net sales.
- `swiggy_net_sales_paise` (paise, sum, exact, crossPlatform false): Swiggy Net Sales. Not Zomato sales and not payout ST+PC.
- `aov_paise` (paise, ratio, exact, crossPlatform false): Average order value rebuilt as platform sales divided by delivered orders.
- `cancelled_orders` (count, sum, exact, crossPlatform false): All cancellations on a payout file. Swiggy's business export uses restaurant_cancelled_orders instead.
- `restaurant_cancelled_orders` (count, sum, exact, crossPlatform false): Orders the restaurant cancelled on Swiggy. Not every cancellation.
- `cancelled_order_loss_paise` (paise, sum, exact, crossPlatform false): Money Swiggy reports as lost to restaurant-cancelled orders.
- `orders_band_lt250` (count, sum, exact, crossPlatform false): Delivered orders with a value below ₹250.
- `orders_band_250_450` (count, sum, exact, crossPlatform false): Delivered orders with a value from ₹250 to ₹450.
- `orders_band_450_650` (count, sum, exact, crossPlatform false): Delivered orders with a value from ₹450 to ₹650.
- `orders_band_650_850` (count, sum, exact, crossPlatform false): Delivered orders with a value from ₹650 to ₹850.
- `orders_band_gt850` (count, sum, exact, crossPlatform false): Delivered orders with a value above ₹850.
- `market_share_pct` (pct, platform_only, approx, crossPlatform false): The platform's market-share figure. There is no market total to rebuild it from.
- `bolt_orders` (count, sum, exact, crossPlatform false): Swiggy Bolt orders, the fast-delivery channel.
- `bolt_orders_pct` (pct, ratio, exact, crossPlatform false): Share of delivered orders that were Bolt orders.
- `bolt_sales_paise` (paise, sum, exact, crossPlatform false): Bolt sales, Bolt AOV times Bolt orders, summed after the daily product.
- `bolt_prep_wsum` (decimal, sum, approx, crossPlatform false): Bolt prep minutes times Bolt orders. The weight for Bolt prep time.
- `bolt_prep_minutes` (minutes, weighted_avg, approx, crossPlatform false): Swiggy Bolt average prep time, weighted by Bolt orders.
- `bolt_fast_prep_orders` (count, sum, exact, crossPlatform false): Bolt orders with prep under 6 minutes.
- `bolt_fast_prep_pct` (pct, ratio, exact, crossPlatform false): Share of Bolt orders prepared in under 6 minutes.
- `bolt_delayed_orders_gt5` (count, sum, exact, crossPlatform false): Bolt orders delayed by more than 5 minutes.
- `rated_orders` (count, sum, exact, crossPlatform false): Orders that received a rating. The same label is not confirmed to mean the same thing.
- `poor_rated_orders` (count, sum, exact, crossPlatform false): Orders with a poor customer rating.
- `rating_snapshot_sum` (decimal, sum, exact, crossPlatform false): Zomato's daily platform rating. A range is the sum of these snapshots.
- `rating_snapshot_days` (count, sum, exact, crossPlatform false): One for each day that has a Zomato platform rating snapshot.
- `rating` (decimal, snapshot_mean, exact, crossPlatform false): Zomato platform rating: the sum of daily snapshots divided by days with a snapshot.
- `bad_orders` (count, sum, exact, crossPlatform false): Zomato's bad-order count. It is the platform's own count, not the sum of its slices.
- `bad_orders_pct` (pct, ratio, exact, crossPlatform false): Share of delivered orders Zomato treats as bad.
- `rejected_orders` (count, sum, exact, crossPlatform false): Rejected orders in Zomato's bad-orders breakdown.
- `delayed_orders_kpt10` (count, sum, exact, crossPlatform false): Zomato orders delayed by KPT plus 10 minutes.
- `delayed_orders_gt10` (count, sum, exact, crossPlatform false): Swiggy orders delayed by more than 10 minutes.
- `delayed_orders_gt10_pct` (pct, ratio, exact, crossPlatform false): Share of delivered Swiggy orders delayed by more than 10 minutes.
- `complaints` (count, sum, exact, crossPlatform false): Complaints. Zomato's total, or Swiggy's non-refunded plus refunded. Not added across platforms.
- `non_refunded_complaints` (count, sum, exact, crossPlatform false): Complaints that were not refunded. This is not the slice inside Zomato bad orders.
- `refunded_complaints` (count, sum, exact, crossPlatform false): Swiggy complaints the customer was refunded for.
- `complaints_missing` (count, sum, exact, crossPlatform false): Complaints about missing items.
- `complaints_quality` (count, sum, exact, crossPlatform false): Complaints about food quality.
- `complaints_wrong` (count, sum, exact, crossPlatform false): Complaints about a wrong item.
- `complaints_packaging` (count, sum, exact, crossPlatform false): Complaints about packaging. Swiggy's label also includes spillage.
- `complaints_quantity` (count, sum, exact, crossPlatform false): Swiggy complaints about quantity.
- `complaint_orders` (count, sum, exact, crossPlatform false): Swiggy orders that had a complaint. One order can carry more than one complaint.
- `complaint_orders_pct` (pct, ratio, exact, crossPlatform false): Share of delivered Swiggy orders that had a complaint.
- `self_logged_ors` (count, sum, exact, crossPlatform false): Zomato self-logged other order issues. Not part of the bad-order count.
- `lost_sales_paise` (paise, sum, exact, crossPlatform false): Sales Zomato reports as lost, for example from being offline or rejecting.
- `online_hours` (hours, sum, approx, crossPlatform false): Hours the outlet was online. Empty until scheduled hours are stored.
- `scheduled_hours` (hours, sum, exact, crossPlatform false): Hours the outlet was scheduled to be open. The weight for online percentage.
- `online_pct` (pct, weighted_avg, approx, crossPlatform false): Share of time the outlet was online. Days with scheduled hours are weighted by those hours. A day without scheduled hours counts as one day, and that result stays approximate.
- `offline_time_hours` (hours, platform_only, approx, crossPlatform false): Zomato's offline time for one platform window. The rounded daily hours do not add up.
- `kpt_weighted_sum` (decimal, sum, approx, crossPlatform false): Kitchen prep minutes times delivered orders.
- `kpt_minutes` (minutes, weighted_avg, approx, crossPlatform false): Kitchen preparation time, weighted by delivered orders. An approximation.
- `for_accurate_est` (decimal, sum, approx, crossPlatform false): Zomato FOR accuracy times delivered orders. The daily percentage is rounded.
- `for_accuracy_pct` (pct, weighted_avg, approx, crossPlatform false): Zomato food-order-ready accuracy, weighted by delivered orders.
- `mfr_accurate_orders` (count, sum, exact, crossPlatform false): Swiggy orders marked food-ready on time. The denominator is delivered orders.
- `food_ready_accuracy_pct` (pct, ratio, exact, crossPlatform false): Swiggy food-ready accuracy: accurate orders divided by delivered orders.
- `impressions` (decimal, sum, exact, crossPlatform false): Menu impressions. Swiggy's figures keep their decimals.
- `menu_opens` (count, sum, exact, crossPlatform false): Menu opens.
- `cart_builds` (count, sum, exact, crossPlatform false): Cart builds.
- `placed_orders` (count, sum, exact, crossPlatform false): Zomato placed orders. This is above delivered, and it is not Swiggy's funnel count.
- `swiggy_funnel_orders` (count, sum, exact, crossPlatform false): Swiggy Orders Placed. It stays below delivered orders, so it is a funnel count only.
- `impressions_to_menu_pct` (pct, ratio, exact, crossPlatform false): Share of impressions that became menu opens.
- `menu_to_cart_pct` (pct, ratio, exact, crossPlatform false): Share of menu opens that became cart builds.
- `cart_to_orders_pct` (pct, ratio, exact, crossPlatform false): Share of cart builds that became funnel orders. The numerator differs by platform.
- `menu_conversion_pct` (pct, platform_only, exact, crossPlatform false): Legacy single funnel rate. It is not rolled up. Use the three funnel rates instead.
- `new_user_orders` (count, sum, exact, crossPlatform false): Zomato orders from new users. Together with repeat and lapsed, these match placed orders.
- `repeat_user_orders` (count, sum, exact, crossPlatform false): Zomato orders from repeat users.
- `lapsed_user_orders` (count, sum, exact, crossPlatform false): Zomato orders from lapsed users. Not Swiggy's dormant orders.
- `swiggy_new_customer_orders` (count, sum, exact, crossPlatform false): Swiggy delivered orders from new customers.
- `swiggy_new_customer_pct` (pct, ratio, exact, crossPlatform false): Share of delivered Swiggy orders from new customers.
- `swiggy_repeat_customer_orders` (count, sum, exact, crossPlatform false): Swiggy delivered orders from repeat customers.
- `swiggy_repeat_customer_pct` (pct, ratio, exact, crossPlatform false): Share of delivered Swiggy orders from repeat customers.
- `dormant_user_orders` (count, sum, exact, crossPlatform false): Swiggy delivered orders from dormant customers. Not Zomato lapsed orders.
- `dormant_customer_pct` (pct, ratio, exact, crossPlatform false): Share of delivered Swiggy orders from dormant customers.
- `swiggy_new_customers` (count, platform_only, exact, crossPlatform false): Distinct new customers in one Swiggy window.
- `swiggy_repeat_customers` (count, platform_only, exact, crossPlatform false): Distinct repeat customers in one Swiggy window.
- `swiggy_dormant_customers` (count, platform_only, exact, crossPlatform false): Distinct dormant customers in one Swiggy window.
- `unique_customers` (count, distinct, exact, crossPlatform false): Distinct Zomato customers in the range, from salted payout hashes.
- `breakfast_orders` (count, sum, exact, crossPlatform false): Zomato breakfast orders.
- `lunch_orders` (count, sum, exact, crossPlatform false): Zomato lunch orders.
- `snacks_orders` (count, sum, exact, crossPlatform false): Zomato snacks orders.
- `dinner_orders` (count, sum, exact, crossPlatform false): Zomato dinner orders.
- `late_night_orders` (count, sum, exact, crossPlatform false): Zomato late night orders.
- `ads_sales_paise` (paise, sum, exact, crossPlatform false): Zomato sales from ads.
- `ad_orders` (count, sum, exact, crossPlatform false): Zomato orders attributed to ads. Swiggy CPC orders are cpc_orders.
- `ads_impressions` (decimal, sum, exact, crossPlatform false): Zomato ads impressions.
- `ads_menu_opens` (count, sum, exact, crossPlatform false): Zomato menu opens from ads.
- `ads_ctr_pct` (pct, ratio, exact, crossPlatform false): Zomato ads click-through rate: ads menu opens divided by ads impressions.
- `ads_roi` (decimal, ratio, exact, crossPlatform false): Zomato ads ROI from sales before the discount, divided by ads spend. Not a 0 to 100 percent.
- `cpc_sales_paise` (paise, sum, exact, crossPlatform false): Swiggy CPC ad sales.
- `cpc_orders` (count, sum, exact, crossPlatform false): Swiggy orders attributed to CPC ads.
- `cpc_spend_paise` (paise, sum, exact, crossPlatform false): Swiggy CPC spend in the business export.
- `cpc_menu_opens` (count, sum, exact, crossPlatform false): Swiggy menu visits from CPC ads.
- `cpc_roas` (pct, ratio, exact, crossPlatform false): Swiggy CPC return: CPC sales divided by CPC spend.
- `cpc_ads_depth_pct` (pct, ratio, exact, crossPlatform false): Swiggy CPC sales divided by Swiggy GMV. The monthly platform figure is excluded.
- `cba_sales_paise` (paise, sum, exact, crossPlatform false): Swiggy CBA ad sales.
- `cba_orders` (count, sum, exact, crossPlatform false): Swiggy orders attributed to CBA ads.
- `cba_spend_paise` (paise, sum, exact, crossPlatform false): Swiggy CBA spend.
- `cba_impressions` (decimal, sum, exact, crossPlatform false): Swiggy CBA ad impressions.
- `cba_menu_opens` (count, sum, exact, crossPlatform false): Swiggy menu visits from CBA ads.
- `cba_ads_depth_pct` (pct, ratio, exact, crossPlatform false): Swiggy CBA sales divided by Swiggy GMV.
- `cba_avg_cost_per_impression_paise` (paise, ratio, exact, crossPlatform false): Swiggy CBA spend divided by CBA impressions.
- `swiggy_gmv_paise` (paise, sum, exact, crossPlatform false): Swiggy gross value, restaurant discount divided by the discount GMV rate. Null when the discount is ₹0.
- `discount_gmv_pct` (pct, ratio, exact, crossPlatform false): Restaurant discount as a share of Swiggy GMV.
- `discounted_orders` (count, sum, exact, crossPlatform false): Swiggy delivered orders that had a restaurant discount.
- `discounted_orders_pct` (pct, ratio, exact, crossPlatform false): Share of delivered Swiggy orders that had a restaurant discount.
- `rdpo_paise` (paise, ratio, exact, crossPlatform false): Restaurant discount per delivered Swiggy order, not per discounted order.
- `offer_gross_sales_paise` (paise, sum, exact, crossPlatform false): Zomato gross sales from offers. The file label is swapped with the orders column; the value decides.
- `offer_orders` (count, sum, exact, crossPlatform false): Zomato orders with offers. The file label is swapped with the sales column.
- `offer_discount_pct` (pct, ratio, exact, crossPlatform false): Zomato discount divided by gross sales from offers.
- `menu_score` (decimal, snapshot_latest, exact, crossPlatform false): Swiggy menu score out of 100. A 0 is not computed.
- `menu_category_score` (decimal, snapshot_latest, exact, crossPlatform false): Swiggy menu category score. A 0 is not computed.
- `menu_item_score` (decimal, snapshot_latest, exact, crossPlatform false): Swiggy menu item score. A 0 is not computed.
- `menu_addon_score` (decimal, snapshot_latest, exact, crossPlatform false): Swiggy menu add-on score. A 0 is not computed.
- `menu_combo_score` (decimal, snapshot_latest, exact, crossPlatform false): Swiggy menu combo score. A 0 is not computed.
- `menu_photo_pct` (pct, snapshot_latest, exact, crossPlatform false): Share of Swiggy items that have a photo.
- `menu_desc_pct` (pct, snapshot_latest, exact, crossPlatform false): Share of Swiggy items that have a description.
- `top5_items_revenue_paise` (paise, platform_only, exact, crossPlatform false): Gross revenue of the top 5 items in the requested window. It is not added across windows.
- `lag_banner` (boolean, snapshot_latest, exact, crossPlatform false): Whether Swiggy showed the 48-hour lag banner. The numbers on screen are still stored.

## Reports

`POST /agent/v1/reports`

```json
{
  "type": "weekly-payout",
  "outletId": null,
  "periodStart": "2026-01-05T00:00:00.000+05:30",
  "periodEnd": "2026-01-12T00:00:00.000+05:30",
  "status": "amber",
  "summaryMarkdown": "Payout was short.",
  "files": [{ "name": "payout.csv", "contentType": "text/csv" }],
  "clientNonce": "weekly-payout-2026-01-05"
}
```

`status` is `green`, `amber`, `red`, or `null`. `outletId` may be `null`. File names are plain (`letters, digits, dot, underscore, hyphen`) and unique. `clientNonce` is optional. Sending the same nonce and the same file names again returns the same report with new upload links. A different file list for that nonce is `409`.

Response `201`:

```json
{
  "reportId": "ck...",
  "uploads": [
    {
      "name": "payout.csv",
      "contentType": "text/csv",
      "method": "PUT",
      "uploadUrl": "https://api.example/agent/v1/reports/ck.../files/payout.csv?exp=...&sig=...",
      "expiresAt": "2026-01-07T05:15:00.000Z"
    }
  ]
}
```

`PUT` the bytes to `uploadUrl` with the same bearer token, within 15 minutes, at most 20 MB. The link is signed. A changed name or an expired link is `403`. The file is stored under a private prefix for that restaurant. An empty `files` list is allowed and does not need object storage.

## Actions

`POST /agent/v1/actions` creates an action in `proposed`.

```json
{
  "outletId": "ck...",
  "platform": "swiggy",
  "type": "discount",
  "title": "Lunch discount",
  "details": { "percent": 10 },
  "estCostPaise": 50000,
  "chatMessageId": null,
  "clientNonce": "discount-lunch-1",
  "evidenceFiles": []
}
```

`type` is `discount`, `ad_campaign`, `price_change`, `menu_change`, or `other`. `estCostPaise` is an integer number of paise, or `null`. `chatMessageId`, when set, must already be a message in this restaurant. `evidenceFiles` uses the same upload links as reports, on `/agent/v1/actions/<actionId>/files/<name>`.

`PATCH /agent/v1/actions/<actionId>`

```json
{ "status": "approved", "approvedByMessageId": "ck..." }
```

`result` is an optional object, or `null`.

### Status

| From        | Allowed next            |
| ----------- | ----------------------- |
| `proposed`  | `approved`, `rejected`  |
| `approved`  | `executing`, `rejected` |
| `executing` | `executed`, `failed`    |
| `executed`  | `reverted`              |
| `failed`    | `reverted`              |
| `rejected`  | none                    |
| `reverted`  | none                    |

Sending the status the action already has is a retry and does not ask for approval again. The update is saved only if the status is still the one that was checked. If another request moved it first, this one is `409` `invalid_transition`.

`approved`, `executing`, and `executed` require a chat message that a person in this restaurant sent. On the move to `approved`, send `approvedByMessageId`. Later moves re-check the message already stored. The message has to be a user message in a thread of this space, and the person who owns that thread has to be a current member of the space. A bot message, a message from another restaurant, or a person who is not a member is `409` `approval_required`. The same sentence is used for each of those, so a guess does not reveal which one it was.

An action cannot skip from `proposed` to `executing` or `executed`.

## Runs

`POST /agent/v1/runs` records one job. Post it when the job starts and again when it finishes. `runId` is your id for that job and is unique inside the restaurant. A second post with the same `runId` updates the row. The first `startedAt` is kept. A field you leave out stays as it was. Send `null` to clear an optional field, except `startedAt`, which cannot be cleared. Do not reuse a `runId` for a different job.

`startedAt` is required the first time a run is posted. Leaving it out then is `400` `invalid_body`. On a repeat post, leave `startedAt` out; the stored start time stays. A different `startedAt` on a repeat post does not replace the first one. When `endedAt` is sent, it must be at or after that stored start time.

```json
{
  "runId": "payout-2026-01-06",
  "skill": "payout",
  "status": "succeeded",
  "startedAt": "2026-01-07T04:00:00.000Z",
  "endedAt": "2026-01-07T04:10:00.000Z",
  "costPaise": 420,
  "costUsdMicros": 5000,
  "fxRate": 84.125,
  "model": "example-model",
  "outletId": "ck...",
  "error": null
}
```

A finish post can omit `startedAt`:

```json
{
  "runId": "payout-2026-01-06",
  "skill": "payout",
  "status": "succeeded",
  "endedAt": "2026-01-07T04:10:00.000Z"
}
```

`status` is `running`, `succeeded`, `failed`, or `needs_owner`. `needs_owner` means the job is blocked on a one-time password or another step a person has to finish. `endedAt` may be omitted while the job is still running. When both times are present, `endedAt` is at or after `startedAt`.

### Cost

These three fields are the model spend for the run. `costPaise` covers model spend only, never computer or server time.

| Field           | Meaning                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `costUsdMicros` | Source figure. An integer count of millionths of a US dollar: the per-request usage cost of every model call in the run, added up, including retries and calls to fallback models. |
| `fxRate`        | The USD to INR rate used for this figure: how many rupees per one US dollar. Greater than 0, at most 6 decimal places.                                                             |
| `costPaise`     | Model spend only, in paise. The INR figure computed from `costUsdMicros` and `fxRate`.                                                                                             |

If you send `costPaise`, including `0`, you must also send `costUsdMicros` and `fxRate`. The server stores the three numbers you send. It does not recompute paise from the rate, so rounding stays yours. You may omit all three when you do not have a cost yet.

```sh
curl -sS -X POST -H "Authorization: Bearer ecom_agent_example" \
  -H "Content-Type: application/json" \
  -d '{"runId":"payout-2026-01-06","skill":"payout","status":"running","startedAt":"2026-01-07T04:00:00.000Z"}' \
  "$API/agent/v1/runs"
```

The response echoes the stored run, including `jobId`, `runId`, `status`, `startedAt`, `endedAt`, `costPaise`, `costUsdMicros`, `fxRate`, `model`, `outletId`, and `error`.
