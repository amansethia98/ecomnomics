-- Indexes for the owner metrics read. Adding indexes is safe for the previous release.

CREATE INDEX "metric_values_owner_read_idx"
  ON "restaurant_metric_values" ("restaurantId", "outletId", "platform", "periodStart");

CREATE INDEX "metric_values_owner_current_idx"
  ON "restaurant_metric_values" ("restaurantId", "outletId", "platform", "periodStart")
  WHERE "supersededAt" IS NULL;

CREATE INDEX "metric_values_owner_history_idx"
  ON "restaurant_metric_values" ("restaurantId", "outletId", "platform", "key", "periodStart")
  WHERE "supersededAt" IS NOT NULL;

CREATE INDEX "metric_fetches_owner_read_idx"
  ON "metric_fetches" ("restaurantId", "outletId", "platform", "requestedPeriodStart");

CREATE INDEX "payout_orders_owner_order_idx"
  ON "payout_orders" ("restaurantId", "outletId", "orderDate");

CREATE INDEX "payout_orders_owner_settlement_idx"
  ON "payout_orders" ("restaurantId", "outletId", "settlementDate");

CREATE INDEX "payout_orders_owner_current_idx"
  ON "payout_orders" ("restaurantId", "outletId", "orderDate")
  WHERE "supersededAt" IS NULL;

CREATE INDEX "payout_adjustments_owner_read_idx"
  ON "payout_adjustments" ("restaurantId", "outletId", "periodFrom");
