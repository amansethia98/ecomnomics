import { createHash } from "node:crypto";
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
        "2026-10-26",
        "2026-11-02",
        await file("zomato-900002.xlsx"),
      );
      expect(posted.status).toBe(200);
      const stored = (await posted.json()) as {
        orders: number;
        adjustments: number;
        checks: Array<{ pass: boolean }>;
        warnings: string[];
      };
      expect(stored.orders).toBe(33);
      expect(stored.adjustments).toBe(2);
      expect(stored.checks.every((check) => check.pass)).toBe(true);
      expect(stored.warnings.join(" ")).not.toContain("Test Kitchen");

      const rejected = await post(
        "zomato",
        "2026-10-26",
        "2026-11-02",
        await file("zomato-999002-wrong-outlet.xlsx"),
      );
      expect(rejected.status).toBe(422);
      const rejection = (await rejected.json()) as { code: string; fetchId: string };
      expect(rejection.code).toBe("file_identity");

      const current = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutOrder.findMany({
          where: { outletId: outlet.id, platform: "zomato", supersededAt: null },
        }),
      );
      expect(current).toHaveLength(33);
      expect(current.some((order) => order.utrLast4 === "0201")).toBe(true);
      expect(current.some((order) => order.utrLast4 === "0299")).toBe(true);
      expect(
        current.some(
          (order) =>
            order.customerHash ===
            "772e82626b52819280a7878e9e250599c432b79a94e7d9d5504b6ea52b1332ad",
        ),
      ).toBe(false);
      const dumped = JSON.stringify({
        orders: current,
        fetches: await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
          db.metricFetch.findMany({ where: { outletId: outlet.id } }),
        ),
      });
      expect(dumped).not.toContain("TESTUTRAA000201");
      expect(dumped).not.toContain("AABCT9000A");
      const linked = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutOrder.count({ where: { fetchId: rejection.fetchId } }),
      );
      expect(linked).toBe(0);
      const prior = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutAdjustment.count({
          where: { outletId: outlet.id, invoiceId: "80110200", supersededAt: null },
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
        `/agent/v1/metrics?outletId=${outlet.id}&platform=zomato&from=2026-11-04&to=2026-11-05&basis=settlement_date`,
        tokenA,
      );
      expect(settlement.status).toBe(200);
      const settlementBody = (await settlement.json()) as {
        gap: { adjustmentsPaise: number };
        values: Array<{ key: string; value: number | null }>;
        provisional: boolean;
      };
      expect(
        settlementBody.values.find((row) => row.key === "platform_net_payout_paise")?.value,
      ).toBe(922098);
      expect(settlementBody.values.find((row) => row.key === "paid_amount_paise")?.value).toBe(
        957098,
      );
      expect(settlementBody.gap.adjustmentsPaise).toBe(275000);
      expect(settlementBody.provisional).toBe(false);

      const ordered = await call(
        "GET",
        `/agent/v1/metrics?outletId=${outlet.id}&platform=zomato&from=2026-10-26&to=2026-11-02&basis=order_date`,
        tokenA,
      );
      const orderedBody = (await ordered.json()) as {
        adjustments: { amountPaise: number };
        gap: { adjustmentsPaise: number; notYetSettledPaise: number };
        values: Array<{ key: string; value: number | null; reason?: string }>;
      };
      expect(orderedBody.values.find((row) => row.key === "payout_orders")?.value).toBe(33);
      expect(orderedBody.values.find((row) => row.key === "ad_spend_paise")?.value).toBeNull();
      expect(orderedBody.adjustments.amountPaise).toBe(240000);
      expect(orderedBody.values.find((row) => row.key === "paid_amount_paise")?.reason).toBe(
        "The platform's cycle total is a settlement figure.",
      );
      expect(orderedBody.gap).toMatchObject({ adjustmentsPaise: 240000, notYetSettledPaise: 0 });

      const again = await post(
        "zomato",
        "2026-10-26",
        "2026-11-02",
        await file("zomato-900002.xlsx"),
      );
      expect(again.status).toBe(200);
      const still = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutOrder.count({
          where: { outletId: outlet.id, platform: "zomato", supersededAt: null },
        }),
      );
      expect(still).toBe(33);

      const settled = await post(
        "swiggy",
        "2026-10-25",
        "2026-11-01",
        await file("swiggy-900001.xlsx"),
      );
      expect(settled.status).toBe(200);
      const swiggyBody = (await settled.json()) as {
        orders: number;
        checks: Array<{ pass: boolean }>;
      };
      expect(swiggyBody.orders).toBe(39);
      expect(swiggyBody.checks.every((check) => check.pass)).toBe(true);
      const swiggyRows = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.payoutOrder.findMany({ where: { outletId: outlet.id, platform: "swiggy" } }),
      );
      const live = swiggyRows.filter((row) => row.supersededAt == null);
      expect(live).toHaveLength(39);
      expect(live.every((row) => row.settlementStatus === "settled")).toBe(true);
      expect(JSON.stringify(swiggyRows)).not.toContain("TESTUTRBB000101");
    } finally {
      if (previousSalt === undefined) delete process.env.CUSTOMER_HASH_SALT;
      else process.env.CUSTOMER_HASH_SALT = previousSalt;
    }
  });

  it("plans windows for this restaurant and refuses another outlet", async () => {
    expect((await routes.request("/agent/v1/fetch-plan?outletId=missing")).status).toBe(401);
    expect((await routes.request("/agent/v1/fetches?outletId=missing")).status).toBe(401);
    for (const [method, path, body] of [
      ["GET", `/agent/v1/fetch-plan?outletId=missing-outlet`, undefined],
      ["GET", `/agent/v1/fetches?outletId=missing-outlet`, undefined],
      [
        "POST",
        "/agent/v1/fetches/check",
        {
          outletId: "missing-outlet",
          platform: "zomato",
          files: [
            {
              sha256: "a".repeat(64),
              report: "daily",
              periodStart: "2026-10-01",
              periodEnd: "2026-10-08",
              parserVersion: "2026-11-12.1",
            },
          ],
        },
      ],
      [
        "POST",
        "/agent/v1/fetches",
        {
          outletId: "missing-outlet",
          platform: "zomato",
          report: "daily",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-08",
          runId: "run-missing",
          status: "signed_out",
          reason: "session_expired",
        },
      ],
    ] as const) {
      const response = await call(method, path, tokenA, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "Outlet is not part of this restaurant.",
        code: "unknown_outlet",
      });
    }

    const foreign = await call("POST", "/agent/v1/fetches", tokenB, {
      outletId: outletA,
      platform: "zomato",
      report: "daily",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-08",
      runId: "run-foreign",
      status: "signed_out",
      reason: "session_expired",
    });
    expect(foreign.status).toBe(422);
    expect(
      await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.metricFetch.count({ where: { outletId: outletA, runId: "run-foreign" } }),
      ),
    ).toBe(0);

    const other = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${outletB}&date=2026-11-16`,
      tokenB,
    );
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as {
      platforms: Array<{ platform: string; platformId: string | null; reason: string | null }>;
    };
    expect(otherBody.platforms).toEqual([
      expect.objectContaining({ platform: "zomato", platformId: "z-2", reason: null, held: false }),
      {
        platform: "swiggy",
        platformId: null,
        reason: "missing_platform_id",
        held: false,
        windows: [],
      },
    ]);
    expect(JSON.stringify(otherBody)).not.toContain("z-1");
    expect(JSON.stringify(otherBody)).not.toContain("s-1");

    const bare = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${bareOutlet}&date=2026-11-16`,
      tokenA,
    );
    expect(await bare.json()).toMatchObject({
      platforms: [
        {
          platform: "zomato",
          platformId: null,
          reason: "missing_platform_id",
          held: false,
          windows: [],
        },
        {
          platform: "swiggy",
          platformId: null,
          reason: "missing_platform_id",
          held: false,
          windows: [],
        },
      ],
    });

    const invalid = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${outletA}&date=2026-02-31`,
      tokenA,
    );
    expect(invalid.status).toBe(400);

    const windows = async (date: string, platform: string, report: string) => {
      const response = await call(
        "GET",
        `/agent/v1/fetch-plan?outletId=${outletA}&date=${date}`,
        tokenA,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        platforms: Array<{
          platform: string;
          windows: Array<{ report: string; periodStart: string; periodEnd: string }>;
        }>;
      };
      return body.platforms
        .find((item) => item.platform === platform)
        ?.windows.filter((window) => window.report === report);
    };
    expect(await windows("2026-11-16", "zomato", "weekly")).toEqual([
      expect.objectContaining({ periodStart: "2026-11-09", periodEnd: "2026-11-16" }),
    ]);
    expect(await windows("2026-11-16", "swiggy", "weekly")).toEqual([]);
    expect(await windows("2026-11-17", "swiggy", "weekly")).toEqual([
      expect.objectContaining({ periodStart: "2026-11-08", periodEnd: "2026-11-15" }),
    ]);
    expect(await windows("2026-11-17", "zomato", "weekly")).toEqual([]);
  });

  it("matches a raw hash, logs a fetch with no file, and hides secrets", async () => {
    const parent = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.outlet.findFirst({ where: { id: outletA }, select: { restaurantId: true } }),
    );
    const restaurantId = parent?.restaurantId ?? "";
    const kitchen = await createOutlet(ownerDb, restaurantId, {
      name: "Test Kitchen",
      city: "Testcity",
      zomatoResId: "900002",
      swiggyRid: "900001",
    });
    const otherParent = await runAsTenant(
      { spaceId: `m0-b-${suffix}`, userId: `m0-user-b-${suffix}` },
      () => db.outlet.findFirst({ where: { id: outletB }, select: { restaurantId: true } }),
    );
    await runAsSystem("fetch plan cycles", async () => {
      await ownerDb.payoutCycle.create({
        data: {
          restaurantId,
          spaceId: spaceA,
          outletId: kitchen.id,
          platform: "zomato",
          cycleId: `open-${suffix}`,
          cycleStart: new Date("2026-10-05T00:00:00.000Z"),
          cycleEnd: new Date("2026-10-12T00:00:00.000Z"),
          settlementStatus: "pending",
          utrLast4: "9999",
        },
      });
      await ownerDb.payoutCycle.create({
        data: {
          restaurantId,
          spaceId: spaceA,
          outletId: kitchen.id,
          platform: "zomato",
          cycleId: `pending-${suffix}`,
          cycleStart: new Date("2026-08-10T00:00:00.000Z"),
          cycleEnd: new Date("2026-08-17T00:00:00.000Z"),
          settlementStatus: "pending",
          utrLast4: "9999",
        },
      });
    });

    const csv = await readFile(
      new URL(
        "../../../packages/contracts/fixtures/metrics/zomato_daily_sample.csv",
        import.meta.url,
      ),
      "utf8",
    );
    const contentHash = createHash("sha256").update(csv).digest("hex");
    const rawHash = "ab".repeat(32);
    const ingested = await call("POST", "/agent/v1/metric-reports", tokenA, {
      outletId: kitchen.id,
      platform: "zomato",
      report: "daily",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-08",
      csv,
      rawSha256: rawHash,
      runId: `metrics-${suffix}`,
      source: "export",
      capturedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(ingested.status).toBe(200);
    const stored = (await ingested.json()) as { fetchId: string; status: string };
    expect(stored.status).toBe("stored");
    const storedRow = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricFetch.findFirst({
        where: { id: stored.fetchId },
        select: { sha256: true, rawSha256: true, parserVersion: true },
      }),
    );
    expect(storedRow).toMatchObject({ sha256: contentHash, rawSha256: rawHash });

    const payoutFile = Buffer.from(
      await readFile(
        new URL("../../../packages/contracts/fixtures/payouts/zomato-900002.xlsx", import.meta.url),
      ),
    );
    const payoutRaw = "cd".repeat(32);
    const payout = await call("POST", "/agent/v1/payout-reports", tokenA, {
      outletId: kitchen.id,
      platform: "zomato",
      periodStart: "2026-10-26",
      periodEnd: "2026-11-02",
      fileBase64: payoutFile.toString("base64"),
      rawSha256: payoutRaw,
      runId: `payout-raw-${suffix}`,
      source: "payout-file",
      capturedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(payout.status).toBe(200);
    const payoutRow = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricFetch.findFirst({
        where: { outletId: kitchen.id, reportKind: "payout", rawSha256: payoutRaw },
        select: { rawSha256: true, sha256: true, parserVersion: true },
      }),
    );
    expect(payoutRow?.rawSha256).toBe(payoutRaw);
    expect(payoutRow?.sha256).toBe(createHash("sha256").update(payoutFile).digest("hex"));

    const foreign = await runAsSystem("foreign fetch", () =>
      ownerDb.metricFetch.create({
        data: {
          restaurantId: otherParent?.restaurantId ?? "",
          spaceId: `m0-b-${suffix}`,
          outletId: outletB,
          platform: "zomato",
          reportKind: "daily",
          status: "stored",
          requestedPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
          requestedPeriodEnd: new Date("2026-10-08T00:00:00.000Z"),
          sha256: contentHash,
          rawSha256: rawHash,
          attemptCount: 1,
          source: "export",
          parserVersion: storedRow?.parserVersion ?? "2026-11-12.1",
          runId: `foreign-${suffix}`,
          capturedAt: new Date("2026-11-12T05:00:00.000Z"),
        },
        select: { id: true },
      }),
    );
    const checked = await call("POST", "/agent/v1/fetches/check", tokenA, {
      outletId: kitchen.id,
      platform: "zomato",
      files: [
        {
          sha256: "b".repeat(64),
          rawSha256: rawHash,
          report: "daily",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-08",
          parserVersion: storedRow?.parserVersion,
        },
        {
          sha256: contentHash,
          rawSha256: "c".repeat(64),
          report: "daily",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-08",
          parserVersion: storedRow?.parserVersion,
        },
        {
          sha256: contentHash,
          rawSha256: rawHash,
          report: "daily",
          periodStart: "2026-10-02",
          periodEnd: "2026-10-08",
          parserVersion: storedRow?.parserVersion,
        },
        {
          sha256: contentHash,
          report: "daily",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-08",
          parserVersion: "other",
        },
      ],
    });
    expect(checked.status).toBe(200);
    const checks = (await checked.json()) as {
      files: Array<{ stored: boolean; fetchId: string | null }>;
    };
    expect(checks.files.map((file) => file.stored)).toEqual([true, true, false, false]);
    expect(checks.files[0]?.fetchId).toBe(stored.fetchId);
    expect(checks.files[1]?.fetchId).toBe(stored.fetchId);
    expect(checks.files.map((file) => file.fetchId)).not.toContain(foreign.id);
    const hidden = await call("POST", "/agent/v1/fetches/check", tokenA, {
      outletId: outletB,
      platform: "zomato",
      files: [
        {
          sha256: contentHash,
          rawSha256: rawHash,
          report: "daily",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-08",
          parserVersion: storedRow?.parserVersion,
        },
      ],
    });
    expect(hidden.status).toBe(422);

    await runAsSystem("fetch list fixtures", async () => {
      await ownerDb.metricFetch.create({
        data: {
          restaurantId,
          spaceId: spaceA,
          outletId: kitchen.id,
          platform: "zomato",
          reportKind: "daily",
          status: "rejected_mismatch",
          requestedPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          requestedPeriodEnd: new Date("2026-09-02T00:00:00.000Z"),
          sha256: "d".repeat(64),
          attemptCount: 1,
          source: "export",
          parserVersion: "2026-11-12.1",
          reason: "The file said OTP 123456 and password hunter2",
          runId: `reject-${suffix}`,
          capturedAt: new Date("2026-09-02T00:00:00.000Z"),
        },
      });
      await ownerDb.metricFetch.create({
        data: {
          restaurantId,
          spaceId: spaceA,
          outletId: kitchen.id,
          platform: "zomato",
          reportKind: "weekly",
          status: "stored",
          requestedPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
          requestedPeriodEnd: new Date("2026-08-08T00:00:00.000Z"),
          sha256: "e".repeat(64),
          attemptCount: 1,
          source: "export",
          parserVersion: "2026-11-12.1",
          reason: "Rounded a rupee.",
          runId: `warn-${suffix}`,
          capturedAt: new Date("2026-08-08T00:00:00.000Z"),
        },
      });
    });

    const logged = await call("POST", "/agent/v1/fetches", tokenA, {
      outletId: kitchen.id,
      platform: "swiggy",
      report: "daily",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-08",
      runId: `log-${suffix}`,
      status: "download_failed",
      reason: "export_missing",
    });
    expect(logged.status).toBe(201);
    const loggedBody = (await logged.json()) as { fetchId: string; status: string };
    expect(loggedBody.status).toBe("download_failed");

    const prose = await call("POST", "/agent/v1/fetches", tokenA, {
      outletId: kitchen.id,
      platform: "swiggy",
      report: "daily",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-08",
      runId: `log-prose-${suffix}`,
      status: "signed_out",
      reason: "Signed out OTP 123456",
    });
    expect(prose.status).toBe(400);
    expect(JSON.stringify(await prose.json())).not.toContain("123456");

    const listed = await call("GET", `/agent/v1/fetches?outletId=${kitchen.id}&limit=50`, tokenA);
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as {
      fetches: Array<{
        fetchId: string;
        status: string;
        reason: string | null;
        warnings: string[];
        sha256: string | null;
        report: string;
        rejectedMismatch: boolean;
      }>;
    };
    expect(list.fetches[0]?.fetchId).toBe(loggedBody.fetchId);
    expect(list.fetches[0]).toMatchObject({
      status: "download_failed",
      reason: "export_missing",
      warnings: [],
      sha256: null,
      report: "daily",
    });
    const rejected = list.fetches.find((row) => row.status === "rejected_mismatch");
    expect(rejected).toMatchObject({ rejectedMismatch: true, reason: null, warnings: [] });
    const warned = list.fetches.find((row) => row.report === "weekly" && row.status === "stored");
    expect(warned?.warnings).toEqual(["Rounded a rupee."]);
    const dumped = JSON.stringify(list);
    expect(dumped).not.toContain("123456");
    expect(dumped).not.toContain("hunter2");
    expect(dumped).not.toContain("9999");

    const newest = await call("GET", `/agent/v1/fetches?outletId=${kitchen.id}&limit=1`, tokenA);
    const newestBody = (await newest.json()) as { fetches: Array<{ fetchId: string }> };
    expect(newestBody.fetches).toHaveLength(1);
    expect(newestBody.fetches[0]?.fetchId).toBe(loggedBody.fetchId);
    const future = await call(
      "GET",
      `/agent/v1/fetches?outletId=${kitchen.id}&since=2099-01-01T00:00:00.000Z`,
      tokenA,
    );
    expect(await future.json()).toEqual({
      fetches: [],
      holds: [
        { platform: "zomato", held: false, reason: null, createdAt: null },
        { platform: "swiggy", held: false, reason: null, createdAt: null },
      ],
    });
    const tooMany = await call("GET", `/agent/v1/fetches?outletId=${kitchen.id}&limit=201`, tokenA);
    expect(tooMany.status).toBe(400);

    const plan = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${kitchen.id}&date=2026-10-08`,
      tokenA,
    );
    const planBody = (await plan.json()) as {
      platforms: Array<{
        platform: string;
        platformId: string | null;
        windows: Array<{
          report: string;
          reasons: string[];
          periodStart: string;
          periodEnd: string;
        }>;
      }>;
    };
    const zomato = planBody.platforms.find((item) => item.platform === "zomato");
    expect(zomato?.platformId).toBe("900002");
    const payouts = zomato?.windows.filter((window) => window.report === "payout") ?? [];
    expect(payouts).toContainEqual({
      report: "payout",
      reasons: ["pending"],
      periodStart: "2026-08-10",
      periodEnd: "2026-08-17",
    });
    expect(payouts.some((window) => window.periodStart === "2026-10-05")).toBe(false);
    expect(JSON.stringify(planBody)).not.toContain("9999");
    const friday = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${kitchen.id}&date=2026-10-09`,
      tokenA,
    );
    const fridayBody = (await friday.json()) as {
      platforms: Array<{ windows: Array<{ report: string }> }>;
    };
    expect(
      fridayBody.platforms.every((item) =>
        item.windows.every((window) => window.report !== "payout"),
      ),
    ).toBe(true);
  });

  it("keeps daily gaps open when only a monthly report is stored", async () => {
    const parent = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.outlet.findFirst({ where: { id: outletA }, select: { restaurantId: true } }),
    );
    const restaurantId = parent?.restaurantId ?? "";
    const row = (platform: string, reportKind: string, from: string, to: string, sha: string) => ({
      restaurantId,
      spaceId: spaceA,
      outletId: outletA,
      platform,
      reportKind,
      status: "stored",
      requestedPeriodStart: new Date(`${from}T00:00:00.000Z`),
      requestedPeriodEnd: new Date(`${to}T00:00:00.000Z`),
      sha256: sha,
      attemptCount: 1,
      source: "export",
      parserVersion: "2026-11-12.1",
      runId: `cover-${suffix}`,
      capturedAt: new Date("2026-10-08T00:00:00.000Z"),
    });
    await runAsSystem("daily coverage fixtures", () =>
      ownerDb.metricFetch.createMany({
        data: [
          row("zomato", "daily", "2026-07-10", "2026-09-01", "1".repeat(64)),
          row("swiggy", "daily", "2026-07-10", "2026-09-01", "2".repeat(64)),
          row("zomato", "monthly", "2026-09-01", "2026-10-01", "3".repeat(64)),
        ],
      }),
    );
    const response = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${outletA}&date=2026-10-08`,
      tokenA,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      platforms: Array<{
        platform: string;
        windows: Array<{
          report: string;
          reasons: string[];
          periodStart: string;
          periodEnd: string;
        }>;
      }>;
    };
    const backfill = body.platforms
      .find((item) => item.platform === "zomato")
      ?.windows.filter((window) => window.reasons.includes("backfill"));
    expect(backfill).toEqual([
      {
        report: "daily",
        reasons: ["backfill"],
        periodStart: "2026-09-01",
        periodEnd: "2026-10-01",
      },
    ]);
  });

  async function restaurantA(): Promise<string> {
    const parent = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.outlet.findFirst({ where: { id: outletA }, select: { restaurantId: true } }),
    );
    return parent?.restaurantId ?? "";
  }

  async function holdState(token: string, outletId: string, platform: string) {
    const response = await call("GET", `/agent/v1/fetches?outletId=${outletId}`, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      holds: Array<{
        platform: string;
        held: boolean;
        reason: string | null;
        createdAt: string | null;
      }>;
    };
    return body.holds.find((hold) => hold.platform === platform);
  }

  const sampleCsv = () =>
    readFile(
      new URL(
        "../../../packages/contracts/fixtures/metrics/zomato_daily_sample.csv",
        import.meta.url,
      ),
      "utf8",
    );

  it("holds fetching after three identity mismatches and ignores attempt", async () => {
    const outlet = await createOutlet(ownerDb, await restaurantA(), {
      name: "Test Kitchen",
      city: "Testcity",
      zomatoResId: "900002",
      swiggyRid: `hold-${suffix}`.slice(0, 64),
    });
    const csv = await sampleCsv();
    const post = (periodStart: string, periodEnd: string, attempt?: number) =>
      call("POST", "/agent/v1/metric-reports", tokenA, {
        outletId: outlet.id,
        platform: "zomato",
        report: "daily",
        periodStart,
        periodEnd,
        csv,
        ...(attempt === undefined ? {} : { attempt }),
        runId: `hold-${suffix}`,
        source: "export",
        capturedAt: "2026-11-12T05:00:00.000Z",
      });

    const first = await post("2026-09-01", "2026-09-08", 3);
    expect(first.status).toBe(422);
    expect(await first.json()).toMatchObject({
      code: "file_identity",
      status: "rejected_mismatch",
    });
    expect(await holdState(tokenA, outlet.id, "zomato")).toMatchObject({ held: false });

    const second = await post("2026-09-01", "2026-09-08");
    expect(second.status).toBe(422);
    expect(await holdState(tokenA, outlet.id, "zomato")).toMatchObject({ held: false });

    const stored = await post("2026-10-01", "2026-10-08");
    expect(stored.status).toBe(200);
    expect(await holdState(tokenA, outlet.id, "zomato")).toMatchObject({ held: false });

    const third = await post("2026-09-01", "2026-09-08");
    expect(third.status).toBe(422);
    expect(await holdState(tokenA, outlet.id, "zomato")).toMatchObject({
      held: true,
      reason: "identity_mismatch",
    });
    expect((await holdState(tokenA, outlet.id, "zomato"))?.createdAt).toEqual(expect.any(String));
    expect(await holdState(tokenA, outlet.id, "swiggy")).toMatchObject({ held: false });

    const before = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricFetch.count({ where: { outletId: outlet.id } }),
    );
    const blocked = await post("2026-10-01", "2026-10-08");
    expect(blocked.status).toBe(423);
    expect(await blocked.json()).toMatchObject({ code: "fetch_held" });
    const payout = await call("POST", "/agent/v1/payout-reports", tokenA, {
      outletId: outlet.id,
      platform: "zomato",
      periodStart: "2026-10-26",
      periodEnd: "2026-11-02",
      fileBase64: Buffer.from("not a workbook").toString("base64"),
      runId: `hold-payout-${suffix}`,
      source: "payout-file",
      capturedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(payout.status).toBe(423);
    const after = await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
      db.metricFetch.count({ where: { outletId: outlet.id } }),
    );
    expect(after).toBe(before);

    const plan = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${outlet.id}&date=2026-10-08`,
      tokenA,
    );
    const planBody = (await plan.json()) as {
      platforms: Array<{ platform: string; held: boolean; windows: unknown[] }>;
    };
    expect(planBody.platforms.find((item) => item.platform === "zomato")).toMatchObject({
      held: true,
      windows: [],
    });
    const swiggy = planBody.platforms.find((item) => item.platform === "swiggy");
    expect(swiggy?.held).toBe(false);
    expect(swiggy?.windows.length).toBeGreaterThan(0);

    const foreignPlan = await call(
      "GET",
      `/agent/v1/fetch-plan?outletId=${outlet.id}&date=2026-10-08`,
      tokenB,
    );
    expect(foreignPlan.status).toBe(422);
    expect(await holdState(tokenB, outletB, "zomato")).toMatchObject({ held: false });
    const sneak = await call("POST", "/agent/v1/metric-reports", tokenB, {
      outletId: outlet.id,
      platform: "zomato",
      report: "daily",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-08",
      csv,
      runId: `hold-foreign-${suffix}`,
      source: "export",
      capturedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(sneak.status).toBe(422);
    expect(await sneak.json()).toMatchObject({ code: "unknown_outlet" });
    expect(
      await runAsTenant({ spaceId: spaceA, userId: userA }, () =>
        db.metricFetch.count({ where: { outletId: outlet.id } }),
      ),
    ).toBe(after);
  });

  it("does not hold three mismatches spread over more than 24 hours", async () => {
    const outlet = await createOutlet(ownerDb, await restaurantA(), {
      name: "Test Kitchen",
      city: "Testcity",
      zomatoResId: "900002",
    });
    const restaurantId = await restaurantA();
    const ages = [25, 48];
    await runAsSystem("old identity mismatches", () =>
      ownerDb.metricFetch.createMany({
        data: ages.map((hours, index) => {
          const createdAt = new Date(Date.now() - hours * 60 * 60 * 1000);
          return {
            restaurantId,
            spaceId: spaceA,
            outletId: outlet.id,
            platform: "zomato",
            reportKind: "daily",
            status: "rejected_mismatch",
            requestedPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
            requestedPeriodEnd: new Date("2026-08-02T00:00:00.000Z"),
            sha256: `${index + 1}`.repeat(64).slice(0, 64),
            attemptCount: 1,
            identityMismatch: true,
            source: "export",
            parserVersion: "2026-11-12.1",
            runId: `aged-${suffix}-${index}`,
            capturedAt: createdAt,
            createdAt,
          };
        }),
      }),
    );
    const csv = await sampleCsv();
    const live = await call("POST", "/agent/v1/metric-reports", tokenA, {
      outletId: outlet.id,
      platform: "zomato",
      report: "daily",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-08",
      csv,
      attempt: 1,
      runId: `aged-live-${suffix}`,
      source: "export",
      capturedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(live.status).toBe(422);
    expect(await live.json()).toMatchObject({ status: "rejected_mismatch" });
    expect(await holdState(tokenA, outlet.id, "zomato")).toMatchObject({ held: false });
  });

  it("does not count rejected rows the previous release did not mark as identity mismatches", async () => {
    const outlet = await createOutlet(ownerDb, await restaurantA(), {
      name: "Test Kitchen",
      city: "Testcity",
      zomatoResId: "900002",
    });
    const restaurantId = await restaurantA();
    await runAsSystem("unmarked rejections", () =>
      ownerDb.metricFetch.createMany({
        data: [0, 1].map((index) => ({
          restaurantId,
          spaceId: spaceA,
          outletId: outlet.id,
          platform: "zomato",
          reportKind: "daily",
          status: "rejected_mismatch",
          requestedPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
          requestedPeriodEnd: new Date("2026-08-02T00:00:00.000Z"),
          sha256: `${index + 3}`.repeat(64).slice(0, 64),
          attemptCount: 1,
          source: "export",
          parserVersion: "2026-11-12.1",
          reason: "The file could not be read.",
          runId: `legacy-${suffix}-${index}`,
          capturedAt: new Date(),
        })),
      }),
    );
    const csv = await sampleCsv();
    const live = await call("POST", "/agent/v1/metric-reports", tokenA, {
      outletId: outlet.id,
      platform: "zomato",
      report: "daily",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-08",
      csv,
      runId: `legacy-live-${suffix}`,
      source: "export",
      capturedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(live.status).toBe(422);
    expect(await holdState(tokenA, outlet.id, "zomato")).toMatchObject({ held: false });
  });

  it("counts local_mismatch logs and does not count parse failures", async () => {
    const restaurantId = await restaurantA();
    const logged = await createOutlet(ownerDb, restaurantId, {
      name: "Logged",
      city: "Pune",
      zomatoResId: "z-log",
      swiggyRid: "s-log",
    });
    for (let index = 0; index < 3; index += 1) {
      const response = await call("POST", "/agent/v1/fetches", tokenA, {
        outletId: logged.id,
        platform: "zomato",
        report: "daily",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-02",
        runId: `local-${suffix}-${index}`,
        status: "local_mismatch",
        reason: "outlet_mismatch",
      });
      expect(response.status).toBe(201);
    }
    expect(await holdState(tokenA, logged.id, "zomato")).toMatchObject({
      held: true,
      reason: "identity_mismatch",
    });
    const blocked = await call("POST", "/agent/v1/metric-reports", tokenA, {
      outletId: logged.id,
      platform: "zomato",
      report: "daily",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-02",
      csv: "not,a,report",
      runId: `local-file-${suffix}`,
      source: "export",
      capturedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(blocked.status).toBe(423);

    const parsed = await createOutlet(ownerDb, restaurantId, {
      name: "Parsed",
      city: "Pune",
      zomatoResId: "z-parse",
      swiggyRid: "s-parse",
    });
    for (let index = 0; index < 3; index += 1) {
      const response = await call("POST", "/agent/v1/metric-reports", tokenA, {
        outletId: parsed.id,
        platform: "zomato",
        report: "daily",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-02",
        csv: "a,b,c\n1,2,3",
        runId: `parse-${suffix}-${index}`,
        source: "export",
        capturedAt: "2026-11-12T05:00:00.000Z",
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ status: "parse_failed" });
    }
    for (let index = 0; index < 3; index += 1) {
      const response = await call("POST", "/agent/v1/fetches", tokenA, {
        outletId: parsed.id,
        platform: "swiggy",
        report: "daily",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-02",
        runId: `other-${suffix}-${index}`,
        status: "download_failed",
        reason: "export_missing",
      });
      expect(response.status).toBe(201);
    }
    expect(await holdState(tokenA, parsed.id, "zomato")).toMatchObject({ held: false });
    expect(await holdState(tokenA, parsed.id, "swiggy")).toMatchObject({ held: false });

    const missing = await createOutlet(ownerDb, restaurantId, { name: "No id", city: "Pune" });
    for (let index = 0; index < 3; index += 1) {
      const response = await call("POST", "/agent/v1/metric-reports", tokenA, {
        outletId: missing.id,
        platform: "zomato",
        report: "daily",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-02",
        csv: "a,b,c\n1,2,3",
        runId: `missing-${suffix}-${index}`,
        source: "export",
        capturedAt: "2026-11-12T05:00:00.000Z",
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ status: "missing_platform_id" });
    }
    expect(await holdState(tokenA, missing.id, "zomato")).toMatchObject({ held: false });
  });
});
