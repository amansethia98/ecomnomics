import { expect, it } from "vitest";
import { addDays, formatCount } from "./ops/format.js";
import type { DashReading, OwnerDashboardInput } from "./owner-dashboard.js";
import {
  composeOwnerDashboard,
  dashboardPlots,
  dashReadingState,
  funnelHeadline,
  incomparableFunnelDays,
  lastCompleteWeekChange,
  ownerRupeeAxis,
  resolveOwnerPlot,
} from "./owner-dashboard.js";

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

it("drops an unfinished week from the chart", () => {
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
      { today: "2026-11-18", range: "12w", from: "2026-08-26", to: "2026-11-18" },
    ),
  );
  expect(dash.panels[0]?.points.at(-1)?.week).toBe("2026-11-09");
  expect(dash.panels[0]?.points.at(-1)?.sales).toBe(200);
  expect(dash.panels[0]?.points.some((point) => point.week === "2026-11-16")).toBe(false);
  expect(dash.shadeWeek).toBe("2026-11-09");
  expect(dash.answer.pct).toBe(dash.tiles.find((tile) => tile.id === "sales")?.changePct ?? null);
  expect(dash.answer.dipped).toBeNull();
  const salesWord = dash.tiles.find((tile) => tile.id === "sales");
  expect(salesWord?.word === "falling").toBe((salesWord?.changePct ?? 0) < -3);
});

it("draws two sales panels, each with its own trend line, and shades the last week", () => {
  const dash = composeOwnerDashboard(
    input(
      [
        ...salesWeeks("zomato", [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210]),
        ...salesWeeks("swiggy", [40, 40, 42, 41, 40, 39, 40, 41, 40, 38, 36, 34]),
      ],
      { range: "12w", from: "2026-08-26", to: "2026-11-17" },
    ),
  );
  expect(dash.panels.map((panel) => panel.platform)).toEqual(["zomato", "swiggy"]);
  expect(dash.panels[0]?.points).toHaveLength(12);
  expect(dash.panels[0]?.points.find((point) => point.week === "2026-08-31")?.sales).toBe(100);
  expect(dash.panels[0]?.points.some((point) => point.week === "2026-11-16")).toBe(false);
  expect(dash.shadeWeek).toBe("2026-11-09");
  expect(dash.periodPhrase).toBe("in 12 weeks");
  expect(dash.answer.pct).toBe(dash.tiles.find((tile) => tile.id === "sales")?.changePct ?? null);
  expect(dash.onePlatform).toBe(false);
  const plots = dashboardPlots(dash);
  const salesPlot = plots.find((plot) => plot.id === "sales-zomato");
  const swiggyPlot = plots.find((plot) => plot.id === "sales-swiggy");
  expect(salesPlot?.marks.filter((mark) => mark.type === "lineY")).toHaveLength(1);
  expect(swiggyPlot?.marks.filter((mark) => mark.type === "lineY")).toHaveLength(1);
  expect(salesPlot?.marks.some((mark) => mark.type === "areaY")).toBe(true);
  const trend = salesPlot?.marks.find((mark) => mark.type === "linearRegressionY");
  expect(trend?.options?.ci).toBe(0);
  const shade = salesPlot?.marks.find((mark) => mark.type === "rect");
  expect(JSON.stringify(shade?.data)).toContain("2026-11-09");
  expect(JSON.stringify(shade?.data)).toContain("2026-11-16");
  const domain = salesPlot?.x?.domain as string[] | undefined;
  expect((domain?.[1] ?? "") >= "2026-11-16").toBe(true);
  expect(salesPlot?.y?.domain).not.toEqual(swiggyPlot?.y?.domain);
  expect(salesPlot?.marks.some((mark) => mark.type === "rect")).toBe(true);
  expect(salesPlot?.y?.format).toBe("inr");
  expect(salesPlot?.marks.some((mark) => mark.options?.stroke === "var(--owner-zomato)")).toBe(
    true,
  );
  expect(swiggyPlot?.marks.some((mark) => mark.options?.stroke === "var(--owner-swiggy)")).toBe(
    true,
  );
  expect(salesPlot?.x?.ticks).toHaveLength(4);
  expect(JSON.stringify(salesPlot)).not.toContain("tickFormat");
  const rupees = resolveOwnerPlot(salesPlot ?? plots[0]!).y?.tickFormat as
    | ((value: number) => string)
    | undefined;
  expect(rupees?.(2_700_000)).toBe("₹27k");
  const label = salesPlot?.marks.find(
    (mark) => mark.type === "text" && JSON.stringify(mark.data).includes("/wk"),
  );
  expect(label?.options?.textAnchor).toBe("end");
  const heatmap = plots.find((plot) => plot.id === "heatmap");
  expect(heatmap?.y?.domain).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
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
  const dash = composeOwnerDashboard(
    input(readings, {
      holidays: ["2026-11-08"],
      range: "12w",
      from: "2026-08-26",
      to: "2026-11-17",
    }),
  );
  expect(dash.pins.map((pin) => pin.kind)).toEqual(["festival", "discount", "offline"]);
  expect(dash.pins[0]?.label).toBe("Diwali");
  expect(dash.pins.map((pin) => pin.n)).toEqual([1, 2, 3]);
  expect(dash.tiles.find((tile) => tile.id === "sales")?.festival).toBe(true);
  const marked = dashboardPlots(dash).flatMap((plot) =>
    plot.marks.flatMap((mark) =>
      mark.type === "text"
        ? (mark.data as Array<{ n?: string }>).flatMap((row) => (row.n ? [row.n] : []))
        : [],
    ),
  );
  expect(marked).toEqual(expect.arrayContaining(["1", "2", "3"]));
});

