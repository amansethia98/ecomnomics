-- A renamed payout column is null, not zero. The previous release writes a
-- number into each of these columns, which still satisfies a nullable column.
-- pending_fields defaults to empty, so a row that release writes has no pending label.

ALTER TABLE "payout_orders" ALTER COLUMN "gross_sales_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "discount_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "commission_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "platform_fees_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "taxes_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "tds_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "tcs_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "cv_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "gst_collected_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "complaints_cancellation_charges_paise" DROP NOT NULL;
ALTER TABLE "payout_orders" ALTER COLUMN "net_payout_paise" DROP NOT NULL;

ALTER TABLE "payout_orders" ADD COLUMN "pending_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "payout_cycles" ADD COLUMN "pending_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
