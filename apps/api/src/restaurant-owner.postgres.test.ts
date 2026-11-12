import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createOutlet,
  ensureRestaurant,
  readOwnerMetrics,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("owner metrics read (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let ownerDb: PrismaClient;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  let routes: ReturnType<typeof restaurantOwnerRoutes>;
  const ids = {
    a: { org: `own-a-org-${suffix}`, user: `own-a-user-${suffix}`, space: `own-a-${suffix}` },
    b: { org: `own-b-org-${suffix}`, user: `own-b-user-${suffix}`, space: `own-b-${suffix}` },
  };
  let restaurantA = "";
  let restaurantB = "";
  let outletA1 = "";
  let outletA2 = "";
  let outletB = "";

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

    await runAsSystem("owner metrics fixture", async () => {
      for (const key of ["a", "b"] as const) {
        const row = ids[key];
        await ownerDb.organization.create({
          data: { id: row.org, name: key, slug: row.org, createdAt: new Date() },
        });
        await ownerDb.user.create({
          data: {
            id: row.user,
            name: key,
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
          name: key === "a" ? "North Kitchen" : "Other Kitchen",
        });
        if (key === "a") restaurantA = restaurant.id;
        else restaurantB = restaurant.id;
      }
      const first = await createOutlet(ownerDb, restaurantA, {
        name: "North",
        city: "Testcity",
        swiggyRid: "900001",
        zomatoResId: "900002",
      });
      const second = await createOutlet(ownerDb, restaurantA, {
        name: "South",
        city: "Testcity",
      });
      const other = await createOutlet(ownerDb, restaurantB, {
        name: "Other",
        city: "Testcity",
        swiggyRid: "900001",
        zomatoResId: "900002",
      });
      outletA1 = first.id;
      outletA2 = second.id;
      outletB = other.id;

      await ownerDb.$executeRaw`
        INSERT INTO "restaurant_metric_values" (
          "id", "restaurantId", "spaceId", "outletId", "platform", "granularity",
          "periodStart", "periodEnd", "key", "value", "runId", "source", "capturedAt",
          "rowRole", "createdAt", "updatedAt"
        )
        SELECT
          'om-' || ${suffix} || '-' || o.slot::text || '-' || p.platform || '-' || k.key || '-' || d.n::text,
          ${restaurantA},
          ${ids.a.space},
          CASE o.slot WHEN 1 THEN ${outletA1} ELSE ${outletA2} END,
          p.platform,
          'day',
          ((DATE '2025-01-01' + d.n)::timestamp AT TIME ZONE 'UTC'),
          ((DATE '2025-01-01' + d.n + 1)::timestamp AT TIME ZONE 'UTC'),
          k.key,
          CASE k.key WHEN 'delivered_orders' THEN 1 ELSE 100 END,
          'owner-read',
          'fixture',
          NOW(),
          'fact',
          NOW(),
          NOW()
        FROM generate_series(0, 399) AS d(n)
        CROSS JOIN (VALUES (1), (2)) AS o(slot)
        CROSS JOIN (VALUES ('zomato'::text), ('swiggy')) AS p(platform)
        CROSS JOIN (VALUES ('delivered_orders'::text), ('gross_sales_paise')) AS k(key)
      `;
      await ownerDb.$executeRaw`
        INSERT INTO "metric_fetches" (
          "id", "restaurantId", "spaceId", "outletId", "platform", "reportKind", "status",
          "requestedPeriodStart", "requestedPeriodEnd", "sha256", "attemptCount", "source",
          "parserVersion", "runId", "capturedAt", "createdAt"
        )
        SELECT
          'of-' || ${suffix} || '-' || o.slot::text || '-' || p.platform,
          ${restaurantA},
          ${ids.a.space},
          CASE o.slot WHEN 1 THEN ${outletA1} ELSE ${outletA2} END,
          p.platform,
          'daily',
          'stored',
          (TIMESTAMP '2025-01-01' AT TIME ZONE 'UTC'),
          (TIMESTAMP '2026-02-05' AT TIME ZONE 'UTC'),
          'abc',
          1,
          'fixture',
          'test',
          'owner-read',
          NOW(),
          NOW()
        FROM (VALUES (1), (2)) AS o(slot)
        CROSS JOIN (VALUES ('zomato'::text), ('swiggy')) AS p(platform)
      `;
      await ownerDb.metricValue.create({
        data: {
          restaurantId: restaurantB,
          spaceId: ids.b.space,
          outletId: outletB,
          platform: "zomato",
          granularity: "day",
          periodStart: new Date("2025-06-01T00:00:00.000Z"),
          periodEnd: new Date("2025-06-02T00:00:00.000Z"),
          key: "delivered_orders",
          value: 999,
          runId: "other",
          source: "fixture",
          capturedAt: new Date(),
        },
      });
    });
  });

  afterAll(async () => {
    await runAsSystem("owner metrics cleanup", async () => {
      await ownerDb.organization.deleteMany({
        where: { id: { in: [ids.a.org, ids.b.org] } },
      });
      await ownerDb.user.deleteMany({ where: { id: { in: [ids.a.user, ids.b.user] } } });
    });
    await stop();
  });

  const path = (restaurantId: string, extra = "") =>
    `/api/v1/restaurants/${restaurantId}/metrics?platform=all&from=2025-01-01&to=2026-02-05&basis=order_date&keys=delivered_orders&keys=gross_sales_paise${extra}`;

  async function call(restaurantId: string, user: string, extra = "") {
    return routes.request(path(restaurantId, extra), {
      headers: { authorization: `Bearer ${user}` },
    });
  }

  it("does not let one restaurant's owner read another, even by outlet id", async () => {
    const missing = await call(restaurantB, ids.a.user);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: string };
    expect(body.error).toBe("Restaurant not found.");

    const guessed = await call(restaurantA, ids.a.user, `&outletIds=${outletB}`);
    expect(guessed.status).toBe(422);
    const guessBody = (await guessed.json()) as { error: string };
    expect(guessBody.error).toBe("Outlet is not part of this restaurant.");
    expect(JSON.stringify(guessBody)).not.toContain("999");

    const own = await call(restaurantA, ids.a.user);
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as {
      values: Array<{ key: string; platform: string; value: number }>;
    };
    expect(ownBody.values.find((value) => value.key === "delivered_orders")?.value).toBe(1600);
    expect(JSON.stringify(ownBody)).not.toContain("999");
  });

  it("reads two outlets, two platforms, and 400 days in under 300 ms", async () => {
    const query = {
      platform: "all" as const,
      from: "2025-01-01",
      to: "2026-02-05",
      keys: ["delivered_orders", "gross_sales_paise"],
      basis: "order_date" as const,
      likeForLike: false,
      grain: "day" as const,
    };
    const scope = { restaurantId: restaurantA, spaceId: ids.a.space };
    await runAsTenant({ spaceId: ids.a.space, userId: ids.a.user }, () =>
      readOwnerMetrics(db, scope, query),
    );
    const started = performance.now();
    const result = await runAsTenant({ spaceId: ids.a.space, userId: ids.a.user }, () =>
      readOwnerMetrics(db, scope, query),
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(300);
    expect(result.values.find((value) => value.key === "delivered_orders")).toMatchObject({
      platform: "all",
      value: 1600,
      coverageDays: 400,
      expectedDays: 400,
      missingDates: [],
    });
    expect(result.values.find((value) => value.key === "gross_sales_paise")?.value).toBe(160_000);
    expect(result.series).toHaveLength(400);
    expect(result.note).toBeNull();
  });
});