it("combines both apps for the last day's dip", () => {
  const readings = [
    day("2026-11-13", "zomato", "ops_sales_paise", 200),
    day("2026-11-13", "swiggy", "swiggy_net_sales_paise", 200),
    day("2026-11-20", "zomato", "ops_sales_paise", 180),
    day("2026-11-20", "swiggy", "swiggy_net_sales_paise", 40),
  ];
  const dash = composeOwnerDashboard(
    input(readings, { today: "2026-11-21", from: "2026-11-14", to: "2026-11-21" }),
  );
  expect(dash.answer.dipped?.pct).toBeCloseTo(-45);
  expect(dash.answer.dipped?.against).toBe("last Friday");
});

it("shows the weekly menu headline on a short range and a long one", () => {
  const starts = ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"];
  const opens = [400, 300, 200, 100];
  const readings = starts.flatMap((start, index) => [
    week(start, "zomato", "ops_sales_paise", 1000),
    week(start, "zomato", "impressions", 1000),
    week(start, "zomato", "menu_opens", opens[index] ?? 100),
    week(start, "zomato", "cart_builds", 50),
    week(start, "zomato", "placed_orders", 20),
  ]);
  const shared = {
    platform: "zomato" as const,
    today: "2026-11-22",
    from: "2026-10-26",
    to: "2026-11-23",
  };
  const four = composeOwnerDashboard(input(readings, { ...shared, range: "4w" }));
  const twelve = composeOwnerDashboard(
    input(readings, { ...shared, range: "12w", from: "2026-08-31" }),
  );
  expect(four.funnelLine).toContain("down 4 weeks in a row");
  expect(twelve.funnelLine).toBe(four.funnelLine);
});

it("calls a rating rise of a few tenths improving", () => {
  const readings = [
    ...salesWeeks(
      "zomato",
      Array.from({ length: 12 }, () => 100),
    ),
    ...weeks.map((from) => week(from, "zomato", "rating", from < "2026-10-12" ? 4 : 4.4)),
  ];
  const dash = composeOwnerDashboard(
    input(readings, {
      platform: "zomato",
      range: "12w",
      from: "2026-08-26",
      to: "2026-11-17",
    }),
  );
  const rating = dash.tiles.find((tile) => tile.id === "rating");
  expect((rating?.changePct ?? 0) >= 0.1).toBe(true);
  expect(rating?.word).toBe("improving");
});

