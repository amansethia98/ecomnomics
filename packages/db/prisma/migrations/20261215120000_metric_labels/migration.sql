-- Additive. Global label names for the metric and payout parsers.
-- The previous release does not read these tables. Row security lets every
-- login read them. Writes need the system bypass or membership of
-- ecomnomics_admin. There is no tenant write policy, and row security is
-- not forced, so the migration owner can load the first registry row.

CREATE TABLE "metric_label_slots" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "reportKind" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "summable" BOOLEAN NOT NULL,
    "allowAutoApply" BOOLEAN NOT NULL,
    "collect" TEXT NOT NULL,

    CONSTRAINT "metric_label_slots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metric_label_slots_platform_reportKind_section_slotKey_key"
  ON "metric_label_slots"("platform", "reportKind", "section", "slotKey");

CREATE TABLE "metric_label_aliases" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "reportKind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "normLabel" TEXT NOT NULL,
    "matchMode" TEXT NOT NULL,
    "includeTokens" TEXT[] NOT NULL,
    "excludeTokens" TEXT[] NOT NULL,
    "group" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "metric_label_aliases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "metric_label_aliases_slotId_idx" ON "metric_label_aliases"("slotId");
CREATE INDEX "metric_label_aliases_platform_reportKind_normLabel_idx"
  ON "metric_label_aliases"("platform", "reportKind", "normLabel");

ALTER TABLE "metric_label_aliases"
  ADD CONSTRAINT "metric_label_aliases_slotId_fkey"
  FOREIGN KEY ("slotId") REFERENCES "metric_label_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "metric_label_registry" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_label_registry_pkey" PRIMARY KEY ("id")
);

INSERT INTO "metric_label_registry" ("id", "version", "updatedAt")
VALUES ('global', 1, CURRENT_TIMESTAMP);

ALTER TABLE "metric_label_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_label_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_label_registry" ENABLE ROW LEVEL SECURITY;

CREATE POLICY metric_label_slots_read ON "metric_label_slots" FOR SELECT USING (true);
CREATE POLICY metric_label_aliases_read ON "metric_label_aliases" FOR SELECT USING (true);
CREATE POLICY metric_label_registry_read ON "metric_label_registry" FOR SELECT USING (true);

CREATE POLICY metric_label_slots_system ON "metric_label_slots"
  FOR ALL USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));
CREATE POLICY metric_label_aliases_system ON "metric_label_aliases"
  FOR ALL USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));
CREATE POLICY metric_label_registry_system ON "metric_label_registry"
  FOR ALL USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "metric_label_slots", "metric_label_aliases", "metric_label_registry"
      TO ecomnomics_admin;
    EXECUTE $policy$CREATE POLICY metric_label_slots_admin ON "metric_label_slots" FOR ALL USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY metric_label_aliases_admin ON "metric_label_aliases" FOR ALL USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY metric_label_registry_admin ON "metric_label_registry" FOR ALL USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
  END IF;
END $$;
