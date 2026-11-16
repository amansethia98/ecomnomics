import type { PrismaClient } from "@rakazo/db";
import { createDb, createOutlet, ensureRestaurant, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("owner staff question (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  let routes: ReturnType<typeof restaurantOwnerRoutes>;
  const ids = {
    org: `staff-org-${suffix}`,
    user: `staff-user-${suffix}`,
    space: `staff-${suffix}`,
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
    await runAsSystem("owner staff fixture", async () => {
      await owner.prisma.organization.create({
        data: { id: ids.org, name: "Staff", slug: ids.org, createdAt: new Date() },
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
        data: { id: ids.space, organizationId: ids.org, name: "Staff", createdByUserId: ids.user },
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
      await createOutlet(owner.prisma, restaurant.id, {
        name: "Indiranagar",
        city: "Bengaluru",
        swiggyRid: "910001",
        zomatoResId: "910002",
      });
    });
  });

  afterAll(async () => {
    await stop();
  });

  it("stores a question against the migrated schema, triggers included", async () => {
    const response = await routes.request(`/api/v1/restaurants/${restaurantId}/staff/questions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ids.user}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "How were yesterday's sales?" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const text = JSON.stringify(body);
    expect(text).toContain("How were yesterday's sales?");
    expect(body.messages.some((message: { role: string }) => message.role === "staff")).toBe(true);
  });
});
