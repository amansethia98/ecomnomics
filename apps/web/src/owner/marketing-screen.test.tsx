// @vitest-environment jsdom
import type { MarketingScreen } from "@rakazo/contracts";
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

import { MarketingActionsScreen } from "./marketing-screen";

afterEach(() => {
  document.body.replaceChildren();
});

it("shows the suggestion flow and an empty table when nothing is waiting", () => {
  const host = render(empty);
  expect(host.textContent).toContain("you approve");
  expect(host.textContent).toContain("No suggestions are waiting");
  expect(host.textContent).toContain("All (0)");
  expect(host.textContent).toContain("Waiting (0)");
  expect(host.textContent).toContain("No suggestions yet.");
  expect(host.textContent).toContain("You switch offers on");
});

it("puts a waiting suggestion on a card with Approve and Not now", () => {
  const choices: string[] = [];
  const host = render(
    {
      ...empty,
      hero: "waiting",
      waiting: [
        {
          id: "offer-1",
          title: "Weekday lunch offer",
          detail: "15% off, capped.",
          display: "waiting",
          maxCostPaise: 320_000,
          resultPaise: null,
        },
      ],
    },
    (id, choice) => choices.push(`${id}:${choice}`),
  );
  expect(host.textContent).toContain("1 suggestions are waiting for your OK");
  expect(host.textContent).toContain("Weekday lunch offer");
  const approve = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Approve",
  );
  approve?.click();
  expect(choices).toEqual(["offer-1:approve"]);
});

const empty: MarketingScreen = {
  hero: "empty",
  history: true,
  resultTitle: null,
  resultPaise: null,
  waiting: [],
  overflow: [],
  rows: [],
};

function render(
  screen: MarketingScreen,
  onDecide?: (id: string, choice: "approve" | "not_now") => void,
) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <MarketingActionsScreen
        restaurantId="sample"
        screen={screen}
        onConfirm={() => undefined}
        onDecide={onDecide}
      />,
    );
  });
  return host;
}
