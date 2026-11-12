-- Bank paid amount from the payout file. Null when that file has no settled amount.
-- Adding columns is safe for the previous release: it does not read them.

ALTER TABLE "payout_orders" ADD COLUMN "paid_amount_paise" INTEGER;
ALTER TABLE "payout_cycles" ADD COLUMN "paid_amount_paise" INTEGER;
