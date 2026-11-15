import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  decideWouldApply,
  detectBusinessLabels,
  detectPayoutLabels,
} from "./metric-label-change.js";
import { seedLabelBook } from "./metric-label-seed.js";
import { evaluateBusinessReport } from "./metric-parse.js";
import { parsePayoutWorkbook } from "./payout-parse.js";

const require = createRequire(import.meta.url);

const swiggyDaily = {
  platform: "swiggy" as const,
  report: "daily" as const,
  restaurantId: "900001",
  name: "Test Kitchen",
  city: "Testcity",
  periodStart: "2026-11-02",
  periodEnd: "2026-11-09",
};

const book = seedLabelBook();
const sample = readFileSync(
  new URL("../fixtures/metrics/swiggy_daily_sample.csv", import.meta.url),
  "utf8",
);

function ready(overrides: Partial<Parameters<typeof decideWouldApply>[0]> = {}) {
  return decideWouldApply({
    absentInSection: 1,
    unknownInSection: 1,
    samePlace: true,
    unitMatch: true,
    kindMatch: true,
    nameSimilar: true,
    aliasCollision: false,
    otherFinding: false,
    relationPass: true,
    continuityPass: false,
    summable: true,
    outlets: 2,
    files: 2,
    nights: 1,
    contradiction: false,
    allowAutoApply: true,
    switchOn: false,
    ...overrides,
  });
}

function withOutlets(ruleInput: Parameters<typeof decideWouldApply>[0]) {
  return decideWouldApply({ ...ruleInput, outlets: 2, files: 2, switchOn: false });
}

describe("label change decisions", () => {
  it("would apply a single rename while the switch stays off", () => {
    const decision = ready();
    expect(decision.wouldApply).toBe(true);
    expect(decision.ruleResults.A9).toBe(false);
    expect(decision.reasons.join(" ")).toContain("ECOMNOMICS_LABEL_AUTO_APPLY");
    expect(decision.confidence).toBe("high");
  });

  it("does not apply when two new labels share a section", () => {
    const decision = ready({ unknownInSection: 2, absentInSection: 2 });
    expect(decision.wouldApply).toBe(false);
    expect(decision.ruleResults.A1).toBe(false);
  });

  it("checks a percentage with a relation instead of a sum", () => {
    const decision = ready({ summable: false, relationPass: true, continuityPass: false });
    expect(decision.ruleResults.A6).toBe(true);
    expect(decision.wouldApply).toBe(true);
    const summed = ready({ summable: true, relationPass: false });
    expect(summed.ruleResults.A6).toBe(false);
    expect(summed.wouldApply).toBe(false);
  });

  it("refuses a label that is already an alias", () => {
    const decision = ready({ aliasCollision: true });
    expect(decision.wouldApply).toBe(false);
    expect(decision.ruleResults.A5).toBe(false);
  });
});

