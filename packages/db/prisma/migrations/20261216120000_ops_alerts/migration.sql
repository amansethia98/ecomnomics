-- Additive. The previous release does not read these tables or the new
-- report columns. A daily brief, its alerts and the sends the runner records.

ALTER TABLE "restaurant_reports" ADD COLUMN "kind" TEXT;
ALTER TABLE "restaurant_reports" ADD COLUMN "businessDate" DATE;
ALTER TABLE "restaurant_reports" ADD COLUMN "payload" JSONB;
ALTER TABLE "restaurant_reports" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "restaurant_reports" ADD COLUMN "dataAsOf" TIMESTAMP(3);
CREATE INDEX "restaurant_reports_kind_date_idx" ON "restaurant_reports"("restaurantId", "kind", "businessDate");

CREATE TABLE "ops_alerts" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT,
    "platform" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "family" TEXT,
    "ownerRuleId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "firstSeenDate" DATE NOT NULL,
    "lastSeenDate" DATE NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "consecutiveDays" INTEGER NOT NULL DEFAULT 1,
    "clearDays" INTEGER NOT NULL DEFAULT 0,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "escalatedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedReason" TEXT,
    "lastValue" DECIMAL(20,4),
    "threshold" DECIMAL(20,4),
    "baselineValue" DECIMAL(20,4),
    "evidence" JSONB NOT NULL,
    "fixKey" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "notifiedSeverity" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ops_alert_events" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT,
    "value" DECIMAL(20,4),
    "reportId" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_alert_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ops_report_deliveries" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "reportVersion" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "externalId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_report_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ops_alerts_status_idx" ON "ops_alerts"("restaurantId", "status", "lastSeenDate");
CREATE INDEX "ops_alerts_space_idx" ON "ops_alerts"("spaceId");
CREATE UNIQUE INDEX "ops_alerts_open_key" ON "ops_alerts"("restaurantId", "dedupeKey") WHERE "status" <> 'resolved';
CREATE INDEX "ops_alert_events_alert_idx" ON "ops_alert_events"("alertId", "createdAt");
CREATE INDEX "ops_alert_events_space_idx" ON "ops_alert_events"("spaceId");
CREATE INDEX "ops_report_deliveries_report_idx" ON "ops_report_deliveries"("reportId", "sentAt");
CREATE INDEX "ops_report_deliveries_space_idx" ON "ops_report_deliveries"("spaceId");

ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_alert_events" ADD CONSTRAINT "ops_alert_events_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "ops_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_alert_events" ADD CONSTRAINT "ops_alert_events_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_report_deliveries" ADD CONSTRAINT "ops_report_deliveries_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "restaurant_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_report_deliveries" ADD CONSTRAINT "ops_report_deliveries_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "ops_alerts_same_space" BEFORE INSERT OR UPDATE ON "ops_alerts" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

-- Events and deliveries have no outlet. The shared trigger reads outletId, so these check the restaurant only.
CREATE FUNCTION ops_same_restaurant_space() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  restaurant_space text;
BEGIN
  SELECT "spaceId" INTO restaurant_space FROM restaurants WHERE id = NEW."restaurantId";
  IF restaurant_space IS DISTINCT FROM NEW."spaceId" THEN
    RAISE EXCEPTION 'restaurant space mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ops_alert_events_same_space" BEFORE INSERT OR UPDATE ON "ops_alert_events" FOR EACH ROW EXECUTE FUNCTION ops_same_restaurant_space();
CREATE TRIGGER "ops_report_deliveries_same_space" BEFORE INSERT OR UPDATE ON "ops_report_deliveries" FOR EACH ROW EXECUTE FUNCTION ops_same_restaurant_space();

ALTER TABLE "ops_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops_alert_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops_report_deliveries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY ops_alerts_tenant ON "ops_alerts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY ops_alerts_system ON "ops_alerts"
  USING ((SELECT app_rls_bypass()));

CREATE POLICY ops_alert_events_tenant ON "ops_alert_events"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY ops_alert_events_system ON "ops_alert_events"
  USING ((SELECT app_rls_bypass()));

CREATE POLICY ops_report_deliveries_tenant ON "ops_report_deliveries"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY ops_report_deliveries_system ON "ops_report_deliveries"
  USING ((SELECT app_rls_bypass()));
