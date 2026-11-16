-- Additive. The previous release does not read these tables.
-- marketing_actions records a chat decision. It does not change a platform.
-- owner_staff_turns is the in-app thread. Counted owner rows are the daily limit.

CREATE TABLE "marketing_actions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "maxCostPaise" INTEGER,
    "decision" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "declinedUntil" DATE,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "marketing_actions_decision_idx" ON "marketing_actions"("restaurantId", "decision");
CREATE INDEX "marketing_actions_space_idx" ON "marketing_actions"("spaceId");

ALTER TABLE "marketing_actions" ADD CONSTRAINT "marketing_actions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_actions" ADD CONSTRAINT "marketing_actions_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER "marketing_actions_same_space" BEFORE INSERT OR UPDATE ON "marketing_actions" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "marketing_actions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY marketing_actions_tenant ON "marketing_actions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY marketing_actions_system ON "marketing_actions"
  USING ((SELECT app_rls_bypass()));

CREATE TABLE "owner_staff_turns" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "role" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "counted" BOOLEAN NOT NULL DEFAULT false,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_staff_turns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "owner_staff_turns_day_idx" ON "owner_staff_turns"("restaurantId", "userId", "businessDate");
CREATE INDEX "owner_staff_turns_space_idx" ON "owner_staff_turns"("spaceId");

ALTER TABLE "owner_staff_turns" ADD CONSTRAINT "owner_staff_turns_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "owner_staff_turns_same_space" BEFORE INSERT OR UPDATE ON "owner_staff_turns" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "owner_staff_turns" ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_staff_turns_tenant ON "owner_staff_turns"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY owner_staff_turns_system ON "owner_staff_turns"
  USING ((SELECT app_rls_bypass()));
