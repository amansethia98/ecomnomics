-- Payout orders, the adjustments booked on a cycle, and the platform's own cycle totals.
-- Adding tables is safe for the previous release: it does not read them.

CREATE TABLE "payout_orders" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformOrderId" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "cycleId" TEXT NOT NULL,
    "cycleStart" TIMESTAMP(3) NOT NULL,
    "cycleEnd" TIMESTAMP(3) NOT NULL,
    "settlementStatus" TEXT NOT NULL,
    "settlementDate" TIMESTAMP(3),
    "utr_last4" TEXT,
    "orderStatus" TEXT NOT NULL,
    "category" TEXT,
    "cancelled_by" TEXT,
    "gross_sales_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL,
    "commission_paise" INTEGER NOT NULL,
    "platform_fees_paise" INTEGER NOT NULL,
    "taxes_paise" INTEGER NOT NULL,
    "tds_paise" INTEGER NOT NULL,
    "tcs_paise" INTEGER NOT NULL,
    "cv_paise" INTEGER NOT NULL,
    "gst_collected_paise" INTEGER NOT NULL,
    "complaints_cancellation_charges_paise" INTEGER NOT NULL,
    "net_payout_paise" INTEGER NOT NULL,
    "mfr_marked" BOOLEAN,
    "mfr_accurate" BOOLEAN,
    "customer_hash" TEXT,
    "fetchId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_orders_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payout_orders"
  ADD CONSTRAINT "payout_orders_platform_chk"
  CHECK ("platform" IN ('zomato', 'swiggy'));

ALTER TABLE "payout_orders"
  ADD CONSTRAINT "payout_orders_settlement_chk"
  CHECK ("settlementStatus" IN ('settled', 'pending'));

ALTER TABLE "payout_orders"
  ADD CONSTRAINT "payout_orders_utr_chk"
  CHECK ("utr_last4" IS NULL OR "utr_last4" ~ '^[A-Za-z0-9]{4}$');

CREATE UNIQUE INDEX "payout_orders_current"
  ON "payout_orders"("platform", "outletId", "platformOrderId")
  WHERE "supersededAt" IS NULL;

CREATE INDEX "payout_orders_order_date_idx" ON "payout_orders"("outletId", "platform", "orderDate");
CREATE INDEX "payout_orders_settlement_idx" ON "payout_orders"("outletId", "platform", "settlementDate");
CREATE INDEX "payout_orders_space_idx" ON "payout_orders"("spaceId");
CREATE INDEX "payout_orders_fetch_idx" ON "payout_orders"("fetchId");

CREATE TABLE "payout_adjustments" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL DEFAULT '',
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "booked_cycle" TEXT NOT NULL,
    "fetchId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_adjustments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payout_adjustments"
  ADD CONSTRAINT "payout_adjustments_platform_chk"
  CHECK ("platform" IN ('zomato', 'swiggy'));

CREATE UNIQUE INDEX "payout_adjustments_current"
  ON "payout_adjustments"("platform", "outletId", "cycleId", "type", "invoice_id")
  WHERE "supersededAt" IS NULL;

CREATE INDEX "payout_adjustments_cycle_idx" ON "payout_adjustments"("outletId", "platform", "booked_cycle");
CREATE INDEX "payout_adjustments_period_idx" ON "payout_adjustments"("outletId", "platform", "periodFrom");
CREATE INDEX "payout_adjustments_space_idx" ON "payout_adjustments"("spaceId");
CREATE INDEX "payout_adjustments_fetch_idx" ON "payout_adjustments"("fetchId");

CREATE TABLE "payout_cycles" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "cycleStart" TIMESTAMP(3) NOT NULL,
    "cycleEnd" TIMESTAMP(3) NOT NULL,
    "settlementStatus" TEXT NOT NULL,
    "settlementDate" TIMESTAMP(3),
    "utr_last4" TEXT,
    "payout_orders" INTEGER,
    "gross_sales_paise" INTEGER,
    "discount_paise" INTEGER,
    "cv_paise" INTEGER,
    "commission_paise" INTEGER,
    "platform_fees_paise" INTEGER,
    "taxes_paise" INTEGER,
    "tds_paise" INTEGER,
    "tcs_paise" INTEGER,
    "gst_collected_paise" INTEGER,
    "complaints_cancellation_charges_paise" INTEGER,
    "ad_spend_paise" INTEGER,
    "net_payout_paise" INTEGER,
    "platform_net_payout_paise" INTEGER,
    "fetchId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_cycles_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payout_cycles"
  ADD CONSTRAINT "payout_cycles_platform_chk"
  CHECK ("platform" IN ('zomato', 'swiggy'));

ALTER TABLE "payout_cycles"
  ADD CONSTRAINT "payout_cycles_settlement_chk"
  CHECK ("settlementStatus" IN ('settled', 'pending'));

ALTER TABLE "payout_cycles"
  ADD CONSTRAINT "payout_cycles_utr_chk"
  CHECK ("utr_last4" IS NULL OR "utr_last4" ~ '^[A-Za-z0-9]{4}$');

CREATE UNIQUE INDEX "payout_cycles_current"
  ON "payout_cycles"("platform", "outletId", "cycleId")
  WHERE "supersededAt" IS NULL;

CREATE INDEX "payout_cycles_window_idx" ON "payout_cycles"("outletId", "platform", "cycleStart");
CREATE INDEX "payout_cycles_space_idx" ON "payout_cycles"("spaceId");
CREATE INDEX "payout_cycles_fetch_idx" ON "payout_cycles"("fetchId");

ALTER TABLE "payout_orders"
  ADD CONSTRAINT "payout_orders_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_orders"
  ADD CONSTRAINT "payout_orders_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_orders"
  ADD CONSTRAINT "payout_orders_fetchId_fkey"
  FOREIGN KEY ("fetchId") REFERENCES "metric_fetches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payout_adjustments"
  ADD CONSTRAINT "payout_adjustments_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_adjustments"
  ADD CONSTRAINT "payout_adjustments_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_adjustments"
  ADD CONSTRAINT "payout_adjustments_fetchId_fkey"
  FOREIGN KEY ("fetchId") REFERENCES "metric_fetches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payout_cycles"
  ADD CONSTRAINT "payout_cycles_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_cycles"
  ADD CONSTRAINT "payout_cycles_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_cycles"
  ADD CONSTRAINT "payout_cycles_fetchId_fkey"
  FOREIGN KEY ("fetchId") REFERENCES "metric_fetches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER "payout_orders_same_space" BEFORE INSERT OR UPDATE ON "payout_orders" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "payout_adjustments_same_space" BEFORE INSERT OR UPDATE ON "payout_adjustments" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "payout_cycles_same_space" BEFORE INSERT OR UPDATE ON "payout_cycles" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "payout_orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY payout_orders_tenant ON "payout_orders"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY payout_orders_system ON "payout_orders"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "payout_adjustments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY payout_adjustments_tenant ON "payout_adjustments"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY payout_adjustments_system ON "payout_adjustments"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "payout_cycles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY payout_cycles_tenant ON "payout_cycles"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY payout_cycles_system ON "payout_cycles"
  USING ((SELECT app_rls_bypass()));
