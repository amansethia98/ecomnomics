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

`PUT /agent/v1/metrics`

Upserts each row. The same outlet, platform, granularity, period start, and key overwrite the previous value. A batch is all or nothing, and at most 500 rows.

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

`platform` is `zomato` or `swiggy`. `granularity` is `day`, `week`, or `month`. Times are ISO-8601 with an offset. The same instant written with two different offsets is one period.

Response: `{ "upserted": 1 }`.

`value` may be `null`. Null means the figure is missing. Do not send `0` for a figure the screen did not show.

### Metric keys

`orders` is not a key. Send `delivered_orders` for the ops card and `payout_orders` for the payout file.

These names are computed, not stored: `effective_discount_pct` (`discount_paise / gross_sales_paise`), `ads_pct` (`ad_spend_paise / gross_sales_paise`), `payout_pct` (`net_payout_paise / gross_sales_paise`), `burn_pct` (`1 - payout_pct`), `ops_aov_paise` (`ops_sales_paise / delivered_orders`), `gross_aov_paise` (`gross_sales_paise / delivered_orders`), and `fees_incl_gst_paise` (`commission_paise + platform_fees_paise + taxes_paise`). A combined fee tile uses `fees_incl_gst_paise` because Zomato's fee row includes GST on fees and Swiggy's does not. `commission_pg_gst_paise` is stored: it is the calculator's Comm.+PG+GST row as printed, and Swiggy's printed row excludes GST on fees. `aov_paise` is the on-screen average and is stored. The two computed AOV figures are not.