describe("business label detection", () => {
  it("keeps an unchanged Swiggy file free of pending rows", () => {
    const parsed = evaluateBusinessReport(sample, swiggyDaily, book);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.labelDetection).toBeUndefined();
    expect(parsed.rows.every((row) => row.state === "ok")).toBe(true);
  });

  it("stores a renamed Carts Builds row as pending and would apply", () => {
    const renamed = sample
      .replaceAll("Carts Builds", "Cart Builds")
      .replace("Menu to Cart,19.51%", "Menu to Cart,33.87%");
    const parsed = evaluateBusinessReport(renamed, swiggyDaily, book);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const carts = parsed.rows.filter((row) => row.key === "cart_builds");
    expect(carts.length).toBeGreaterThan(0);
    expect(carts.every((row) => row.state === "pending_label" && row.value == null)).toBe(true);
    const finding = parsed.labelDetection?.findings.find((item) =>
      item.slotId.endsWith("cart_builds"),
    );
    expect(finding?.candidateLabel).toBe("Cart Builds");
    expect(finding?.kind).toBe("metric_label_change");
    expect(finding?.evidence.valueEvidence.min).not.toBeNull();
    const decision = finding ? withOutlets(finding.ruleInput) : ready({ relationPass: false });
    expect(decision.wouldApply).toBe(true);
    expect(decision.ruleResults.A9).toBe(false);
    expect(book.aliases.some((alias) => alias.label === "Cart Builds")).toBe(false);
  });

  it("does not apply when the section has two new labels", () => {
    const renamed = sample
      .replaceAll("Carts Builds", "Cart Builds")
      .replaceAll("Orders Placed", "Orders Sent");
    const parsed = evaluateBusinessReport(renamed, swiggyDaily, book);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const findings =
      parsed.labelDetection?.findings.filter((item) => item.kind === "metric_label_change") ?? [];
    expect(findings.length).toBeGreaterThan(1);
    expect(findings.every((item) => withOutlets(item.ruleInput).wouldApply === false)).toBe(true);
    expect(
      parsed.rows.some((row) => row.key === "cart_builds" && row.state === "pending_label"),
    ).toBe(true);
    expect(
      parsed.rows.some(
        (row) => row.key === "swiggy_funnel_orders" && row.state === "pending_label",
      ),
    ).toBe(true);
  });

  it("uses the funnel relation for a renamed percentage", () => {
    const opens = [431, 544, 317, 298, 316, 364, 190];
    const carts = [146, 111, 79, 111, 65, 97, 61];
    const pcts = opens.map((open, index) => `${((carts[index] ?? 0) / open) * 100}`).join("%,");
    const renamed = sample.replace(/Menu to Cart,[^\n]+/, `Menu to Cart Pct,${pcts}%`);
    const parsed = evaluateBusinessReport(renamed, swiggyDaily, book);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const finding = parsed.labelDetection?.findings.find((item) =>
      item.slotId.endsWith("menu_to_cart"),
    );
    expect(finding?.summable).toBe(false);
    expect(finding?.ruleInput.relationPass).toBe(true);
    expect(finding ? withOutlets(finding.ruleInput).wouldApply : false).toBe(true);
    expect(
      parsed.rows.some((row) => row.key === "menu_to_cart_pct" && row.state === "pending_label"),
    ).toBe(true);
  });

  it("keeps the days that still use the old label", () => {
    const lines = sample.split("\n");
    const original = lines.find((line) => line.includes("Carts Builds")) ?? "";
    const body = lines.map((line) => {
      if (!line.includes("Carts Builds")) return line;
      const cells = line.split(",");
      return cells.map((cell, index) => (index > 7 ? "" : cell)).join(",");
    });
    const added = original
      .split(",")
      .map((cell, index) => (index > 5 && index <= 7 ? "" : cell))
      .join(",")
      .replace("Carts Builds", "Cart Builds");
    const parsed = evaluateBusinessReport([...body, added].join("\n"), swiggyDaily, book);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const carts = parsed.rows.filter((row) => row.key === "cart_builds");
    expect(carts.some((row) => row.state === "ok" && row.value != null)).toBe(true);
    expect(carts.some((row) => row.state === "pending_label" && row.value == null)).toBe(true);
  });

  it("does not treat a Swiggy label as a Zomato rename", () => {
    const present = [
      ["Sales", "Delivered orders", 20],
      ["Sales", "Sales (Rs)", 100],
      ["Customer funnel", "Impressions", 400],
      ["Customer funnel", "Menu opens", 80],
      ["Customer experience", "Rated orders", 4],
    ] as const;
    const detection = detectBusinessLabels({
      platform: "zomato",
      reportKind: "daily",
      book,
      periods: 1,
      expectedLabels: new Set([
        ...present.map(([section, metric]) => `${section}\t${metric}`),
        "Customer funnel\tCart builds",
      ]),
      rows: [
        ...present.map(([section, metric, value], index) => ({
          section,
          metric,
          rowIndex: index + 1,
          cells: [{ value, kind: "number" }],
        })),
        {
          section: "Customer funnel",
          metric: "Cart build",
          rowIndex: present.length + 1,
          cells: [{ value: 10, kind: "number" }],
        },
        {
          section: "CONVERSION_FUNNEL",
          metric: "Cart Builds",
          rowIndex: present.length + 2,
          cells: [{ value: 12, kind: "number" }],
        },
      ],
    });
    expect(detection.findings.every((item) => item.platform === "zomato")).toBe(true);
    expect(detection.findings.some((item) => item.section === "CONVERSION_FUNNEL")).toBe(false);
    expect(detection.findings.some((item) => item.candidateLabel === "Cart build")).toBe(true);
  });

  it("records an alias collision and does not add the alias", () => {
    const before = book.aliases.length;
    const parsed = evaluateBusinessReport(
      sample.replaceAll("Carts Builds", "Orders"),
      swiggyDaily,
      book,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const finding = parsed.labelDetection?.findings.find((item) =>
      item.slotId.endsWith("cart_builds"),
    );
    expect(finding?.ruleInput.aliasCollision).toBe(true);
    expect(finding ? withOutlets(finding.ruleInput).wouldApply : true).toBe(false);
    expect(book.aliases).toHaveLength(before);
  });

  it("rejects more than ten unrecognised labels as a layout change", () => {
    const present = [
      ["SALES", "Net Sales", 100],
      ["SALES", "Delivered Orders", 10],
      ["SALES", "Restaurant Cancelled Orders", 0],
      ["SALES", "Cancelled Order Loss", 0],
    ] as const;
    const detection = detectBusinessLabels({
      platform: "swiggy",
      reportKind: "daily",
      book,
      periods: 1,
      expectedLabels: new Set(present.map(([section, metric]) => `${section}\t${metric}`)),
      rows: [
        ...present.map(([section, metric, value], index) => ({
          section,
          metric,
          rowIndex: index + 1,
          cells: [{ value, kind: "number" as const }],
        })),
        ...Array.from({ length: 11 }, (_, index) => ({
          section: "SALES",
          metric: `New metric ${index + 1}`,
          rowIndex: present.length + index + 1,
          cells: [{ value: 1, kind: "number" as const }],
        })),
      ],
    });
    expect(detection.layoutReason).toContain("ten");
    expect(detection.pending).toHaveLength(0);
    expect(detection.findings[0]?.kind).toBe("layout_change");
  });

  it("keeps a one-metric file as a partial extract", () => {
    const csv = [
      "Restaurant ID,Restaurant name,Area,City,Overview,Metric,1st Oct 2026,3rd Oct 2026",
      "900001.0,Test Kitchen,Testarea,Testcity,SALES,Delivered Orders,4,6",
    ].join("\n");
    const parsed = evaluateBusinessReport(
      csv,
      {
        ...swiggyDaily,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-04",
      },
      book,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.labelDetection?.layoutReason ?? null).toBeNull();
    const delivered = parsed.rows.filter((row) => row.key === "delivered_orders");
    expect(delivered.some((row) => row.state === "ok" && row.value === 4)).toBe(true);
    expect(delivered.some((row) => row.state === "pending_label")).toBe(false);
  });

  it("rejects an unreadable header as a layout change", () => {
    const parsed = evaluateBusinessReport("not a report", swiggyDaily, book);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.layout).toBe(true);
    expect(parsed.identity).toBe(false);
  });
});

