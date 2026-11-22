import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createOutlet,
  ensureRestaurant,
  readOwnerProfileForMember,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("owner profile read (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let ownerDb: PrismaClient;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  let routes: ReturnType<typeof restaurantOwnerRoutes>;
  const ids = {
    a: { org: `prof-a-org-${suffix}`, user: `prof-a-user-${suffix}`, space: `prof-a-${suffix}` },
    b: { org: `prof-b-org-${suffix}`, user: `prof-b-user-${suffix}`, space: `prof-b-${suffix}` },
  };
  let restaurantA = "";
  let outletA = "";

  beforeAll(async () => {
    const owner = createDb(migrationUrl!);
    const app = createDb(runtimeUrl!, { poolMax: 4 });
    ownerDb = owner.prisma;
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
        if (token === ids.a.user || token === ids.b.user) return { userId: token };
        return null;
      },
    });

    await runAsSystem("owner profile fixture", async () => {
      for (const key of ["a", "b"] as const) {
        const row = ids[key];
        await ownerDb.organization.create({
          data: { id: row.org, name: key, slug: row.org, createdAt: new Date() },
        });
        await ownerDb.user.create({
          data: {
            id: row.user,
            name: key === "a" ? "Ravi Kumar" : "Other",
            email: `${row.user}@ecomnomics.test`,
            emailVerified: true,
          },
        });
        await ownerDb.member.create({
          data: {
            id: `${row.user}-member`,
            organizationId: row.org,
            userId: row.user,
            role: "owner",
            createdAt: new Date(),
          },
        });
        await ownerDb.space.create({
          data: { id: row.space, organizationId: row.org, name: key, createdByUserId: row.user },
        });
        await ownerDb.spaceMember.create({
          data: {
            id: `${row.user}-space`,
            spaceId: row.space,
            userId: row.user,
            organizationId: row.org,
            role: "owner",
            createdAt: new Date(),
          },
        });
        const restaurant = await ensureRestaurant(ownerDb, {
          spaceId: row.space,
          name: key === "a" ? "Kesar Kitchen" : "Other Kitchen",
        });
        if (key === "a") restaurantA = restaurant.id;
      }
      const outlet = await createOutlet(ownerDb, restaurantA, {
        name: "Indiranagar",
        city: "Bengaluru",
        swiggyRid: "900001",
        zomatoResId: "900002",
      });
      outletA = outlet.id;
      await ownerDb.metricFetch.create({
        data: {
          restaurantId: restaurantA,
          spaceId: ids.a.space,
          outletId: outletA,
          platform: "swiggy",
          reportKind: "daily",
          status: "signed_out",
          requestedPeriodStart: new Date("2026-11-14T00:00:00.000Z"),
          requestedPeriodEnd: new Date("2026-11-15T00:00:00.000Z"),
          observedName: "Old outlet name",
          attemptCount: 1,
          source: "export",
          parserVersion: "test",
          runId: `profile-${suffix}`,
          capturedAt: new Date("2026-11-15T05:00:00.000Z"),
        },
      });
      await ownerDb.metricFetch.create({
        data: {
          restaurantId: restaurantA,
          spaceId: ids.a.space,
          outletId: outletA,
          platform: "zomato",
          reportKind: "daily",
          status: "stored",
          requestedPeriodStart: new Date("2026-11-14T00:00:00.000Z"),
          requestedPeriodEnd: new Date("2026-11-15T00:00:00.000Z"),
          attemptCount: 1,
          source: "export",
          parserVersion: "test",
          runId: `profile-z-${suffix}`,
          capturedAt: new Date("2026-11-15T05:00:00.000Z"),
        },
      });
    });
  });

  afterAll(async () => {
    await stop();
  });

  it("returns the current name and connection status, and no credentials", async () => {
    const response = await routes.request(`/api/v1/restaurants/${restaurantA}/profile`, {
      headers: { authorization: `Bearer ${ids.a.user}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/password|cookie|zomatoResId|swiggyRid|900001|900002/i);
    expect(body.outlets).toEqual([
      {
        id: outletA,
        name: "Indiranagar",
        city: "Bengaluru",
        connections: [
          { platform: "zomato", status: "connected" },
          { platform: "swiggy", status: "login_needs_attention" },
        ],
      },
    ]);
    expect(body.owner).toMatchObject({ name: "Ravi Kumar" });
  });

  it("hides the restaurant from another tenant", async () => {
    const listed = await routes.request("/api/v1/restaurants", {
      headers: { authorization: `Bearer ${ids.b.user}` },
    });
    const list = await listed.json();
    expect(list.restaurants.map((row: { id: string }) => row.id)).not.toContain(restaurantA);
    const response = await routes.request(`/api/v1/restaurants/${restaurantA}/profile`, {
      headers: { authorization: `Bearer ${ids.b.user}` },
    });
    expect(response.status).toBe(404);
    await expect(readOwnerProfileForMember(db, ids.b.user, restaurantA)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("does not keep a name change when an outlet id is unknown", async () => {
    const response = await routes.request(`/api/v1/restaurants/${restaurantA}/profile`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ids.a.user}`, "content-type": "application/json" },
      body: JSON.stringify({
        restaurantName: "Should not stick",
        outlets: [{ id: `missing-${suffix}`, name: "Nope", city: "Nope" }],
      }),
    });
    expect(response.status).toBe(422);
    const profile = await readOwnerProfileForMember(db, ids.a.user, restaurantA);
    expect(profile.restaurant.name).toBe("Kesar Kitchen");
  });

  it("saves a name and leaves the platform link alone", async () => {
    const response = await routes.request(`/api/v1/restaurants/${restaurantA}/profile`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ids.a.user}`, "content-type": "application/json" },
      body: JSON.stringify({
        restaurantName: "Kesar Kitchen demo",
        outlets: [{ id: outletA, name: "Indiranagar", city: "Bengaluru" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.restaurant.name).toBe("Kesar Kitchen demo");
    expect(body.outlets[0].connections[1].status).toBe("login_needs_attention");
  });
});
