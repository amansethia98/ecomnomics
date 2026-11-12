# Owner metrics read

`GET /api/v1/restaurants/:restaurantId/metrics`

The signed-in owner of a restaurant reads one total, and a series when `grain` is set. The same read is available to the restaurant agent as `GET /agent/v1/metrics` when the request includes `keys`. The agent token is not accepted on the owner route.

Dates are civil dates in Asia/Kolkata. `to` is exclusive. `platform` is `zomato`, `swiggy`, or `all`. `basis` is `order_date` or `settlement_date`. Omit `outletIds` to include every outlet. A range longer than 400 days is rejected. More than 100 keys is rejected.

`order_date` sums business metrics and payout keys by the day the order was placed. Adjustments are spread across the days of their own period and returned on `adjustments`. They are not added into the order totals. `settlement_date` sums settled payout orders by settlement date. `settlements` lists each settlement with the last four characters of the bank reference. `gap` is the bridge between the two views: orders that settled in this window but were placed earlier, orders placed in this window that are still pending, and the adjustments.

A value is `provisional` when its days fall in the last 7 days, a settlement in it is still pending, or Swiggy's lag banner is on. `lagBanner` is that banner. It is null when the read is not for Swiggy. `restated` is true when a stored day in that period was replaced by a later fetch. A day with no stored fetch and no figure is a missing date. It is not counted as zero.

`all` adds a key across Zomato and Swiggy only when that key is marked cross-platform. Every other key comes back once per platform. An outlet that joined during the range is included, and `note` names it and the dates it does not cover. `likeForLike=true` drops those outlets from the total. Swiggy train and Toing orders stay inside the Swiggy totals and are also listed on `categories`.

```json
{
  "basis": "order_date",
  "platform": "all",
  "from": "2026-01-01",
  "to": "2026-01-03",
  "grain": "day",
  "likeForLike": false,
  "provisional": false,
  "lagBanner": false,
  "outlets": [
    {
      "id": "outlet_north",
      "name": "North",
      "partial": false,
      "partialDates": [],
      "included": true
    }
  ],
  "note": null,
  "values": [
    {
      "key": "delivered_orders",
      "platform": "all",
      "unit": "count",
      "kind": "sum",
      "accuracy": "exact",
      "value": 5,
      "status": "ok",
      "coverageDays": 2,
      "expectedDays": 2,
      "missingDates": [],
      "partialDates": [],
      "provisional": false,
      "restated": false
    }
  ],
  "series": [
    {
      "from": "2026-01-01",
      "to": "2026-01-02",
      "restated": false,
      "provisional": false,
      "values": [
        {
          "key": "delivered_orders",
          "platform": "all",
          "unit": "count",
          "kind": "sum",
          "accuracy": "exact",
          "value": 2,
          "status": "ok",
          "coverageDays": 1,
          "expectedDays": 1,
          "missingDates": [],
          "partialDates": [],
          "provisional": false,
          "restated": false
        }
      ],
      "adjustments": { "amountPaise": 34, "byDate": [{ "date": "2026-01-01", "amountPaise": 34 }] }
    }
  ],
  "adjustments": {
    "amountPaise": 67,
    "byDate": [
      { "date": "2026-01-01", "amountPaise": 34 },
      { "date": "2026-01-02", "amountPaise": 33 }
    ]
  },
  "gap": {
    "settledFromEarlierPaise": 0,
    "notYetSettledPaise": 0,
    "adjustmentsPaise": 67
  },
  "settlements": [],
  "categories": [
    {
      "platform": "swiggy",
      "category": "train",
      "orders": 1,
      "grossSalesPaise": 30,
      "netPayoutPaise": 10
    }
  ]
}
```
