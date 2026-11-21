import { describe, expect, it } from "vitest";
import type { PaymentCycle } from "./owner-desk.js";
import {
  composeOwnerDocuments,
  composeOwnerMenu,
  composeOwnerPayments,
  composeOwnerRatings,
  LicencePatchSchema,
  PAYOUT_CHECK,
  parseDisplayDate,
} from "./owner-desk.js";

function cycle(id: string, to: string, extra: Partial<PaymentCycle> = {}): PaymentCycle {
  return {
    id,
    outletId: "outlet-1",
    platform: "zomato",
    from: "2026-11-03",
    to,
    orderCount: 4,
    netPayoutPaise: 80_000,
    paidAmountPaise: null,
    grossSalesPaise: 100_000,
    outletName: "Indiranagar",
    commissionPaise: 10_000,
    feesPaise: null,
    taxesPaise: null,
    tdsPaise: null,
    tcsPaise: null,
    adsPaise: 2_000,
    discountsPaise: null,
    gstPaise: null,
    complaintsPaise: null,
    ...extra,
  };
}

describe("owner payments", () => {
  it("keeps every payout on the Thursday check", () => {
    const screen = composeOwnerPayments({
      cycles: [cycle("older", "2026-11-02"), cycle("newer", "2026-11-09", { platform: "swiggy" })],
      orders: [
        { cycleId: "newer", orderId: "o-1", date: "2026-11-08", netPayoutPaise: 20_000 },
        { cycleId: "older", orderId: "o-2", date: "2026-11-01", netPayoutPaise: 15_000 },
      ],
      adjustments: [{ cycleId: "newer", label: "Ad credit", amountPaise: -500 }],
      selectedId: null,
    });
    expect(screen.payouts.map((payout) => payout.status)).toEqual([PAYOUT_CHECK, PAYOUT_CHECK]);
    expect(screen.selectedId).toBe("newer");
    expect(screen.orders.map((order) => order.orderId)).toEqual(["o-1"]);
    expect(screen.adjustments).toHaveLength(1);
    expect(screen.deductions.map((row) => row.id)).toEqual(["commission", "ads"]);
    expect(screen.payouts[0]?.bankBasis).toBe("net");
    expect(screen.breakdown.map((row) => row.id)).toEqual([
      "sales",
      "discounts",
      "commission",
      "ads",
      "tax",
      "deductions",
      "net",
    ]);
    expect(screen.breakdown.find((row) => row.id === "discounts")?.paise).toBeNull();
    expect(screen.breakdown.find((row) => row.id === "net")).toMatchObject({
      paise: 80_000,
      basis: "net",
    });
    expect(screen.plot?.marks[0]?.type).toBe("rectY");
    expect(JSON.stringify(screen)).not.toContain("Matches");
  });

  it("is empty when no payout has arrived", () => {
    const screen = composeOwnerPayments({
      cycles: [],
      orders: [],
      adjustments: [],
      selectedId: "missing",
    });
    expect(screen.payouts).toEqual([]);
    expect(screen.selectedId).toBeNull();
    expect(screen.plot).toBeNull();
  });

  it("uses the settled amount for the bank line when the file has one", () => {
    const screen = composeOwnerPayments({
      cycles: [cycle("paid", "2026-11-09", { paidAmountPaise: 60_000, netPayoutPaise: 80_000 })],
      orders: [],
      adjustments: [],
      selectedId: null,
    });
    expect(screen.payouts[0]?.bankBasis).toBe("paid");
    expect(screen.payouts[0]?.paidAmountPaise).toBe(60_000);
    expect(screen.breakdown.find((row) => row.id === "bank")?.paise).toBe(60_000);
    expect(screen.breakdown.some((row) => row.id === "net")).toBe(false);
  });
});

