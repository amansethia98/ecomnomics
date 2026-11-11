-- Additive: the previous release writes numeric metric values and never reads
-- valueBoolean. Null value means the figure is missing.

ALTER TABLE "restaurant_metric_values" ALTER COLUMN "value" DROP NOT NULL;

ALTER TABLE "restaurant_metric_values" ADD COLUMN "valueBoolean" BOOLEAN;

ALTER TABLE "restaurant_metric_values"
  ADD CONSTRAINT "restaurant_metric_values_value_kind_chk"
  CHECK (NOT ("value" IS NOT NULL AND "valueBoolean" IS NOT NULL));
