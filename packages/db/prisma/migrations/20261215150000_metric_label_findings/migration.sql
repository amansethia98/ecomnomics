-- Label findings are global. Observations name the outlet and the days, under the
-- tenant's row security. Adding tables is safe for the previous release.

CREATE TABLE "metric_label_findings" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "reportKind" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "slotId" TEXT,
    "oldLabel" TEXT NOT NULL,
    "candidateLabel" TEXT,
    "candidateNorm" TEXT,
    "evidence" JSONB NOT NULL,
    "confidence" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "outletsAffected" INTEGER NOT NULL DEFAULT 0,
    "daysAffected" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "aliasId" TEXT,

    CONSTRAINT "metric_label_findings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "metric_label_observations" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "fetchId" TEXT,
    "reportKind" TEXT NOT NULL,
    "periods" TEXT NOT NULL,
    "rowIndex" INTEGER,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_label_observations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "metric_label_findings_status_idx" ON "metric_label_findings"("status", "platform", "kind");
CREATE UNIQUE INDEX "metric_label_findings_open_idx"
  ON "metric_label_findings" (
    "kind", "platform", "family", "reportKind", "section", COALESCE("slotId", ''), COALESCE("candidateNorm", '')
  )
  WHERE "status" = 'open';
CREATE INDEX "metric_label_observations_space_idx" ON "metric_label_observations"("spaceId");
CREATE INDEX "metric_label_observations_finding_idx" ON "metric_label_observations"("findingId");

ALTER TABLE "metric_label_findings"
  ADD CONSTRAINT "metric_label_findings_slotId_fkey"
  FOREIGN KEY ("slotId") REFERENCES "metric_label_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "metric_label_observations"
  ADD CONSTRAINT "metric_label_observations_findingId_fkey"
  FOREIGN KEY ("findingId") REFERENCES "metric_label_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_label_observations"
  ADD CONSTRAINT "metric_label_observations_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_label_observations"
  ADD CONSTRAINT "metric_label_observations_outletId_spaceId_fkey"
  FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_label_observations"
  ADD CONSTRAINT "metric_label_observations_fetchId_fkey"
  FOREIGN KEY ("fetchId") REFERENCES "metric_fetches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER "metric_label_observations_same_space"
  BEFORE INSERT OR UPDATE ON "metric_label_observations"
  FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "metric_label_findings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_label_observations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY metric_label_findings_system ON "metric_label_findings"
  USING ((SELECT app_rls_bypass()));
CREATE POLICY metric_label_observations_tenant_read ON "metric_label_observations"
  FOR SELECT USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY metric_label_observations_tenant_insert ON "metric_label_observations"
  FOR INSERT WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY metric_label_observations_system ON "metric_label_observations"
  USING ((SELECT app_rls_bypass()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    GRANT SELECT ON TABLE "metric_label_findings" TO ecomnomics_admin;
    GRANT SELECT ON TABLE "metric_label_observations" TO ecomnomics_admin;
    EXECUTE $policy$CREATE POLICY metric_label_findings_admin ON "metric_label_findings" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY metric_label_observations_admin ON "metric_label_observations" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
  END IF;
END $$;
