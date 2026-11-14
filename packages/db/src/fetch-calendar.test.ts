import { addIsoDays, daysBetween, expectedPeriods } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { FetchPlanFacts } from "./fetch-calendar.js";
import { buildFetchPlan, chunkBackfill } from "./fetch-calendar.js";

function plan(overrides: Partial<FetchPlanFacts> & Pick<FetchPlanFacts, "date">) {
  return buildFetchPlan({
    outletId: "outlet-1",
    zomatoResId: "z-1",
    swiggyRid: "s-1",
    facts: [],
    fetches: [],
    orders: [],
    cycles: [],
    ...overrides,
  });
}

function of(
  result: ReturnType<typeof plan>,
  platform: "zomato" | "swiggy",
): ReturnType<typeof plan>["platforms"][number];
function of(
  result: ReturnType<typeof plan>,
  platform: "zomato" | "swiggy",
  report: "daily" | "weekly" | "monthly" | "payout",
): ReturnType<typeof plan>["platforms"][number]["windows"];
function of(
  result: ReturnType<typeof plan>,
  platform: "zomato" | "swiggy",
  report?: "daily" | "weekly" | "monthly" | "payout",
) {
  const found = result.platforms.find((item) => item.platform === platform);
  if (!found) throw new Error(`missing ${platform}`);
  return report ? found.windows.filter((window) => window.report === report) : found;
}

function spanDays(periodStart: string, periodEnd: string): number {
  return daysBetween(periodStart, periodEnd).length;
}

