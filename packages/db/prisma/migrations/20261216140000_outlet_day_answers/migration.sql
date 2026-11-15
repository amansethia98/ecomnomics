-- Additive. The previous release does not read this table. An owner answer
-- for one outlet on one civil date, used by the daily brief.

CREATE TABLE "outlet_day_answers" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_day_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outlet_day_answers_restaurantId_outletId_businessDate_key" ON "outlet_day_answers"("restaurantId", "outletId", "businessDate");
CREATE INDEX "outlet_day_answers_space_idx" ON "outlet_day_answers"("spaceId");

ALTER TABLE "outlet_day_answers" ADD CONSTRAINT "outlet_day_answers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outlet_day_answers" ADD CONSTRAINT "outlet_day_answers_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "outlet_day_answers_same_space" BEFORE INSERT OR UPDATE ON "outlet_day_answers" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "outlet_day_answers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY outlet_day_answers_tenant ON "outlet_day_answers"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY outlet_day_answers_system ON "outlet_day_answers"
  USING ((SELECT app_rls_bypass()));
