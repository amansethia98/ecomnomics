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

import { Answer } from "./dashboard-screen";

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
      dipped: { platform: "swiggy", pct: -8.4 },
    }),
  );
  expect(host.textContent).toContain("up 12.5% in 4 weeks");
  expect(host.textContent).toContain("dipped 8.4%");
  expect(host.textContent).not.toContain("+");
  expect(host.textContent).not.toContain("−");
});

it("counts the selected range in days", () => {
  const host = render(answer({ direction: "down", pct: -4, weeks: 7, unit: "day", dipped: null }));
  expect(host.textContent).toContain("down 4.0% in 7 days");
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
    comparisonsStart: null,
    onePlatform: false,
  };
}

function render(model: OwnerDashboardModel) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(<Answer model={model} />);
  });
  return host;
}
