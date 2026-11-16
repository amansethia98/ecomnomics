import type { PrismaClient } from "@rakazo/db";
import { createDb, ensureRestaurant, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("owner licence save (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  let routes: ReturnType<typeof restaurantOwnerRoutes>;
  const ids = {
    org: `desk-org-${suffix}`,
    user: `desk-user-${suffix}`,
    space: `desk-${suffix}`,
  };
  let restaurantId = "";

  beforeAll(async () => {
    const owner = createDb(migrationUrl!);
    const app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    stop = async () => {
      await owner.prisma.$disconnect();
      await owner.pool.end();
      await app.prisma.$disconnect();
      await app.pool.end();
    };
    routes = restaurantOwnerRoutes({
      prisma: db,
      getSession: async (headers) => {
        const token = headers.get("authorization")?.replace("Bearer ", "");
        return token === ids.user ? { userId: token } : null;
      },
    });
    await runAsSystem("owner licence fixture", async () => {
      await owner.prisma.organization.create({
        data: { id: ids.org, name: "Desk", slug: ids.org, createdAt: new Date() },
      });
      await owner.prisma.user.create({
        data: {
          id: ids.user,
          name: "Owner",
          email: `${ids.user}@ecomnomics.test`,
          emailVerified: true,
        },
      });
      await owner.prisma.member.create({
        data: {
          id: `${ids.user}-member`,
          organizationId: ids.org,
          userId: ids.user,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await owner.prisma.space.create({
        data: { id: ids.space, organizationId: ids.org, name: "Desk", createdByUserId: ids.user },
      });
      await owner.prisma.spaceMember.create({
        data: {
          id: `${ids.user}-space`,
          spaceId: ids.space,
          userId: ids.user,
          organizationId: ids.org,
          role: "owner",
          createdAt: new Date(),
        },
      });
      const restaurant = await ensureRestaurant(owner.prisma, {
        spaceId: ids.space,
        name: "Sample Kitchen",
      });
      restaurantId = restaurant.id;
    });
  });

  afterAll(async () => {
    await stop();
  });

  it("saves an expiry against the migrated schema, triggers included", async () => {
    const response = await routes.request(`/api/v1/restaurants/${restaurantId}/documents`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ids.user}`, "content-type": "application/json" },
      body: JSON.stringify({ reference: "LIC-100", expiresOn: "2027-01-15", gstin: null }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.expiresOn).toBe("2027-01-15");
    expect(body.reference).toBe("LIC-100");
  });
});
