# Restaurant agent API

The computer for one restaurant calls this API with that restaurant's token. One token can read and write only that restaurant. Money is an integer number of paise.

Definitions of each metric, and which Zomato or Swiggy field it comes from, will live in [docs/metric-dictionary.md](docs/metric-dictionary.md).

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

That value is shown once. The database stores only its hash. Put `RESTAURANT_AGENT_TOKEN` in the environment of that restaurant's computer and nowhere else. Do not set it on the API process, and do not copy it into another restaurant's computer. When that computer is created, add the variable next to the computer's own bot id.

Send it on every request:

```text
Authorization: Bearer $RESTAURANT_AGENT_TOKEN
```

`--rotate` revokes the current token and prints a new one. `--revoke` revokes it and prints nothing secret. A missing, wrong, or revoked token is `401` with the same body.

## Errors

Every error is JSON: `{ "error": "<sentence>", "code": "<code>" }`.

| HTTP | code | When |
| --- | --- | --- |
| 401 | `unauthorized` | No token, or the token is unknown or revoked. |
| 400 | `invalid_body` | The JSON does not match the shape below. |
| 400 | `unknown_metric_key` | A metric row uses a key that is not in the list. The sentence names the key and the allowed keys. Nothing is written. |
| 422 | `unknown_outlet` | `outletId` is missing or belongs to another restaurant. Both cases use the same sentence. |
| 422 | `unknown_message` | `chatMessageId` is not a message in this restaurant. |
| 404 | `not_found` | The action or file is not in this restaurant. |
| 409 | `invalid_transition` | The action status is not a legal next step. |
| 409 | `approval_required` | The action is not approved by a message a person in this restaurant sent. |
| 409 | `idempotency_conflict` | `clientNonce` was already used for a different file list. |
| 413 | `invalid_body` | An uploaded file is larger than 20 MB. |
| 503 | `object_storage_unconfigured` | The request includes files and this server has no object storage. Nothing is created. |

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

### Metric keys

| Key | Meaning |
| --- | --- |
| `gross_sales_paise` | Menu value of orders before commission, fees, and taxes, in paise. |
| `net_payout_paise` | Amount the platform is expected to pay the restaurant, in paise. |
| `orders` | Count of orders in the period. |
| `aov_paise` | Average order value, in paise. |
| `commission_paise` | Platform commission on the orders, in paise. |
| `platform_fees_paise` | Platform fees other than commission, in paise. |
| `taxes_paise` | Taxes on the orders, in paise. |
| `discount_paise` | Discounts on the orders, in paise. |
| `ad_spend_paise` | Ad spend in the period, in paise. |
| `ad_orders` | Orders attributed to ads. |
| `cancelled_orders` | Orders cancelled in the period. |
| `rating` | Average rating for the period, from 0 to 5. |
| `menu_conversion_pct` | Share of menu views that became orders, as a percent from 0 to 100. |

Keys ending in `_paise`, and the three counts, are non-negative integers. `rating` and `menu_conversion_pct` are non-negative numbers with at most 4 decimal places.

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

| From | Allowed next |
| --- | --- |
| `proposed` | `approved`, `rejected` |
| `approved` | `executing`, `rejected` |
| `executing` | `executed`, `failed` |
| `executed` | `reverted` |
| `failed` | `reverted` |
| `rejected` | none |
| `reverted` | none |

Sending the status the action already has is a retry and does not ask for approval again.

`approved`, `executing`, and `executed` require a chat message that a person in this restaurant sent. On the move to `approved`, send `approvedByMessageId`. Later moves re-check the message already stored. The message has to be a user message in a thread of this space, and the person who owns that thread has to be a current member of the space. A bot message, a message from another restaurant, or a person who is not a member is `409` `approval_required`. The same sentence is used for each of those, so a guess does not reveal which one it was.

An action cannot skip from `proposed` to `executing` or `executed`.

## Runs

`POST /agent/v1/runs` records one job. Post it when the job starts and again when it finishes. `runId` is your id for that job and is unique inside the restaurant. A second post with the same `runId` updates the row. The first `startedAt` is kept. A field you leave out stays as it was. Send `null` to clear an optional field. Do not reuse a `runId` for a different job.

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

`status` is `running`, `succeeded`, `failed`, or `needs_owner`. `needs_owner` means the job is blocked on a one-time password or another step a person has to finish. `endedAt` may be omitted while the job is still running. When both times are present, `endedAt` is at or after `startedAt`.

### Cost

These three fields are the model spend for the run. `costPaise` covers model spend only, never computer or server time.

| Field | Meaning |
| --- | --- |
| `costUsdMicros` | Source figure. An integer count of millionths of a US dollar: the per-request usage cost of every model call in the run, added up, including retries and calls to fallback models. |
| `fxRate` | The USD to INR rate used for this figure: how many rupees per one US dollar. Greater than 0, at most 6 decimal places. |
| `costPaise` | Model spend only, in paise. The INR figure computed from `costUsdMicros` and `fxRate`. |

If you send `costPaise`, including `0`, you must also send `costUsdMicros` and `fxRate`. The server stores the three numbers you send. It does not recompute paise from the rate, so rounding stays yours. You may omit all three when you do not have a cost yet.

```sh
curl -sS -X POST -H "Authorization: Bearer ecom_agent_example" \
  -H "Content-Type: application/json" \
  -d '{"runId":"payout-2026-01-06","skill":"payout","status":"running","startedAt":"2026-01-07T04:00:00.000Z"}' \
  "$API/agent/v1/runs"
```

The response echoes the stored run, including `jobId`, `runId`, `status`, `startedAt`, `endedAt`, `costPaise`, `costUsdMicros`, `fxRate`, `model`, `outletId`, and `error`.
