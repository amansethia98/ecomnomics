import { expect, it } from "vitest";
import type { DashReading, OwnerDashboardInput } from "./owner-dashboard.js";
import { composeOwnerDashboard, dashboardPlots } from "./owner-dashboard.js";

function week(
  from: string,
  platform: "zomato" | "swiggy",
  key: string,
  value: number | null,
  state: DashReading["state"] = "ok",
): DashReading {
  return { from, grain: "week", platform, key, value, state };
}

function day(
  from: string,
  platform: "zomato" | "swiggy",
  key: string,
  value: number | null,
  state: DashReading["state"] = "ok",
): DashReading {
  return { from, grain: "day", platform, key, value, state };
}

const weeks = [
  "2026-08-31",
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
  "2026-11-02",
  "2026-11-09",
  "2026-11-16",
];

function salesWeeks(platform: "zomato" | "swiggy", values: number[]): DashReading[] {
  const key = platform === "zomato" ? "ops_sales_paise" : "swiggy_net_sales_paise";
  return weeks.map((from, index) => week(from, platform, key, values[index] ?? values.at(-1) ?? 0));
}

function input(
  readings: DashReading[],
  over: Partial<OwnerDashboardInput> = {},
): OwnerDashboardInput {
  return {
    today: "2026-11-17",
    range: "7d",
    from: "2026-11-10",
    to: "2026-11-17",
    platform: "both",
    holidays: [],
    readings,
    historyDays: 90,
    ...over,
  };
}

it("leaves the unfinished week on the chart and out of the trend", () => {
  const rising = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 20];
  const dash = composeOwnerDashboard(
    input(
      [
        ...salesWeeks("zomato", rising),
        ...salesWeeks(
          "swiggy",
          rising.map((value) => value / 2),
        ),
      ],
      { today: "2026-11-18" },
    ),
  );
  expect(dash.panels[0]?.points.at(-1)?.sales).toBe(20);
  expect(dash.shadeWeek).toBe("2026-11-16");
  expect(dash.answer.direction).toBe("up");
  expect(dash.answer.dipped).toBeNull();
  expect(dash.tiles.find((tile) => tile.id === "sales")?.word).not.toBe("falling");
});

it("draws two sales panels, each with its own trend line, and shades the last week", () => {
  const dash = composeOwnerDashboard(
    input([
      ...salesWeeks("zomato", [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210]),
      ...salesWeeks("swiggy", [40, 40, 42, 41, 40, 39, 40, 41, 40, 38, 36, 34]),
    ]),
  );
  expect(dash.panels.map((panel) => panel.platform)).toEqual(["zomato", "swiggy"]);
  expect(dash.panels[0]?.points).toHaveLength(12);
  expect(dash.panels[0]?.points[0]?.sales).toBe(100);
  expect(dash.shadeWeek).toBe("2026-11-16");
  expect(dash.answer.direction).toBe("up");
  expect(dash.onePlatform).toBe(false);
  const plots = dashboardPlots(dash);
  const zomato = plots.find((plot) => plot.id === "sales-zomato");
  expect(zomato?.marks.map((mark) => mark.type)).toEqual(["rectY", "lineY", "linearRegressionY"]);
  expect(zomato?.marks[1]?.options?.stroke).toBe("var(--owner-zomato)");
  expect(plots.some((plot) => plot.marks.some((mark) => mark.type === "cell"))).toBe(true);
});

it("numbers festival, discount, and offline weeks", () => {
  const readings = [
    ...salesWeeks("zomato", [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 80]),
    ...salesWeeks("swiggy", [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]),
    week("2026-10-26", "zomato", "discount_paise", 500),
    week("2026-11-02", "zomato", "discount_paise", 0),
    week("2026-11-09", "swiggy", "online_pct", 40),
  ];
  const dash = composeOwnerDashboard(input(readings, { holidays: ["2026-10-28"] }));
  expect(dash.pins.map((pin) => pin.kind)).toEqual(["festival", "discount", "offline"]);
  expect(dash.pins.map((pin) => pin.n)).toEqual([1, 2, 3]);
  expect(dash.tiles.find((tile) => tile.id === "sales")?.festival).toBe(false);
});

