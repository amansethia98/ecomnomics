import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

const require = createRequire(import.meta.url);
const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface SyntheticSheet {
  addRow(values: unknown[]): void;
}

function duplicateHyperboostWorkbook(): Promise<Uint8Array> {
  const { Workbook } = require("exceljs") as {
    Workbook: new () => {
      addWorksheet(name: string): SyntheticSheet;
      xlsx: { writeBuffer(): Promise<ArrayBuffer> };
    };
  };
  const book = new Workbook();
  const summary = book.addWorksheet("Summary");
  for (const line of [
    "Test Kitchen",
    "Test Area",
    "Testcity",
    "Rest. ID - 900001",
    "25 October - 31 October",
  ]) {
    summary.addRow([line]);
  }
  const orders = book.addWorksheet("Order Level");
  orders.addRow([
    "Order ID",
    "Order Date",
    "Order Status",
    "Item Total",
    "Net Payout",
    "Settlement Date",
  ]);
  orders.addRow(["100001", "2026-10-25", "Delivered", 100, 100, "2026-11-03"]);
  orders.addRow(["100002", "2026-10-31", "Delivered", 80, 80, "2026-11-03"]);
  const growth = book.addWorksheet("Growth Investments and Other De");
  growth.addRow([
    "Adjustment Type",
    "Total Amount",
    "Settled Amount",
    "Period From",
    "Period To",
    "Invoice Number",
  ]);
  growth.addRow(["HyperBoost", 1800, 1800, "2026-10-25", "2026-10-31", ""]);
  growth.addRow(["HyperBoost", 900, 900, "2026-10-25", "2026-10-31", ""]);
  return book.xlsx.writeBuffer().then((buffer) => new Uint8Array(buffer));
}

describePostgres("built payout server", () => {
  const suffix = `bundle-${process.pid}-${Date.now()}`;
  const spaceId = `bundle-space-${suffix}`;
  const userId = `bundle-user-${suffix}`;
  let ownerDb: PrismaClient;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  let token = "";
  let outletId = "";
  let child: ReturnType<typeof spawn> | undefined;
  let port = 0;

  beforeAll(async () => {
    const built = spawn(
      "node",
      [path.join(repoRoot, "scripts/build-server.mjs"), "src/payout-bundle-server.ts"],
      { cwd: apiRoot, stdio: "inherit" },
    );
    const buildCode = await new Promise<number>((resolve, reject) => {
      built.once("error", reject);
      built.once("exit", (code) => resolve(code ?? 1));
    });
    expect(buildCode).toBe(0);

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
    const organizationId = `bundle-org-${suffix}`;
    await runAsSystem("payout bundle fixture", async () => {
      await ownerDb.organization.create({
        data: { id: organizationId, name: "bundle", slug: organizationId, createdAt: new Date() },
      });
      await ownerDb.user.create({
        data: {
          id: userId,
          name: "bundle",
          email: `${userId}@ecomnomics.test`,
          emailVerified: true,
        },
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
        data: { id: spaceId, organizationId, name: "bundle", createdByUserId: userId },
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
      const restaurant = await ensureRestaurant(ownerDb, { spaceId, name: "Test Kitchen" });
      const outlet = await createOutlet(ownerDb, restaurant.id, {
        name: "Test Kitchen",
        city: "Testcity",
        swiggyRid: "900001",
      });
      outletId = outlet.id;
      token = await mintAgentToken(ownerDb, restaurant.id);
    });

    const dir = await mkdtemp(path.join(tmpdir(), "payout-bundle-"));
    const portFile = path.join(dir, "port");
    child = spawn("node", ["dist/payout-bundle-server.js"], {
      cwd: apiRoot,
      env: { ...process.env, PAYOUT_BUNDLE_PORT_FILE: portFile },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`built server exited ${child.exitCode}`);
      try {
        port = Number(await readFile(portFile, "utf8"));
        if (port > 0) break;
      } catch {
        // The file appears once the server is listening.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!port) throw new Error("built server did not listen");
  }, 120_000);

  afterAll(async () => {
    if (child && child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child?.once("exit", resolve));
    }
    await runAsSystem("payout bundle cleanup", async () => {
      await ownerDb.organization.deleteMany({ where: { id: `bundle-org-${suffix}` } });
      await ownerDb.user.deleteMany({ where: { id: userId } });
    }).catch(() => undefined);
    await stop?.();
  });

  it("stores two blank-invoice HyperBoost rows and skips the same file", async () => {
    const file = await duplicateHyperboostWorkbook();
    const body = {
      outletId,
      platform: "swiggy",
      periodStart: "2026-10-25",
      periodEnd: "2026-11-01",
      fileBase64: Buffer.from(file).toString("base64"),
      runId: `bundle-${suffix}`,
      source: "payout-file",
      capturedAt: "2026-11-03T05:00:00.000Z",
    };
    const post = () =>
      fetch(`http://127.0.0.1:${port}/agent/v1/payout-reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await post();
    const stored = (await first.json()) as {
      status?: string;
      adjustments?: number;
      error?: string;
    };
    expect(first.status, JSON.stringify(stored)).toBe(200);
    expect(stored).toMatchObject({ status: "stored", adjustments: 2, orders: 2 });

    const rows = await runAsTenant({ spaceId, userId }, () =>
      db.payoutAdjustment.findMany({
        where: { outletId, type: "HyperBoost", supersededAt: null },
        orderBy: { invoiceId: "asc" },
      }),
    );
    expect(rows.map((row) => row.invoiceId)).toEqual(["growth#2", "growth#3"]);

    const second = await post();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "skipped" });
    const again = await runAsTenant({ spaceId, userId }, () =>
      db.payoutAdjustment.count({ where: { outletId, type: "HyperBoost", supersededAt: null } }),
    );
    expect(again).toBe(2);
  }, 30_000);
});
