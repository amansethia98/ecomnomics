// @vitest-environment jsdom
import type { MarketingScreen, StaffThread } from "@rakazo/contracts";
import type { ReactNode } from "react";
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

import { MarketingActionsScreen } from "./marketing-screen";
import { StaffScreen } from "./staff-screen";

const thread: StaffThread = {
  greeting: "Hi, I'm your chief of staff.",
  starters: ["What needs me today?"],
  messages: [
    {
      id: "m1",
      role: "staff",
      date: "2026-11-15",
      counted: false,
      failed: false,
      blocks: [
        {
          kind: "metric",
          label: "Net sales",
          paise: 11248000,
          changePct: -6,
          compare: "last Sunday",
          pending: "swiggy",
        },
        {
          kind: "choice",
          actionId: "offer-1",
          question: "Lunch offer",
          detail: "A capped discount.",
          maxCostPaise: 1600000,
          answerId: null,
        },
      ],
    },
  ],
  quota: { asked: 25, remaining: 5, showCounter: true, inputDisabled: false },
};

afterEach(() => {
  document.body.replaceChildren();
});

it("shows the counter only in the thread it was given, and the metric with the offer", () => {
  const host = render(
    <StaffScreen
      restaurantId="r1"
      thread={thread}
      onAsk={() => undefined}
      onChoose={() => undefined}
    />,
  );
  expect(host.textContent).toContain("Sun 15 Nov");
  expect(host.textContent).not.toContain("2026-11-15");
  expect(host.textContent).toContain("5 of 30 questions left today");
  expect(host.textContent).toContain("₹1,12,480");
  expect(host.textContent).toContain("Approve this offer");
  expect(host.textContent).toContain("What needs me today?");
});

it("hides the starters and disables the question when the day is used up", () => {
  const host = render(
    <StaffScreen
      restaurantId="r1"
      thread={{
        ...thread,
        greeting: null,
        starters: [],
        quota: { asked: 30, remaining: 0, showCounter: false, inputDisabled: true },
      }}
      onAsk={() => undefined}
      onChoose={() => undefined}
    />,
  );
  expect(host.textContent).not.toContain("What needs me today?");
  expect(host.textContent).not.toContain("of 30 questions left");
  expect(host.querySelector("input")?.getAttribute("placeholder")).toMatch(/30 questions/);
  expect(host.querySelector("input")?.hasAttribute("disabled")).toBe(true);
});

it("links an empty marketing log to the chat and folds extra waiting rows", () => {
  const empty: MarketingScreen = {
    hero: "empty",
    history: false,
    resultTitle: null,
    resultPaise: null,
    waiting: [],
    overflow: [],
    rows: [],
  };
  const host = render(
    <MarketingActionsScreen restaurantId="r1" screen={empty} onConfirm={() => undefined} />,
  );
  expect(host.textContent).toContain("No suggestions are waiting");
  expect(host.textContent).toContain("you approve");
  const known = render(
    <MarketingActionsScreen
      restaurantId="r1"
      screen={{ ...empty, history: true }}
      onConfirm={() => undefined}
    />,
  );
  expect(known.textContent).toContain("No suggestions yet.");
  expect(known.textContent).toContain("You switch offers on");

  const many: MarketingScreen = {
    hero: "waiting",
    history: true,
    resultTitle: null,
    resultPaise: null,
    waiting: [row("a"), row("b"), row("c")],
    overflow: [row("d"), row("e")],
    rows: [{ ...row("seen"), display: "not_seen" }],
  };
  const list = render(
    <MarketingActionsScreen restaurantId="r1" screen={many} onConfirm={() => undefined} />,
  );
  expect(list.textContent).toContain("Offer d");
  expect(list.textContent).toContain("Waiting (5)");
  expect(list.textContent).toContain("Not seen yet");
  expect(list.textContent).toContain("Did you switch it on?");

  const measured = render(
    <MarketingActionsScreen
      restaurantId="r1"
      screen={{
        ...many,
        rows: [{ ...row("done"), display: "result", resultPaise: 8_000 }],
      }}
      onConfirm={() => undefined}
    />,
  );
  expect(measured.textContent).toContain("₹80");
});

function row(id: string) {
  return {
    id,
    title: `Offer ${id}`,
    detail: "Discount cap",
    display: "waiting" as const,
    maxCostPaise: 1000,
    resultPaise: null,
  };
}

function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return host;
}
