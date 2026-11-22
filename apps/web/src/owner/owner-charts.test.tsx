// @vitest-environment jsdom
import type { DashReading } from "@rakazo/contracts";
import { addDays, composeOwnerDashboard, formatRupees } from "@rakazo/contracts";
import { ChartTooltipContent } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => text + (index ? String(values[index - 1]) : "") + part,
        "",
      ),
  }),
}));

import { FunnelChart, SalesChart } from "./owner-charts";

function day(from: string, value: number): DashReading {
  return { from, grain: "day", platform: "zomato", key: "ops_sales_paise", value, state: "ok" };
}

it("keeps the sales axis inside a 390px chart", () => {
  const readings: DashReading[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    readings.push(day(addDays("2026-11-14", offset), 1000 + offset));
  }
  const model = composeOwnerDashboard({
    today: "2026-11-22",
    range: "7d",
    from: "2026-11-14",
    to: "2026-11-21",
    platform: "zomato",
    holidays: [],
    readings,
    historyDays: 30,
  });
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(<SalesChart model={model} fitWidth={390} />);
  });
  const svg = host.querySelector("svg");
  expect(svg).not.toBeNull();
  expect(Number(svg?.getAttribute("width"))).toBeLessThanOrEqual(390);
  const ticks = [...host.querySelectorAll("text")];
  expect(ticks.length).toBeGreaterThan(0);
  for (const tick of ticks) {
    const x = Number(tick.getAttribute("x") ?? tick.querySelector("tspan")?.getAttribute("x") ?? 0);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(390);
  }
  const labels = ticks.map((tick) => tick.textContent ?? "").join(" ");
  expect(labels).toMatch(/14/);
  expect(labels).toMatch(/20/);
});

function readingsFor(days: number, missing: number | null, grain: "day" | "week"): DashReading[] {
  const rows: DashReading[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const from = addDays(
      grain === "day" ? "2026-11-09" : "2026-08-31",
      offset * (grain === "day" ? 1 : 7),
    );
    const missingDay = missing === offset;
    rows.push({
      from,
      grain,
      platform: "zomato",
      key: "ops_sales_paise",
      value: missingDay ? null : 1_000_000 + offset * 100,
      state: missingDay ? "missing" : "ok",
    });
    if (grain === "day") {
      rows.push(
        {
          from,
          grain,
          platform: "zomato",
          key: "impressions",
          value: 100,
          state: "ok",
        },
        {
          from,
          grain,
          platform: "zomato",
          key: "menu_opens",
          value: 42,
          state: "ok",
        },
      );
    }
  }
  return rows;
}

function renderChart(node: ReactNode) {
  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "240px";
  document.body.append(host);
  const rect = () => ({
    width: 800,
    height: 224,
    top: 0,
    left: 0,
    right: 800,
    bottom: 224,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  });
  HTMLElement.prototype.getBoundingClientRect = rect;
  class ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback(
        [{ contentRect: { width: 800, height: 224 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserver;
  act(() => {
    createRoot(host).render(node);
  });
  return host;
}

it("draws a 7 day line with a gap, a 12 week line, and a funnel line", () => {
  const week = composeOwnerDashboard({
    today: "2026-11-22",
    range: "7d",
    from: "2026-11-09",
    to: "2026-11-16",
    platform: "zomato",
    holidays: [],
    readings: readingsFor(7, 2, "day"),
    historyDays: 30,
  });
  const seven = renderChart(<SalesChart model={week} />);
  expect(seven.querySelectorAll(".recharts-line-curve, path").length).toBeGreaterThan(0);
  const twelveModel = composeOwnerDashboard({
    today: "2026-11-22",
    range: "12w",
    from: "2026-08-31",
    to: "2026-11-23",
    platform: "zomato",
    holidays: [],
    readings: readingsFor(12, null, "week"),
    historyDays: 90,
  });
  const twelve = renderChart(<SalesChart model={twelveModel} />);
  expect(twelve.querySelectorAll("path").length).toBeGreaterThan(0);
  const funnel = renderChart(<FunnelChart model={week} step="menu" />);
  expect(funnel.querySelectorAll("path").length).toBeGreaterThan(0);
});

it("shows rupees in the sales tooltip", () => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <ChartTooltipContent
        active
        label="16 Nov"
        payload={[{ name: "Zomato", value: 8_067_400, dataKey: "zomato" }]}
        formatValue={formatRupees}
      />,
    );
  });
  expect(host.textContent).toContain("₹80,674");
});
