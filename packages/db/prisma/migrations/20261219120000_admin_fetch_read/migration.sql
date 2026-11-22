-- Additive. The platform admin reads when a download was stored.
-- The previous release does not select metric_fetches as that role.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    GRANT SELECT ON TABLE "metric_fetches" TO ecomnomics_admin;
    EXECUTE $policy$CREATE POLICY metric_fetches_platform_admin ON "metric_fetches" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
  END IF;
END $$;
