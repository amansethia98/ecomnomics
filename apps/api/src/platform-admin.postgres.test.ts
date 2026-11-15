import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createOutlet,
  createPlatformAdminStore,
  ensureRestaurant,
  hashAgentToken,
  mintAgentToken,
  provisionPlatformAdminLogin,
  revokeRuntimeAdminAuditAccess,
  runAsPlatformAdmin,
  runAsSystem,
  runAsTenant,
  seedMetricLabels,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformAdminRoutes } from "./platform-admin-routes.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("platform admin is a separate role (PostgreSQL)", () => {
  // A skipped suite still evaluates this callback. Leave it when the URL is absent.
  if (!runtimeUrl || !migrationUrl) return;
  const suffix = `${process.pid}-${Date.now()}`;
  const login = `ecomadm${process.pid}`.slice(0, 32);
  const adminUrl = new URL(migrationUrl);
  adminUrl.username = login;
  adminUrl.password = "admin-test-pass";
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let admin: ReturnType<typeof createDb>;
  let db: PrismaClient;
  let restaurantId = "";
  let tokenHash = "";

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    await revokeRuntimeAdminAuditAccess(migrationUrl!);
    await provisionPlatformAdminLogin(migrationUrl!, adminUrl.toString());
    admin = createDb(adminUrl.toString(), { poolMax: 2 });
    const organizationId = `adm-org-${suffix}`;
    const userId = `adm-user-${suffix}`;
    const spaceId = `adm-space-${suffix}`;
    await runAsSystem("platform admin fixture", async () => {
      await owner.prisma.organization.create({
        data: { id: organizationId, name: "Admin", slug: organizationId, createdAt: new Date() },
      });
      await owner.prisma.user.create({
        data: {
          id: userId,
          name: "Admin",
          email: `${userId}@ecomnomics.test`,
          emailVerified: true,
        },
      });
      await owner.prisma.member.create({
        data: {
          id: `${userId}-member`,
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await owner.prisma.space.create({
        data: { id: spaceId, organizationId, name: "Admin", createdByUserId: userId },
      });
      await owner.prisma.spaceMember.create({
        data: {
          id: `${userId}-space`,
          spaceId,
          userId,
          organizationId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      const restaurant = await ensureRestaurant(owner.prisma, { spaceId, name: "Audited" });
      restaurantId = restaurant.id;
      const token = await mintAgentToken(owner.prisma, restaurant.id);
      tokenHash = hashAgentToken(token);
      await owner.prisma.jobRun.create({
        data: {
          restaurantId,
          spaceId,
          runId: `adm-${suffix}`,
          skill: "payout",
          status: "failed",
          startedAt: new Date("2026-01-07T04:00:00.000Z"),
          costPaise: 10,
          costUsdMicros: 100n,
          fxRate: "83.5",
          error: `otp waiting ${suffix}`,
        },
      });
    });
  });

  afterAll(async () => {
    await runAsSystem("platform admin cleanup", async () => {
      await owner.prisma.organization.deleteMany({ where: { id: `adm-org-${suffix}` } });
      await owner.prisma.user.deleteMany({ where: { id: `adm-user-${suffix}` } });
    }).catch(() => undefined);
    await admin?.prisma.$disconnect().catch(() => undefined);
    await admin?.pool.end().catch(() => undefined);
    await app?.prisma.$disconnect().catch(() => undefined);
    await app?.pool.end().catch(() => undefined);
    await owner.prisma
      .$executeRawUnsafe(`REVOKE ecomnomics_admin FROM "${login}"`)
      .catch(() => undefined);
    await owner.prisma.$executeRawUnsafe(`DROP ROLE "${login}"`).catch(() => undefined);
    await owner?.prisma.$disconnect().catch(() => undefined);
    await owner?.pool.end().catch(() => undefined);
  });

  it("does not let the app login read the audit log or become the admin role", async () => {
    await expect(db.$queryRaw`SELECT 1 FROM admin_audit_log`).rejects.toThrow();
    await expect(
      runAsSystem(
        "bypass still cannot read the audit log",
        () => db.$queryRaw`SELECT 1 FROM admin_audit_log`,
      ),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`SET ROLE ${login}`)).rejects.toThrow();
    await expect(db.$executeRawUnsafe("SET ROLE ecomnomics_admin")).rejects.toThrow();
  });

  it("does not let the admin login read token hashes", async () => {
    await expect(
      admin.prisma.$queryRaw`SELECT "tokenHash" FROM restaurant_agent_tokens`,
    ).rejects.toThrow();
  });

  it("logs an allowlisted read and leaves secrets out of the response", async () => {
    const store = createPlatformAdminStore(admin.prisma);
    const before = await runAsPlatformAdmin("count", () => admin.prisma.adminAuditLog.count());
    const routes = platformAdminRoutes({
      allowlist: ["auditor@example.com"],
      store,
      getSession: async () => ({
        user: { id: `auditor-${suffix}`, email: "auditor@example.com", emailVerified: true },
      }),
      clientIp: () => "203.0.113.5",
    });
    const response = await routes.request(`/admin/v1/restaurants/${restaurantId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const text = JSON.stringify(body);
    expect(text).toContain("Audited");
    expect(text).toContain("83.5");
    expect(text).not.toContain(tokenHash);
    expect(text).not.toContain(`otp waiting ${suffix}`);
    expect(text).not.toContain("tokenHash");
    const after = await runAsPlatformAdmin("count", () => admin.prisma.adminAuditLog.count());
    expect(after).toBe(before + 1);

    const denied = await routes.request("/admin/v1/restaurants", {
      headers: { authorization: "Bearer ecom_agent_example" },
    });
    expect(denied.status).toBe(403);
    const still = await runAsPlatformAdmin("count", () => admin.prisma.adminAuditLog.count());
    expect(still).toBe(after);
  });

  it("clears a fetch hold for an allowlisted admin and refuses an agent token", async () => {
    const outlet = await createOutlet(owner.prisma, restaurantId, {
      name: "Held",
      city: "Pune",
      zomatoResId: "z-held",
    });
    const spaceId = `adm-space-${suffix}`;
    const hold = await runAsSystem("open fetch hold", () =>
      owner.prisma.fetchHold.create({
        data: {
          restaurantId,
          spaceId,
          outletId: outlet.id,
          platform: "zomato",
          reason: "identity_mismatch",
        },
        select: { id: true },
      }),
    );
    const store = createPlatformAdminStore(admin.prisma);
    const routes = platformAdminRoutes({
      allowlist: ["auditor@example.com"],
      store,
      getSession: async () => ({
        user: { id: `auditor-${suffix}`, email: "auditor@example.com", emailVerified: true },
      }),
      clientIp: () => "203.0.113.5",
    });
    const body = JSON.stringify({ outletId: outlet.id, platform: "zomato" });
    const path = `/admin/v1/restaurants/${restaurantId}/fetch-holds`;
    const before = await runAsPlatformAdmin("count", () => admin.prisma.adminAuditLog.count());
    const denied = await routes.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer ecom_agent_example",
        "content-type": "application/json",
      },
      body,
    });
    expect(denied.status).toBe(403);
    expect(await runAsPlatformAdmin("count", () => admin.prisma.adminAuditLog.count())).toBe(
      before,
    );

    const wrong = await routes.request(`/admin/v1/restaurants/other-${suffix}/fetch-holds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toMatchObject({ code: "not_found" });
    const open = await runAsSystem("hold still open", () =>
      owner.prisma.fetchHold.findUnique({ where: { id: hold.id }, select: { clearedAt: true } }),
    );
    expect(open?.clearedAt).toBeNull();
    await expect(
      runAsTenant({ spaceId, userId: `adm-user-${suffix}` }, () =>
        db.fetchHold.update({
          where: { id: hold.id },
          data: { clearedAt: new Date(), clearedBy: "agent" },
        }),
      ),
    ).rejects.toThrow();

    const cleared = await routes.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ outletId: outlet.id, platform: "zomato" });
    const row = await runAsPlatformAdmin("cleared hold", () =>
      admin.prisma.fetchHold.findUnique({ where: { id: hold.id } }),
    );
    expect(row?.clearedAt).not.toBeNull();
    expect(row?.clearedBy).toBe(`auditor-${suffix}`);
    const audit = await runAsPlatformAdmin("clear audit", () =>
      admin.prisma.adminAuditLog.findFirst({
        where: { action: "clear_fetch_hold", restaurantId },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(audit).toMatchObject({
      adminUserId: `auditor-${suffix}`,
      target: path,
      ip: "203.0.113.5",
    });

    const again = await routes.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(again.status).toBe(404);
  });

  it("does not let an agent token or a non-admin add a label alias", async () => {
    await seedMetricLabels(owner.prisma);
    const store = createPlatformAdminStore(admin.prisma);
    const path = "/admin/v1/metric-labels/slots/swiggy.business.SALES.net_sales/aliases";
    const body = JSON.stringify({ label: "Net Revenue" });
    const routes = platformAdminRoutes({
      allowlist: ["auditor@example.com"],
      store,
      getSession: async () => ({
        user: { id: `auditor-${suffix}`, email: "auditor@example.com", emailVerified: true },
      }),
    });
    const agent = await routes.request(path, {
      method: "POST",
      headers: { authorization: "Bearer ecom_agent_example", "content-type": "application/json" },
      body,
    });
    expect(agent.status).toBe(403);
    const stranger = platformAdminRoutes({
      allowlist: ["auditor@example.com"],
      store,
      getSession: async () => ({
        user: { id: `other-${suffix}`, email: "other@example.com", emailVerified: true },
      }),
    });
    const denied = await stranger.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(denied.status).toBe(403);
    expect(
      await runAsSystem("alias was not written", () =>
        owner.prisma.metricLabelAlias.findFirst({ where: { label: "Net Revenue" } }),
      ),
    ).toBeNull();
  });
});
