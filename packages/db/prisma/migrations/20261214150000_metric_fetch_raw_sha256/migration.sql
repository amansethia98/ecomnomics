-- Additive. The previous release always writes sha256 and the old statuses.
-- A log row has no file, so sha256 may be null. rawSha256 is the raw download
-- hash and stays null until a client sends one. New statuses are outcomes
-- with no stored file. Adding a nullable column and an index is safe while
-- the previous release is still running.

ALTER TABLE "metric_fetches" ADD COLUMN "rawSha256" TEXT;
ALTER TABLE "metric_fetches" ALTER COLUMN "sha256" DROP NOT NULL;

ALTER TABLE "metric_fetches" DROP CONSTRAINT "metric_fetches_status_chk";
ALTER TABLE "metric_fetches"
  ADD CONSTRAINT "metric_fetches_status_chk"
  CHECK ("status" IN (
    'stored',
    'skipped',
    'rejected_mismatch',
    'needs_owner',
    'signed_out',
    'download_failed',
    'ui_changed',
    'local_mismatch',
    'missing_platform_id'
  ));

CREATE INDEX "metric_fetches_raw_sha_idx"
  ON "metric_fetches" ("restaurantId", "outletId", "platform", "reportKind", "requestedPeriodStart", "rawSha256");
