// @vitest-environment jsdom
import type { OwnerDocuments, OwnerMenu, OwnerPayments, OwnerRatings } from "@rakazo/contracts";
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

import { DocumentsScreen } from "./documents-screen";
import { MenuScreen } from "./menu-screen";
import { PaymentsScreen } from "./payments-screen";
import { RatingsScreen } from "./ratings-screen";

afterEach(() => {
  document.body.replaceChildren();
});

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return host;
}

const payments: OwnerPayments = {
  payouts: [
    {
      id: "cycle-1",
      outletId: "outlet-1",
      platform: "swiggy",
      from: "2026-11-03",
      to: "2026-11-09",
      orderCount: 4,
      netPayoutPaise: 80_000,
      status: "pending_check",
    },
  ],
  selectedId: "cycle-1",
  deductions: [],
  plot: null,
  orders: [{ cycleId: "cycle-1", orderId: "o-1", date: "2026-11-08", netPayoutPaise: 20_000 }],
  adjustments: [],
};

it("shows the Thursday check on a payout and not a match", () => {
  const host = render(<PaymentsScreen screen={payments} onSelect={() => undefined} />);
  expect(host.textContent).toContain("Check runs Thursday");
  expect(host.textContent).toContain("₹800");
  expect(host.textContent).not.toContain("Matches");
  expect(host.textContent).toContain("o-1");
});

it("asks for a licence date and reminds inside seven days", () => {
  const screen: OwnerDocuments = {
    reference: null,
    expiresOn: null,
    gstin: null,
    reminder: null,
    daysLeft: null,
    reports: [],
  };
  const empty = render(
    <DocumentsScreen
      screen={screen}
      saving={false}
      onSave={() => undefined}
      onDirty={() => undefined}
    />,
  );
  expect(empty.querySelector("input[type='date']")).not.toBeNull();
  expect(empty.textContent).toContain("No reports yet.");
  document.body.replaceChildren();

  const due = render(
    <DocumentsScreen
      screen={{
        ...screen,
        reference: "LIC-1",
        expiresOn: "2026-11-16",
        reminder: "7",
        daysLeft: 3,
        reports: [
          {
            id: "rep-1",
            kind: "weekly",
            from: "2026-11-03",
            to: "2026-11-09",
            createdOn: "2026-11-10",
          },
        ],
      }}
      saving={false}
      onSave={() => undefined}
      onDirty={() => undefined}
    />,
  );
  expect(due.textContent).toContain("Your FSSAI licence expires on Mon 16 Nov.");
  expect(due.textContent).toContain("Weekly review");
  expect(due.querySelector("input[type='file']")).toBeNull();
});

it("says menu editing is coming soon and names a missing app", () => {
  const menu: OwnerMenu = {
    editing: false,
    missingCount: 1,
    rows: [{ name: "Soup", platforms: ["zomato"], revenuePaise: 5_000, missingApp: true }],
  };
  const host = render(<MenuScreen screen={menu} />);
  expect(host.textContent).toContain("Menu editing is coming soon.");
  expect(host.textContent).toContain("1 item not on one app");
  expect(host.textContent).toContain("Soup");
  expect(host.querySelector("button")).toBeNull();
});

it("copies a review reply and does not post it", () => {
  const write = vi.fn();
  Object.assign(navigator, { clipboard: { writeText: write } });
  const screen: OwnerRatings = {
    rating: 4.2,
    reviews: [
      {
        id: "rev-1",
        platform: "zomato",
        rating: 5,
        text: "Hot food.",
        reply: "Thank you.",
        date: "2026-11-14",
      },
    ],
  };
  const host = render(<RatingsScreen screen={screen} />);
  const button = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "Copy reply",
  );
  expect(button).toBeTruthy();
  expect(host.textContent).not.toContain("Post");
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(write).toHaveBeenCalledWith("Thank you.");
});
