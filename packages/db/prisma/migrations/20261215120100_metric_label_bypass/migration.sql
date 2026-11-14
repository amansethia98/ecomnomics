-- The label-table system policies set WITH CHECK explicitly. Every other
-- bypass policy leaves WITH CHECK empty, and the row-security check requires
-- that shape. Postgres still uses the USING expression for inserts.

DROP POLICY metric_label_slots_system ON "metric_label_slots";
CREATE POLICY metric_label_slots_system ON "metric_label_slots"
  USING ((SELECT app_rls_bypass()));

DROP POLICY metric_label_aliases_system ON "metric_label_aliases";
CREATE POLICY metric_label_aliases_system ON "metric_label_aliases"
  USING ((SELECT app_rls_bypass()));

DROP POLICY metric_label_registry_system ON "metric_label_registry";
CREATE POLICY metric_label_registry_system ON "metric_label_registry"
  USING ((SELECT app_rls_bypass()));
