// @vitest-environment jsdom
import type { DashReading, OwnerDashboardInput, OwnerPlot } from "@rakazo/contracts";
import { composeOwnerDashboard, dashboardPlots } from "@rakazo/contracts";
import { renderPlotSpecToSvg } from "@rakazo/core/plot";
import { expect, it } from "vitest";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function iso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
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

/** Thirty days, Swiggy missing the last one. Week rows keep the 30-day chart filled. */
function laggingReadings(): DashReading[] {
  const rows: DashReading[] = [];
  for (let offset = 0; offset < 30; offset += 1) {
    const date = iso(2026, 10, 18 + offset);
    const pending = offset === 29;
    rows.push(day(date, "zomato", "ops_sales_paise", 1_000));
    rows.push(day(date, "zomato", "delivered_orders", 10));
    rows.push(
      day(
        date,
        "swiggy",
        "swiggy_net_sales_paise",
        pending ? null : 500,
        pending ? "pending" : "ok",
      ),
    );
    rows.push(
      day(date, "swiggy", "delivered_orders", pending ? null : 5, pending ? "pending" : "ok"),
    );
  }
  for (const week of [
    "2026-10-12",
    "2026-10-19",
    "2026-10-26",
    "2026-11-02",
    "2026-11-09",
    "2026-11-16",
  ]) {
    rows.push({
      from: week,
      grain: "week",
      platform: "zomato",
      key: "ops_sales_paise",
      value: 7_000,
      state: "ok",
    });
    rows.push({
      from: week,
      grain: "week",
      platform: "swiggy",
      key: "swiggy_net_sales_paise",
      value: 3_000,
      state: "ok",
    });
  }
  return rows;
}

function view(over: Partial<OwnerDashboardInput>): OwnerDashboardInput {
  return {
    today: "2026-11-17",
    range: "7d",
    from: "2026-11-10",
    to: "2026-11-17",
    platform: "both",
    holidays: [],
    readings: laggingReadings(),
    historyDays: 90,
    ...over,
  };
}

function draw(plot: OwnerPlot): string {
  return renderPlotSpecToSvg(plot, undefined, document);
}

it("draws the sales lines and the weekday heatmap when one platform lags a day", () => {
  for (const input of [view({}), view({ range: "custom", from: "2026-10-18", to: "2026-11-17" })]) {
    const plots = dashboardPlots(composeOwnerDashboard(input));
    for (const id of ["sales-zomato", "sales-swiggy", "heatmap"]) {
      const plot = plots.find((item) => item.id === id);
      expect(plot, id).toBeTruthy();
      const svg = draw(plot!);
      expect(svg.startsWith("<svg"), id).toBe(true);
      expect(svg.length, id).toBeGreaterThan(100);
    }
    const sales = plots.find((item) => item.id === "sales-zomato");
    const ticks = ((sales?.x?.ticks as Date[] | undefined) ?? []).map((tick) =>
      tick.toISOString().slice(0, 10),
    );
    expect(ticks.every((tick) => tick <= "2026-11-16")).toBe(true);
    const heatmap = plots.find((item) => item.id === "heatmap");
    expect(heatmap?.color?.type).toBe("sqrt");
    expect(heatmap?.y?.domain).toEqual(WEEKDAYS);
    const labels = [...draw(heatmap!).matchAll(/>(Mon|Tue|Wed|Thu|Fri|Sat|Sun)</g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(WEEKDAYS);
  }
});
