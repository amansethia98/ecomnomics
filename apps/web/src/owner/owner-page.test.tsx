// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

import { OwnerPage } from "./page";

const profile = {
  restaurant: { id: "r1", name: "Sample Kitchen", timezone: "Asia/Kolkata" },
  owner: { name: "Owner", email: "owner@example.com", locale: "en" },
  outlets: [
    {
      id: "o1",
      name: "Indiranagar",
      city: "Bengaluru",
      active: true,
      connections: [
        { platform: "zomato", status: "connected" },
        { platform: "swiggy", status: "connected" },
      ],
    },
  ],
};

const payments = {
  payouts: [
    {
      id: "cycle-1",
      outletId: "o1",
      platform: "swiggy",
      from: "2026-11-03",
      to: "2026-11-09",
      orderCount: 2,
      netPayoutPaise: 80_000,
      paidAmountPaise: 60_000,
      outletName: "Indiranagar",
      bankBasis: "paid",
      status: "pending_check",
    },
  ],
  selectedId: "cycle-1",
  breakdown: [],
  deductions: [],
  plot: null,
  orders: [],
  adjustments: [{ cycleId: "cycle-1", label: "Ad credit", amountPaise: -500 }],
};

function payload(url: string): unknown {
  if (url === "/api/v1/restaurants") return { restaurants: [{ id: "r1", name: "Sample Kitchen" }] };
  if (url.endsWith("/profile")) return profile;
  if (url.includes("/payments")) return payments;
  if (url.endsWith("/documents")) {
    return {
      reference: null,
      expiresOn: null,
      gstin: null,
      reminder: null,
      daysLeft: null,
      reports: [],
    };
  }
  if (url.includes("/menu")) return { editing: false, missingCount: 0, rows: [], swiggy: null };
  return { rating: null, reviews: [], apps: [] };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("opens payments, documents, menu, and ratings from their routes", async () => {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload(url)),
      });
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  for (const [path, copy] of [
    ["/restaurants/r1/payments", "Check runs Thursday"],
    ["/restaurants/r1/documents", "Your first brief arrives tomorrow at 9:00 AM."],
    ["/restaurants/r1/menu", "Dish-by-dish insights are on the way"],
    ["/restaurants/r1/ratings", "Reviews and replies are on the way"],
  ] as const) {
    const root = createRoot(host);
    await act(async () => {
      root.render(<Page path={path} />);
    });
    await vi.waitFor(() => {
      expect(host.textContent, path).toContain(copy);
    });
    if (path.endsWith("/payments")) expect(host.textContent).toContain("Latest payouts");
    await act(async () => {
      root.unmount();
    });
  }
  expect(seen.some((url) => url.includes("/payments"))).toBe(true);
  expect(seen.some((url) => url.endsWith("/documents"))).toBe(true);
  expect(seen.some((url) => url.includes("/menu"))).toBe(true);
  expect(seen.some((url) => url.includes("/ratings"))).toBe(true);
});

it("opens a restaurant read-only and does not offer a save", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload(String(input))),
      }),
    ),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Page path="/restaurants/r1/settings?readonly=1" />);
  });
  await vi.waitFor(() => {
    expect(host.textContent).toContain("Read only. This view cannot change the restaurant.");
  });
  expect(host.textContent).not.toContain("Save");
  expect(host.querySelector("input")).toBeNull();
  await act(async () => {
    root.unmount();
  });
  const documents = createRoot(host);
  await act(async () => {
    documents.render(<Page path="/restaurants/r1/documents?readonly=1" />);
  });
  await vi.waitFor(() => {
    expect(host.textContent).toContain("Add your FSSAI licence expiry");
  });
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("Read only");
});

function Page({ path }: { path: string }): ReactNode {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/restaurants/:restaurantId/:screen" element={<OwnerPage />} />
      </Routes>
    </MemoryRouter>
  );
}
