-- Additive. Admin decisions on a renamed label, and the nights a re-read failed.
-- The previous release does not read these tables. Tenants cannot read events.
-- A re-read attempt is tenant-scoped, like a fetch hold.

ALTER TABLE "metric_label_slots" ADD COLUMN "retiredFrom" TIMESTAMP(3);

ALTER TABLE "metric_label_aliases" ADD COLUMN "retiredAt" TIMESTAMP(3);

CREATE TABLE "metric_label_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "findingId" TEXT,
    "aliasId" TEXT,
    "slotId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "registryVersion" INTEGER NOT NULL,

    CONSTRAINT "metric_label_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "metric_label_events_finding_idx" ON "metric_label_events"("findingId");

CREATE TABLE "metric_relabel_attempts" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "night" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_relabel_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metric_relabel_attempts_night_key"
  ON "metric_relabel_attempts"("outletId", "findingId", "periodStart", "night");
CREATE INDEX "metric_relabel_attempts_space_idx" ON "metric_relabel_attempts"("spaceId");

ALTER TABLE "metric_relabel_attempts"
  ADD CONSTRAINT "metric_relabel_attempts_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_relabel_attempts"
  ADD CONSTRAINT "metric_relabel_attempts_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "metric_relabel_attempts_same_space"
  BEFORE INSERT OR UPDATE ON "metric_relabel_attempts"
  FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "metric_label_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_relabel_attempts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY metric_label_events_system ON "metric_label_events"
  USING ((SELECT app_rls_bypass()))
  WITH CHECK ((SELECT app_rls_bypass()));

CREATE POLICY metric_relabel_attempts_tenant_read ON "metric_relabel_attempts"
  FOR SELECT USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY metric_relabel_attempts_tenant_insert ON "metric_relabel_attempts"
  FOR INSERT WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY metric_relabel_attempts_system ON "metric_relabel_attempts"
  USING ((SELECT app_rls_bypass()))
  WITH CHECK ((SELECT app_rls_bypass()));

-- Findings were select-only for an admin. Approving one updates the row and may open an absent finding.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    GRANT SELECT, INSERT ON TABLE "metric_label_events" TO ecomnomics_admin;
    GRANT SELECT ON TABLE "metric_relabel_attempts" TO ecomnomics_admin;
    GRANT INSERT, UPDATE ON TABLE "metric_label_findings" TO ecomnomics_admin;
    GRANT UPDATE ON TABLE "restaurant_metric_values" TO ecomnomics_admin;
    EXECUTE $policy$CREATE POLICY metric_label_events_admin ON "metric_label_events" FOR ALL USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY metric_relabel_attempts_admin ON "metric_relabel_attempts" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY metric_label_findings_admin_write ON "metric_label_findings" FOR INSERT WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY metric_label_findings_admin_update ON "metric_label_findings" FOR UPDATE USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY restaurant_metric_values_admin_label ON "restaurant_metric_values" FOR UPDATE USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
  END IF;
END $$;
