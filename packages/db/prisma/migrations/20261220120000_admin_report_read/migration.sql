-- Additive. The platform admin reads which briefs were sent, and the
-- cart and order figures a data-quality note is built from.
-- The previous release does not select these tables as that role.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    GRANT SELECT ON TABLE "restaurant_reports" TO ecomnomics_admin;
    GRANT SELECT ON TABLE "restaurant_metric_values" TO ecomnomics_admin;
    EXECUTE $policy$CREATE POLICY restaurant_reports_platform_admin ON "restaurant_reports" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY restaurant_metric_values_platform_admin ON "restaurant_metric_values" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
  END IF;
END $$;
