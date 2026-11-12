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

const ZOMATO_UTR = "TESTUTRAA000201";
const LATER_UTR = "TESTUTRAA000299";
const SWIGGY_UTR = "TESTUTRBB000101";
const CUSTOMER_ID = "772e82626b52819280a7878e9e250599c432b79a94e7d9d5504b6ea52b1332ad";
const PAN = "AABCT9000A";
const SALT = "fixture-salt";
const ZOMATO_NET = 922098;
const ZOMATO_PAID = 957098;
const SWIGGY_PAYOUT = 1054387;

const fixture = (name: string) => readFile(new URL(`../fixtures/payouts/${name}`, import.meta.url));

describe("payout workbooks", () => {
  it("parses the Zomato settlement file, including the prior-week adjustment", async () => {
    const parsed = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", SALT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payout = parsed.payout;
    expect(payout.cycleId).toBe("zomato:900002:2026-10-26:2026-11-02");
    expect(payout.observed).toMatchObject({
      restaurantId: "900002",
      name: "Test Kitchen",
      city: "Testcity",
    });
    expect(payout.orders).toHaveLength(33);
    expect(payout.orders.filter((order) => order.orderStatus === "DELIVERED")).toHaveLength(30);
    expect(payout.orders.filter((order) => order.orderStatus === "CANCELLED")).toHaveLength(2);
    expect(payout.orders.filter((order) => order.orderStatus === "REJECTED")).toHaveLength(1);
    expect(payout.settlementDate).toBe("2026-11-04");
    expect(payout.utrLast4).toBe("0201");
    const later = payout.orders.find((order) => order.settlementDate === "2026-11-11");
    expect(later).toMatchObject({ utrLast4: "0299", settlementStatus: "settled" });
    expect(payout.orders[0]?.customerHash).toBe(hash(CUSTOMER_ID));
    expect(payout.adjustments).toEqual([
      expect.objectContaining({
        type: "ADS",
        invoiceId: "80110201",
        periodFrom: "2026-10-26",
        periodTo: "2026-11-02",
        amountPaise: 240000,
      }),
      expect.objectContaining({
        type: "Previous week adjustment",
        invoiceId: "80110200",
        periodFrom: "2026-10-19",
        periodTo: "2026-10-26",
        amountPaise: 35000,
      }),
    ]);
    expect(payout.totals.orderCount).toBe(33);
    expect(payout.totals.platformNetPayoutPaise).toBe(ZOMATO_NET);
    expect(payout.totals.paidAmountPaise).toBe(ZOMATO_PAID);
    expect(payout.checks.every((check) => check.pass)).toBe(true);
    const text = JSON.stringify(payout);
    expect(text).not.toContain(ZOMATO_UTR);
    expect(text).not.toContain(LATER_UTR);
    expect(text).not.toContain(CUSTOMER_ID);
    expect(text).not.toContain(PAN);
  });

  it("parses the Swiggy annexure, keeping train and Toing on the summary payout", async () => {
    const parsed = await parsePayoutWorkbook(await fixture("swiggy-900001.xlsx"), "swiggy", SALT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payout = parsed.payout;
    expect(payout.cycleId).toBe("swiggy:900001:2026-10-25:2026-11-01");
    expect(payout.observed).toMatchObject({
      restaurantId: "900001",
      name: "Test Kitchen",
      city: "Testcity",
      area: "Testarea",
    });
    expect(payout.orders).toHaveLength(39);
    expect(payout.orders.filter((order) => order.category === "TRAIN_ORDER")).toHaveLength(1);
    expect(payout.orders.filter((order) => order.category === "Toing")).toHaveLength(7);
    expect(payout.orders.every((order) => order.settlementStatus === "settled")).toBe(true);
    expect(payout.orders.filter((order) => order.settlementDate === "2026-11-11")).toHaveLength(1);
    expect(payout.settlementDate).toBe("2026-11-03");
    expect(payout.utrLast4).toBe("0101");
    expect(payout.orders[0]).toMatchObject({
      mfrMarked: true,
      mfrAccurate: false,
      customerHash: null,
    });
    expect(payout.adjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "HyperBoost",
          amountPaise: 180000,
          invoiceId: "261104TK80100101",
        }),
        expect.objectContaining({ type: "Top Picks - Ads", amountPaise: 40000 }),
        expect.objectContaining({ type: "Ads Offers", amountPaise: 20000 }),
        expect.objectContaining({
          type: "Brandverse Social Media Marketing",
          amountPaise: 30000,
          periodFrom: "2026-10-25",
          periodTo: "2026-11-01",
        }),
        expect.objectContaining({
          type: "Previous week adjustment",
          amountPaise: 25000,
          periodFrom: "2026-10-18",
          periodTo: "2026-10-25",
        }),
      ]),
    );
    expect(payout.adjustments).toHaveLength(5);
    expect(payout.totals.orderCount).toBe(39);
    expect(payout.totals.platformNetPayoutPaise).toBe(SWIGGY_PAYOUT);
    expect(payout.totals.paidAmountPaise).toBe(SWIGGY_PAYOUT);
    expect(payout.checks.every((check) => check.pass)).toBe(true);
    expect(JSON.stringify(payout)).not.toContain(SWIGGY_UTR);
  });

  it("rejects a wrong outlet id and warns on a different name", async () => {
    const wrongSwiggy = await parsePayoutWorkbook(
      await fixture("swiggy-999001-wrong-outlet.xlsx"),
      "swiggy",
      SALT,
    );
    expect(wrongSwiggy.ok).toBe(true);
    if (!wrongSwiggy.ok) return;
    const rejectedSwiggy = checkObservedIdentity(
      wrongSwiggy.payout.observed,
      expected("swiggy", "900001"),
    );
    expect(rejectedSwiggy.reject).toBe("The file is for restaurant 999001, not 900001.");

    const wrongZomato = await parsePayoutWorkbook(
      await fixture("zomato-999002-wrong-outlet.xlsx"),
      "zomato",
      SALT,
    );
    expect(wrongZomato.ok).toBe(true);
    if (!wrongZomato.ok) return;
    const rejectedZomato = checkObservedIdentity(
      wrongZomato.payout.observed,
      expected("zomato", "900002"),
    );
    expect(rejectedZomato.reject).toBe("The file is for restaurant 999002, not 900002.");

    const named = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", SALT);
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    const warned = checkObservedIdentity(
      named.payout.observed,
      expected("zomato", "900002", "Other Kitchen"),
    );
    expect(warned.reject).toBeNull();
    expect(warned.warnings).toContain("The file names Test Kitchen, not Other Kitchen.");
  });

  it("keeps a settled Swiggy cycle and omits customer hashes without a salt", async () => {
    const swiggy = await parsePayoutWorkbook(await fixture("swiggy-900001.xlsx"), "swiggy", null);
    expect(swiggy.ok).toBe(true);
    if (!swiggy.ok) return;
    expect(swiggy.payout.settlementStatus).toBe("settled");
    expect(swiggy.payout.settlementDate).toBe("2026-11-03");
    expect(swiggy.payout.utrLast4).toBe("0101");
    const unsalted = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", null);
    expect(unsalted.ok).toBe(true);
    if (!unsalted.ok) return;
    expect(unsalted.payout.warnings).toContain(
      "Customer hashes were not stored because CUSTOMER_HASH_SALT is not set.",
    );
    expect(unsalted.payout.orders.every((order) => order.customerHash == null)).toBe(true);
    const unread = readPayoutWindow({
      platform: "zomato",
      basis: "settlement_date",
      from: "2026-11-04",
      to: "2026-11-05",
      ...factsOf(unsalted.payout),
    });
    expect(unread.values.find((row) => row.key === "unique_customers")?.reason).toBe(
      "Distinct customers need the stored customer hash.",
    );
  });

  it("splits settlement and order dates, and counts a prior-week adjustment once", async () => {
    const zomato = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", SALT);
    expect(zomato.ok).toBe(true);
    if (!zomato.ok) return;
    const facts = factsOf(zomato.payout);
    const onSettlementDay = facts.orders.filter((order) => order.settlementDate === "2026-11-04");
    const settled = readPayoutWindow({
      platform: "zomato",
      basis: "settlement_date",
      from: "2026-11-04",
      to: "2026-11-05",
      ...facts,
    });
    const adjustmentTotal = facts.adjustments.reduce((total, row) => total + row.amountPaise, 0);
    expect(value(settled.values, "net_payout_paise")).toBe(
      onSettlementDay.reduce((total, order) => total + order.netPayoutPaise, 0) - adjustmentTotal,
    );
    expect(value(settled.values, "platform_net_payout_paise")).toBe(ZOMATO_NET);
    expect(value(settled.values, "paid_amount_paise")).toBe(ZOMATO_PAID);
    expect(value(settled.values, "unique_customers")).toBeGreaterThan(1);
    expect(settled.gap).toMatchObject({
      settledFromEarlierPaise: onSettlementDay.reduce(
        (total, order) => total + order.netPayoutPaise,
        0,
      ),
      notYetSettledPaise: 0,
      adjustmentsPaise: adjustmentTotal,
    });
    expect(settled.provisional).toBe(false);

    const ordered = readPayoutWindow({
      platform: "zomato",
      basis: "order_date",
      from: "2026-10-26",
      to: "2026-11-02",
      ...facts,
    });
    expect(value(ordered.values, "net_payout_paise")).toBe(
      facts.orders.reduce((total, order) => total + order.netPayoutPaise, 0),
    );
    expect(value(ordered.values, "ad_spend_paise")).toBe(240000);
    expect(value(ordered.values, "paid_amount_paise")).toBeNull();
    expect(ordered.values.find((row) => row.key === "paid_amount_paise")?.reason).toBe(
      "The platform's cycle total is a settlement figure.",
    );
    expect(ordered.gap).toMatchObject({ notYetSettledPaise: 0, adjustmentsPaise: 240000 });

    const prior = readPayoutWindow({
      platform: "zomato",
      basis: "order_date",
      from: "2026-10-19",
      to: "2026-10-26",
      ...facts,
    });
    expect(prior.gap.adjustmentsPaise).toBe(35000);
    expect(value(prior.values, "net_payout_paise")).toBe(0);

    const priorSettlement = readPayoutWindow({
      platform: "zomato",
      basis: "settlement_date",
      from: "2026-10-19",
      to: "2026-10-26",
      ...facts,
    });
    expect(priorSettlement.gap.adjustmentsPaise).toBe(0);

    const rollup = rollupMetrics(
      [],
      {
        platform: "zomato",
        from: "2026-11-04",
        to: "2026-11-05",
        today: "2026-12-01",
        basis: "settlement_date",
      },
      facts,
    );
    expect(rollup.gap?.adjustmentsPaise).toBe(adjustmentTotal);
    expect(rollup.values.find((row) => row.key === "delivered_orders")?.reason).toBe(
      "This figure is not part of the settlement-date payout.",
    );
    const swiggy = rollupMetrics(
      [],
      {
        platform: "swiggy",
        from: "2026-11-04",
        to: "2026-11-05",
        today: "2026-12-01",
        basis: "settlement_date",
      },
      facts,
    );
    expect(swiggy.values.find((row) => row.key === "unique_customers")?.reason).toBe(
      "Distinct customers are counted from Zomato payout orders.",
    );
  });

  it("redacts the full UTR, PAN, and customer id before the file is kept", async () => {
    const original = await fixture("zomato-900002.xlsx");
    const redacted = await redactPayoutWorkbook(original);
    const dir = await mkdtemp(join(tmpdir(), "payout-redact-"));
    const path = join(dir, "redacted.xlsx");
    await writeFile(path, redacted);
    const text = execFileSync("unzip", ["-p", path]).toString("utf8");
    expect(text).not.toContain(ZOMATO_UTR);
    expect(text).not.toContain(LATER_UTR);
    expect(text).not.toContain(CUSTOMER_ID);
    expect(text).not.toContain(PAN);
    expect(text).toContain("0201");
    expect(text).toContain("900002");
  });

  it("keeps an earlier business total when that window has no payout orders", async () => {
    const parsed = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", SALT);
    if (!parsed.ok) throw new Error(parsed.reason);
    const rollup = rollupMetrics(
      [
        {
          key: "gross_sales_paise",
          platform: "zomato",
          granularity: "day",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-02",
          value: 10000,
          rowRole: "fact",
        },
      ],
      {
        platform: "zomato",
        from: "2026-10-01",
        to: "2026-10-02",
        today: "2026-12-01",
        basis: "order_date",
      },
      factsOf(parsed.payout),
    );
    expect(rollup.values.find((row) => row.key === "gross_sales_paise")?.value).toBe(10000);
    expect(rollup.gap).toBeUndefined();
  });

  it("keeps the other platform's business total beside a payout day", async () => {
    const parsed = await parsePayoutWorkbook(await fixture("zomato-900002.xlsx"), "zomato", SALT);
    if (!parsed.ok) throw new Error(parsed.reason);
    const dayGross = parsed.payout.orders
      .filter((order) => order.orderDate === "2026-10-26")
      .reduce((total, order) => total + order.grossSalesPaise, 0);
    expect(dayGross).toBeGreaterThan(0);
    const rollup = rollupMetrics(
      [
        {
          key: "gross_sales_paise",
          platform: "swiggy",
          granularity: "day",
          periodStart: "2026-10-26",
          periodEnd: "2026-10-27",
          value: 5000,
          rowRole: "fact",
        },
      ],
      {
        platform: "combined",
        from: "2026-10-26",
        to: "2026-10-27",
        today: "2026-12-01",
        basis: "order_date",
      },
      factsOf(parsed.payout),
    );
    expect(rollup.values.find((row) => row.key === "gross_sales_paise")?.value).toBe(
      5000 + dayGross,
    );
  });
});

function hash(id: string): string {
  return createHmac("sha256", SALT).update(id).digest("hex");
}

function expected(platform: "zomato" | "swiggy", restaurantId: string, name = "Test Kitchen") {
  return {
    platform,
    report: "payout" as const,
    restaurantId,
    name,
    city: "Testcity",
    periodStart: platform === "swiggy" ? "2026-10-25" : "2026-10-26",
    periodEnd: platform === "swiggy" ? "2026-11-01" : "2026-11-02",
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
      paidAmountPaise: order.paidAmountPaise,
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
        paidAmountPaise: payout.totals.paidAmountPaise,
      },
    ],
  };
}

function value(rows: Array<{ key: string; value: number | null }>, key: string): number | null {
  return rows.find((row) => row.key === key)?.value ?? null;
}
