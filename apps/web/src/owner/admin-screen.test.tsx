// @vitest-environment jsdom
import type { AdminPanel } from "@rakazo/contracts";
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

import { AdminPanelScreen } from "./admin-screen";

afterEach(() => {
  document.body.replaceChildren();
});

const panel: AdminPanel = {
  health: "All 1 restaurants updated",
  needsYou: false,
  runs: [{ restaurant: "Sample", state: "done" }],
  restaurants: [{ restaurantId: "r1", name: "Sample", paused: false }],
  connections: [
    { restaurant: "Sample", outlet: "HSR", zomato: "connected", swiggy: "not_connected" },
  ],
  messages: "No messages are in this view.",
  costsPaise: null,
  rules: "No rule placeholders left.",
};

it("shows the health line and a read-only view with no credential field", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const onView = vi.fn();
  act(() => {
    createRoot(host).render(
      <AdminPanelScreen
        panel={panel}
        view={{
          restaurantId: "r1",
          name: "Sample",
          readOnly: true,
          outlets: [
            {
              name: "HSR",
              city: "Bengaluru",
              active: true,
              zomato: "connected",
              swiggy: "not_connected",
            },
          ],
        }}
        onView={onView}
      />,
    );
  });
  expect(host.textContent).toContain("All 1 restaurants updated");
  expect(host.textContent).toContain("Nothing needs you");
  expect(host.textContent).toContain("Read only");
  expect(host.textContent).toContain("Zomato connected");
  expect(host.textContent).toContain("Swiggy not connected");
  expect(host.textContent).not.toMatch(/password|token|secret/i);
  const button = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "View as owner",
  );
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onView).toHaveBeenCalledWith("r1");
});
