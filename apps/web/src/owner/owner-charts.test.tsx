// @vitest-environment jsdom
import type { DashReading } from "@rakazo/contracts";
import { addDays, composeOwnerDashboard } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SalesChart } from "./owner-charts";

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