| Key                                     | Unit    | Meaning                                                                                                                                   |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `gross_sales_paise`                     | paise   | Item total plus packaging (ST+PC), before GST and before restaurant-funded discounts. Not the weekly ops Sales tile.                      |
| `net_payout_paise`                      | paise   | Owner's Net Payout: commissionable value minus ads minus commission, other fees, and GST on fees. Not the amount paid under the bank UTR. |
| `aov_paise`                             | paise   | Average order value as shown on the weekly ops screen. Not an average computed from payout sales.                                         |
| `commission_paise`                      | paise   | Platform commission or base service fee only, not long-distance, payment-gateway, or GST on fees.                                         |
| `commission_pg_gst_paise`               | paise   | The payout calculator's Comm.+PG+GST row: platform commission plus payment-gateway fees plus GST, as that row is printed. Swiggy's row excludes GST on fees. |
| `platform_fees_paise`                   | paise   | Other platform fees besides commission, excluding GST on fees.                                                                            |
| `taxes_paise`                           | paise   | 18% GST on platform fees only. Not customer GST, and not TDS or TCS.                                                                      |
| `discount_paise`                        | paise   | Discounts the restaurant pays for. Not platform-funded discounts.                                                                         |
| `ad_spend_paise`                        | paise   | Ads charged to the restaurant for that period, counted once.                                                                              |
| `ad_orders`                             | count   | Orders attributed to ads.                                                                                                                 |
| `cancelled_orders`                      | count   | Cancelled orders for this platform. Do not add Zomato and Swiggy figures together.                                                        |
| `rating`                                | rating  | Average customer star rating, from 0 to 5.                                                                                                |
| `menu_conversion_pct`                   | percent | Starter funnel rate. Prefer impressions_to_menu_pct, menu_to_cart_pct, and cart_to_orders_pct until one meaning is chosen.                |
| `delivered_orders`                      | count   | Orders delivered in the ops week (what the ops card means by orders).                                                                     |
| `payout_orders`                         | count   | Payout-file total orders: delivered plus cancelled or rejected, for the payout period.                                                    |
| `ops_sales_paise`                       | paise   | Sales as shown on the weekly ops dashboard, stored separately from gross sales.                                                           |
| `bad_orders_pct`                        | percent | Share of orders Zomato treats as bad.                                                                                                     |
| `rejected_orders`                       | count   | Rejected orders in Zomato's bad-orders breakdown.                                                                                         |
| `delayed_orders`                        | count   | Orders delayed past the kitchen or prep threshold.                                                                                        |
| `poor_rated_orders`                     | count   | Orders with a poor customer rating.                                                                                                       |
| `bad_order_complaints`                  | count   | Complaints slice inside Zomato's bad-orders breakdown. It can differ from total complaints.                                               |
| `complaints`                            | count   | Total complaints for the week.                                                                                                            |
| `lost_sales_paise`                      | paise   | Sales Zomato reports as lost, for example from being offline or rejecting.                                                                |
| `cancelled_order_loss_paise`            | paise   | Money Swiggy reports as lost to restaurant-cancelled orders.                                                                              |
| `online_pct`                            | percent | Share of time the outlet was online or available.                                                                                         |
| `kpt_minutes`                           | minutes | Kitchen preparation time, in minutes to one decimal.                                                                                      |
| `food_ready_accuracy_pct`               | percent | Swiggy food-ready accuracy (MFR) on the weekly screen.                                                                                    |
| `for_accuracy_pct`                      | percent | Zomato food-order-ready accuracy, from the monthly export only.                                                                           |
| `offline_time_hours`                    | hours   | Time the outlet was offline, in hours.                                                                                                    |
| `rated_orders`                          | count   | How many orders received a rating.                                                                                                        |
| `lag_banner`                            | boolean | Whether Swiggy showed the 48-hour lag banner on this week. The numbers on screen are still stored.                                        |
| `cv_paise`                              | paise   | Commissionable value: item total plus packaging, minus the restaurant-funded discount.                                                    |
| `platform_net_payout_paise`             | paise   | The platform's own net payout figure, before comparing it to the bank.                                                                    |
| `paid_amount_paise`                     | paise   | Amount marked paid on the Payouts screen, tied to a bank UTR.                                                                             |
| `tds_paise`                             | paise   | Tax deducted at source and withheld from the payout. A tax credit, not a cost.                                                            |
| `tcs_paise`                             | paise   | Tax collected at source, including TCS IGST where it is present.                                                                          |
| `gst_collected_paise`                   | paise   | GST collected from customers. Not restaurant revenue on delivery orders.                                                                  |
| `complaints_cancellation_charges_paise` | paise   | Complaint refunds and cancellation charges deducted from the payout.                                                                      |
| `placed_orders`                         | count   | Orders placed in the calendar month.                                                                                                      |
| `ads_sales_paise`                       | paise   | Sales from ads.                                                                                                                           |
| `ads_roi`                               | ratio   | Platform-reported ads ROI. Not a 0 to 100 percent.                                                                                        |
| `ads_ctr_pct`                           | percent | Ads click-through rate.                                                                                                                   |
| `impressions`                           | count   | Menu impressions.                                                                                                                         |
| `menu_opens`                            | count   | Menu opens.                                                                                                                               |
| `cart_builds`                           | count   | Cart builds.                                                                                                                              |
| `impressions_to_menu_pct`               | percent | Share of impressions that became menu opens.                                                                                              |
| `menu_to_cart_pct`                      | percent | Share of menu opens that became cart builds.                                                                                              |
| `cart_to_orders_pct`                    | percent | Share of cart builds that became orders.                                                                                                  |
| `new_user_orders`                       | count   | Orders from new users.                                                                                                                    |
| `repeat_user_orders`                    | count   | Orders from repeat users.                                                                                                                 |
| `lapsed_user_orders`                    | count   | Orders from lapsed users.                                                                                                                 |

Paise and counts are non-negative integers. Percents are from 0 to 100 with at most 2 decimal places. `rating` is from 0 to 5 with at most 2 decimal places. `kpt_minutes` has at most 1 decimal place. Hours and `ads_roi` are non-negative with at most 4 decimal places; `ads_roi` is not capped at 100. `lag_banner` is `true`, `false`, or `null`. Any known key accepts `null`.

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
