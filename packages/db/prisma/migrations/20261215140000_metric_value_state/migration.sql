-- An absent metric is pending_label, not a zero and not a bare null.
-- The default keeps rows the previous release writes in the ok state.

ALTER TABLE "restaurant_metric_values" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE "restaurant_metric_values"
  ADD CONSTRAINT "restaurant_metric_values_state_chk"
  CHECK ("state" IN ('ok', 'pending_label', 'label_unrecoverable'));
