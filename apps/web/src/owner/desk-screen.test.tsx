// @vitest-environment jsdom
import type { OwnerDocuments, OwnerMenu, OwnerPayments, OwnerRatings } from "@rakazo/contracts";
import { formatRupees } from "@rakazo/contracts";
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
      paidAmountPaise: null,
      expectedPaise: 80_000,
      outletName: "Indiranagar",
      bankBasis: "net",
      status: "pending_check",
    },
    {
      id: "cycle-z",
      outletId: "outlet-1",
      platform: "zomato",
      from: "2026-11-09",
      to: "2026-11-16",
      orderCount: 2,
      netPayoutPaise: 40_000,
      paidAmountPaise: null,
      expectedPaise: 40_000,
      outletName: "Indiranagar",
      bankBasis: "net",
      status: "pending_check",
    },
  ],
  selectedId: "cycle-1",
  breakdown: [
    { id: "discounts", label: "Discounts you paid for", paise: null, basis: null },
    { id: "net", label: "Net in file", paise: 80_000, basis: "net" },
  ],
  deductions: [],
  plot: null,
  orders: [{ cycleId: "cycle-1", orderId: "o-1", date: "2026-11-08", netPayoutPaise: 20_000 }],
  adjustments: [{ cycleId: "cycle-1", label: "Ad credit", amountPaise: -500 }],
};

it("shows the Thursday check on a payout and not a match", () => {
  const onSelect = vi.fn();
  const host = render(<PaymentsScreen screen={payments} today="2026-11-22" onSelect={onSelect} />);
  expect(host.textContent).toContain("Check runs Thursday");
  expect(host.textContent).toContain("Net in file");
  expect(host.textContent).toContain("Not in report");
  const options = [...host.querySelectorAll("option")].map((option) => option.textContent ?? "");
  expect(options).toEqual([
    "Zomato 16–23 Nov · Report not in yet",
    "Zomato 9–16 Nov",
    "Swiggy 9–15 Nov · Report not in yet",
    "Swiggy 3–9 Nov",
  ]);
  expect(options.some((option) => option.includes("Zomato") && option.includes("Swiggy"))).toBe(
    false,
  );
  const weekLine = host.querySelector("[data-testid='payout-week']")?.textContent ?? "";
  expect(weekLine).toContain("Zomato 16–23 Nov · Report not in yet");
  expect(weekLine).toContain("Swiggy 9–15 Nov · Report not in yet");
  expect(weekLine).not.toContain("₹1,200");
  expect(weekLine).not.toMatch(/paid · expected/i);
  expect(host.textContent).toContain("Where your money went");
  expect(host.textContent).toContain("₹800");
  expect(host.textContent).not.toContain("Matches");
  expect(host.textContent).toContain("Expected ₹800");
  expect(host.textContent).not.toContain("paid · expected");
  expect(host.textContent).toContain("View orders");
  expect(host.textContent).not.toContain("o-1");
  act(() => {
    [...host.querySelectorAll("button")]
      .find((item) => item.textContent?.includes("View orders"))
      ?.click();
  });
  expect(host.textContent).toContain("o-1");
  expect(onSelect).not.toHaveBeenCalled();
  expect(host.querySelector(".owner-dot-swiggy")).not.toBeNull();
  expect(host.querySelector(".owner-dot-zomato")).not.toBeNull();
  expect(host.textContent).not.toContain("Ad credit");
  expect(formatRupees(-500)).not.toBe(formatRupees(500));
});

it("keeps each app's latest period on its own header line", () => {
  const swiggy = payments.payouts[0];
  const zomato = payments.payouts[1];
  if (!swiggy || !zomato) throw new Error("fixture");
  const host = render(
    <PaymentsScreen
      today="2026-11-12"
      onSelect={() => undefined}
      screen={{
        ...payments,
        payouts: [
          {
            ...swiggy,
            id: "swiggy-paid",
            from: "2026-11-08",
            to: "2026-11-15",
            paidAmountPaise: 8_067_400,
            bankBasis: "paid",
          },
          {
            ...zomato,
            id: "zomato-paid",
            from: "2026-11-09",
            to: "2026-11-16",
            paidAmountPaise: 8_091_300,
            expectedPaise: 8_091_300,
            bankBasis: "paid",
          },
        ],
        selectedId: "swiggy-paid",
      }}
    />,
  );
  const options = [...host.querySelectorAll("option")].map((option) => option.textContent);
  expect(options).toEqual(["Zomato 9–16 Nov", "Swiggy 8–15 Nov"]);
  const weekLine = host.querySelector("[data-testid='payout-week']")?.textContent ?? "";
  expect(weekLine).toContain("Zomato 9–16 Nov · Paid ₹80,913");
  expect(weekLine).toContain("Swiggy 8–15 Nov · Paid ₹80,674");
  expect(weekLine).not.toContain("₹1,61,587");
  expect(host.textContent).not.toContain("Zomato 9–16 Nov · Swiggy");
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
  expect(empty.querySelector("input[type='date']")).toBeNull();
  expect(empty.querySelector("input[placeholder='DD MMM YYYY']")).toBeNull();
  act(() => {
    [...empty.querySelectorAll("button")]
      .find((item) => item.textContent === "Add expiry")
      ?.click();
  });
  expect(empty.querySelector("input[placeholder='DD MMM YYYY']")).not.toBeNull();
  expect(empty.textContent).toContain("Add your FSSAI licence expiry");
  expect(empty.textContent).toContain("Daily briefs");
  expect(empty.textContent).toContain("Payout checks");
  expect(empty.textContent).toContain("FSSAI licence");
  expect(empty.textContent).toContain("Your first brief arrives tomorrow at 9:00 AM.");
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
            createdAt: "2026-11-10T03:30:00.000Z",
            urgent: 1,
          },
        ],
      }}
      saving={false}
      onSave={() => undefined}
      onDirty={() => undefined}
    />,
  );
  expect(due.textContent).toContain("Your FSSAI licence expires on Mon 16 Nov.");
  document.body.replaceChildren();
  const current = render(
    <DocumentsScreen
      screen={{ ...screen, reference: "LIC-1", expiresOn: "2027-11-16" }}
      saving={false}
      onSave={() => undefined}
      onDirty={() => undefined}
    />,
  );
  expect(current.textContent).toContain("All documents up to date.");
  expect(due.textContent).toContain("Weekly review");
  expect(due.textContent).toContain("09:00");
  expect(due.textContent).toContain("1 urgent");
  expect(due.querySelector("svg")).not.toBeNull();
  expect(due.querySelector("input[type='file']")).toBeNull();
});

