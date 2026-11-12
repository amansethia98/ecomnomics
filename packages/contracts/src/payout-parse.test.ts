import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkObservedIdentity } from "./metric-parse.js";
import { rollupMetrics } from "./metric-rollup.js";
import type { ParsedPayoutFile } from "./payout-parse.js";
import { parsePayoutWorkbook } from "./payout-parse.js";
import type { PayoutAdjustmentFact, PayoutCycleFact, PayoutOrderFact } from "./payout-read.js";
import { readPayoutWindow } from "./payout-read.js";
import { redactPayoutWorkbook } from "./payout-redact.js";

const FULL_ZOMATO_UTR = "UTRX900002ABCD";
const FULL_SWIGGY_UTR = "SBI0000WXYZ";
const PHONE = "9876543210";
const SALT = "fixture-salt";

const fixture = (name: string) => readFile(new URL(`../fixtures/payouts/${name}`, import.meta.url));

describe("payout workbooks", () => {
  it("parses the Zomato settlement file, including the prior-week adjustment", async () => {
    const parsed = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", SALT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payout = parsed.payout;
    expect(payout.cycleId).toBe("zomato:900002:2026-11-02:2026-11-09");
    expect(payout.orders).toHaveLength(3);
    expect(payout.orders.map((order) => order.netPayoutPaise)).toEqual([8330, 0, 2001]);
    expect(payout.orders[0]).toMatchObject({
      orderDate: "2026-11-02",
      orderStatus: "DELIVERED",
      settlementStatus: "settled",
      settlementDate: "2026-11-11",
      utrLast4: "ABCD",
      grossSalesPaise: 11000,
      discountPaise: 750,
      customerHash: hash("CUSTA"),
    });
    expect(payout.orders[1]).toMatchObject({
      orderDate: "2026-11-03",
      orderStatus: "CANCELLED",
      cancelledBy: "restaurant",
      customerHash: hash("CUSTB"),
    });
    expect(payout.orders[2]).toMatchObject({
      orderDate: "2026-11-08",
      settlementStatus: "pending",
      settlementDate: null,
      utrLast4: null,
      grossSalesPaise: 2001,
      customerHash: hash("CUSTA"),
    });
    expect(new Set(payout.orders.map((order) => order.customerHash)).size).toBe(2);
    expect(payout.adjustments).toEqual([
      expect.objectContaining({
        type: "Ads",
        invoiceId: "INV-ADS",
        periodFrom: "2026-11-02",
        periodTo: "2026-11-09",
        amountPaise: 1000,
        bookedCycle: payout.cycleId,
      }),
      expect.objectContaining({
        type: "Prior week fee",
        invoiceId: "INV-PRIOR",
        periodFrom: "2026-10-26",
        periodTo: "2026-11-02",
        amountPaise: 400,
        bookedCycle: payout.cycleId,
      }),
    ]);
    expect(payout.totals.platformNetPayoutPaise).toBe(8931);
    expect(payout.checks.every((check) => check.pass)).toBe(true);
    expect(JSON.stringify(payout)).not.toContain(FULL_ZOMATO_UTR);
    expect(JSON.stringify(payout)).not.toContain(PHONE);
  });

  it("parses the Swiggy annexure, shifting the summary period and keeping train and Toing", async () => {
    const parsed = await parsePayoutWorkbook(await fixture("swiggy-900001.xlsx"), "swiggy", SALT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payout = parsed.payout;
    expect(payout.cycleId).toBe("swiggy:900001:2026-11-01:2026-11-08");
    expect(payout.observed.restaurantId).toBe("900001");
    expect(payout.orders.map((order) => order.category)).toEqual([null, "TRAIN_ORDER", "Toing"]);
    expect(payout.orders.map((order) => order.netPayoutPaise)).toEqual([15580, 4410, 0]);
    expect(payout.orders[0]).toMatchObject({
      mfrMarked: true,
      mfrAccurate: true,
      commissionPaise: 3000,
      taxesPaise: 720,
      platformFeesPaise: 1000,
      utrLast4: "WXYZ",
      customerHash: null,
    });
    expect(payout.orders[1]).toMatchObject({ mfrMarked: false, mfrAccurate: false });
    expect(payout.orders[2]).toMatchObject({
      mfrMarked: null,
      mfrAccurate: null,
      orderStatus: "CANCELLED",
      cancelledBy: "customer",
    });
    expect(payout.adjustments).toEqual([
      expect.objectContaining({
        type: "Weekly ad pack",
        amountPaise: 800,
        bookedCycle: payout.cycleId,
      }),
    ]);
    expect(payout.totals.platformNetPayoutPaise).toBe(19190);
    expect(payout.checks.every((check) => check.pass)).toBe(true);
    expect(JSON.stringify(payout)).not.toContain(FULL_SWIGGY_UTR);
  });

  it("rejects a wrong outlet id and warns on a different name", async () => {
    const wrong = await parsePayoutWorkbook(
      await fixture("swiggy-999001-wrong-outlet.xlsx"),
      "swiggy",
      SALT,
    );
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    const rejected = checkObservedIdentity(wrong.payout.observed, expected("swiggy", "900001"));
    expect(rejected.reject).toBe("The file is for restaurant 999001, not 900001.");

    const named = await parsePayoutWorkbook(
      await fixture("zomato-900002-other-name.xlsx"),
      "zomato",
      SALT,
    );
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    const warned = checkObservedIdentity(named.payout.observed, expected("zomato", "900002"));
    expect(warned.reject).toBeNull();
    expect(warned.warnings).toContain("The file names Other Kitchen, not Test Kitchen.");
  });

  it("keeps a pending re-upload distinct and omits customer hashes without a salt", async () => {
    const pending = await parsePayoutWorkbook(
      await fixture("swiggy-900001-pending.xlsx"),
      "swiggy",
      null,
    );
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.payout.settlementStatus).toBe("pending");
    expect(pending.payout.settlementDate).toBeNull();
    expect(pending.payout.orders.every((order) => order.utrLast4 == null)).toBe(true);
    const unsalted = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", null);
    expect(unsalted.ok).toBe(true);
    if (!unsalted.ok) return;
    expect(unsalted.payout.warnings).toContain(
      "Customer hashes were not stored because CUSTOMER_HASH_SALT is not set.",
    );
    expect(unsalted.payout.orders.every((order) => order.customerHash == null)).toBe(true);
  });

  it("splits settlement and order dates, and counts a prior-week adjustment once", async () => {
    const zomato = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", SALT);
    expect(zomato.ok).toBe(true);
    if (!zomato.ok) return;
    const facts = factsOf(zomato.payout);
    const settled = readPayoutWindow({
      platform: "zomato",
      basis: "settlement_date",
      from: "2026-11-11",
      to: "2026-11-12",
      ...facts,
    });
    expect(value(settled.values, "net_payout_paise")).toBe(6930);
    expect(value(settled.values, "platform_net_payout_paise")).toBe(8931);
    expect(value(settled.values, "unique_customers")).toBe(2);
    expect(settled.gap).toEqual({
      settledFromEarlierPaise: 8330,
      notYetSettledPaise: 0,
      adjustmentsPaise: 1400,
    });
    expect(settled.provisional).toBe(true);

    const ordered = readPayoutWindow({
      platform: "zomato",
      basis: "order_date",
      from: "2026-11-02",
      to: "2026-11-09",
      ...facts,
    });
    expect(value(ordered.values, "net_payout_paise")).toBe(10331);
    expect(value(ordered.values, "ad_spend_paise")).toBe(1000);
    expect(ordered.gap).toMatchObject({ notYetSettledPaise: 2001, adjustmentsPaise: 1000 });

    const prior = readPayoutWindow({
      platform: "zomato",
      basis: "order_date",
      from: "2026-10-26",
      to: "2026-11-02",
      ...facts,
    });
    expect(prior.gap.adjustmentsPaise).toBe(400);
    expect(value(prior.values, "net_payout_paise")).toBe(0);

    const priorSettlement = readPayoutWindow({
      platform: "zomato",
      basis: "settlement_date",
      from: "2026-10-26",
      to: "2026-11-02",
      ...facts,
    });
    expect(priorSettlement.gap.adjustmentsPaise).toBe(0);

    const rollup = rollupMetrics(
      [],
      {
        platform: "zomato",
        from: "2026-11-11",
        to: "2026-11-12",
        today: "2026-12-01",
        basis: "settlement_date",
      },
      facts,
    );
    expect(rollup.gap?.adjustmentsPaise).toBe(1400);
    expect(rollup.values.find((row) => row.key === "delivered_orders")?.reason).toBe(
      "This figure is not part of the settlement-date payout.",
    );
    const swiggy = rollupMetrics(
      [],
      {
        platform: "swiggy",
        from: "2026-11-11",
        to: "2026-11-12",
        today: "2026-12-01",
        basis: "settlement_date",
      },
      facts,
    );
    expect(swiggy.values.find((row) => row.key === "unique_customers")?.reason).toBe(
      "Distinct customers are counted from Zomato payout orders.",
    );
  });

  it("redacts the full UTR and the phone number before the file is kept", async () => {
    const original = await fixture("zomato-900002.xlsx");
    const redacted = await redactPayoutWorkbook(original);
    const dir = await mkdtemp(join(tmpdir(), "payout-redact-"));
    const path = join(dir, "redacted.xlsx");
    await writeFile(path, redacted);
    const text = execFileSync("unzip", ["-p", path]).toString("utf8");
    expect(text).not.toContain(FULL_ZOMATO_UTR);
    expect(text).not.toContain(PHONE);
    expect(text).toContain("ABCD");
    expect(text).toContain("900002");
  });
});

