-- Additive. The previous release does not read or write this column.
-- Null means the row was not marked as an identity mismatch, so a parse
-- failure the previous release stored as rejected_mismatch does not count.

ALTER TABLE "metric_fetches" ADD COLUMN "identityMismatch" BOOLEAN;
