-- GST Swiggy deducted on one order. Null when that column is missing or the cell is blank.
-- Adding a column is safe for the previous release: it does not read it.

ALTER TABLE "payout_orders" ADD COLUMN "gst_deduction_paise" INTEGER;
