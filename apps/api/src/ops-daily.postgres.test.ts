import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createOutlet,
  ensureRestaurant,
  mintAgentToken,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restaurantAgentRoutes } from "./restaurant-agent-routes.js";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("daily ops brief (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let ownerDb: PrismaClient;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  let agent: ReturnType<typeof restaurantAgentRoutes>;
  let owner: ReturnType<typeof restaurantOwnerRoutes>;
  let tokenA = "";
  let tokenB = "";
  let restaurantA = "";
  let restaurantB = "";
  let outletA = "";
  let outletB = "";
  const spaceA = `ops-a-${suffix}`;
  const spaceB = `ops-b-${suffix}`;
  const userA = `ops-user-a-${suffix}`;
  const userB = `ops-user-b-${suffix}`;

  beforeAll(async () => {
    const ownerConn = createDb(migrationUrl!);
    const app = createDb(runtimeUrl!, { poolMax: 4 });
    ownerDb = ownerConn.prisma;
    db = app.prisma;
    stop = async () => {
      await ownerConn.prisma.$disconnect();
      await ownerConn.pool.end();
      await app.prisma.$disconnect();
      await app.pool.end();
    };
    agent = restaurantAgentRoutes({
      prisma: db,
      uploadSecret: "test-upload-secret",
      publicBaseUrl: "http://127.0.0.1:3100",
    });
    owner = restaurantOwnerRoutes({
      prisma: db,
      getSession: async (headers) => {
        const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (token === userA || token === userB) return { userId: token };
        return null;
      },
    });

    await runAsSystem("ops daily fixture", async () => {
      for (const row of [
        {
          key: "a",
          org: `ops-a-org-${suffix}`,
          user: userA,
          space: spaceA,
          name: "Sample Kitchen",
        },
        { key: "b", org: `ops-b-org-${suffix}`, user: userB, space: spaceB, name: "Other Kitchen" },
      ]) {
        await ownerDb.organization.create({
          data: { id: row.org, name: row.key, slug: row.org, createdAt: new Date() },
        });
        await ownerDb.user.create({
          data: {
            id: row.user,
            name: row.key,
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
          data: {
            id: row.space,
            organizationId: row.org,
            name: row.key,
            createdByUserId: row.user,
          },
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
        const restaurant = await ensureRestaurant(ownerDb, { spaceId: row.space, name: row.name });
        if (row.key === "a") restaurantA = restaurant.id;
        else restaurantB = restaurant.id;
      }
      const outlet = await createOutlet(ownerDb, restaurantA, {
        name: "Sample Kitchen",
        city: "Testcity",
        zomatoResId: "Z-TEST-0001",
        swiggyRid: "S-TEST-0001",
      });
      outletA = outlet.id;
      const other = await createOutlet(ownerDb, restaurantB, {
        name: "Park Street",
        city: "Testcity",
        zomatoResId: "Z-TEST-0002",
        swiggyRid: "S-TEST-0002",
      });
      outletB = other.id;
      const second = await createOutlet(ownerDb, restaurantB, {
        name: "New Town",
        city: "Testcity",
        zomatoResId: "Z-TEST-0003",
        swiggyRid: "S-TEST-0003",
      });
      await seedDay(restaurantB, spaceB, outletB, "2026-02-14", 200_000, 100_000, 20);
      await seedDay(restaurantB, spaceB, outletB, "2026-02-07", 400_000, 200_000, 20);
      await seedDay(restaurantB, spaceB, second.id, "2026-02-14", 300_000, 150_000, 20);
      await seedDay(restaurantB, spaceB, second.id, "2026-02-07", 500_000, 250_000, 20);
      tokenA = await mintAgentToken(ownerDb, restaurantA, "ops");
      tokenB = await mintAgentToken(ownerDb, restaurantB, "ops");
      await seedDay(restaurantA, spaceA, outletA, "2026-03-14", 570_000, 720_000, 20);
      await seedDay(restaurantA, spaceA, outletA, "2026-03-07", 1_070_000, 663_000, 20);
      for (const platform of ["zomato", "swiggy"] as const) {
        await ownerDb.metricFetch.create({
          data: {
            restaurantId: restaurantA,
            spaceId: spaceA,
            outletId: outletA,
            platform,
            reportKind: "daily",
            status: "signed_out",
            requestedPeriodStart: new Date("2026-03-13T00:00:00.000Z"),
            requestedPeriodEnd: new Date("2026-03-14T00:00:00.000Z"),
            attemptCount: 1,
            source: "fixture",
            parserVersion: "test",
            runId: "ops-test",
            capturedAt: new Date("2026-03-14T03:00:00.000Z"),
          },
        });
      }
    });
  });

  afterAll(async () => {
    await stop();
  });

  it("runs the daily brief, keeps a re-run idempotent, and records a delivery", async () => {
    const first = await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
      kind: "daily",
      date: "2026-03-14",
      runId: "run-1",
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      reportId: string;
      version: number;
      status: string;
      deliver: { shouldNotify: boolean; reason: string };
      readiness: { ready: boolean };
      message: { text: string; chars: number };
      workbook: { available: boolean };
    };
    expect(body.status).toBe("red");
    expect(body.readiness.ready).toBe(true);
    expect(body.deliver).toEqual({ shouldNotify: true, reason: "first" });
    expect(body.workbook.available).toBe(false);
    expect(body.message.chars).toBeLessThanOrEqual(1200);
    expect(body.message.text).toContain("Zomato sales down");
    expect(body.message.text).toContain(
      "confirm the outlet was open and visible on Zomato through dinner",
    );
    expect(body.message.text).not.toMatch(/\b[A-Z0-9]{12,22}\b/);

    const again = await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
      kind: "daily",
      date: "2026-03-14",
      runId: "run-1",
    });
    const second = (await again.json()) as {
      version: number;
      deliver: { shouldNotify: boolean; reason: string };
    };
    expect(second.version).toBe(1);
    expect(second.deliver).toEqual({ shouldNotify: false, reason: "unchanged" });

    const alerts = await call(agent, "GET", "/agent/v1/ops/alerts?status=open", tokenA);
    const listed = (await alerts.json()) as {
      alerts: Array<{ id: string; occurrences: number; dedupeKey: string }>;
    };
    expect(listed.alerts.length).toBeGreaterThan(0);
    expect(listed.alerts.every((alert) => alert.occurrences === 1)).toBe(true);

    const report = await call(agent, "GET", `/agent/v1/ops/reports/${body.reportId}`, tokenA);
    expect(report.status).toBe(200);
    const stored = (await report.json()) as { text: string; outlets: Array<{ outletId: string }> };
    expect(stored.text).toContain("Zomato sales down");
    expect(stored.outlets[0]?.outletId).toBe(outletA);

    const workbook = await call(
      agent,
      "GET",
      `/agent/v1/ops/reports/${body.reportId}/workbook`,
      tokenA,
    );
    expect(workbook.status).toBe(404);

    const delivery = await call(
      agent,
      "POST",
      `/agent/v1/ops/reports/${body.reportId}/deliveries`,
      tokenA,
      {
        reportVersion: 1,
        channel: "in_app",
        status: "sent",
        runId: "run-1",
        sentAt: "2026-03-15T03:30:00.000Z",
      },
    );
    expect(delivery.status).toBe(201);
    const withDelivery = (await (
      await call(agent, "GET", `/agent/v1/ops/reports/${body.reportId}`, tokenA)
    ).json()) as {
      deliveries: Array<{ channel: string; status: string }>;
    };
    expect(withDelivery.deliveries).toEqual([
      { channel: "in_app", status: "sent", sentAt: "2026-03-15T03:30:00.000Z", reportVersion: 1 },
    ]);

    const hidden = await call(agent, "GET", `/agent/v1/ops/reports/${body.reportId}`, tokenB);
    expect(hidden.status).toBe(404);
    const otherTenant = await runAsTenant({ spaceId: spaceB, userId: userB }, () =>
      db.opsAlert.count({ where: { restaurantId: restaurantA } }),
    );
    expect(otherTenant).toBe(0);

    const feed = await call(owner, "GET", `/api/v1/restaurants/${restaurantA}/ops/feed`, userA);
    expect(feed.status).toBe(200);
    const feedBody = (await feed.json()) as { reports: Array<{ id: string }> };
    expect(feedBody.reports.map((item) => item.id)).toContain(body.reportId);
    const outsider = await call(owner, "GET", `/api/v1/restaurants/${restaurantA}/ops/feed`, userB);
    expect(outsider.status).toBe(404);
    const agentOnOwner = await call(
      owner,
      "GET",
      `/api/v1/restaurants/${restaurantA}/ops/feed`,
      tokenA,
    );
    expect(agentOnOwner.status).toBe(403);

    const alertId = listed.alerts[0]?.id ?? "";
    const proposed = await call(
      owner,
      "POST",
      `/api/v1/restaurants/${restaurantA}/ops/alerts/${alertId}/propose-action`,
      userA,
    );
    expect(proposed.status).toBe(201);
    const action = (await proposed.json()) as { actionId: string; status: string };
    expect(action.status).toBe("proposed");
    const repeat = await call(
      owner,
      "POST",
      `/api/v1/restaurants/${restaurantA}/ops/alerts/${alertId}/propose-action`,
      userA,
    );
    expect(((await repeat.json()) as { actionId: string }).actionId).toBe(action.actionId);
    const row = await runAsSystem("ops action check", () =>
      ownerDb.action.findUnique({ where: { id: action.actionId } }),
    );
    expect(row?.status).toBe("proposed");
    expect(row?.executedAt).toBeNull();
    expect(row?.type).toBe("other");

    const snoozed = await call(
      owner,
      "POST",
      `/api/v1/restaurants/${restaurantA}/ops/alerts/${alertId}/snooze`,
      userA,
      {
        days: 3,
      },
    );
    expect(snoozed.status).toBe(200);
    expect(((await snoozed.json()) as { status: string }).status).toBe("snoozed");
    const dismissed = await call(
      owner,
      "POST",
      `/api/v1/restaurants/${restaurantA}/ops/alerts/${alertId}/dismiss`,
      userA,
      {},
    );
    expect(((await dismissed.json()) as { status: string }).status).toBe("resolved");
  });

  it("reports one app down, both apps down, and a held fetch that is not retried", async () => {
    const both = await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
      kind: "daily",
      date: "2026-03-13",
      runId: "run-down",
    });
    const down = (await both.json()) as {
      readiness: { ready: boolean; blockers: Array<{ retryable: boolean; code: string }> };
      message: { text: string };
    };
    expect(both.status).toBe(200);
    expect(down.readiness.ready).toBe(false);
    expect(down.readiness.blockers.every((blocker) => blocker.retryable)).toBe(true);
    expect(down.message.text).toBe("No new data this morning; we'll update this when it lands.");

    await runAsSystem("ops hold fixture", async () => {
      for (const platform of ["zomato", "swiggy"] as const) {
        await ownerDb.fetchHold.create({
          data: {
            restaurantId: restaurantA,
            spaceId: spaceA,
            outletId: outletA,
            platform,
            reason: "identity",
          },
        });
      }
    });
    const held = await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
      kind: "daily",
      date: "2026-03-12",
      runId: "run-held",
    });
    const heldBody = (await held.json()) as {
      readiness: { ready: boolean; blockers: Array<{ code: string; retryable: boolean }> };
    };
    expect(heldBody.readiness.ready).toBe(false);
    expect(heldBody.readiness.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "fetch_held", retryable: false })]),
    );
  });

  it("rolls two outlets into one brief and lets a second run wait", async () => {
    const [left, right] = await Promise.all([
      call(agent, "POST", "/agent/v1/ops/runs", tokenB, {
        kind: "daily",
        date: "2026-02-14",
        runId: "run-left",
      }),
      call(agent, "POST", "/agent/v1/ops/runs", tokenB, {
        kind: "daily",
        date: "2026-02-14",
        runId: "run-right",
      }),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const body = (await left.json()) as { reportId: string; message: { text: string } };
    expect(body.message.text).toContain("Zomato ₹5,000");
    const stored = (await (
      await call(agent, "GET", `/agent/v1/ops/reports/${body.reportId}`, tokenB)
    ).json()) as {
      restaurant: {
        metrics: {
          zomato: Array<{ key: string; value: number }>;
          swiggy: Array<{ key: string; value: number }>;
        };
      } | null;
      outlets: Array<{ outletId: string }>;
    };
    expect(stored.outlets).toHaveLength(2);
    expect(
      stored.restaurant?.metrics.zomato.find((cell) => cell.key === "ops_sales_paise")?.value,
    ).toBe(500_000);
    expect(
      stored.restaurant?.metrics.swiggy.find((cell) => cell.key === "swiggy_net_sales_paise")
        ?.value,
    ).toBe(250_000);
    const alerts = (await (
      await call(agent, "GET", "/agent/v1/ops/alerts?status=open", tokenB)
    ).json()) as { alerts: Array<{ occurrences: number }> };
    expect(alerts.alerts.length).toBeGreaterThan(0);
    expect(alerts.alerts.every((alert) => alert.occurrences === 1)).toBe(true);
    const opened = await runAsSystem("ops overlap check", () =>
      ownerDb.opsAlertEvent.count({
        where: { restaurantId: restaurantB, kind: "opened" },
      }),
    );
    expect(opened).toBe(alerts.alerts.length);
  });

  it("rejects a weekly run, a bad date, and a day that is not finished", async () => {
    expect(
      (
        await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
          kind: "weekly",
          weekStart: "2026-03-09",
          runId: "w",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
          kind: "payout_check",
          runId: "p",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
          kind: "daily",
          date: "2026-02-31",
          runId: "bad",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(agent, "POST", "/agent/v1/ops/runs", tokenA, {
          kind: "daily",
          date: "2099-01-01",
          runId: "future",
        })
      ).status,
    ).toBe(409);
  });

  async function seedDay(
    restaurantId: string,
    spaceId: string,
    outletId: string,
    date: string,
    zomatoPaise: number,
    swiggyPaise: number,
    delivered: number,
  ) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = [
      ["zomato", "ops_sales_paise", zomatoPaise],
      ["zomato", "delivered_orders", delivered],
      ["swiggy", "swiggy_net_sales_paise", swiggyPaise],
      ["swiggy", "delivered_orders", delivered],
    ] as const;
    for (const [platform, key, value] of rows) {
      await ownerDb.metricValue.create({
        data: {
          restaurantId,
          spaceId,
          outletId,
          platform,
          granularity: "day",
          periodStart: start,
          periodEnd: end,
          key,
          value,
          runId: "ops-test",
          source: "fixture",
          capturedAt: new Date("2026-03-15T00:18:00.000Z"),
        },
      });
    }
  }
});

async function call(
  app: { request: (input: string, init?: RequestInit) => Promise<Response> | Response },
  method: string,
  path: string,
  token: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
