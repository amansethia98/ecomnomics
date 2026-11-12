import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isoWeekRange } from "./metric-dates.js";
import {
  CROSS_PLATFORM_KEYS,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  metricDictionaryMarkdown,
  resolveCheck,
} from "./metric-dictionary.js";
import { checkObservedIdentity, evaluateBusinessReport, expectedPeriods } from "./metric-parse.js";
import type { RollupFact } from "./metric-rollup.js";
import { comparePlatformValue, rollupMetrics } from "./metric-rollup.js";
import { planReplaceWindow } from "./metric-window.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/metrics/${name}`, import.meta.url), "utf8");

const swiggyDaily = {
  platform: "swiggy" as const,
  report: "daily" as const,
  restaurantId: "900001",
  name: "Test Kitchen",
  city: "Testcity",
  periodStart: "2026-11-02",
  periodEnd: "2026-11-09",
};

function rowValue(
  rows: ReadonlyArray<{
    key: string;
    periodStart: string;
    rowRole: string;
    value: number | null;
    source?: string;
  }>,
  key: string,
  periodStart: string,
) {
  return rows.find((row) => row.key === key && row.periodStart === periodStart);
}

describe("business report parser", () => {
  it("reads the synthetic Swiggy daily file", () => {
    const parsed = evaluateBusinessReport(fixture("swiggy_daily_sample.csv"), swiggyDaily);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.granularity).toBe("day");
    const sales = rowValue(parsed.rows, "swiggy_net_sales_paise", "2026-11-02");
    expect(sales?.value).toBe(1_102_177);
    expect(sales?.rowRole).toBe("fact");
    expect(rowValue(parsed.rows, "delivered_orders", "2026-11-02")?.value).toBe(36);
    expect(rowValue(parsed.rows, "impressions", "2026-11-02")?.value).toBe(2676.06);
    expect(rowValue(parsed.rows, "menu_score", "2026-11-02")?.value).toBeNull();
  });

  it("reads the synthetic Zomato daily file and unswaps offer columns", () => {
    const parsed = evaluateBusinessReport(fixture("zomato_daily_sample.csv"), {
      platform: "zomato",
      report: "daily",
      restaurantId: "900002",
      name: "Test Kitchen",
      city: "Testcity",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-08",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(rowValue(parsed.rows, "delivered_orders", "2026-10-01")?.value).toBe(16);
    expect(rowValue(parsed.rows, "offer_orders", "2026-10-01")?.value).toBe(9);
    expect(rowValue(parsed.rows, "offer_gross_sales_paise", "2026-10-01")?.value).toBe(566_987);
  });

  it("reads Swiggy weeks and Zomato ISO weeks", () => {
    const swiggy = evaluateBusinessReport(fixture("swiggy_weekly_sample.csv"), {
      platform: "swiggy",
      report: "weekly",
      restaurantId: "900001",
      name: "Test Kitchen",
      city: "Testcity",
      periodStart: "2026-10-11",
      periodEnd: "2026-11-08",
    });
    expect(swiggy.ok).toBe(true);
    if (!swiggy.ok) return;
    expect(swiggy.granularity).toBe("week_sun_sat");
    const delivered = rowValue(swiggy.rows, "delivered_orders", "2026-10-11");
    expect(delivered?.rowRole).toBe("platform_check");
    expect(swiggy.rows.some((row) => row.key === "mfr_accurate_orders")).toBe(false);

    const week40 = isoWeekRange(2026, 40);
    const week44 = isoWeekRange(2026, 44);
    expect(week40?.start).toBe("2026-09-28");
    expect(week44?.end).toBe("2026-11-02");
    const zomato = evaluateBusinessReport(fixture("zomato_weekly_sample.csv"), {
      platform: "zomato",
      report: "weekly",
      restaurantId: "900002",
      name: "Test Kitchen",
      city: "Testcity",
      periodStart: week40?.start ?? "",
      periodEnd: week44?.end ?? "",
    });
    expect(zomato.ok).toBe(true);
    if (!zomato.ok) return;
    expect(zomato.granularity).toBe("week_mon_sun");
  });

  it("derives counts, skips a zero menu score, and nulls GMV when the discount is zero", () => {
    const csv = [
      "Restaurant ID,Restaurant name,Area,City,Overview,Metric,2nd Nov 2026,3rd Nov 2026",
      "900001.0,Test Kitchen,Testarea,Testcity,SALES,Delivered Orders,10,0",
      "900001.0,Test Kitchen,Testarea,Testcity,OPERATIONS,Food Ready Accuracy (MFR),14%,0%",
      "900001.0,Test Kitchen,Testarea,Testcity,MENU,Menu Score(Out of 100),0,40",
      "900001.0,Test Kitchen,Testarea,Testcity,DISCOUNTS,Discount Given by Restaurant(RDGMV),₹0,₹100",
      "900001.0,Test Kitchen,Testarea,Testcity,DISCOUNTS,Discount GMV %,12%,10%",
    ].join("\n");
    const parsed = evaluateBusinessReport(csv, {
      ...swiggyDaily,
      periodEnd: "2026-11-04",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const accurate = rowValue(parsed.rows, "mfr_accurate_orders", "2026-11-02");
    expect(accurate?.value).toBe(1);
    expect(accurate?.source).toBe("derived:round(mfr_pct*delivered_orders/100)");
    expect(rowValue(parsed.rows, "mfr_accurate_orders", "2026-11-03")?.value).toBe(0);
    expect(rowValue(parsed.rows, "menu_score", "2026-11-02")?.value).toBeNull();
    expect(rowValue(parsed.rows, "menu_score", "2026-11-03")?.value).toBe(40);
    expect(rowValue(parsed.rows, "swiggy_gmv_paise", "2026-11-02")?.value).toBeNull();
    expect(rowValue(parsed.rows, "swiggy_gmv_paise", "2026-11-03")?.value).toBe(100_000);
  });

  it("rejects a file for the wrong outlet or the wrong dates", () => {
    const csv = fixture("swiggy_daily_sample.csv");
    const wrongId = evaluateBusinessReport(csv, { ...swiggyDaily, restaurantId: "900009" });
    expect(wrongId.ok).toBe(false);
    if (!wrongId.ok) expect(wrongId.reason).toContain("900009");
    const shifted = csv.replace("2nd Nov 2026", "1st Nov 2026");
    const wrongDates = evaluateBusinessReport(shifted, swiggyDaily);
    expect(wrongDates.ok).toBe(false);
    if (!wrongDates.ok) expect(wrongDates.reason).toContain("2026-11-01");
  });

  it("caps a Swiggy daily request at 7 days and still checks a payout header", () => {
    const tooLong = expectedPeriods({ ...swiggyDaily, periodEnd: "2026-11-10" });
    expect(tooLong).toContain("at most 7 days");
    const monthly = evaluateBusinessReport(
      [
        "Restaurant ID,Restaurant name,Subzone,City,Overview,Metric,Oct 2026",
        "900002,Test Kitchen,Testarea,Testcity,Sales,Delivered orders,100",
      ].join("\n"),
      {
        platform: "zomato",
        report: "monthly",
        restaurantId: "900002",
        name: "Test Kitchen",
        city: "Testcity",
        periodStart: "2026-10-01",
        periodEnd: "2026-11-01",
      },
    );
    expect(monthly.ok).toBe(true);
    if (monthly.ok) expect(monthly.granularity).toBe("month");
    expect(
      checkObservedIdentity(
        {
          restaurantId: "900009",
          name: "Test Kitchen",
          city: "Testcity",
          periods: [{ start: "2026-10-05", end: "2026-10-12", label: "payout" }],
        },
        {
          platform: "zomato",
          report: "payout",
          restaurantId: "900002",
          name: "Test Kitchen",
          city: "Testcity",
          periodStart: "2026-10-05",
          periodEnd: "2026-10-12",
        },
      ),
    ).toContain("900009");
  });
});

describe("replace window", () => {
  const prior = {
    id: "row-1",
    key: "delivered_orders",
    periodStart: "2026-11-02",
    periodEnd: "2026-11-03",
    rowRole: "fact" as const,
    value: 10,
    source: "column:Delivered Orders",
  };

  it("leaves an unchanged value and nulls a key the new file dropped", () => {
    const same = planReplaceWindow([prior], [{ ...prior, source: "column:Delivered Orders" }]);
    expect(same.unchanged).toBe(1);
    expect(same.inserts).toHaveLength(0);
    const dropped = planReplaceWindow([prior], []);
    expect(dropped.supersedeIds).toEqual(["row-1"]);
    expect(dropped.inserts[0]?.value).toBeNull();
    expect(dropped.inserts[0]?.source).toBe("missing");
  });

  it("supersedes a changed value and does not treat a platform check as the same slot", () => {
    const changed = planReplaceWindow([prior], [{ ...prior, value: 12 }]);
    expect(changed.supersedeIds).toEqual(["row-1"]);
    expect(changed.inserts[0]?.value).toBe(12);
    const check = planReplaceWindow([prior], [{ ...prior, rowRole: "platform_check", value: 99 }]);
    expect(check.inserts.find((row) => row.rowRole === "platform_check")?.value).toBe(99);
    expect(check.inserts.find((row) => row.rowRole === "fact")?.value).toBeNull();
  });
});

function fact(
  key: string,
  day: string,
  value: number | null,
  platform: "zomato" | "swiggy" = "swiggy",
): RollupFact {
  return {
    key,
    platform,
    granularity: "day",
    periodStart: day,
    periodEnd: day,
    value,
    rowRole: "fact",
  };
}

describe("rollup", () => {
  const days = ["2026-11-02", "2026-11-03"];

  it("adds sums and weights ratios from the parts", () => {
    const rows = [
      fact("delivered_orders", days[0] ?? "", 1),
      fact("delivered_orders", days[1] ?? "", 3),
      fact("ops_sales_paise", days[0] ?? "", 100),
      fact("ops_sales_paise", days[1] ?? "", 900),
      fact("kpt_weighted_sum", days[0] ?? "", 10),
      fact("kpt_weighted_sum", days[1] ?? "", 90),
      fact("rating_snapshot_sum", days[0] ?? "", 4, "zomato"),
      fact("rating_snapshot_sum", days[1] ?? "", 2, "zomato"),
      fact("rating_snapshot_days", days[0] ?? "", 1, "zomato"),
      fact("rating_snapshot_days", days[1] ?? "", 1, "zomato"),
    ];
    const swiggy = rollupMetrics(rows, {
      platform: "swiggy",
      from: "2026-11-02",
      to: "2026-11-04",
      today: "2026-12-01",
      basis: "order_date",
    });
    const orders = swiggy.values.find((value) => value.key === "delivered_orders");
    expect(orders?.value).toBe(4);
    expect(orders?.accuracy).toBe("exact");
    const aov = swiggy.values.find((value) => value.key === "ops_aov_paise");
    expect(aov?.value).toBe(250);
    expect(aov?.coverageDays).toBe(2);
    expect(aov?.expectedDays).toBe(2);
    const kpt = swiggy.values.find((value) => value.key === "kpt_minutes");
    expect(kpt?.value).toBe(25);
    expect(kpt?.accuracy).toBe("approx");
    const zomato = rollupMetrics(rows, {
      platform: "zomato",
      from: "2026-11-02",
      to: "2026-11-04",
      today: "2026-12-01",
      basis: "order_date",
    });
    expect(zomato.values.find((value) => value.key === "rating")?.value).toBe(3);
  });

  it("returns platform-only figures only for an exact stored window", () => {
    const stored: RollupFact = {
      key: "offline_time_hours",
      platform: "zomato",
      granularity: "week_mon_sun",
      periodStart: "2026-09-28",
      periodEnd: "2026-10-05",
      value: 6,
      rowRole: "fact",
    };
    const exact = rollupMetrics([stored], {
      platform: "zomato",
      from: "2026-09-28",
      to: "2026-10-05",
      today: "2026-12-01",
      basis: "order_date",
    });
    const hit = exact.values.find((value) => value.key === "offline_time_hours");
    expect(hit?.status).toBe("ok");
    expect(hit?.value).toBe(6);
    expect(hit?.windowMatch).toBe(true);
    const custom = rollupMetrics([stored], {
      platform: "zomato",
      from: "2026-09-28",
      to: "2026-10-04",
      today: "2026-12-01",
      basis: "order_date",
    });
    const miss = custom.values.find((value) => value.key === "offline_time_hours");
    expect(miss?.status).toBe("not_available");
    expect(miss?.reason).toContain("matching day, week, or month");
  });

  it("combines only cross-platform keys and keeps settlement totals unavailable", () => {
    const rows = [
      fact("delivered_orders", "2026-11-02", 2, "zomato"),
      fact("delivered_orders", "2026-11-02", 3, "swiggy"),
      fact("cancelled_orders", "2026-11-02", 1, "zomato"),
      fact("cancelled_orders", "2026-11-02", 4, "swiggy"),
    ];
    const combined = rollupMetrics(rows, {
      platform: "combined",
      from: "2026-11-02",
      to: "2026-11-03",
      today: "2026-12-01",
      basis: "order_date",
    });
    expect(combined.values.map((value) => value.key)).toEqual([...CROSS_PLATFORM_KEYS]);
    expect(combined.values.find((value) => value.key === "delivered_orders")?.value).toBe(5);
    expect(
      combined.values.every((value) => value.accuracy === "exact" || value.accuracy === "approx"),
    ).toBe(true);
    const settlement = rollupMetrics([], {
      platform: "swiggy",
      from: "2026-11-02",
      to: "2026-11-03",
      today: "2026-12-01",
      basis: "settlement_date",
    });
    expect(settlement.values[0]?.status).toBe("not_available");
    expect(settlement.values[0]?.reason).toContain("payout orders");
  });
});

describe("platform checks", () => {
  it("flags a mismatch and excludes the rows that cannot be rebuilt", () => {
    expect(comparePlatformValue("delivered_orders", "swiggy", "week_sun_sat", 10, 10).action).toBe(
      "check",
    );
    const gap = comparePlatformValue("delivered_orders", "swiggy", "week_sun_sat", 10, 12);
    expect(gap.action).toBe("check");
    if (gap.action === "check") expect(gap.pass).toBe(false);
    const kpt = comparePlatformValue("kpt_minutes", "zomato", "week_mon_sun", 16.5, 16.54);
    expect(kpt.action).toBe("check");
    if (kpt.action === "check") expect(kpt.pass).toBe(true);
    expect(comparePlatformValue("cpc_ads_depth_pct", "swiggy", "month", 1, 2).action).toBe(
      "excluded",
    );
    expect(resolveCheck("offline_time_hours", "zomato", "week_mon_sun").mode).toBe("excluded");
    expect(comparePlatformValue("offline_time_hours", "zomato", "week_mon_sun", 1, 2).action).toBe(
      "skip",
    );
  });
});

describe("dictionary", () => {
  it("marks only delivered orders and the shared payout keys as cross-platform", () => {
    for (const key of METRIC_KEYS) {
      expect(METRIC_DEFINITIONS[key].crossPlatform).toBe(
        (CROSS_PLATFORM_KEYS as readonly string[]).includes(key),
      );
    }
    expect(metricDictionaryMarkdown()).toContain("delivered_orders");
    expect(metricDictionaryMarkdown()).toContain("non_refunded_complaints");
  });
});
