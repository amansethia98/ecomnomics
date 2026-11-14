import { METRIC_LABEL_ALIASES, METRIC_LABEL_SLOTS } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { provisionRuntimeRole } from "./database-access.js";
import { seedMetricLabels } from "./metric-labels.js";
import { provisionPlatformAdminLogin } from "./platform-admin-role.js";
import { runAsPlatformAdmin, runAsSystem, runAsTenant } from "./row-security.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("metric label registry (PostgreSQL)", () => {
  if (!runtimeUrl || !migrationUrl) return;
  const login = `ecomlbl${process.pid}`.slice(0, 32);
  const adminUrl = new URL(migrationUrl);
  adminUrl.username = login;
  adminUrl.password = "label-test-pass";
  const probe = `metric-label-probe-${process.pid}`;
  const adminProbe = `metric-label-admin-${process.pid}`;
  const owner = createDb(migrationUrl, { applicationName: "metric-label-owner" });
  const app = createDb(runtimeUrl, { applicationName: "metric-label-app" });
  const admin = createDb(adminUrl.toString(), { applicationName: "metric-label-admin" });
  const slotId = METRIC_LABEL_SLOTS[0]?.id ?? "";

  beforeAll(async () => {
    await provisionRuntimeRole(migrationUrl, runtimeUrl);
    await provisionPlatformAdminLogin(migrationUrl, adminUrl.toString());
    await seedMetricLabels(owner.prisma);
    await seedMetricLabels(owner.prisma);
  });

  afterAll(async () => {
    await runAsSystem("remove metric label probes", async () => {
      await app.prisma.metricLabelAlias.deleteMany({ where: { id: { in: [probe, adminProbe] } } });
    }).catch(() => undefined);
    await admin.prisma.$disconnect().catch(() => undefined);
    await admin.pool.end().catch(() => undefined);
    await app.prisma.$disconnect().catch(() => undefined);
    await app.pool.end().catch(() => undefined);
    await owner.prisma
      .$executeRawUnsafe(`REVOKE ecomnomics_admin FROM "${login}"`)
      .catch(() => undefined);
    await owner.prisma.$executeRawUnsafe(`DROP ROLE "${login}"`).catch(() => undefined);
    await owner.prisma.$disconnect().catch(() => undefined);
    await owner.pool.end().catch(() => undefined);
  });

  it("loads the built-in labels once and leaves them on a second run", async () => {
    const count = await runAsSystem("count metric labels", () =>
      app.prisma.metricLabelAlias.count(),
    );
    expect(count).toBe(METRIC_LABEL_ALIASES.length);
    await seedMetricLabels(app.prisma);
    expect(
      await runAsSystem("count metric labels again", () => app.prisma.metricLabelAlias.count()),
    ).toBe(count);
  });

  it("lets a restaurant agent read labels and blocks a write", async () => {
    const tenant = { spaceId: "label-space", userId: "label-user" };
    const readable = await runAsTenant(tenant, () => app.prisma.metricLabelSlot.count());
    expect(readable).toBe(METRIC_LABEL_SLOTS.length);
    await expect(
      runAsTenant(tenant, () =>
        app.prisma.metricLabelAlias.create({
          data: {
            id: probe,
            slotId,
            platform: "swiggy",
            reportKind: "business",
            label: "Probe",
            normLabel: "probe",
            matchMode: "exact",
            includeTokens: ["probe"],
            excludeTokens: [],
            group: 0,
            role: "read",
            source: "admin",
            createdBy: "label-test",
          },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await runAsSystem("probe was not stored", () =>
        app.prisma.metricLabelAlias.findUnique({ where: { id: probe } }),
      ),
    ).toBeNull();
  });

  it("lets the system bypass and the platform-admin role add an alias", async () => {
    await runAsSystem("store a metric label probe", () =>
      app.prisma.metricLabelAlias.create({
        data: {
          id: probe,
          slotId,
          platform: "swiggy",
          reportKind: "business",
          label: "Probe",
          normLabel: "probe",
          matchMode: "exact",
          includeTokens: ["probe"],
          excludeTokens: [],
          group: 0,
          role: "read",
          source: "admin",
          createdBy: "label-test",
        },
      }),
    );
    await runAsSystem("remove the metric label probe", () =>
      app.prisma.metricLabelAlias.delete({ where: { id: probe } }),
    );
    await runAsPlatformAdmin("label-test", () =>
      admin.prisma.metricLabelAlias.create({
        data: {
          id: adminProbe,
          slotId,
          platform: "swiggy",
          reportKind: "business",
          label: "Admin probe",
          normLabel: "admin probe",
          matchMode: "exact",
          includeTokens: ["admin probe"],
          excludeTokens: [],
          group: 0,
          role: "read",
          source: "admin",
          createdBy: "label-test",
        },
      }),
    );
    await runAsPlatformAdmin("label-test", () =>
      admin.prisma.metricLabelAlias.delete({ where: { id: adminProbe } }),
    );
  });
});
