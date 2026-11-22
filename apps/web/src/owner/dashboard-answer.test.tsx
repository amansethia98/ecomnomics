// @vitest-environment jsdom
import type { OwnerDashboardModel, OwnerView } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => text + (index ? String(values[index - 1]) : "") + part,
        "",
      ),
  }),
}));

import type { DashTile } from "@rakazo/contracts";
import { Answer, FunnelLine, OwnerDashboard } from "./dashboard-screen";
import { NumberCard } from "./number-card";

afterEach(() => {
  document.body.replaceChildren();
});

it("drops the sign when the verb already says the direction", () => {
  const host = render(
    answer({
      direction: "up",
      pct: 12.5,
      weeks: 4,
      unit: "week",
      dipped: { platform: "swiggy", pct: -8.4, against: "the day before" },
    }),
  );
  expect(host.textContent).toContain("up 12.5%, last 4 weeks vs the 4 before");
  expect(host.textContent).toContain("dipped 8.4%");
  expect(host.textContent).not.toContain("+");
  expect(host.textContent).not.toContain("−");
});

it("counts the selected range in days", () => {
  const host = render(answer({ direction: "down", pct: -4, weeks: 7, unit: "day", dipped: null }));
  expect(host.textContent).toContain("down 4.0%, last 7 days vs the same 7 days before");
});

it("says when a daily dip is against the previous day", () => {
  const host = render(
    answer({
      direction: "down",
      pct: -4,
      weeks: 7,
      unit: "day",
      dipped: { platform: "swiggy", pct: -6, against: "the day before" },
    }),
  );
  expect(host.textContent).toContain("The last day dipped 6.0% vs the day before");
});

function answer(over: Partial<OwnerDashboardModel["answer"]>): OwnerDashboardModel {
  return {
    answer: {
      direction: "none",
      pct: null,
      weeks: 0,
      flatPlatform: null,
      flatWeeks: 0,
      dipped: null,
      festival: false,
      pendingPlatform: null,
      unit: "week",
      ...over,
    },
    panels: [],
    pins: [],
    shadeWeek: null,
    tiles: [],
    heatmap: [],
    funnel: [],
    pendingNote: null,
    missingNote: null,
    compared: null,
    periodPhrase:
      over.unit === "day"
        ? "last 7 days vs the same 7 days before"
        : "last 4 weeks vs the 4 before",
    heatmapLine: null,
    funnelLine: null,
    comparisonsStart: null,
    onePlatform: false,
  };
}

it("renders the seven-day funnel headline on the page", async () => {
  const days = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
  const opens = [40, 30, 20, 10];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        series: days.map((from, index) => ({
          from,
          to: from,
          provisional: false,
          values: [
            { key: "ops_sales_paise", value: 1000, status: "ok", coverageDays: 1 },
            { key: "impressions", value: 100, status: "ok", coverageDays: 1 },
            { key: "menu_opens", value: opens[index], status: "ok", coverageDays: 1 },
            { key: "cart_builds", value: 10, status: "ok", coverageDays: 1 },
            { key: "placed_orders", value: 4, status: "ok", coverageDays: 1 },
          ],
        })),
      }),
    })),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const view: OwnerView = {
    range: "7d",
    platform: "zomato",
    outlet: "all",
    from: "2026-11-15",
    to: "2026-11-22",
  };
  await act(async () => {
    createRoot(host).render(
      <MemoryRouter>
        <OwnerDashboard restaurantId="r1" today="2026-11-22" view={view} />
      </MemoryRouter>,
    );
  });
  const line = [...host.querySelectorAll("p")].find((node) =>
    node.className.includes("text-foreground"),
  );
  expect(line?.textContent).toContain("Zomato: fewer people who see you open your menu, ");
  expect(line?.textContent).toMatch(/down \d+ weeks in a row/);
  expect(line?.className).not.toContain("text-destructive");
  const wine = [...(line?.querySelectorAll(".text-destructive") ?? [])].map(
    (node) => node.textContent ?? "",
  );
  expect(wine.some((text) => text.includes("●"))).toBe(true);
  expect(wine.some((text) => /down \d+ weeks in a row/.test(text))).toBe(true);
  vi.unstubAllGlobals();
});

it("keeps the funnel headline dark, with wine only on the dot and the decline", () => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <FunnelLine text="Zomato: fewer people who see you open your menu, down 4 weeks in a row" />,
    );
  });
  const line = host.querySelector("p");
  expect(line?.className).toContain("text-foreground");
  expect(line?.className).not.toContain("text-destructive");
  const wine = [...host.querySelectorAll(".text-destructive")].map(
    (node) => node.textContent ?? "",
  );
  expect(wine.some((text) => text.includes("●"))).toBe(true);
  expect(wine).toContain("down 4 weeks in a row");
  expect(host.textContent).toContain("Zomato: fewer people who see you open your menu, ");
});

it("says festival week once, beside the comparison", () => {
  const host = render(answer({ festival: true, dipped: null }));
  expect(host.textContent?.match(/festival week/g)).toHaveLength(1);
});

it("says no change when a tile moved by nothing", () => {
  const tile: DashTile = {
    id: "rejected",
    value: 4,
    format: "count",
    changePct: 0,
    spark: [],
    word: "steady",
    weeks: 4,
    good: null,
    state: "value",
    festival: true,
    splits: [],
    basis: "in 4 weeks",
    span: "4 weeks",
  };
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(<NumberCard tile={tile} onOpen={() => undefined} />);
  });
  expect(host.textContent).toContain("Steady");
  expect(host.textContent).not.toContain("Down");
  expect(host.textContent).not.toContain("festival week");
});

it("shows one judgement when the word and the arrow would disagree", () => {
  const tile: DashTile = {
    id: "online",
    value: 90,
    format: "pct",
    changePct: -1,
    spark: [],
    word: "improving",
    weeks: 1,
    good: true,
    state: "value",
    festival: false,
    splits: [],
    basis: "vs last week",
    span: "7 days",
  };
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(<NumberCard tile={tile} onOpen={() => undefined} />);
  });
  expect(host.textContent).toContain("Steady");
  expect(host.textContent).not.toContain("Down");
  expect(host.textContent).not.toContain("Improving");
});

function render(model: OwnerDashboardModel) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(<Answer model={model} />);
  });
  return host;
}
