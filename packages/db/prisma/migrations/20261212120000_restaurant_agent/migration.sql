-- Additive: the previous release never reads these tables.
-- One restaurant is one organization and one space. Child rows repeat spaceId so
-- row-level security can filter without a join. The platform-admin role can read
-- a few of these tables; it is not the app login and it cannot use app.rls_bypass.

CREATE TABLE "restaurants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurants_organizationId_key" ON "restaurants"("organizationId");
CREATE UNIQUE INDEX "restaurants_spaceId_key" ON "restaurants"("spaceId");
CREATE UNIQUE INDEX "restaurants_id_spaceId_key" ON "restaurants"("id", "spaceId");

CREATE TABLE "outlets" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "zomatoResId" TEXT,
    "zomatoCommissionPct" DECIMAL(6,3),
    "swiggyRid" TEXT,
    "swiggyCommissionPct" DECIMAL(6,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outlets_id_spaceId_key" ON "outlets"("id", "spaceId");
CREATE INDEX "outlets_spaceId_idx" ON "outlets"("spaceId");
CREATE INDEX "outlets_restaurantId_idx" ON "outlets"("restaurantId");

CREATE TABLE "restaurant_metric_values" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "granularity" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "key" TEXT NOT NULL,
    "value" DECIMAL(20,4) NOT NULL,
    "runId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_metric_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metricUpsert" ON "restaurant_metric_values"("outletId", "platform", "granularity", "periodStart", "key");
CREATE INDEX "restaurant_metric_values_spaceId_key_periodStart_idx" ON "restaurant_metric_values"("spaceId", "key", "periodStart");

CREATE TABLE "restaurant_reports" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outletId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT,
    "summaryMarkdown" TEXT NOT NULL,
    "clientNonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reportNonce" ON "restaurant_reports"("restaurantId", "clientNonce");
CREATE INDEX "restaurant_reports_spaceId_periodStart_idx" ON "restaurant_reports"("spaceId", "periodStart");

CREATE TABLE "restaurant_report_files" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "storageKey" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_report_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_report_files_reportId_name_key" ON "restaurant_report_files"("reportId", "name");
CREATE INDEX "restaurant_report_files_spaceId_idx" ON "restaurant_report_files"("spaceId");

CREATE TABLE "restaurant_actions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT,
    "platform" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "estCostPaise" INTEGER,
    "chatMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "approvedByMessageId" TEXT,
    "result" JSONB,
    "clientNonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "executingAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "restaurant_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "actionNonce" ON "restaurant_actions"("restaurantId", "clientNonce");
CREATE INDEX "restaurant_actions_spaceId_status_idx" ON "restaurant_actions"("spaceId", "status");

CREATE TABLE "restaurant_action_files" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "storageKey" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_action_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_action_files_actionId_name_key" ON "restaurant_action_files"("actionId", "name");
CREATE INDEX "restaurant_action_files_spaceId_idx" ON "restaurant_action_files"("spaceId");

CREATE TABLE "restaurant_agent_tokens" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "restaurant_agent_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_agent_tokens_tokenHash_key" ON "restaurant_agent_tokens"("tokenHash");
CREATE INDEX "restaurant_agent_tokens_spaceId_revokedAt_idx" ON "restaurant_agent_tokens"("spaceId", "revokedAt");

CREATE TABLE "restaurant_job_runs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "outletId" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "costPaise" INTEGER,
    "costUsdMicros" BIGINT,
    "fxRate" DECIMAL(16,6),
    "model" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_job_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jobRunId" ON "restaurant_job_runs"("restaurantId", "runId");
CREATE INDEX "restaurant_job_runs_spaceId_startedAt_idx" ON "restaurant_job_runs"("spaceId", "startedAt");

CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "restaurantId" TEXT,
    "target" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_log_createdAt_idx" ON "admin_audit_log"("createdAt");
CREATE INDEX "admin_audit_log_adminUserId_createdAt_idx" ON "admin_audit_log"("adminUserId", "createdAt");
CREATE INDEX "admin_audit_log_restaurantId_createdAt_idx" ON "admin_audit_log"("restaurantId", "createdAt");

ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "outlets" ADD CONSTRAINT "outlets_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_metric_values" ADD CONSTRAINT "restaurant_metric_values_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_metric_values" ADD CONSTRAINT "restaurant_metric_values_outletId_spaceId_fkey" FOREIGN KEY ("outletId", "spaceId") REFERENCES "outlets"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_reports" ADD CONSTRAINT "restaurant_reports_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_reports" ADD CONSTRAINT "restaurant_reports_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "restaurant_report_files" ADD CONSTRAINT "restaurant_report_files_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "restaurant_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_actions" ADD CONSTRAINT "restaurant_actions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_actions" ADD CONSTRAINT "restaurant_actions_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "restaurant_action_files" ADD CONSTRAINT "restaurant_action_files_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "restaurant_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_agent_tokens" ADD CONSTRAINT "restaurant_agent_tokens_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_job_runs" ADD CONSTRAINT "restaurant_job_runs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_job_runs" ADD CONSTRAINT "restaurant_job_runs_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keeps a child row in the same space as its restaurant, and an outlet reference
-- in that same restaurant. Runs as the caller, so row-level security still hides
-- another restaurant's rows and the insert fails closed.
CREATE FUNCTION restaurant_same_space() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  restaurant_space text;
  outlet_space text;
  outlet_restaurant text;
BEGIN
  SELECT "spaceId" INTO restaurant_space FROM restaurants WHERE id = NEW."restaurantId";
  IF restaurant_space IS DISTINCT FROM NEW."spaceId" THEN
    RAISE EXCEPTION 'restaurant space mismatch';
  END IF;
  IF TG_TABLE_NAME = 'outlets' OR TG_TABLE_NAME = 'restaurant_agent_tokens' THEN
    RETURN NEW;
  END IF;
  IF NEW."outletId" IS NOT NULL THEN
    SELECT "spaceId", "restaurantId" INTO outlet_space, outlet_restaurant FROM outlets WHERE id = NEW."outletId";
    IF outlet_space IS DISTINCT FROM NEW."spaceId" OR outlet_restaurant IS DISTINCT FROM NEW."restaurantId" THEN
      RAISE EXCEPTION 'outlet is not in this restaurant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "outlets_same_space" BEFORE INSERT OR UPDATE ON "outlets" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "restaurant_metric_values_same_space" BEFORE INSERT OR UPDATE ON "restaurant_metric_values" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "restaurant_reports_same_space" BEFORE INSERT OR UPDATE ON "restaurant_reports" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "restaurant_actions_same_space" BEFORE INSERT OR UPDATE ON "restaurant_actions" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "restaurant_agent_tokens_same_space" BEFORE INSERT OR UPDATE ON "restaurant_agent_tokens" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();
CREATE TRIGGER "restaurant_job_runs_same_space" BEFORE INSERT OR UPDATE ON "restaurant_job_runs" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

CREATE FUNCTION restaurant_file_same_space() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_space text;
BEGIN
  IF TG_TABLE_NAME = 'restaurant_report_files' THEN
    SELECT "spaceId" INTO parent_space FROM restaurant_reports WHERE id = NEW."reportId";
  ELSE
    SELECT "spaceId" INTO parent_space FROM restaurant_actions WHERE id = NEW."actionId";
  END IF;
  IF parent_space IS DISTINCT FROM NEW."spaceId" THEN
    RAISE EXCEPTION 'file space mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "restaurant_report_files_same_space" BEFORE INSERT OR UPDATE ON "restaurant_report_files" FOR EACH ROW EXECUTE FUNCTION restaurant_file_same_space();
CREATE TRIGGER "restaurant_action_files_same_space" BEFORE INSERT OR UPDATE ON "restaurant_action_files" FOR EACH ROW EXECUTE FUNCTION restaurant_file_same_space();

CREATE FUNCTION admin_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$;

CREATE TRIGGER "admin_audit_log_no_update"
  BEFORE UPDATE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();

ALTER TABLE "restaurants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurants_tenant ON "restaurants"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurants_system ON "restaurants"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "outlets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY outlets_tenant ON "outlets"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY outlets_system ON "outlets"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "restaurant_metric_values" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_metric_values_tenant ON "restaurant_metric_values"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_metric_values_system ON "restaurant_metric_values"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "restaurant_reports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_reports_tenant ON "restaurant_reports"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_reports_system ON "restaurant_reports"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "restaurant_report_files" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_report_files_tenant ON "restaurant_report_files"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_report_files_system ON "restaurant_report_files"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "restaurant_actions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_actions_tenant ON "restaurant_actions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_actions_system ON "restaurant_actions"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "restaurant_action_files" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_action_files_tenant ON "restaurant_action_files"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_action_files_system ON "restaurant_action_files"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "restaurant_agent_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_agent_tokens_tenant ON "restaurant_agent_tokens"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_agent_tokens_system ON "restaurant_agent_tokens"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "restaurant_job_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_job_runs_tenant ON "restaurant_job_runs"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_job_runs_system ON "restaurant_job_runs"
  USING ((SELECT app_rls_bypass()));

-- No tenant policy and no bypass policy. Membership of ecomnomics_admin is the only way in.
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_audit_log" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    BEGIN
      CREATE ROLE ecomnomics_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'Cannot create role ecomnomics_admin (the migration role lacks CREATEROLE). Platform admin queries stay unavailable until that role exists.';
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecomnomics_admin') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO ecomnomics_admin', current_database());
    GRANT USAGE ON SCHEMA public TO ecomnomics_admin;
    -- Operational rows only. Token hashes, secrets, passwords, and job error text are not granted.
    GRANT SELECT ON TABLE "restaurants", "outlets" TO ecomnomics_admin;
    GRANT SELECT (
      "id", "restaurantId", "spaceId", "runId", "skill", "outletId", "status",
      "startedAt", "endedAt", "costPaise", "costUsdMicros", "fxRate", "model",
      "createdAt", "updatedAt"
    ) ON TABLE "restaurant_job_runs" TO ecomnomics_admin;
    GRANT SELECT, INSERT ON TABLE "admin_audit_log" TO ecomnomics_admin;

    EXECUTE $policy$CREATE POLICY restaurants_platform_admin ON "restaurants" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY outlets_platform_admin ON "outlets" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY restaurant_job_runs_platform_admin ON "restaurant_job_runs" FOR SELECT USING (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
    EXECUTE $policy$CREATE POLICY admin_audit_log_admin ON "admin_audit_log" FOR ALL USING (pg_has_role(current_user, 'ecomnomics_admin', 'member')) WITH CHECK (pg_has_role(current_user, 'ecomnomics_admin', 'member'))$policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    REVOKE ALL ON TABLE "admin_audit_log" FROM rakazo_app;
  END IF;
END $$;

REVOKE ALL ON TABLE "admin_audit_log" FROM PUBLIC;