it("leaves a pending day out of both sides and says so", () => {
  const readings: DashReading[] = [];
  for (let offset = 0; offset < 14; offset += 1) {
    const date = `2026-11-${String(3 + offset).padStart(2, "0")}`;
    readings.push(day(date, "zomato", "ops_sales_paise", 1000));
    readings.push(day(date, "zomato", "delivered_orders", 10));
    readings.push(
      day(
        date,
        "swiggy",
        "swiggy_net_sales_paise",
        offset === 13 ? null : 500,
        offset === 13 ? "pending" : "ok",
      ),
    );
    readings.push(
      day(
        date,
        "swiggy",
        "delivered_orders",
        offset === 13 ? null : 5,
        offset === 13 ? "pending" : "ok",
      ),
    );
  }
  const dash = composeOwnerDashboard(
    input([
      ...readings,
      ...salesWeeks("zomato", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      ...salesWeeks("swiggy", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    ]),
  );
  expect(dash.pendingNote).toBe("swiggy");
  expect(dash.compared).toEqual({ kept: 6, expected: 6 });
  const monday = dash.heatmap.find((cell) => cell.week === "2026-11-16" && cell.weekday === "Mon");
  expect(monday?.pending).toBe(true);
  expect(monday?.orders).toBeNull();
});

it("marks a gap and withholds a comparison until a week of history exists", () => {
  const readings = [
    week("2026-11-16", "zomato", "ops_sales_paise", null, "missing"),
    day("2026-11-16", "zomato", "ops_sales_paise", 100),
    day("2026-11-15", "zomato", "delivered_orders", 4),
  ];
  const dash = composeOwnerDashboard(
    input(readings, { platform: "zomato", historyDays: 3, holidays: ["2026-11-16"] }),
  );
  expect(dash.missingNote).toBe("2026-11-16");
  expect(dash.comparisonsStart).toBe("2026-11-22");
  expect(dash.tiles.find((tile) => tile.id === "sales")?.changePct).toBeNull();
  expect(dash.onePlatform).toBe(true);
  expect(dash.panels).toHaveLength(1);
  expect(dash.tiles.find((tile) => tile.id === "rating")?.state).not.toBe("not_in_report");
});

it("says rating is not in Swiggy's report, and that no ads ran", () => {
  const readings = [
    ...salesWeeks("swiggy", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
    week("2026-11-09", "swiggy", "cpc_sales_paise", 0),
    week("2026-11-09", "swiggy", "cpc_spend_paise", 0),
    week("2026-11-16", "swiggy", "cpc_sales_paise", 0),
    week("2026-11-16", "swiggy", "cpc_spend_paise", 0),
  ];
  const dash = composeOwnerDashboard(
    input(readings, { platform: "swiggy", range: "4w", from: "2026-10-20", to: "2026-11-17" }),
  );
  expect(dash.tiles.find((tile) => tile.id === "rating")?.state).toBe("not_in_report");
  expect(dash.tiles.find((tile) => tile.id === "ads")?.state).toBe("no_ads");
  expect(dashboardPlots(dash).some((plot) => plot.id === "sales-zomato")).toBe(false);
});

it("builds the funnel from menu, cart, and orders, and pins the plot marks", () => {
  const readings = [
    ...salesWeeks("zomato", [80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 160]),
    week("2026-11-16", "zomato", "impressions", 1000),
    week("2026-11-16", "zomato", "menu_opens", 137),
    week("2026-11-16", "zomato", "cart_builds", 46),
    week("2026-11-16", "zomato", "placed_orders", 34),
    week("2026-11-09", "zomato", "discount_paise", 0),
    week("2026-11-02", "zomato", "online_pct", 96),
  ];
  const dash = composeOwnerDashboard(
    input(readings, {
      platform: "zomato",
      range: "12w",
      from: "2026-08-25",
      to: "2026-11-17",
      holidays: ["2026-11-12"],
    }),
  );
  const menu = dash.funnel.find((series) => series.step === "menu")?.points.at(-1);
  expect(menu?.pct).toBeCloseTo(13.7);
  const plots = dashboardPlots(dash);
  const sales = plots.find((plot) => plot.id === "sales-zomato");
  expect(sales?.marks.some((mark) => mark.type === "ruleX")).toBe(true);
  expect(sales?.marks.some((mark) => mark.type === "text")).toBe(true);
  expect(dash.pins.some((pin) => pin.kind === "festival")).toBe(true);
  expect(dash.pins.some((pin) => pin.kind === "discount")).toBe(false);
  expect(dash.tiles.find((tile) => tile.id === "sales")?.word).toBe("growing");
});