describe("payout label columns", () => {
  it("skips the order rebuild when one formula column was renamed", async () => {
    const headers = [
      "Order ID",
      "Order date",
      "Order status",
      "Item total",
      "Packaging charge",
      "Discount",
      "Commission Fee",
      "Total Swiggy fees",
      "GST on service fee",
      "TDS",
      "TCS",
      "Complaint and cancellation charges",
      "Net bill",
      "Settlement date",
      "Cancelled by",
      "Category",
      "Settlement status",
      "UTR",
      "MFR pressed",
      "MFR accurate",
      "GST collected",
      "Net payout",
      "Amount settled",
    ];
    const bytes = await workbook(
      [
        headers,
        [
          "9200001",
          "2026-10-25",
          "Delivered",
          "100",
          "0",
          "0",
          "10",
          "0",
          "0",
          "0",
          "0",
          "0",
          "100",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "0",
          "90",
          "90",
        ],
      ],
      (file) => {
        const breakup = file.addWorksheet("Payout Breakup");
        breakup.addRow(["", "Particular", "Total"]);
        breakup.addRow(["", "Commission", "10"]);
        breakup.addRow(["", "Swiggy fees", "10"]);
      },
    );
    const parsed = await parsePayoutWorkbook(bytes, "swiggy", null, book);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payout.checks.some((check) => check.key === "net_payout_paise")).toBe(false);
    const skipped = parsed.payout.skippedChecks?.map((check) => check.key) ?? [];
    expect(skipped).toContain("net_payout_paise");
    expect(skipped).toContain("commission_paise");
    expect(skipped).toContain("platform_fees_paise");
    expect(parsed.payout.skippedChecks?.every((check) => check.reason === "pending_label")).toBe(
      true,
    );
    const finding = parsed.payout.labelFindings?.find((item) => item.slotId.endsWith("commission"));
    expect(parsed.payout.orders[0]?.commissionPaise).toBeNull();
    expect(parsed.payout.orders[0]?.pendingFields).toContain("commissionPaise");
    expect(parsed.payout.orders[0]?.netPayoutPaise).toBe(9000);
    expect(finding?.candidateLabel).toBe("Commission Fee");
    expect(finding?.evidence.valueEvidence).toEqual({
      method: "none",
      count: 0,
      min: null,
      max: null,
      median: null,
    });
    expect(JSON.stringify(finding?.evidence)).not.toContain("9200001");
  });

  it("treats a renamed order date as a layout change before reading rows", async () => {
    const bytes = await workbook([
      ["Order ID", "Order day", "Order status", "Item total", "Net payout"],
      ["9200002", "2026-10-25", "Delivered", "100", "100"],
    ]);
    const parsed = await parsePayoutWorkbook(bytes, "swiggy", null, book);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.layout).toBe(true);
    expect(parsed.reason).toContain("key column");
  });

  it("treats a missing order id column as a layout change", async () => {
    const bytes = await workbook([
      ["Bill", "Order Date", "Item Total"],
      ["9200002", "2026-10-25", "100"],
    ]);
    const parsed = await parsePayoutWorkbook(bytes, "swiggy", null, book);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.layout).toBe(true);
  });

  it("treats a wide payout sheet that is missing most columns as a layout change", () => {
    const headers = [
      "Order ID",
      "Order date",
      "Order status",
      "Mystery one",
      "Mystery two",
      "Mystery three",
    ];
    const columns = [
      { slotId: "swiggy.payout_annexure.order_level.order_id", index: 0 },
      { slotId: "swiggy.payout_annexure.order_level.order_date", index: 1 },
      { slotId: "swiggy.payout_annexure.order_level.order_status", index: 2 },
      { slotId: "swiggy.payout_annexure.order_level.item_total", index: null },
      { slotId: "swiggy.payout_annexure.order_level.commission", index: null },
      { slotId: "swiggy.payout_annexure.order_level.net_payout", index: null },
    ];
    const detected = detectPayoutLabels({
      platform: "swiggy",
      reportKind: "payout_annexure",
      section: "order_level",
      book,
      headers,
      columns,
    });
    expect(detected.layoutReason).toBeTruthy();
    expect(detected.findings[0]?.kind).toBe("layout_change");
    expect(JSON.stringify(detected.findings[0]?.evidence)).not.toContain("9200001");
  });

  it("does not store payout cell values on a finding", () => {
    const detected = detectPayoutLabels({
      platform: "swiggy",
      reportKind: "payout_annexure",
      section: "order_level",
      book,
      headers: ["Order ID", "Commission Fee"],
      columns: [
        { slotId: "swiggy.payout_annexure.order_level.order_id", index: 0 },
        { slotId: "swiggy.payout_annexure.order_level.commission", index: null },
      ],
    });
    expect(detected.findings[0]?.evidence.valueEvidence.min).toBeNull();
    expect(detected.findings[0]?.evidence.valueEvidence.max).toBeNull();
    expect(detected.findings[0]?.evidence.valueEvidence.median).toBeNull();
  });
});

function workbook(
  rows: unknown[][],
  extra?: (file: { addWorksheet(name: string): { addRow(values: unknown[]): void } }) => void,
): Promise<Uint8Array> {
  const { Workbook } = require("exceljs") as {
    Workbook: new () => {
      addWorksheet(name: string): { addRow(values: unknown[]): void };
      xlsx: { writeBuffer(): Promise<ArrayBuffer> };
    };
  };
  const file = new Workbook();
  const summary = file.addWorksheet("Summary");
  for (const line of [
    "Test Kitchen",
    "Test Area",
    "Testcity",
    "Rest. ID - 900001",
    "25 October - 31 October",
  ]) {
    summary.addRow([line]);
  }
  const orders = file.addWorksheet("Order Level");
  for (const row of rows) orders.addRow(row);
  extra?.(file);
  return file.xlsx.writeBuffer().then((buffer) => new Uint8Array(buffer));
}
