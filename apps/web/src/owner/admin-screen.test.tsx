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

import { AdminAccessDenied, AdminPanelScreen } from "./admin-screen";

afterEach(() => {
  document.body.replaceChildren();
});

const panel: AdminPanel = {
  health: "All 1 restaurants updated",
  needsYou: false,
  runs: [{ restaurant: "Sample", state: "done" }],
  restaurants: [
    {
      restaurantId: "r1",
      name: "Sample",
      paused: false,
      outlets: 1,
      zomato: "connected",
      swiggy: "not_connected",
      run: "done",
      lastDownload: "2026-11-16",
      costPaise: null,
    },
    {
      restaurantId: "r2",
      name: "Paused Kitchen",
      paused: true,
      outlets: 0,
      zomato: "not_connected",
      swiggy: "not_connected",
      run: "paused",
      lastDownload: null,
      costPaise: null,
    },
  ],
  connections: [
    { restaurant: "Sample", outlet: "HSR", zomato: "connected", swiggy: "not_connected" },
  ],
  messages: "No messages are in this view.",
  costsPaise: null,
  rules: "No rule placeholders left.",
  quality: [],
};

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(node);
  });
  return host;
}

it("keeps each admin section on its own view and filters the restaurant table", () => {
  const onView = vi.fn();
  const host = render(<AdminPanelScreen panel={panel} onView={onView} />);
  expect(host.textContent).toContain("All 1 restaurants updated");
  expect(host.textContent).toContain("Nothing needs you");
  expect(host.textContent).toContain("Platform health");
  expect(host.querySelector("input")).toBeNull();
  const restaurants = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "Restaurants",
  );
  act(() => {
    restaurants?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.textContent).not.toContain("Nothing needs you");
  expect(host.querySelector("input[aria-label='Search restaurants']")).not.toBeNull();
  expect(host.textContent).toContain("Sample");
  expect(host.textContent).toContain("Paused Kitchen");
  const search = host.querySelector("input");
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(search, "Paused");
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    search?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("Paused Kitchen");
  expect(host.textContent).not.toContain("Sample");
  const paused = [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith("Paused"),
  );
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(search, "");
    search?.dispatchEvent(new Event("change", { bubbles: true }));
    paused?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const all = [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith("All"),
  );
  act(() => {
    all?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const view = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "View as owner",
  );
  act(() => {
    view?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onView).toHaveBeenCalledWith("r1");
  expect(host.textContent).not.toContain("Read only");
  expect(host.textContent).toContain("Admin access · never shows passwords");
  const connections = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "Logins & connections",
  );
  act(() => {
    connections?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.textContent).toContain("Status only");
  expect(host.textContent).toContain("Zomato connected");
  expect(host.textContent).toContain("Swiggy not connected");
  expect(host.textContent).not.toMatch(/\btoken\b|\bsecret\b/i);
});

it("styles a denied admin as a closed panel", () => {
  const host = render(<AdminAccessDenied />);
  expect(host.textContent).toContain("You don't have admin access");
  expect(host.textContent).toContain("Back to the owner app");
  expect(host.querySelector(".owner-panel")).not.toBeNull();
  expect(host.querySelector("input")).toBeNull();
});
