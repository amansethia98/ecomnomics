// @vitest-environment jsdom
import type { OwnerDashboardModel } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
import { Answer } from "./dashboard-screen";
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
  expect(host.textContent).toContain("no change");
  expect(host.textContent).not.toContain("0.0%");
  expect(host.textContent).not.toContain("festival week");
});

function render(model: OwnerDashboardModel) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(<Answer model={model} />);
  });
  return host;
}
