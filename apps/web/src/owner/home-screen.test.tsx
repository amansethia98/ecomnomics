// @vitest-environment jsdom
import type { OwnerHomeModel } from "@rakazo/contracts";
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

import { OwnerHomeScreen } from "./home-screen";

const home: OwnerHomeModel = {
  kind: "alerts",
  date: "2026-11-15",
  baselineDate: "2026-11-08",
  readiness: "🟢 Zomato healthy · Swiggy pending",
  corrections: ["Correction: yesterday's Swiggy sales alert was a false alarm."],
  staleNote: null,
  urgent: 1,
  watch: 1,
  card: {
    ids: ["act"],
    severity: "act_now",
    outletId: "indiranagar",
    outletName: "Indiranagar",
    platform: "zomato",
    text: "Indiranagar was offline.",
    fix: "Check the tablet stays online.",
    consecutiveDays: 3,
    impactPaise: 640000,
    fresh: true,
    canSnooze: false,
    detail: "Zomato · Indiranagar · Sat 15 Nov",
  },
  rows: [
    {
      ids: ["watch"],
      severity: "watch",
      outletId: "hsr",
      outletName: "HSR",
      platform: "swiggy",
      text: "Food-ready marked on time for 78% of orders.",
      fix: "Mark food ready only when it is packed.",
      consecutiveDays: 2,
      impactPaise: 0,
      fresh: false,
      canSnooze: true,
      detail: "Swiggy · HSR · Fri 13 Nov",
    },
  ],
  overflow: [],
  positive: null,
  questions: [
    { outletId: "koramangala", outletName: "Koramangala", platform: "swiggy", date: "2026-11-14" },
  ],
  sales: { paise: 11248000, count: null, changePct: -6, pendingPlatform: "swiggy", asOf: null },
  delivered: { paise: null, count: 236, changePct: -4, pendingPlatform: "swiggy", asOf: null },
  payout: { paise: null, toCheck: 1, nextDate: "2026-11-19" },
  checksPassed: 18,
  updated: { zomato: "05:42", swiggy: null },
  askChief: false,
};

afterEach(() => {
  document.body.replaceChildren();
});

it("shows the act-now card without a snooze, and snooze only on a watch row", () => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <MemoryRouter>
        <OwnerHomeScreen
          restaurantId="r1"
          restaurantName="Kesar Kitchen"
          home={home}
          onSnooze={() => undefined}
          onAnswer={() => undefined}
        />
      </MemoryRouter>,
    );
  });
  expect(host.textContent).toContain("2 things need you today");
  expect(host.textContent).toContain("1 urgent");
  expect(host.textContent).toContain("New since 9 AM");
  expect(host.textContent).toContain("Yes, closed");
  expect(host.textContent).toContain("Not sure");
  expect(host.textContent).toContain("● Zomato only · ● Swiggy pending");
  expect(host.textContent).toContain("Yesterday");
  expect(host.textContent).toContain("Zomato updated 5:42 AM");
  expect(host.textContent).toContain("Swiggy pending, usually in by 11 AM");
  expect(host.textContent).toContain("Open full dashboard");
  expect(host.textContent).toContain("▼ −6.0% vs Sun 8");
  expect(host.textContent).not.toContain("Act now (");
  const snooze = [...host.querySelectorAll("summary")].map((node) => node.textContent);
  expect(snooze).toEqual(["···"]);
});

it("labels each app against the same weekday last week", () => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <MemoryRouter>
        <OwnerHomeScreen
          restaurantId="r1"
          restaurantName="Kesar Kitchen"
          home={{
            ...home,
            baselineDate: "2026-11-13",
            sales: {
              ...home.sales,
              pendingPlatform: null,
              splits: [
                { platform: "zomato", value: 1600000, changePct: -22.6 },
                { platform: "swiggy", value: 600000, changePct: -47 },
              ],
            },
          }}
          onSnooze={() => undefined}
          onAnswer={() => undefined}
        />
      </MemoryRouter>,
    );
  });
  expect(host.textContent).toContain("▼ −6.0% vs Fri 13");
  expect(host.textContent).toContain("▼ −22.6% vs Fri 13");
  expect(host.textContent).toContain("▼ −47.0% vs Fri 13");
  const down = [...host.querySelectorAll(".owner-change-down")].map(
    (node) => node.textContent ?? "",
  );
  expect(down.some((text) => text.includes("▼"))).toBe(true);
});

it("names the day a fallback figure comes from", () => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <MemoryRouter>
        <OwnerHomeScreen
          restaurantId="r1"
          restaurantName="Kesar Kitchen"
          home={{
            ...home,
            kind: "waiting",
            sales: { ...home.sales, paise: 80000, asOf: "2026-11-14", changePct: null },
            delivered: { ...home.delivered, count: 12, asOf: "2026-11-14", changePct: null },
          }}
          onSnooze={() => undefined}
          onAnswer={() => undefined}
        />
      </MemoryRouter>,
    );
  });
  expect(host.textContent).toContain("₹800");
  expect(host.textContent).toContain("12");
  expect(host.textContent).toContain("Last complete day · Sat 14 Nov");
  expect(host.textContent).toContain("Check runs Thursday");
});

it("hides the question when there is nothing to ask and says all good", () => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <MemoryRouter>
        <OwnerHomeScreen
          restaurantId="r1"
          restaurantName="Kesar Kitchen"
          home={{
            ...home,
            kind: "clear",
            urgent: 0,
            watch: 0,
            card: null,
            rows: [],
            questions: [],
            positive: { kind: "steady", weekday: "Sunday" },
          }}
          onSnooze={() => undefined}
          onAnswer={() => undefined}
        />
      </MemoryRouter>,
    );
  });
  expect(host.textContent).toContain("All good yesterday");
  expect(host.textContent).toContain("18 checks passed");
  expect(host.textContent).not.toContain("Was it closed?");
  expect(host.textContent).not.toContain("Snooze");
});
