import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { labelCollisions, normaliseLabel } from "./metric-label.js";
import { METRIC_LABEL_ALIASES, METRIC_LABEL_SLOTS, seedLabelBook } from "./metric-label-seed.js";
import { evaluateBusinessReport, parseCsv } from "./metric-parse.js";
import { parsePayoutWorkbook } from "./payout-parse.js";
import { swiggyWorkbookCsv, writeSwiggyWorkbook } from "./swiggy-workbook.js";

describe("metric label names", () => {
  it("folds currency, percent, comparisons, and minutes the same way", () => {
    expect(normaliseLabel("Sales (Rs)")).toBe("sales inr");
    expect(normaliseLabel("₹250")).toBe("inr 250");
    expect(normaliseLabel("INR")).toBe("inr");
    expect(normaliseLabel("Online %")).toBe("online pct");
    expect(normaliseLabel("Market share (%)")).toBe("market share pct");
    expect(normaliseLabel("percentage")).toBe("pct");
    expect(normaliseLabel("Delayed Orders (>5 mins)")).toBe("delayed orders gt 5 min");
    expect(normaliseLabel("Orders with <6 min Prep time")).toBe("orders with lt 6 min prep time");
    expect(normaliseLabel("9(5)")).toBe("9 5");
    expect(normaliseLabel("Packaging & Spillage")).toBe("packaging and spillage");
    expect(normaliseLabel("  Net   Sales ")).toBe("net sales");
  });

  it("keeps one meaning for each folded name in a platform report", () => {
    expect(labelCollisions(METRIC_LABEL_ALIASES)).toEqual([]);
    expect(new Set(METRIC_LABEL_SLOTS.map((slot) => slot.id)).size).toBe(METRIC_LABEL_SLOTS.length);
    expect(new Set(METRIC_LABEL_ALIASES.map((alias) => alias.id)).size).toBe(
      METRIC_LABEL_ALIASES.length,
    );
  });
});

const metricFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/metrics/${name}`, import.meta.url), "utf8");
const payoutFixture = (name: string) =>
  readFile(new URL(`../fixtures/payouts/${name}`, import.meta.url));

const swiggyDaily = {
  platform: "swiggy" as const,
  report: "daily" as const,
  restaurantId: "900001",
  name: "Test Kitchen",
  city: "Testcity",
  periodStart: "2026-11-02",
  periodEnd: "2026-11-09",
};
describe("label book parses the synthetic files the same way", () => {
  const book = seedLabelBook();

  it("reads each business fixture, including a workbook copy", () => {
    const files: Array<[string, Parameters<typeof evaluateBusinessReport>[1]]> = [
      ["swiggy_daily_sample.csv", swiggyDaily],
      [
        "swiggy_weekly_sample.csv",
        {
          platform: "swiggy",
          report: "weekly",
          restaurantId: "900001",
          name: "Test Kitchen",
          city: "Testcity",
          periodStart: "2026-10-11",
          periodEnd: "2026-11-08",
        },
      ],
      [
        "zomato_daily_sample.csv",
        {
          platform: "zomato",
          report: "daily",
          restaurantId: "900002",
          name: "Test Kitchen",
          city: "Testcity",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-08",
        },
      ],
      [
        "zomato_weekly_sample.csv",
        {
          platform: "zomato",
          report: "weekly",
          restaurantId: "900002",
          name: "Test Kitchen",
          city: "Testcity",
          periodStart: "2026-09-28",
          periodEnd: "2026-11-02",
        },
      ],
    ];
    for (const [name, expected] of files) {
      const csv = metricFixture(name);
      const hardcoded = evaluateBusinessReport(csv, expected);
      expect(hardcoded.ok).toBe(true);
      expect(evaluateBusinessReport(csv, expected, book)).toEqual(hardcoded);
    }
    const sheet = swiggyWorkbookCsv(
      writeSwiggyWorkbook(parseCsv(metricFixture("swiggy_daily_sample.csv"))),
    );
    expect(sheet).toBeTruthy();
    expect(evaluateBusinessReport(sheet ?? "", swiggyDaily, book)).toEqual(
      evaluateBusinessReport(sheet ?? "", swiggyDaily),
    );
  });

  it("reads each payout fixture the same way", async () => {
    for (const [name, platform] of [
      ["zomato-900002.xlsx", "zomato"],
      ["swiggy-900001.xlsx", "swiggy"],
      ["zomato-999002-wrong-outlet.xlsx", "zomato"],
      ["swiggy-999001-wrong-outlet.xlsx", "swiggy"],
    ] as const) {
      const bytes = await payoutFixture(name);
      const hardcoded = await parsePayoutWorkbook(bytes, platform, "fixture-salt");
      expect(hardcoded.ok).toBe(true);
      expect(await parsePayoutWorkbook(bytes, platform, "fixture-salt", book)).toEqual(hardcoded);
    }
  });
});
