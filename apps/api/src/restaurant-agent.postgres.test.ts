import { readFile } from "node:fs/promises";
import type { ObjectStorage } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createOutlet,
  ensureRestaurant,
  hashAgentToken,
  mintAgentToken,
  revokeAgentTokens,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restaurantAgentRoutes } from "./restaurant-agent-routes.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.objects.set(key, bytes);
  }

  async *get(key: string): AsyncIterable<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("missing");
    yield bytes;
  }

  async *list(): AsyncIterable<{ key: string; lastModified: Date }> {}

  async delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

describePostgres("restaurant agent API (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const storage = new MemoryStorage();
  let ownerDb: PrismaClient;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  let routes: ReturnType<typeof restaurantAgentRoutes>;
  let tokenA = "";
  let tokenB = "";
  let outletA = "";
  let outletB = "";
  let bareOutlet = "";
  let approvalMessage = "";
  let botMessage = "";
  let outsiderMessage = "";
  let otherMessage = "";
  const spaceA = `m0-a-${suffix}`;
  const userA = `m0-user-a-${suffix}`;

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
    routes = restaurantAgentRoutes({
      prisma: db,
      uploadSecret: "test-upload-secret",
      publicBaseUrl: "http://127.0.0.1:3100",
      objectStorage: storage,
    });

    await runAsSystem("restaurant agent fixture", async () => {
      for (const key of ["a", "b"] as const) {
        const organizationId = `m0-${key}-org-${suffix}`;
        const userId = `m0-user-${key}-${suffix}`;
        const spaceId = `m0-${key}-${suffix}`;
        await ownerDb.organization.create({
          data: { id: organizationId, name: key, slug: organizationId, createdAt: new Date() },
        });
        await ownerDb.user.create({
          data: { id: userId, name: key, email: `${userId}@ecomnomics.test`, emailVerified: true },
        });
        await ownerDb.member.create({
          data: {
            id: `${userId}-member`,
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
        await ownerDb.space.create({
          data: { id: spaceId, organizationId, name: key, createdByUserId: userId },
        });
        await ownerDb.spaceMember.create({
          data: {
            id: `${userId}-space`,
            spaceId,
            userId,
            organizationId,
            role: "owner",
            createdAt: new Date(),
          },
        });
        await ownerDb.bot.create({
          data: { id: `m0-bot-${key}-${suffix}`, spaceId, userId, name: key, color: "#111111" },
        });
        await ownerDb.thread.create({
          data: {
            id: `m0-thread-${key}-${suffix}`,
            spaceId,
            userId,
            botId: `m0-bot-${key}-${suffix}`,
          },
        });
      }
      const userMessage = await ownerDb.message.create({
        data: {
          threadId: `m0-thread-a-${suffix}`,
          seq: 1,
          role: "user",
          blocks: [{ text: "yes" }],
        },
      });
      const fromBot = await ownerDb.message.create({
        data: {
          threadId: `m0-thread-a-${suffix}`,
          seq: 2,
          role: "bot",
          botId: `m0-bot-a-${suffix}`,
          blocks: [{ text: "no" }],
        },
      });
      const fromOther = await ownerDb.message.create({
        data: {
          threadId: `m0-thread-b-${suffix}`,
          seq: 1,
          role: "user",
          blocks: [{ text: "other" }],
        },
      });
      approvalMessage = userMessage.id;
      botMessage = fromBot.id;
      otherMessage = fromOther.id;

      const outsiderId = `m0-outsider-${suffix}`;
      await ownerDb.user.create({
        data: {
          id: outsiderId,
          name: "outsider",
          email: `${outsiderId}@ecomnomics.test`,
          emailVerified: true,
        },
      });
      await ownerDb.bot.create({
        data: {
          id: `m0-out-bot-${suffix}`,
          spaceId: spaceA,
          userId: outsiderId,
          name: "out",
          color: "#222222",
        },
      });
      await ownerDb.thread.create({
        data: {
          id: `m0-out-thread-${suffix}`,
          spaceId: spaceA,
          userId: outsiderId,
          botId: `m0-out-bot-${suffix}`,
        },
      });
      const outsider = await ownerDb.message.create({
        data: {
          threadId: `m0-out-thread-${suffix}`,
          seq: 1,
          role: "user",
          blocks: [{ text: "not a member" }],
        },
      });
      outsiderMessage = outsider.id;

      const restaurantA = await ensureRestaurant(ownerDb, { spaceId: spaceA, name: "Kitchen A" });
      const restaurantB = await ensureRestaurant(ownerDb, {
        spaceId: `m0-b-${suffix}`,
        name: "Kitchen B",
      });
      const first = await createOutlet(ownerDb, restaurantA.id, {
        name: "Indiranagar",
        city: "Bengaluru",
        zomatoResId: "z-1",
        zomatoCommissionPct: 18.5,
        swiggyRid: "s-1",
        swiggyCommissionPct: 20,
      });
      const bare = await createOutlet(ownerDb, restaurantA.id, { name: "Bare", city: "Pune" });
      const second = await createOutlet(ownerDb, restaurantB.id, {
        name: "Other",
        city: "Mumbai",
        zomatoResId: "z-2",
      });
      outletA = first.id;
      bareOutlet = bare.id;
      outletB = second.id;
      tokenA = await mintAgentToken(ownerDb, restaurantA.id);
      tokenB = await mintAgentToken(ownerDb, restaurantB.id);
    });
  });

  afterAll(async () => {
    await runAsSystem("restaurant agent cleanup", async () => {
      await ownerDb.organization.deleteMany({
        where: { id: { in: [`m0-a-org-${suffix}`, `m0-b-org-${suffix}`] } },
      });
      await ownerDb.user.deleteMany({
        where: { id: { in: [userA, `m0-user-b-${suffix}`, `m0-outsider-${suffix}`] } },
      });
    });
    await stop();
  });

  function call(method: string, path: string, token: string, body?: unknown) {
    return routes.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const metricRow = (outletId: string, key: string, value: number | boolean | null) => ({
    outletId,
    platform: "zomato",
    granularity: "day",
    periodStart: "2026-01-06T00:00:00.000+05:30",
    periodEnd: "2026-01-07T00:00:00.000+05:30",
    key,
    value,
  });

  it("rejects a missing, wrong, or revoked token the same way", async () => {
    expect((await call("GET", "/agent/v1/restaurant", "")).status).toBe(401);
    expect((await call("GET", "/agent/v1/restaurant", "ecom_agent_nope")).status).toBe(401);
    const hash = hashAgentToken(tokenB);
    const row = await runAsSystem("find token", () =>
      db.agentToken.findFirst({ where: { tokenHash: hash }, select: { restaurantId: true } }),
    );
    await revokeAgentTokens(db, row!.restaurantId);
    expect((await call("GET", "/agent/v1/restaurant", tokenB)).status).toBe(401);
    tokenB = await mintAgentToken(db, row!.restaurantId);
  });

  it("returns only this restaurant's outlets", async () => {
    const response = await call("GET", "/agent/v1/restaurant", tokenA);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      name: string;
      timezone: string;
      outlets: Array<{
        outletId: string;
        zomato: { resId: string; commissionPct: number | null } | null;
        swiggy: { rid: string; commissionPct: number | null } | null;
      }>;
    };
    expect(body.name).toBe("Kitchen A");
    expect(body.timezone).toBe("Asia/Kolkata");
    const withPlatforms = body.outlets.find((outlet) => outlet.outletId === outletA);
    const bare = body.outlets.find((outlet) => outlet.outletId === bareOutlet);
    expect(withPlatforms?.zomato).toEqual({ resId: "z-1", commissionPct: 18.5 });
    expect(withPlatforms?.swiggy).toEqual({ rid: "s-1", commissionPct: 20 });
    expect(bare?.zomato).toBeNull();
    expect(bare?.swiggy).toBeNull();
    expect(body.outlets.map((outlet) => outlet.outletId)).not.toContain(outletB);
  });

  it("upserts metrics and rejects another restaurant's outlet", async () => {
    const first = await call("PUT", "/agent/v1/metrics", tokenA, {
      runId: "metrics-1",
      source: "export",
      capturedAt: "2026-01-07T05:00:00.000Z",
      rows: [metricRow(outletA, "delivered_orders", 4)],
    });
    expect(first.status).toBe(200);
    const second = await call("PUT", "/agent/v1/metrics", tokenA, {
      runId: "metrics-1",
      source: "export",
      capturedAt: "2026-01-07T06:00:00.000Z",
      rows: [metricRow(outletA, "delivered_orders", 9)],
    });
    expect(await second.json()).toEqual({ upserted: 1 });
    const rows = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricValue.findMany({ where: { outletId: outletA, key: "delivered_orders" } }),
    );
    const current = rows.filter((row) => row.supersededAt == null);
    const previous = rows.filter((row) => row.supersededAt != null);
    expect(current).toHaveLength(1);
    expect(previous).toHaveLength(1);
    expect(Number(current[0]?.value?.toString())).toBe(9);
    expect(Number(previous[0]?.value?.toString())).toBe(4);
    expect(current[0]?.periodStart.toISOString()).toBe("2026-01-06T00:00:00.000Z");
    expect(current[0]?.periodEnd.toISOString()).toBe("2026-01-07T00:00:00.000Z");

    await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricValue.create({
        data: {
          restaurantId: current[0]!.restaurantId,
          spaceId: spaceA,
          outletId: outletA,
          platform: "zomato",
          granularity: "day",
          periodStart: new Date("2026-01-08T00:00:00.000+05:30"),
          periodEnd: new Date("2026-01-09T00:00:00.000+05:30"),
          key: "delivered_orders",
          value: 3,
          runId: "legacy-ist",
          source: "export",
          capturedAt: new Date("2026-01-09T05:00:00.000Z"),
        },
      }),
    );
    const readDay = async (from: string, to: string) => {
      const response = await call(
        "GET",
        `/agent/v1/metrics?outletId=${outletA}&platform=zomato&from=${from}&to=${to}`,
        tokenA,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        values: Array<{ key: string; value: number | null }>;
      };
      return body.values.find((value) => value.key === "delivered_orders")?.value;
    };
    expect(await readDay("2026-01-06", "2026-01-07")).toBe(9);
    expect(await readDay("2026-01-07", "2026-01-08")).toBeNull();
    expect(await readDay("2026-01-08", "2026-01-09")).toBe(3);

    const foreign = await call("PUT", "/agent/v1/metrics", tokenA, {
      runId: "metrics-2",
      source: "export",
      capturedAt: "2026-01-07T05:00:00.000Z",
      rows: [metricRow(outletB, "delivered_orders", 1)],
    });
    expect(foreign.status).toBe(422);
    expect(await foreign.json()).toEqual({
      error: "Outlet is not part of this restaurant.",
      code: "unknown_outlet",
    });
    const hidden = await runAsTenant(
      { spaceId: `m0-b-${suffix}`, userId: `m0-user-b-${suffix}` },
      () => db.metricValue.count({ where: { outletId: outletA } }),
    );
    expect(hidden).toBe(0);
  });

  it("stores a missing figure as null and a lag banner as a boolean", async () => {
    const response = await call("PUT", "/agent/v1/metrics", tokenA, {
      runId: "metrics-null",
      source: "export",
      capturedAt: "2026-01-07T05:00:00.000Z",
      rows: [
        metricRow(outletA, "lost_sales_paise", null),
        metricRow(outletA, "lag_banner", true),
        metricRow(outletA, "kpt_minutes", 16.5),
      ],
    });
    expect(response.status).toBe(200);
    const rows = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricValue.findMany({
        where: {
          outletId: outletA,
          key: { in: ["lost_sales_paise", "lag_banner", "kpt_minutes"] },
        },
      }),
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("lost_sales_paise")?.value).toBeNull();
    expect(byKey.get("lost_sales_paise")?.valueBoolean).toBeNull();
    expect(byKey.get("lag_banner")?.value).toBeNull();
    expect(byKey.get("lag_banner")?.valueBoolean).toBe(true);
    expect(Number(byKey.get("kpt_minutes")?.value?.toString())).toBe(16.5);

    const rejected = await call("PUT", "/agent/v1/metrics", tokenA, {
      runId: "metrics-unit",
      source: "export",
      capturedAt: "2026-01-07T05:00:00.000Z",
      rows: [metricRow(outletA, "kpt_minutes", 16.55)],
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe("invalid_body");
    const banner = await call("PUT", "/agent/v1/metrics", tokenA, {
      runId: "metrics-banner",
      source: "export",
      capturedAt: "2026-01-07T05:00:00.000Z",
      rows: [metricRow(outletA, "lag_banner", 1)],
    });
    expect(banner.status).toBe(400);
  });

  it("rejects an unknown metric key and writes nothing", async () => {
    const before = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricValue.count(),
    );
    const response = await call("PUT", "/agent/v1/metrics", tokenA, {
      runId: "metrics-3",
      source: "export",
      capturedAt: "2026-01-07T05:00:00.000Z",
      rows: [metricRow(outletA, "tips", 1), metricRow(outletA, "delivered_orders", 1)],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("unknown_metric_key");
    expect(body.error).toContain('"tips"');
    expect(body.error).toContain("gross_sales_paise");
    const after = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricValue.count(),
    );
    expect(after).toBe(before);
  });

  it("requires a person's message before an action can run", async () => {
    const created = await call("POST", "/agent/v1/actions", tokenA, {
      outletId: outletA,
      platform: "zomato",
      type: "discount",
      title: "Lunch",
      details: { percent: 10 },
      estCostPaise: 500,
      chatMessageId: approvalMessage,
      clientNonce: `lunch-${suffix}`,
    });
    expect(created.status).toBe(201);
    const action = (await created.json()) as { actionId: string; status: string };
    expect(action.status).toBe("proposed");
    const foreignMessage = await call("POST", "/agent/v1/actions", tokenA, {
      outletId: null,
      platform: "zomato",
      type: "other",
      title: "Elsewhere",
      details: {},
      estCostPaise: null,
      chatMessageId: otherMessage,
    });
    expect(foreignMessage.status).toBe(422);

    const skip = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "executing",
    });
    expect((await skip.json()) as { code: string }).toMatchObject({ code: "invalid_transition" });

    const bot = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "approved",
      approvedByMessageId: botMessage,
    });
    expect(bot.status).toBe(409);
    const outsider = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "approved",
      approvedByMessageId: outsiderMessage,
    });
    expect(outsider.status).toBe(409);
    const other = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "approved",
      approvedByMessageId: otherMessage,
    });
    expect((await other.json()) as { code: string }).toMatchObject({ code: "approval_required" });

    const approved = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "approved",
      approvedByMessageId: approvalMessage,
    });
    expect(approved.status).toBe(200);
    const executing = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "executing",
    });
    expect((await executing.json()) as { status: string }).toMatchObject({ status: "executing" });
    const executed = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "executed",
      result: { applied: true },
    });
    expect((await executed.json()) as { status: string }).toMatchObject({ status: "executed" });

    const foreign = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenB, {
      status: "reverted",
    });
    expect(foreign.status).toBe(404);
  });

  it("lets only one of two overlapping status changes win", async () => {
    const created = await call("POST", "/agent/v1/actions", tokenA, {
      outletId: null,
      platform: "swiggy",
      type: "other",
      title: "Race",
      details: {},
      estCostPaise: null,
      chatMessageId: null,
      clientNonce: `race-${suffix}`,
    });
    const action = (await created.json()) as { actionId: string };
    const approved = await call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, {
      status: "approved",
      approvedByMessageId: approvalMessage,
    });
    expect(approved.status).toBe(200);
    const [rejected, executing] = await Promise.all([
      call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, { status: "rejected" }),
      call("PATCH", `/agent/v1/actions/${action.actionId}`, tokenA, { status: "executing" }),
    ]);
    const statuses = [rejected.status, executing.status].sort();
    expect(statuses).toEqual([200, 409]);
    const stored = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.action.findFirst({ where: { id: action.actionId }, select: { status: true } }),
    );
    expect(stored?.status === "rejected" || stored?.status === "executing").toBe(true);
  });

  it("stores a report file behind the signed upload link", async () => {
    const created = await call("POST", "/agent/v1/reports", tokenA, {
      type: "weekly",
      outletId: null,
      periodStart: "2026-01-05T00:00:00.000Z",
      periodEnd: "2026-01-12T00:00:00.000Z",
      status: "green",
      summaryMarkdown: "ok",
      files: [{ name: "payout.csv", contentType: "text/csv" }],
      clientNonce: `report-${suffix}`,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      reportId: string;
      uploads: Array<{ uploadUrl: string }>;
    };
    const upload = new URL(body.uploads[0]!.uploadUrl);
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    const put = await routes.request(`${upload.pathname}${upload.search}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${tokenA}` },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const stored = [...storage.objects.entries()].find(([key]) => key.includes(body.reportId));
    expect(new TextDecoder().decode(stored?.[1])).toBe("a,b\n1,2\n");

    const again = await call("POST", "/agent/v1/reports", tokenA, {
      type: "weekly",
      outletId: null,
      periodStart: "2026-01-05T00:00:00.000Z",
      periodEnd: "2026-01-12T00:00:00.000Z",
      status: "green",
      summaryMarkdown: "ok",
      files: [{ name: "payout.csv", contentType: "text/csv" }],
      clientNonce: `report-${suffix}`,
    });
    expect(((await again.json()) as { reportId: string }).reportId).toBe(body.reportId);
  });

  it("keeps the first start time and the three cost figures", async () => {
    const started = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-${suffix}`,
      skill: "payout",
      status: "running",
      startedAt: "2026-01-07T04:00:00.000Z",
      outletId: outletA,
    });
    expect(started.status).toBe(200);
    const missing = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-${suffix}`,
      skill: "payout",
      status: "succeeded",
      startedAt: "2026-01-07T04:00:00.000Z",
      endedAt: "2026-01-07T04:10:00.000Z",
      costPaise: 420,
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("costUsdMicros");
    const finished = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-${suffix}`,
      skill: "payout",
      status: "succeeded",
      startedAt: "2026-01-07T04:05:00.000Z",
      endedAt: "2026-01-07T04:10:00.000Z",
      costPaise: 420,
      costUsdMicros: 5000,
      fxRate: 84.125,
      model: "example-model",
    });
    expect(finished.status).toBe(200);
    const body = (await finished.json()) as {
      startedAt: string;
      costPaise: number;
      costUsdMicros: number;
      fxRate: number;
      status: string;
    };
    expect(body.startedAt.startsWith("2026-01-07T04:00:00")).toBe(true);
    expect(body.costPaise).toBe(420);
    expect(body.costUsdMicros).toBe(5000);
    expect(body.fxRate).toBe(84.125);
    expect(body.status).toBe("succeeded");

    const zero = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-zero-${suffix}`,
      skill: "payout",
      status: "needs_owner",
      startedAt: "2026-01-07T04:00:00.000Z",
      costPaise: 0,
      costUsdMicros: 0,
      fxRate: 83,
      error: "waiting for a code",
    });
    expect((await zero.json()) as { status: string; costPaise: number }).toMatchObject({
      status: "needs_owner",
      costPaise: 0,
    });

    const foreign = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-foreign-${suffix}`,
      skill: "payout",
      status: "running",
      startedAt: "2026-01-07T04:00:00.000Z",
      outletId: outletB,
    });
    expect(foreign.status).toBe(422);
  });

  it("requires startedAt on the first post and keeps it when a repeat omits it", async () => {
    const missing = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-nostart-${suffix}`,
      skill: "payout-zomato",
      status: "running",
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "startedAt is required the first time a run is posted.",
      code: "invalid_body",
    });

    const started = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-repeat-${suffix}`,
      skill: "payout-zomato",
      status: "running",
      startedAt: "2026-01-07T04:00:00.000Z",
    });
    expect(started.status).toBe(200);

    const finished = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-repeat-${suffix}`,
      skill: "payout-zomato",
      status: "succeeded",
      endedAt: "2026-01-07T04:10:00.000Z",
      outletId: outletA,
      error: null,
    });
    expect(finished.status).toBe(200);
    const body = (await finished.json()) as {
      startedAt: string;
      endedAt: string;
      status: string;
      outletId: string;
      error: string | null;
    };
    expect(body.startedAt.startsWith("2026-01-07T04:00:00")).toBe(true);
    expect(body.endedAt.startsWith("2026-01-07T04:10:00")).toBe(true);
    expect(body.status).toBe("succeeded");
    expect(body.outletId).toBe(outletA);
    expect(body.error).toBeNull();

    const early = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-repeat-${suffix}`,
      skill: "payout-zomato",
      status: "failed",
      endedAt: "2026-01-07T03:00:00.000Z",
      error: "too early",
    });
    expect(early.status).toBe(400);
    expect(((await early.json()) as { code: string }).code).toBe("invalid_body");
    const still = await call("POST", "/agent/v1/runs", tokenA, {
      runId: `job-repeat-${suffix}`,
      skill: "payout-zomato",
      status: "succeeded",
      endedAt: "2026-01-07T04:10:00.000Z",
    });
    expect(await still.json()).toMatchObject({ status: "succeeded", error: null });
  });

  it("stores payout orders, rejects a wrong outlet, and keeps the last four of the UTR", async () => {
    const previousSalt = process.env.CUSTOMER_HASH_SALT;
    process.env.CUSTOMER_HASH_SALT = "fixture-salt";
    try {
      const parent = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.outlet.findFirst({ where: { id: outletA }, select: { restaurantId: true } }),
      );
      const outlet = await createOutlet(ownerDb, parent?.restaurantId ?? "", {
        name: "Test Kitchen",
        city: "Testcity",
        zomatoResId: "900002",
        swiggyRid: "900001",
      });
      const file = async (name: string) =>
        Buffer.from(
          await readFile(
            new URL(`../../../packages/contracts/fixtures/payouts/${name}`, import.meta.url),
          ),
        ).toString("base64");
      const post = (platform: string, periodStart: string, periodEnd: string, fileBase64: string) =>
        call("POST", "/agent/v1/payout-reports", tokenA, {
          outletId: outlet.id,
          platform,
          periodStart,
          periodEnd,
          fileBase64,
          runId: `payout-${suffix}`,
          source: "payout-file",
          capturedAt: "2026-11-12T05:00:00.000Z",
        });

      const posted = await post(
        "zomato",
        "2026-11-02",
        "2026-11-09",
        await file("zomato-900002.xlsx"),
      );
      expect(posted.status).toBe(200);
      const stored = (await posted.json()) as {
        orders: number;
        adjustments: number;
        checks: Array<{ pass: boolean }>;
        warnings: string[];
      };
      expect(stored.orders).toBe(3);
      expect(stored.adjustments).toBe(2);
      expect(stored.checks.every((check) => check.pass)).toBe(true);

      const rejected = await post(
        "zomato",
        "2026-11-02",
        "2026-11-09",
        await file("zomato-999002-wrong-outlet.xlsx"),
      );
      expect(rejected.status).toBe(422);
      const rejection = (await rejected.json()) as { code: string; fetchId: string };
      expect(rejection.code).toBe("file_identity");

      const named = await post(
        "zomato",
        "2026-11-02",
        "2026-11-09",
        await file("zomato-900002-other-name.xlsx"),
      );
      expect(named.status).toBe(200);
      const namedBody = (await named.json()) as { warnings: string[] };
      expect(namedBody.warnings).toContain("The file names Other Kitchen, not Test Kitchen.");

      const current = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutOrder.findMany({
          where: { outletId: outlet.id, platform: "zomato", supersededAt: null },
        }),
      );
      expect(current).toHaveLength(3);
      expect(current.some((order) => order.utrLast4 === "ABCD")).toBe(true);
      expect(current.some((order) => order.customerHash === "CUSTA")).toBe(false);
      const dumped = JSON.stringify({
        orders: current,
        fetches: await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
          db.metricFetch.findMany({ where: { outletId: outlet.id } }),
        ),
      });
      expect(dumped).not.toContain("UTRX900002ABCD");
      expect(dumped).not.toContain("9876543210");
      const linked = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutOrder.count({ where: { fetchId: rejection.fetchId } }),
      );
      expect(linked).toBe(0);
      const prior = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutAdjustment.count({
          where: { outletId: outlet.id, invoiceId: "INV-PRIOR", supersededAt: null },
        }),
      );
      expect(prior).toBe(1);

      const hidden = await runAsTenant(
        { spaceId: `m0-b-${suffix}`, userId: `m0-user-b-${suffix}` },
        () => db.payoutOrder.count({ where: { outletId: outlet.id } }),
      );
      expect(hidden).toBe(0);

      const settlement = await call(
        "GET",
        `/agent/v1/metrics?outletId=${outlet.id}&platform=zomato&from=2026-11-11&to=2026-11-12&basis=settlement_date`,
        tokenA,
      );
      expect(settlement.status).toBe(200);
      const settlementBody = (await settlement.json()) as {
        gap: { adjustmentsPaise: number; settledFromEarlierPaise: number };
        values: Array<{ key: string; value: number | null }>;
        provisional: boolean;
      };
      expect(settlementBody.values.find((row) => row.key === "net_payout_paise")?.value).toBe(6930);
      expect(settlementBody.gap).toMatchObject({
        adjustmentsPaise: 1400,
        settledFromEarlierPaise: 8330,
      });
      expect(settlementBody.provisional).toBe(true);

      const ordered = await call(
        "GET",
        `/agent/v1/metrics?outletId=${outlet.id}&platform=zomato&from=2026-11-02&to=2026-11-09&basis=order_date`,
        tokenA,
      );
      const orderedBody = (await ordered.json()) as {
        gap: { adjustmentsPaise: number; notYetSettledPaise: number };
        values: Array<{ key: string; value: number | null }>;
      };
      expect(orderedBody.values.find((row) => row.key === "net_payout_paise")?.value).toBe(10331);
      expect(orderedBody.gap).toMatchObject({ adjustmentsPaise: 1000, notYetSettledPaise: 2001 });

      const pending = await post(
        "swiggy",
        "2026-11-01",
        "2026-11-08",
        await file("swiggy-900001-pending.xlsx"),
      );
      expect(pending.status).toBe(200);
      const settled = await post(
        "swiggy",
        "2026-11-01",
        "2026-11-08",
        await file("swiggy-900001.xlsx"),
      );
      expect(settled.status).toBe(200);
      const swiggyRows = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutOrder.findMany({ where: { outletId: outlet.id, platform: "swiggy" } }),
      );
      const live = swiggyRows.filter((row) => row.supersededAt == null);
      expect(live).toHaveLength(3);
      expect(
        live.every((row) => row.utrLast4 === "WXYZ" && row.settlementStatus === "settled"),
      ).toBe(true);
      expect(
        swiggyRows.some((row) => row.supersededAt != null && row.settlementStatus === "pending"),
      ).toBe(true);
      expect(JSON.stringify(swiggyRows)).not.toContain("SBI0000WXYZ");
    } finally {
      if (previousSalt === undefined) delete process.env.CUSTOMER_HASH_SALT;
      else process.env.CUSTOMER_HASH_SALT = previousSalt;
    }
  });
});