it("says when the menu step falls three weeks in a row", () => {
  expect(
    funnelHeadline([
      {
        step: "menu",
        platform: "zomato",
        points: [{ pct: 30 }, { pct: 20 }, { pct: 10 }],
      },
    ]),
  ).toBe("Zomato: fewer people who see you open your menu, down 3 weeks in a row");
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
  expect(dash.answer.pendingPlatform).toBe("swiggy");
  expect(dash.panels[0]?.points).toHaveLength(7);
  expect(dash.panels[0]?.points[0]?.week).toBe("2026-11-10");
  expect(dash.answer.unit).toBe("day");
  const sales = dash.tiles.find((tile) => tile.id === "sales");
  expect(sales?.state).toBe("value");
  expect(sales?.value).toBe(10_000);
  const orders = dash.tiles.find((tile) => tile.id === "orders");
  expect(orders?.state).toBe("value");
  expect(orders?.value).toBe(100);
  expect(dash.answer.pct).toBe(sales?.changePct ?? null);
  expect(dash.periodPhrase).toBe("last 7 days vs the same 7 days before");
  expect(dash.compared).toBeNull();
  const plots = dashboardPlots(dash);
  const salesPlot = plots.find((plot) => plot.id === "sales-swiggy");
  const pending = salesPlot?.marks.filter(
    (mark) => mark.type === "text" && JSON.stringify(mark.data).includes("Swiggy pending"),
  );
  expect(pending).toHaveLength(1);
  expect(JSON.stringify(pending?.[0]?.data)).toContain("2026-11-16");
  const bands = salesPlot?.marks.filter((mark) => mark.type === "rect") ?? [];
  expect(bands).toHaveLength(1);
  expect(bands[0]?.data?.[0]).toMatchObject({ x1: "2026-11-16", x2: "2026-11-17" });
  const ticks = (salesPlot?.x?.ticks ?? []) as string[];
  expect(ticks.every((tick) => tick <= "2026-11-16")).toBe(true);
  expect(dash.heatmap.some((cell) => cell.week === "2026-11-16")).toBe(false);
  expect(dash.heatmap.some((cell) => cell.week === "2026-11-09")).toBe(true);
});