describe("fetch calendar", () => {
  it("keeps daily to yesterday and uses the same exclusive end as expectedPeriods", () => {
    const date = "2026-10-05";
    const result = plan({ date });
    const daily = of(result, "zomato", "daily").find((window) =>
      window.reasons.includes("scheduled"),
    );
    expect(daily).toEqual({
      report: "daily",
      reasons: ["scheduled"],
      periodStart: "2026-09-28",
      periodEnd: "2026-10-05",
    });
    const periods = expectedPeriods({
      platform: "zomato",
      report: "daily",
      restaurantId: "z-1",
      name: "North",
      city: "Pune",
      periodStart: daily?.periodStart ?? "",
      periodEnd: daily?.periodEnd ?? "",
    });
    expect(Array.isArray(periods)).toBe(true);
    if (Array.isArray(periods)) {
      expect(periods[0]?.start).toBe("2026-09-28");
      expect(periods.at(-1)?.end).toBe(date);
      expect(periods.some((period) => period.start === date)).toBe(false);
    }
    const swiggy = expectedPeriods({
      platform: "swiggy",
      report: "daily",
      restaurantId: "s-1",
      name: "North",
      city: "Pune",
      periodStart: "2026-09-28",
      periodEnd: "2026-10-05",
    });
    expect(Array.isArray(swiggy)).toBe(true);
  });

  it("schedules weekly and monthly only on their days", () => {
    const monday = plan({ date: "2026-10-05" });
    expect(of(monday, "zomato", "weekly")).toEqual([
      {
        report: "weekly",
        reasons: ["scheduled"],
        periodStart: "2026-09-28",
        periodEnd: "2026-10-05",
      },
    ]);
    expect(of(monday, "swiggy", "weekly")).toEqual([]);
    expect(of(monday, "zomato", "monthly")).toEqual([]);

    const tuesday = plan({ date: "2026-10-06" });
    expect(of(tuesday, "zomato", "weekly")).toEqual([]);
    expect(of(tuesday, "swiggy", "weekly")).toEqual([
      {
        report: "weekly",
        reasons: ["scheduled"],
        periodStart: "2026-09-27",
        periodEnd: "2026-10-04",
      },
    ]);

    const third = plan({ date: "2026-11-03" });
    expect(of(third, "zomato", "monthly")).toEqual([
      {
        report: "monthly",
        reasons: ["scheduled"],
        periodStart: "2026-10-01",
        periodEnd: "2026-11-01",
      },
    ]);
    expect(of(plan({ date: "2026-01-03" }), "swiggy", "monthly")[0]).toMatchObject({
      periodStart: "2025-12-01",
      periodEnd: "2026-01-01",
    });
    expect(of(plan({ date: "2026-11-04" }), "zomato", "monthly")).toEqual([]);
  });

  it("on Thursday returns the last four paid cycles, split Swiggy parts, and skips the open cycle", () => {
    const result = plan({
      date: "2026-10-08",
      cycles: [
        {
          platform: "zomato",
          periodStart: "2026-09-28",
          periodEnd: "2026-10-05",
          settlementStatus: "pending",
        },
        {
          platform: "zomato",
          periodStart: "2026-08-10",
          periodEnd: "2026-08-17",
          settlementStatus: "pending",
        },
        {
          platform: "swiggy",
          periodStart: "2026-09-01",
          periodEnd: "2026-09-08",
          settlementStatus: "pending",
        },
        {
          platform: "swiggy",
          periodStart: "2026-10-04",
          periodEnd: "2026-10-11",
          settlementStatus: "pending",
        },
        {
          platform: "swiggy",
          periodStart: "2026-08-01",
          periodEnd: "2026-08-08",
          settlementStatus: "settled",
        },
      ],
      facts: [
        {
          outletId: "outlet-1",
          platform: "swiggy",
          key: "lag_banner",
          date: "2026-08-02",
          value: null,
          valueBoolean: true,
          granularity: "day",
          periodEnd: "2026-08-03",
        },
      ],
    });
    expect(of(result, "zomato", "payout")).toEqual([
      {
        report: "payout",
        reasons: ["pending"],
        periodStart: "2026-08-10",
        periodEnd: "2026-08-17",
      },
      {
        report: "payout",
        reasons: ["scheduled"],
        periodStart: "2026-09-07",
        periodEnd: "2026-09-14",
      },
      {
        report: "payout",
        reasons: ["scheduled"],
        periodStart: "2026-09-14",
        periodEnd: "2026-09-21",
      },
      {
        report: "payout",
        reasons: ["scheduled"],
        periodStart: "2026-09-21",
        periodEnd: "2026-09-28",
      },
      {
        report: "payout",
        reasons: ["scheduled", "pending"],
        periodStart: "2026-09-28",
        periodEnd: "2026-10-05",
      },
    ]);
    expect(of(result, "swiggy", "payout")).toEqual([
      {
        report: "payout",
        reasons: ["lag_banner"],
        periodStart: "2026-08-01",
        periodEnd: "2026-08-08",
      },
      {
        report: "payout",
        reasons: ["pending"],
        periodStart: "2026-09-01",
        periodEnd: "2026-09-08",
      },
      {
        report: "payout",
        reasons: ["scheduled"],
        periodStart: "2026-09-13",
        periodEnd: "2026-09-20",
      },
      {
        report: "payout",
        reasons: ["scheduled"],
        periodStart: "2026-09-20",
        periodEnd: "2026-09-27",
      },
      {
        report: "payout",
        reasons: ["scheduled"],
        periodStart: "2026-09-27",
        periodEnd: "2026-10-01",
      },
      {
        report: "payout",
        reasons: ["scheduled"],
        periodStart: "2026-10-01",
        periodEnd: "2026-10-04",
      },
    ]);
    expect(of(plan({ date: "2026-10-02" }), "zomato", "payout")).toEqual([]);
    expect(of(plan({ date: "2026-10-02" }), "swiggy", "payout")).toEqual([]);
  });

  it("flags a missing platform id and does not invent windows", () => {
    const result = plan({ date: "2026-10-08", zomatoResId: "  ", swiggyRid: null });
    expect(result.platforms).toEqual([
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
    ]);
    const one = plan({ date: "2026-10-05", swiggyRid: " s-9 " });
    const swiggy = one.platforms.find((item) => item.platform === "swiggy");
    expect(swiggy?.platformId).toBe("s-9");
    expect(swiggy?.reason).toBeNull();
    expect(swiggy?.held).toBe(false);
    expect(swiggy?.windows.length).toBeGreaterThan(0);
  });

  it("returns no windows while a platform is held", () => {
    const result = plan({
      date: "2026-10-08",
      held: new Set<"zomato" | "swiggy">(["zomato"]),
    });
    const zomato = result.platforms.find((item) => item.platform === "zomato");
    expect(zomato).toMatchObject({ held: true, platformId: "z-1", windows: [] });
    const swiggy = result.platforms.find((item) => item.platform === "swiggy");
    expect(swiggy?.held).toBe(false);
    expect(swiggy?.windows.length).toBeGreaterThan(0);
  });

  it("does not spend the nightly backfill budget on a held platform", () => {
    const date = "2026-10-05";
    const horizon = addIsoDays(date, -90);
    const dailyStart = addIsoDays(date, -7);
    const openDays = daysBetween(horizon, dailyStart).length;
    const held = plan({ date, held: new Set<"zomato" | "swiggy">(["zomato"]) });
    const backfillDays = (platform: "zomato" | "swiggy") =>
      of(held, platform, "daily")
        .filter((window) => window.reasons.includes("backfill"))
        .flatMap((window) => daysBetween(window.periodStart, window.periodEnd));
    expect(backfillDays("zomato")).toEqual([]);
    expect(backfillDays("swiggy")).toHaveLength(openDays);
  });

  it("backfills gaps in chunks and stops at 90 days across both platforms", () => {
    const date = "2026-10-05";
    const horizon = addIsoDays(date, -90);
    const dailyStart = addIsoDays(date, -7);
    const result = plan({
      date,
      facts: [
        {
          outletId: "outlet-1",
          platform: "zomato",
          key: "delivered_orders",
          date: "2026-09-15",
          value: null,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-09-16",
        },
      ],
      fetches: [
        {
          outletId: "outlet-1",
          platform: "zomato",
          status: "stored",
          from: horizon,
          to: "2026-09-15",
        },
        {
          outletId: "outlet-1",
          platform: "zomato",
          status: "stored",
          from: "2026-09-18",
          to: "2026-09-19",
        },
        {
          outletId: "outlet-1",
          platform: "zomato",
          status: "stored",
          from: "2026-09-20",
          to: dailyStart,
        },
        {
          outletId: "outlet-1",
          platform: "zomato",
          status: "rejected_mismatch",
          from: "2026-09-19",
          to: "2026-09-20",
        },
        {
          outletId: "outlet-1",
          platform: "swiggy",
          status: "stored",
          from: horizon,
          to: dailyStart,
        },
      ],
      orders: [
        {
          outletId: "outlet-1",
          platform: "zomato",
          orderDate: "2026-09-16",
          settlementDate: null,
        },
      ],
    });
    expect(
      of(result, "zomato", "daily").filter((window) => window.reasons.includes("backfill")),
    ).toEqual([
      {
        report: "daily",
        reasons: ["backfill"],
        periodStart: "2026-09-15",
        periodEnd: "2026-09-16",
      },
      {
        report: "daily",
        reasons: ["backfill"],
        periodStart: "2026-09-17",
        periodEnd: "2026-09-18",
      },
      {
        report: "daily",
        reasons: ["backfill"],
        periodStart: "2026-09-19",
        periodEnd: "2026-09-20",
      },
    ]);
    expect(
      of(result, "swiggy", "daily").filter((window) => window.reasons.includes("backfill")),
    ).toEqual([]);

    const open = plan({ date });
    const backfillDays = (platform: "zomato" | "swiggy") =>
      of(open, platform, "daily")
        .filter((window) => window.reasons.includes("backfill"))
        .flatMap((window) => daysBetween(window.periodStart, window.periodEnd));
    const zomatoDays = backfillDays("zomato");
    const swiggyDays = backfillDays("swiggy");
    expect(zomatoDays.length + swiggyDays.length).toBe(90);
    expect(zomatoDays[0]).toBe(horizon);
    expect(swiggyDays[0]).toBe(horizon);
    expect(zomatoDays.some((day) => day >= dailyStart)).toBe(false);
    expect(swiggyDays.some((day) => day >= dailyStart)).toBe(false);
    for (const window of of(open, "zomato", "daily")) {
      if (window.reasons.includes("backfill"))
        expect(spanDays(window.periodStart, window.periodEnd)).toBeLessThanOrEqual(30);
    }
    for (const window of of(open, "swiggy", "daily")) {
      if (window.reasons.includes("backfill"))
        expect(spanDays(window.periodStart, window.periodEnd)).toBeLessThanOrEqual(7);
    }
  });

  it("prefers the older day, and Zomato on a tie, when the night is full", () => {
    const chunks = chunkBackfill(
      ["2026-01-02", "2026-01-03"],
      ["2026-01-01", "2026-01-02", "2026-01-03"],
      3,
    );
    expect(chunks.swiggy).toEqual([{ periodStart: "2026-01-01", periodEnd: "2026-01-03" }]);
    expect(chunks.zomato).toEqual([{ periodStart: "2026-01-02", periodEnd: "2026-01-03" }]);
  });
});
