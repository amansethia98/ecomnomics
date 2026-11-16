-- Additive. The previous release does not read this table.
-- owner_licences stores the FSSAI expiry the owner typed. It does not upload a file.

CREATE TABLE "owner_licences" (
    "restaurantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "reference" TEXT,
    "expiresOn" DATE,
    "gstin" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_licences_pkey" PRIMARY KEY ("restaurantId")
);

CREATE INDEX "owner_licences_space_idx" ON "owner_licences"("spaceId");

ALTER TABLE "owner_licences" ADD CONSTRAINT "owner_licences_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "owner_licences_same_space" BEFORE INSERT OR UPDATE ON "owner_licences" FOR EACH ROW EXECUTE FUNCTION restaurant_same_space();

ALTER TABLE "owner_licences" ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_licences_tenant ON "owner_licences"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY owner_licences_system ON "owner_licences"
  USING ((SELECT app_rls_bypass()));
