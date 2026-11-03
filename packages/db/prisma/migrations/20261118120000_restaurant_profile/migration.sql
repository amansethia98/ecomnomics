-- Additive: the previous release never reads these tables.
-- One restaurant profile per workspace. Outlets are rows in that workspace, not computers.

CREATE TABLE "restaurant_profiles" (
  "spaceId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "cuisine" TEXT NOT NULL DEFAULT '',
  "city" TEXT NOT NULL DEFAULT '',
  "contactName" TEXT NOT NULL DEFAULT '',
  "contactEmail" TEXT NOT NULL DEFAULT '',
  "contactPhone" TEXT NOT NULL DEFAULT '',
  "menuText" TEXT NOT NULL DEFAULT '',
  "menuFileName" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "restaurant_profiles_pkey" PRIMARY KEY ("spaceId")
);

CREATE UNIQUE INDEX "restaurant_profiles_organizationId_key" ON "restaurant_profiles"("organizationId");

ALTER TABLE "restaurant_profiles" ADD CONSTRAINT "restaurant_profiles_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_profiles" ADD CONSTRAINT "restaurant_profiles_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "restaurant_outlets" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "openingHours" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "restaurant_outlets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_outlets_spaceId_position_key" ON "restaurant_outlets"("spaceId", "position");

ALTER TABLE "restaurant_outlets" ADD CONSTRAINT "restaurant_outlets_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "restaurant_profiles"("spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_profiles_tenant ON "restaurant_profiles"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_profiles_system ON "restaurant_profiles"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "restaurant_outlets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_outlets_tenant ON "restaurant_outlets"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY restaurant_outlets_system ON "restaurant_outlets"
  USING (current_setting('app.rls_bypass', true) = 'on');