it("marks a gap and withholds a comparison until a week of history exists", () => {
  const readings = [
    day("2026-11-16", "zomato", "ops_sales_paise", null, "missing"),
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
  expect(dashboardPlots(dash).filter((plot) => plot.id === "sales-swiggy")).toHaveLength(1);
});

it("builds the funnel from menu, cart, and orders, and pins the plot marks", () => {
  const readings = [
    ...salesWeeks("zomato", [80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 160]),
    week("2026-11-09", "zomato", "impressions", 1000),
    week("2026-11-09", "zomato", "menu_opens", 137),
    week("2026-11-09", "zomato", "cart_builds", 46),
    week("2026-11-09", "zomato", "placed_orders", 34),
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
  const salesTile = dash.tiles.find((tile) => tile.id === "sales");
  expect(salesTile?.word === "growing").toBe((salesTile?.changePct ?? 0) > 3);
});

it("names the app whose last complete day is behind, even when an older week is pending", () => {
  const readings: DashReading[] = [
    ...salesWeeks("zomato", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]).map((row, index) =>
      index === 0 ? { ...row, value: null, state: "pending" as const } : row,
    ),
    ...salesWeeks("swiggy", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
  ];
  for (let offset = 0; offset < 14; offset += 1) {
    const date = `2026-11-${String(3 + offset).padStart(2, "0")}`;
    readings.push(day(date, "zomato", "ops_sales_paise", 1000));
    readings.push(
      day(
        date,
        "swiggy",
        "swiggy_net_sales_paise",
        offset === 13 ? null : 500,
        offset === 13 ? "pending" : "ok",
      ),
    );
  }
  const dash = composeOwnerDashboard(
    input(readings, { range: "12w", from: "2026-08-26", to: "2026-11-17" }),
  );
  expect(dash.answer.pendingPlatform).toBe("swiggy");
  expect(dash.pendingNote).toBe("swiggy");
  expect(dash.answer.unit).toBe("week");
  expect(dash.panels[0]?.points).toHaveLength(12);
  expect(dash.answer.pct).toBe(dash.tiles.find((tile) => tile.id === "sales")?.changePct ?? null);
  expect(dash.periodPhrase).toBe("in 12 weeks");
});

it("shows a dash when a metric was not in the report, and keeps a real zero", () => {
  expect(dashReadingState({ status: "ok", value: null, coverageDays: 0, provisional: false })).toBe(
    "missing",
  );
  expect(dashReadingState({ status: "ok", value: 100, coverageDays: 0, provisional: false })).toBe(
    "missing",
  );
  expect(dashReadingState({ status: "ok", value: 0, coverageDays: 3, provisional: false })).toBe(
    "ok",
  );
  const missing = composeOwnerDashboard(
    input(
      [
        day("2026-11-16", "zomato", "ops_sales_paise", 1000),
        day("2026-11-16", "swiggy", "swiggy_net_sales_paise", 500),
        day("2026-11-16", "zomato", "rejected_orders", null, "missing"),
        day("2026-11-16", "zomato", "online_pct", null, "missing"),
      ],
      { range: "7d", from: "2026-11-10", to: "2026-11-17" },
    ),
  );
  expect(missing.tiles.find((tile) => tile.id === "rejected")?.state).toBe("not_in_report");
  expect(missing.tiles.find((tile) => tile.id === "rejected")?.value).toBeNull();
  expect(missing.tiles.find((tile) => tile.id === "rejected")?.changePct).toBeNull();
  expect(missing.tiles.find((tile) => tile.id === "online")?.state).toBe("not_in_report");
  const zero = composeOwnerDashboard(
    input(
      [
        day("2026-11-10", "zomato", "ops_sales_paise", 1000),
        day("2026-11-03", "zomato", "ops_sales_paise", 1000),
        day("2026-11-10", "zomato", "rejected_orders", 0),
        day("2026-11-03", "zomato", "rejected_orders", 4),
      ],
      { platform: "zomato", range: "7d", from: "2026-11-10", to: "2026-11-17" },
    ),
  );
  const rejected = zero.tiles.find((tile) => tile.id === "rejected");
  expect(rejected?.state).toBe("value");
  expect(rejected?.value).toBe(0);
});

it("names the busiest weekdays and the funnel drop from the data", () => {
  const readings: DashReading[] = [];
  for (const week of ["2026-11-02", "2026-11-09"]) {
    for (let offset = 0; offset < 7; offset += 1) {
      const date = `2026-11-${String(2 + offset + (week === "2026-11-09" ? 7 : 0)).padStart(2, "0")}`;
      const orders = offset >= 4 ? 40 : 10;
      readings.push(day(date, "zomato", "delivered_orders", orders));
      readings.push(day(date, "zomato", "ops_sales_paise", 1000));
    }
    readings.push(weekStart(week, "impressions", 1000 - (week === "2026-11-09" ? 0 : 0)));
    readings.push(weekStart(week, "menu_opens", week === "2026-11-02" ? 400 : 200));
    readings.push(weekStart(week, "cart_builds", 80));
    readings.push(weekStart(week, "placed_orders", 40));
  }
  const dash = composeOwnerDashboard(
    input(readings, {
      platform: "zomato",
      range: "4w",
      from: "2026-10-20",
      to: "2026-11-17",
    }),
  );
  expect(dash.heatmapLine).toMatch(/Fri and Sat|Sat and Sun|best day/);
  expect(dash.heatmap.map((cell) => cell.weekday)).toContain("Mon");
  const funnel = dashboardPlots(dash).find((plot) => plot.id === "funnel-menu");
  expect(funnel?.marks.map((mark) => mark.options?.stroke)).toEqual(["var(--owner-zomato)"]);
  const heat = dashboardPlots(dash).find((plot) => plot.id === "heatmap");
  expect(heat?.color?.type).toBe("sqrt");
  expect(heat?.color?.scheme).toBe("purples");
  const orders = dash.heatmap.flatMap((cell) =>
    cell.orders != null && cell.orders > 0 ? [cell.orders] : [],
  );
  const domain = heat?.color?.domain as [number, number] | undefined;
  expect(domain?.[0]).toBeLessThan(Math.min(...orders));
  expect(domain?.[1]).toBe(Math.max(...orders));
  expect(heat?.y?.domain).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
});

it("compares every tile on the same days as sales, and the tag follows that change", () => {
  const readings: DashReading[] = [];
  for (let offset = 0; offset < 14; offset += 1) {
    const date = `2026-11-${String(3 + offset).padStart(2, "0")}`;
    const inWindow = offset >= 7;
    const reported = inWindow && offset < 12;
    readings.push(day(date, "zomato", "ops_sales_paise", 1_000));
    readings.push(
      day(
        date,
        "swiggy",
        "swiggy_net_sales_paise",
        reported || !inWindow ? 500 : null,
        reported || !inWindow ? "ok" : "pending",
      ),
    );
    if (reported) {
      readings.push(day(date, "zomato", "delivered_orders", 4));
      readings.push(day(date, "swiggy", "delivered_orders", 6));
    } else if (!inWindow) {
      readings.push(day(date, "zomato", "delivered_orders", 20));
      readings.push(day(date, "swiggy", "delivered_orders", 20));
    }
  }
  const dash = composeOwnerDashboard(input(readings));
  const orders = dash.tiles.find((tile) => tile.id === "orders");
  expect(orders?.value).toBe(5 * 10);
  expect(orders?.changePct).toBeCloseTo(-75);
  expect(orders?.basis).toBe("last 7 days vs the same 7 days before");
  expect(orders?.word).toBe("falling");
  expect(orders?.weeks).toBe(0);
  expect(orders?.span).toBe("7 days");
  expect(orders?.splits.reduce((sum, split) => sum + (split.value ?? 0), 0)).toBe(5 * 10);
});

it("leaves a missing app out of that day's baseline", () => {
  const readings: DashReading[] = [];
  for (let offset = 0; offset < 14; offset += 1) {
    const date = `2026-11-${String(3 + offset).padStart(2, "0")}`;
    const missing = date === "2026-11-16";
    readings.push(day(date, "zomato", "ops_sales_paise", 1_000));
    readings.push(day(date, "zomato", "delivered_orders", 10));
    if (!missing) {
      readings.push(day(date, "swiggy", "swiggy_net_sales_paise", 500));
      readings.push(day(date, "swiggy", "delivered_orders", 20));
    }
  }
  const dash = composeOwnerDashboard(input(readings));
  const orders = dash.tiles.find((tile) => tile.id === "orders");
  const sales = dash.tiles.find((tile) => tile.id === "sales");
  expect(orders?.value).toBe(190);
  expect(orders?.changePct).toBeCloseTo(0);
  expect(sales?.value).toBe(10_000);
  expect(sales?.changePct).toBe(dash.answer.pct);
  expect(orders?.splits.reduce((sum, split) => sum + (split.value ?? 0), 0)).toBe(190);
  expect(orders?.span).toBe("7 days");
});

it("compares the last four weeks with the first four inside twelve weeks", () => {
  const readings: DashReading[] = [];
  for (let index = 0; index < 13; index += 1) {
    const from = addDays("2026-08-17", index * 7);
    const value = index >= 1 && index <= 4 ? 100 : index >= 9 ? 150 : 120;
    readings.push(week(from, "zomato", "ops_sales_paise", value));
  }
  const dash = composeOwnerDashboard(
    input(readings, {
      platform: "zomato",
      today: "2026-11-22",
      range: "12w",
      from: "2026-08-24",
      to: "2026-11-16",
    }),
  );
  const sales = dash.tiles.find((tile) => tile.id === "sales");
  expect(dash.panels[0]?.points.some((point) => point.week === "2026-11-16")).toBe(false);
  expect(dash.panels[0]?.points.at(-1)?.week).toBe("2026-11-09");
  expect(sales?.span).toBe("12 weeks");
  expect(dash.compared).toBeNull();
  expect(sales?.changePct).toBeCloseTo(50);
  expect(sales?.value).toBe(4 * 100 + 4 * 120 + 4 * 150);
  expect(dash.answer.pct).toBeCloseTo(50);
  expect(dash.periodPhrase).toBe("in 12 weeks");
});

it("keeps a 7-day window ending on the last day with sales", () => {
  const readings: DashReading[] = [];
  for (let offset = 0; offset < 14; offset += 1) {
    const date = addDays("2026-11-07", offset);
    const swiggyPending = date === "2026-11-20";
    readings.push(day(date, "zomato", "ops_sales_paise", 1_000));
    readings.push(
      day(
        date,
        "swiggy",
        "swiggy_net_sales_paise",
        swiggyPending ? null : 500,
        swiggyPending ? "pending" : "ok",
      ),
    );
  }
  const dash = composeOwnerDashboard(
    input(readings, { today: "2026-11-22", from: "2026-11-16", to: "2026-11-23" }),
  );
  expect(dash.panels[0]?.points.map((point) => point.week)).toEqual([
    "2026-11-14",
    "2026-11-15",
    "2026-11-16",
    "2026-11-17",
    "2026-11-18",
    "2026-11-19",
    "2026-11-20",
  ]);
  const sales = dash.tiles.find((tile) => tile.id === "sales");
  expect(sales?.value).toBe(7 * 1_000 + 6 * 500);
  expect(sales?.changePct).toBeCloseTo(0);
  expect(dash.periodPhrase).toBe("last 7 days vs the same 7 days before");
  const pending = dashboardPlots(dash)
    .find((plot) => plot.id === "sales-swiggy")
    ?.marks.find(
      (mark) => mark.type === "text" && JSON.stringify(mark.data).includes("Swiggy pending"),
    );
  expect(JSON.stringify(pending?.data)).toContain("2026-11-20");
});

it("uses one last-complete-week change for the subtitle", () => {
  const readings = [
    week("2026-11-09", "zomato", "ops_sales_paise", 90),
    week("2026-11-02", "zomato", "ops_sales_paise", 100),
    week("2026-11-09", "swiggy", "swiggy_net_sales_paise", 90),
    week("2026-11-02", "swiggy", "swiggy_net_sales_paise", 100),
  ];
  const shared = lastCompleteWeekChange(readings, ["zomato", "swiggy"], "2026-11-22");
  const dash = composeOwnerDashboard(
    input(readings, {
      today: "2026-11-22",
      range: "4w",
      from: "2026-10-26",
      to: "2026-11-23",
    }),
  );
  expect(shared?.pct).toBeCloseTo(-10);
  expect(shared?.from).toBe("2026-11-09");
  expect(shared?.to).toBe("2026-11-15");
  expect(dash.answer.dipped?.pct).toBeCloseTo(shared?.pct ?? 0);
  expect(dash.answer.dipped?.against).toBe("9–15 Nov");
});

it("does not invent a Swiggy rating", () => {
  const readings = [
    ...salesWeeks("zomato", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
    ...salesWeeks("swiggy", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
    week("2026-11-09", "zomato", "rating", 4.3),
    week("2026-11-02", "zomato", "rating", 4.3),
  ];
  const dash = composeOwnerDashboard(
    input(readings, { range: "4w", from: "2026-10-20", to: "2026-11-17" }),
  );
  const rating = dash.tiles.find((tile) => tile.id === "rating");
  expect(rating?.value).toBeCloseTo(4.3);
  expect(rating?.splits.find((split) => split.platform === "swiggy")?.value).toBeNull();
  expect(rating?.splits.find((split) => split.platform === "swiggy")?.inReport).toBe(false);
});

it("leaves an app with sales and zero spend out of ad sales per rupee", () => {
  const readings = [
    day("2026-11-16", "zomato", "ops_sales_paise", 1_000),
    day("2026-11-09", "zomato", "ops_sales_paise", 1_000),
    day("2026-11-16", "swiggy", "swiggy_net_sales_paise", 1_000),
    day("2026-11-09", "swiggy", "swiggy_net_sales_paise", 1_000),
    day("2026-11-16", "zomato", "ads_sales_paise", 581),
    day("2026-11-16", "zomato", "ad_spend_paise", 100),
    day("2026-11-09", "zomato", "ads_sales_paise", 581),
    day("2026-11-09", "zomato", "ad_spend_paise", 100),
    day("2026-11-16", "swiggy", "cpc_sales_paise", 400),
    day("2026-11-16", "swiggy", "cpc_spend_paise", 0),
    day("2026-11-09", "swiggy", "cpc_sales_paise", 400),
    day("2026-11-09", "swiggy", "cpc_spend_paise", 0),
  ];
  const dash = composeOwnerDashboard(input(readings));
  const ads = dash.tiles.find((tile) => tile.id === "ads");
  expect(ads?.value).toBeCloseTo(5.81);
  expect(ads?.splits.find((split) => split.platform === "swiggy")?.gap).toBe("no_spend");
});

it("treats a longer prep time as a bad move and a higher sale as a good one", () => {
  const readings = [
    week("2026-11-09", "zomato", "ops_sales_paise", 200),
    week("2026-11-02", "zomato", "ops_sales_paise", 100),
    week("2026-10-26", "zomato", "ops_sales_paise", 100),
    week("2026-10-19", "zomato", "ops_sales_paise", 100),
    week("2026-11-09", "zomato", "kpt_minutes", 20),
    week("2026-10-12", "zomato", "kpt_minutes", 10),
    week("2026-10-12", "zomato", "ops_sales_paise", 100),
  ];
  const dash = composeOwnerDashboard(
    input(readings, { platform: "zomato", range: "4w", from: "2026-10-20", to: "2026-11-17" }),
  );
  expect(dash.tiles.find((tile) => tile.id === "prep")?.good).toBe(false);
  expect(dash.tiles.find((tile) => tile.id === "prep")?.word).toBe("slower");
  expect(dash.tiles.find((tile) => tile.id === "sales")?.good).toBe(true);
});

it("drops a day where orders exceed carts and keeps the weekly rate at or under 100", () => {
  const readings = [
    day("2026-11-16", "zomato", "ops_sales_paise", 1_000),
    day("2026-11-16", "zomato", "cart_builds", 8),
    day("2026-11-16", "zomato", "placed_orders", 19),
    day("2026-11-15", "zomato", "ops_sales_paise", 1_000),
    day("2026-11-15", "zomato", "cart_builds", 40),
    day("2026-11-15", "zomato", "placed_orders", 20),
  ];
  expect(incomparableFunnelDays(readings)).toEqual(["2026-11-16"]);
  const dash = composeOwnerDashboard(input(readings, { platform: "zomato" }));
  const order = dash.funnel.find((series) => series.step === "order")?.points ?? [];
  const rates = order.flatMap((point) => (point.pct == null ? [] : [point.pct]));
  expect(rates.length).toBeGreaterThan(0);
  expect(Math.max(...rates)).toBeLessThanOrEqual(100);
  expect(Math.max(...rates)).toBeCloseTo(50);
});

it("groups counts the Indian way", () => {
  expect(formatCount(1298)).toBe("1,298");
  expect(formatCount(1747)).toBe("1,747");
});

it("resolves a stored rupee axis without keeping a function in the spec", () => {
  const stored = { y: ownerRupeeAxis([2_700_000]), marks: [] as const };
  expect(JSON.stringify(stored)).not.toContain("[Function");
  const tick = resolveOwnerPlot(stored).y?.tickFormat as (value: number) => string;
  expect(tick(2_700_000)).toBe("₹27k");
  expect(tick(-2_700_000)).toBe("−₹27k");
});

function weekStart(from: string, key: string, value: number): DashReading {
  return week(from, "zomato", key, value);
}
