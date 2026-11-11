import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createOutlet, ensureRestaurant, mintAgentToken } from "./restaurant-agent.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("restaurant tables are tenant scoped (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;
  const ids = {
    a: { org: `iso-a-org-${suffix}`, user: `iso-a-user-${suffix}`, space: `iso-a-${suffix}` },
    b: { org: `iso-b-org-${suffix}`, user: `iso-b-user-${suffix}`, space: `iso-b-${suffix}` },
  };
  let restaurantA = "";
  let outletB = "";

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    const o = owner.prisma;
    await runAsSystem("restaurant isolation fixture", async () => {
      for (const key of ["a", "b"] as const) {
        const row = ids[key];
        await o.organization.create({
          data: { id: row.org, name: key, slug: row.org, createdAt: new Date() },
        });
        await o.user.create({
          data: {
            id: row.user,
            name: key,
            email: `${row.user}@ecomnomics.test`,
            emailVerified: true,
          },
        });
        await o.member.create({
          data: {
            id: `${row.user}-member`,
            organizationId: row.org,
            userId: row.user,
            role: "owner",
            createdAt: new Date(),
          },
        });
        await o.space.create({
          data: { id: row.space, organizationId: row.org, name: key, createdByUserId: row.user },
        });
        await o.spaceMember.create({
          data: {
            id: `${row.user}-space`,
            spaceId: row.space,
            userId: row.user,
            organizationId: row.org,
            role: "owner",
            createdAt: new Date(),
          },
        });
        const restaurant = await ensureRestaurant(o, {
          spaceId: row.space,
          name: `Kitchen ${key}`,
        });
        await createOutlet(o, restaurant.id, { name: key, city: "Bengaluru" });
        if (key === "a") restaurantA = restaurant.id;
      }
      const other = await o.restaurant.findFirst({
        where: { spaceId: ids.b.space },
        select: { id: true },
      });
      const outlet = await o.outlet.findFirst({
        where: { restaurantId: other!.id },
        select: { id: true },
      });
      outletB = outlet!.id;
      await mintAgentToken(o, restaurantA);
      await o.jobRun.create({
        data: {
          restaurantId: restaurantA,
          spaceId: ids.a.space,
          runId: `iso-${suffix}`,
          skill: "payout",
          status: "running",
          startedAt: new Date(),
        },
      });
      const outletA = await o.outlet.findFirst({
        where: { restaurantId: restaurantA },
        select: { id: true },
      });
      await o.metricValue.create({
        data: {
          restaurantId: restaurantA,
          spaceId: ids.a.space,
          outletId: outletA!.id,
          platform: "zomato",
          granularity: "day",
          periodStart: new Date("2026-01-06T00:00:00.000Z"),
          periodEnd: new Date("2026-01-07T00:00:00.000Z"),
          key: "orders",
          value: 3,
          runId: "iso",
          source: "test",
          capturedAt: new Date(),
        },
      });
      await o.report.create({
        data: {
          restaurantId: restaurantA,
          spaceId: ids.a.space,
          type: "weekly",
          periodStart: new Date("2026-01-05T00:00:00.000Z"),
          periodEnd: new Date("2026-01-12T00:00:00.000Z"),
          summaryMarkdown: "ok",
        },
      });
      await o.action.create({
        data: {
          restaurantId: restaurantA,
          spaceId: ids.a.space,
          platform: "zomato",
          type: "other",
          title: "Look",
          details: {},
        },
      });
    });
  });

  afterAll(async () => {
    await runAsSystem("restaurant isolation cleanup", async () => {
      await owner.prisma.organization.deleteMany({ where: { id: { in: [ids.a.org, ids.b.org] } } });
      await owner.prisma.user.deleteMany({ where: { id: { in: [ids.a.user, ids.b.user] } } });
    });
    await owner.prisma.$disconnect();
    await owner.pool.end();
    await app.prisma.$disconnect();
    await app.pool.end();
  });

  const asA = <T>(fn: () => Promise<T>) =>
    runAsTenant({ spaceId: ids.a.space, userId: ids.a.user }, fn);
  const asB = <T>(fn: () => Promise<T>) =>
    runAsTenant({ spaceId: ids.b.space, userId: ids.b.user }, fn);

  it("lets a restaurant read its own rows and not the other restaurant", async () => {
    expect(await asA(() => db.restaurant.count())).toBe(1);
    expect(await asB(() => db.restaurant.findMany({ where: { id: restaurantA } }))).toEqual([]);
    expect(await asB(() => db.outlet.count({ where: { restaurantId: restaurantA } }))).toBe(0);
    expect(await asB(() => db.metricValue.count())).toBe(0);
    expect(await asB(() => db.report.count())).toBe(0);
    expect(await asB(() => db.action.count())).toBe(0);
    expect(await asB(() => db.jobRun.count())).toBe(0);
    expect(await asB(() => db.agentToken.count())).toBe(0);
    expect(await asA(() => db.metricValue.count())).toBe(1);
    expect(await asA(() => db.agentToken.count())).toBe(1);
  });

  it("refuses a metric written against another restaurant's outlet", async () => {
    await expect(
      asB(() =>
        db.metricValue.create({
          data: {
            restaurantId: restaurantA,
            spaceId: ids.b.space,
            outletId: outletB,
            platform: "zomato",
            granularity: "day",
            periodStart: new Date("2026-02-01T00:00:00.000Z"),
            periodEnd: new Date("2026-02-02T00:00:00.000Z"),
            key: "orders",
            value: 1,
            runId: "nope",
            source: "test",
            capturedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("hides the admin audit log from the app login, including in system scope", async () => {
    await expect(asA(() => db.adminAuditLog.findMany())).rejects.toThrow();
    await expect(
      runAsSystem("should not read the audit log", () => db.adminAuditLog.findMany()),
    ).rejects.toThrow();
  });
});
