-- Additive. The previous release does not read or write this column.
-- A stored business report lists requested periods that had no column.
-- Null means the file covered its whole request, or the row is not a stored file.

ALTER TABLE "metric_fetches" ADD COLUMN "missingPeriods" TEXT;