function hash(id: string): string {
  return createHmac("sha256", SALT).update(id).digest("hex");
}

function expected(platform: "zomato" | "swiggy", restaurantId: string) {
  return {
    platform,
    report: "payout" as const,
    restaurantId,
    name: "Test Kitchen",
    city: "Testcity",
    periodStart: platform === "swiggy" ? "2026-11-01" : "2026-11-02",
    periodEnd: platform === "swiggy" ? "2026-11-08" : "2026-11-09",
  };
}

function factsOf(payout: ParsedPayoutFile): {
  orders: PayoutOrderFact[];
  adjustments: PayoutAdjustmentFact[];
  cycles: PayoutCycleFact[];
} {
  return {
    orders: payout.orders.map((order) => ({
      platform: payout.cycleId.startsWith("swiggy") ? "swiggy" : "zomato",
      orderDate: order.orderDate,
      settlementStatus: order.settlementStatus,
      settlementDate: order.settlementDate,
      customerHash: order.customerHash,
      grossSalesPaise: order.grossSalesPaise,
      discountPaise: order.discountPaise,
      commissionPaise: order.commissionPaise,
      platformFeesPaise: order.platformFeesPaise,
      taxesPaise: order.taxesPaise,
      tdsPaise: order.tdsPaise,
      tcsPaise: order.tcsPaise,
      cvPaise: order.cvPaise,
      gstCollectedPaise: order.gstCollectedPaise,
      complaintsCancellationChargesPaise: order.complaintsCancellationChargesPaise,
      netPayoutPaise: order.netPayoutPaise,
    })),
    adjustments: payout.adjustments.map((row) => ({
      platform: payout.cycleId.startsWith("swiggy") ? "swiggy" : "zomato",
      type: row.type,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      amountPaise: row.amountPaise,
      bookedCycle: row.bookedCycle,
      settlementDate: payout.settlementDate,
      settlementStatus: payout.settlementStatus,
    })),
    cycles: [
      {
        platform: payout.cycleId.startsWith("swiggy") ? "swiggy" : "zomato",
        settlementStatus: payout.settlementStatus,
        settlementDate: payout.settlementDate,
        platformNetPayoutPaise: payout.totals.platformNetPayoutPaise,
      },
    ],
  };
}

function value(rows: Array<{ key: string; value: number | null }>, key: string): number | null {
  return rows.find((row) => row.key === key)?.value ?? null;
}
