-- Additive tables and columns. The previous release's PUT /metrics upserts on
-- metricUpsert, which this migration drops, so that path fails until the new
-- release is serving. No column is dropped. Existing week rows are relabeled
-- before the granularity check: Swiggy payout weeks are Sunday-Saturday and
-- every other stored week is Monday-Sunday.

UPDATE "restaurant_metric_values"
  SET "granularity" = 'week_sun_sat'
  WHERE "granularity" = 'week' AND "platform" = 'swiggy';

UPDATE "restaurant_metric_values"
  SET "granularity" = 'week_mon_sun'
  WHERE "granularity" = 'week';

ALTER TABLE "restaurant_metric_values"
  ADD CONSTRAINT "restaurant_metric_values_granularity_chk"
  CHECK ("granularity" IN ('day', 'week_sun_sat', 'week_mon_sun', 'month', 'custom'));

ALTER TABLE "restaurant_metric_values" ADD COLUMN "fetchId" TEXT;
ALTER TABLE "restaurant_metric_values" ADD COLUMN "supersededAt" TIMESTAMP(3);
ALTER TABLE "restaurant_metric_values" ADD COLUMN "rowRole" TEXT NOT NULL DEFAULT 'fact';

ALTER TABLE "restaurant_metric_values"
  ADD CONSTRAINT "restaurant_metric_values_row_role_chk"
  CHECK ("rowRole" IN ('fact', 'platform_check'));

DROP INDEX "metricUpsert";

CREATE UNIQUE INDEX "metricCurrent"
  ON "restaurant_metric_values"("outletId", "platform", "granularity", "periodStart", "periodEnd", "key", "rowRole")
  WHERE "supersededAt" IS NULL;

CREATE INDEX "metric_values_window_idx"
  ON "restaurant_metric_values"("outletId", "platform", "granularity", "periodStart", "periodEnd", "key");

CREATE INDEX "metric_values_fetch_idx" ON "restaurant_metric_values"("fetchId");

CREATE TABLE "metric_fetches" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "reportKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedRestaurantId" TEXT,
    "requestedName" TEXT,
    "requestedCity" TEXT,
    "requestedPeriodStart" TIMESTAMP(3) NOT NULL,
    "requestedPeriodEnd" TIMESTAMP(3) NOT NULL,
    "observedRestaurantId" TEXT,
    "observedName" TEXT,
    "observedCity" TEXT,
    "observedPeriodStart" TIMESTAMP(3),
    "observedPeriodEnd" TIMESTAMP(3),
    "observedLabels" TEXT,
    "sha256" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "reason" TEXT,
    "runId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_fetches_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "metric_fetches"
  ADD CONSTRAINT "metric_fetches_status_chk"
  CHECK ("status" IN ('stored', 'skipped', 'rejected_mismatch', 'needs_owner'));

ALTER TABLE "metric_fetches"
  ADD CONSTRAINT "metric_fetches_kind_chk"
  CHECK ("reportKind" IN ('daily', 'weekly', 'monthly', 'payout'));

CREATE INDEX "metric_fetches_space_idx" ON "metric_fetches"("spaceId", "createdAt");
CREATE INDEX "metric_fetches_window_idx" ON "metric_fetches"("outletId", "platform", "requestedPeriodStart");

CREATE TABLE "metric_checks" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "rebuiltValue" DECIMAL(20,4),
    "platformValue" DECIMAL(20,4),
    "gap" DECIMAL(20,4),
    "tolerance" DECIMAL(20,4),
    "pass" BOOLEAN NOT NULL,
    "fetchId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "metric_checks_space_idx" ON "metric_checks"("spaceId", "checkedAt");
CREATE INDEX "metric_checks_fetch_idx" ON "metric_checks"("fetchId");

CREATE TABLE "platform_window_items" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "rank" INTEGER NOT NULL,
    "itemName" TEXT NOT NULL,
    "revenuePaise" INTEGER NOT NULL,
    "fetchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_window_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_window_items_window_idx"
  ON "platform_window_items"("outletId", "platform", "periodStart", "periodEnd");
CREATE INDEX "platform_window_items_space_idx" ON "platform_window_items"("spaceId");
CREATE INDEX "platform_window_items_fetch_idx" ON "platform_window_items"("fetchId");

ALTER TABLE "restaurant_metric_values"
  ADD CONSTRAINT "restaurant_metric_values_fetchId_fkey"
  FOREIGN KEY ("fetchId") REFERENCES "metric_fetches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "metric_fetches"
  ADD CONSTRAINT "metric_fetches_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_fetches"
  ADD CONSTRAINT "metric_fetches_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "metric_checks"
  ADD CONSTRAINT "metric_checks_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_checks"
  ADD CONSTRAINT "metric_checks_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_checks"
  ADD CONSTRAINT "metric_checks_fetchId_fkey"
  FOREIGN KEY ("fetchId") REFERENCES "metric_fetches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_window_items"
  ADD CONSTRAINT "platform_window_items_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_window_items"
  ADD CONSTRAINT "platform_window_items_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_window_items"
  ADD CONSTRAINT "platform_window_items_fetchId_fkey"
  FOREIGN KEY ("fetchId") REFERENCES "metric_fetches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "metric_fetches_same_space" BEFORE INSERT OR UPDATE ON "metric_fetches" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "metric_checks_same_space" BEFORE INSERT OR UPDATE ON "metric_checks" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "platform_window_items_same_space" BEFORE INSERT OR UPDATE ON "platform_window_items" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "metric_fetches" ENABLE ROW LEVEL SECURITY;
CREATE POLICY metric_fetches_tenant ON "metric_fetches"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY metric_fetches_system ON "metric_fetches"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "metric_checks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY metric_checks_tenant ON "metric_checks"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY metric_checks_system ON "metric_checks"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "platform_window_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_window_items_tenant ON "platform_window_items"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY platform_window_items_system ON "platform_window_items"
  USING ((SELECT app_rls_bypass()));
