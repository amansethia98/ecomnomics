-- Additive. A stored file is current when it left nothing pending, or it was
-- parsed with the label registry this release is using. Older releases write
-- neither column; the defaults keep their rows current.
-- layout_changed is a log the agent writes. It is not an identity mismatch.
-- The previous release never writes it, and every status it writes stays allowed.

ALTER TABLE "metric_fetches" ADD COLUMN "label_set_version" INTEGER;
ALTER TABLE "metric_fetches" ADD COLUMN "pending_labels" INTEGER NOT NULL DEFAULT 0;

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
    'missing_platform_id',
    'parse_failed',
    'layout_changed'
  ));
