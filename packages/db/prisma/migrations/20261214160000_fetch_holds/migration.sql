-- Additive. fetch_holds is a new table. parse_failed widens the status
-- check: the previous release never writes it, and every status it writes
-- is still allowed. The previous release does not read fetch_holds.

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
    'parse_failed'
  ));

CREATE TABLE "fetch_holds" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedBy" TEXT,

    CONSTRAINT "fetch_holds_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fetch_holds_outlet_idx" ON "fetch_holds"("restaurantId", "outletId", "platform");
CREATE UNIQUE INDEX "fetch_holds_open_idx" ON "fetch_holds"("outletId", "platform") WHERE "clearedAt" IS NULL;

ALTER TABLE "fetch_holds" ADD CONSTRAINT "fetch_holds_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fetch_holds" ADD CONSTRAINT "fetch_holds_outletId_spaceId_fkey" FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "fetch_holds_same_space" BEFORE INSERT OR UPDATE ON "fetch_holds" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "fetch_holds" ENABLE ROW LEVEL SECURITY;
CREATE POLICY fetch_holds_tenant_read ON "fetch_holds"
  FOR SELECT USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY fetch_holds_tenant_insert ON "fetch_holds"
  FOR INSERT WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY fetch_holds_system ON "fetch_holds"
  USING ((SELECT app_rls_bypass()));

-- The role is created by the restaurant-agent migration. Grant the clear only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    GRANT SELECT, UPDATE ON TABLE "fetch_holds" TO ecomnomics_admin;
    EXECUTE $policy$CREATE POLICY fetch_holds_platform_admin_read ON "fetch_holds" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY fetch_holds_platform_admin_update ON "fetch_holds" FOR UPDATE USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
  END IF;
END $$;