it("says menu editing is coming soon and names a missing app", () => {
  const menu: OwnerMenu = {
    editing: false,
    missingCount: 1,
    rows: [{ name: "Soup", platforms: ["zomato"], revenuePaise: 5_000, missingApp: true }],
    swiggy: {
      score: 80,
      scoreAsOf: "2026-10-31",
      photoPct: 80,
      descriptionPct: 0,
      top5SharePct: 40,
      top5RevenuePaise: 12_000,
      scorePoints: [70, 80],
    },
  };
  const host = render(<MenuScreen screen={menu} />);
  expect(host.textContent).toContain("Dish-by-dish insights are on the way");
  expect(host.textContent).toContain("What you'll get");
  expect(host.textContent).toContain("Keep & promote");
  expect(host.querySelector("input")).toBeNull();
  const top = [...host.querySelectorAll("li")].find((item) =>
    item.textContent?.includes("Top 5 dishes' share of Swiggy sales"),
  );
  expect(top?.querySelector("[class*='h-1']")).toBeNull();
  expect(host.textContent).toContain("80 / 100");
  const rounded = render(
    <MenuScreen
      screen={{
        ...menu,
        swiggy: { ...menu.swiggy!, score: 92.33, scorePoints: [92.33] },
      }}
    />,
  );
  expect(rounded.textContent).toContain("92 / 100");
  expect(rounded.querySelector("circle")).not.toBeNull();
  expect(host.textContent).toContain("as of Sat 31 Oct");
  expect(host.textContent).not.toContain("In reports");
  expect(host.textContent).toContain("80%");
  expect(host.textContent).toContain("0%");
  expect(host.textContent).toContain("Zomato doesn't share menu scores in its reports.");
  expect(host.textContent).toContain("What we can already see · Swiggy menu, last 12 weeks");
  expect(host.querySelector(".lg\\:grid-cols-2")).not.toBeNull();
  expect(host.querySelector("svg")).not.toBeNull();
  expect(host.textContent).not.toContain("Soup");
  expect(host.querySelector("button")).toBeNull();
});

it("copies a review reply and does not post it", () => {
  const write = vi.fn();
  Object.assign(navigator, { clipboard: { writeText: write } });
  const screen: OwnerRatings = {
    rating: 4.2,
    apps: [
      {
        platform: "zomato",
        rating: 4.2,
        ratingState: "ok",
        poorRatedOrders: 0,
        poorRatedPct: null,
        complaints: [{ id: "complaints_missing", label: "Missing items", count: null }],
      },
      {
        platform: "swiggy",
        rating: null,
        ratingState: "not_in_report",
        poorRatedOrders: 2,
        poorRatedPct: 25,
        complaints: [{ id: "complaints_missing", label: "Missing items", count: 1 }],
      },
    ],
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
  expect(host.textContent).toContain("Not in Swiggy's reports yet");
  expect(host.textContent).toContain("Reviews and replies are on the way");
  expect(host.textContent).toContain("Poorly rated orders 0");
  const appGrid = host.querySelector("section");
  expect(appGrid?.className).toContain("grid-cols-1");
  expect(appGrid?.className).toContain("md:grid-cols-3");
  expect(host.textContent).toContain("25%");
  expect(host.textContent).toContain("Most complaints: Missing items · Swiggy");
  expect(host.textContent).toContain("Not in reports");
  expect(host.textContent).toContain("★ 4.20");
  const bars = host.querySelectorAll("span.bg-destructive");
  expect(bars).toHaveLength(1);
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(write).toHaveBeenCalledWith("Thank you.");
});