describe("owner documents", () => {
  it("reminds at 30 days, at 7 days, and after the date", () => {
    const base = {
      reference: "FSSAI-1",
      gstin: "  ",
      reports: [
        {
          id: "rep-1",
          kind: "weekly_review",
          from: "2026-11-03",
          to: "2026-11-09",
          createdOn: "2026-11-10",
        },
      ],
    };
    expect(
      composeOwnerDocuments({ ...base, today: "2026-10-01", expiresOn: "2026-11-16" }).reminder,
    ).toBeNull();
    expect(
      composeOwnerDocuments({ ...base, today: "2026-10-17", expiresOn: "2026-11-16" }).reminder,
    ).toBe("30");
    expect(
      composeOwnerDocuments({ ...base, today: "2026-11-09", expiresOn: "2026-11-16" }).reminder,
    ).toBe("7");
    const expired = composeOwnerDocuments({
      ...base,
      today: "2026-11-17",
      expiresOn: "2026-11-16",
    });
    expect(expired.reminder).toBe("expired");
    expect(expired.daysLeft).toBe(-1);
    expect(expired.gstin).toBeNull();
    expect(expired.reports[0]?.kind).toBe("weekly");
    const labelled = composeOwnerDocuments({
      ...base,
      today: "2026-11-01",
      expiresOn: null,
      reports: [
        ...base.reports,
        {
          id: "dup",
          kind: "weekly_review",
          from: "2026-11-03",
          to: "2026-11-09",
          createdOn: "2026-11-11",
        },
        { id: "plain", kind: null, from: "2026-11-01", to: "2026-11-02", createdOn: "2026-11-02" },
        {
          id: "day",
          kind: "daily_brief",
          from: "2026-11-10",
          to: "2026-11-10",
          createdOn: "2026-11-11",
        },
      ],
    });
    expect(labelled.reports.map((report) => report.kind)).toEqual(["weekly", "daily"]);
    expect(parseDisplayDate("2 Jan 2027")).toBe("2027-01-02");
    expect(parseDisplayDate("02/01/2027")).toBeNull();
  });

  it("rejects a licence date that is not a civil day", () => {
    expect(
      LicencePatchSchema.safeParse({ reference: null, expiresOn: "2026-02-31", gstin: null })
        .success,
    ).toBe(false);
    expect(
      LicencePatchSchema.safeParse({ reference: "14", expiresOn: "2026-12-01", gstin: null })
        .success,
    ).toBe(true);
  });
});

describe("owner menu and ratings", () => {
  it("counts a dish that is missing from one app and does not open editing", () => {
    const menu = composeOwnerMenu([
      { name: "Thali", platform: "zomato", revenuePaise: 40_000 },
      { name: "Thali", platform: "swiggy", revenuePaise: 20_000 },
      { name: "Soup", platform: "zomato", revenuePaise: 5_000 },
    ]);
    expect(menu.editing).toBe(false);
    expect(menu.missingCount).toBe(1);
    expect(menu.rows[0]).toMatchObject({ name: "Thali", revenuePaise: 60_000, missingApp: false });
    expect(menu.rows[1]).toMatchObject({ name: "Soup", missingApp: true });
    expect(menu.swiggy).toBeNull();
    const withFacts = composeOwnerMenu([], {
      score: null,
      photoPct: 0,
      descriptionPct: 40,
      top5RevenuePaise: 12_000,
    });
    expect(withFacts.swiggy?.photoPct).toBe(0);
    expect(withFacts.swiggy?.score).toBeNull();
  });

  it("keeps a review reply as text and never a post", () => {
    const screen = composeOwnerRatings({
      rating: 4.2,
      reviews: [
        {
          id: "rev-1",
          platform: "zomato",
          rating: 5,
          text: "Hot food.",
          reply: "Thank you, we will keep it hot.",
          date: "2026-11-14",
        },
      ],
    });
    expect(screen.reviews[0]?.reply).toBe("Thank you, we will keep it hot.");
    expect(screen.reviews[0]).not.toHaveProperty("post");
    const swiggy = screen.apps.find((app) => app.platform === "swiggy");
    expect(swiggy?.rating).toBeNull();
    expect(swiggy?.ratingState).toBe("not_in_report");
    const told = composeOwnerRatings({
      rating: 9,
      reviews: [],
      apps: [
        {
          platform: "swiggy",
          rating: 9,
          poorRatedOrders: 0,
          complaints: { complaints_missing: 0 },
        },
      ],
    });
    expect(told.apps.find((app) => app.platform === "swiggy")).toMatchObject({
      rating: null,
      ratingState: "not_in_report",
      poorRatedOrders: null,
    });
    expect(told.apps.find((app) => app.platform === "swiggy")?.complaints[0]).toMatchObject({
      count: null,
    });
    const reported = composeOwnerRatings({
      rating: null,
      reviews: [],
      apps: [
        {
          platform: "zomato",
          rating: 4.2,
          poorRatedOrders: 2,
          complaints: { complaints_missing: 2, complaints_quality: 0 },
        },
      ],
    });
    const zomato = reported.apps.find((app) => app.platform === "zomato");
    expect(zomato?.poorRatedOrders).toBe(2);
    expect(zomato?.complaints.find((row) => row.id === "complaints_quality")?.count).toBe(0);
    expect(zomato?.complaints.find((row) => row.id === "complaints_packaging")?.count).toBeNull();
  });
});
