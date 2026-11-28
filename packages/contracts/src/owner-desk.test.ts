import { describe, expect, it } from "vitest";
import { formatExclusiveRange, formatRupees } from "./ops/format.js";
import type { PaymentCycle } from "./owner-desk.js";
import {
  composeOwnerDocuments,
  composeOwnerMenu,
  composeOwnerPayments,
  composeOwnerRatings,
  LicencePatchSchema,
  largestRemainderRupees,
  PAYOUT_CHECK,
  parseDisplayDate,
  paymentPeriodLabel,
  paymentPeriods,
  payoutAppFigures,
  payoutAppLine,
  ratingsForWindow,
  ratingsFromRows,
  unstoredPayoutWindows,
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
    expect(screen.payouts[0]?.bankBasis).toBe("net");
    expect(screen.breakdown.map((row) => row.id)).toEqual([
      "sales",
      "discounts",
      "commission",
      "ads",
      "tax",
      "gst",
      "complaints",
      "adjustments",
      "other",
      "net",
    ]);
    expect(screen.breakdown.find((row) => row.id === "discounts")?.paise).toBeNull();
    expect(screen.breakdown.find((row) => row.id === "net")).toMatchObject({
      paise: 80_500,
      basis: "net",
    });
    expect(JSON.stringify(screen)).not.toContain("Matches");
  });

  it("nets adjustments and leaves GST collected out of the tax line", () => {
    const screen = composeOwnerPayments({
      cycles: [
        cycle("c", "2026-11-16", {
          from: "2026-11-09",
          paidAmountPaise: 11_600,
          grossSalesPaise: 20_000,
          discountsPaise: 2_000,
          commissionPaise: 3_000,
          feesPaise: 1_000,
          adsPaise: 2_000,
          taxesPaise: 500,
          tdsPaise: 100,
          gstPaise: 700,
          complaintsPaise: 200,
          netPayoutPaise: 10_000,
        }),
      ],
      orders: [],
      adjustments: [{ cycleId: "c", label: "Credit", amountPaise: -400 }],
      selectedId: null,
    });
    const tax = screen.breakdown.find((row) => row.id === "tax")?.paise;
    expect(tax).toBe(600);
    expect(formatExclusiveRange("2026-11-09", "2026-11-16")).toBe("9–15 Nov");
    expect(formatExclusiveRange("2026-11-08", "2026-11-15")).toBe("8–14 Nov");
    const signed = (id: string) => screen.breakdown.find((row) => row.id === id)?.paise ?? 0;
    const reached =
      signed("sales") -
      signed("discounts") -
      signed("commission") -
      signed("ads") -
      signed("tax") -
      signed("complaints") +
      signed("other");
    expect(Math.abs(reached - 11_600)).toBeLessThanOrEqual(100);
  });

  it("uses the stored ads rows when the breakup total leaves one out", () => {
    const summary = 2_329_800;
    const extra = 52_800;
    const screen = composeOwnerPayments({
      cycles: [
        cycle("c", "2026-11-15", {
          from: "2026-11-08",
          paidAmountPaise: 1_000_000,
          grossSalesPaise: 2_000_000,
          adsPaise: summary,
        }),
      ],
      orders: [],
      adjustments: [
        { cycleId: "c", label: "ADS", amountPaise: summary },
        { cycleId: "c", label: "ADS", amountPaise: extra },
      ],
      selectedId: null,
    });
    expect(screen.breakdown.find((row) => row.id === "ads")?.paise).toBe(summary + extra);
    expect(formatRupees(summary + extra)).toBe("₹23,826");
    expect(formatRupees(summary)).toBe("₹23,298");
    const signed = (id: string) => screen.breakdown.find((row) => row.id === id)?.paise ?? 0;
    expect(
      signed("sales") -
        signed("discounts") -
        signed("commission") -
        signed("ads") -
        signed("tax") -
        signed("complaints") +
        signed("other"),
    ).toBe(1_000_000);
  });

  it("counts ads once and leaves other as the remainder", () => {
    const screen = composeOwnerPayments({
      cycles: [
        cycle("c", "2026-11-16", {
          paidAmountPaise: 50_000,
          grossSalesPaise: 80_000,
          discountsPaise: 5_000,
          commissionPaise: 10_000,
          feesPaise: 0,
          adsPaise: 4_000,
          taxesPaise: 1_000,
          complaintsPaise: 500,
        }),
      ],
      orders: [],
      adjustments: [
        { cycleId: "c", label: "Ads", amountPaise: 4_000 },
        { cycleId: "c", label: "Credit", amountPaise: -1_000 },
      ],
      selectedId: null,
    });
    expect(screen.breakdown.find((row) => row.id === "ads")?.paise).toBe(4_000);
    expect(screen.breakdown.find((row) => row.id === "other")?.paise).toBe(-9_500);
    const signed = (id: string) => screen.breakdown.find((row) => row.id === id)?.paise ?? 0;
    expect(
      signed("sales") -
        signed("discounts") -
        signed("commission") -
        signed("ads") -
        signed("tax") -
        signed("complaints") +
        signed("other"),
    ).toBe(50_000);
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
    expect(screen.breakdown.find((row) => row.id === "discounts")?.label).toBe(
      "− Discounts you paid for",
    );
    expect(screen.breakdown.find((row) => row.id === "bank")?.label).toBe("= Paid to your bank");
  });

  it("keeps offset settlement weeks on separate rows", () => {
    const screen = composeOwnerPayments({
      cycles: [
        cycle("z-new", "2026-11-23", {
          from: "2026-11-16",
          netPayoutPaise: 5_000_000,
          paidAmountPaise: null,
        }),
        cycle("z", "2026-11-16", {
          from: "2026-11-09",
          netPayoutPaise: 10_361_477,
          adsPaise: 2_270_143,
          paidAmountPaise: null,
        }),
        cycle("s", "2026-11-15", {
          from: "2026-11-08",
          platform: "swiggy",
          netPayoutPaise: 9_000_000,
          paidAmountPaise: 8_067_351,
        }),
      ],
      orders: [],
      adjustments: [{ cycleId: "z", label: "ADS", amountPaise: 2_270_143 }],
      selectedId: "s",
    });
    expect(screen.payouts.find((payout) => payout.id === "z")?.expectedPaise).toBe(8_091_334);
    const periods = paymentPeriods(screen.payouts);
    expect(periods.map((period) => period.zomato?.id ?? period.swiggy?.id)).toEqual([
      "z-new",
      "z",
      "s",
    ]);
    expect(periods.every((period) => (period.zomato == null) !== (period.swiggy == null))).toBe(
      true,
    );
    expect(periods.map((period) => paymentPeriodLabel(period))).toEqual([
      "Zomato 16–22 Nov",
      "Zomato 9–15 Nov",
      "Swiggy 8–14 Nov",
    ]);
    const apps = payoutAppFigures(screen.payouts);
    expect(apps.swiggy).toMatchObject({ basis: "paid", paise: 8_067_351, from: "2026-11-08" });
    expect(apps.zomato.paise).not.toBe((apps.zomato.paise ?? 0) + (apps.swiggy.paise ?? 0));
    expect(apps.swiggy.paise).not.toBe((apps.zomato.paise ?? 0) + (apps.swiggy.paise ?? 0));
  });

  it("sums a null Zomato total from order rows and leaves an absent field null", () => {
    const screen = composeOwnerPayments({
      cycles: [
        cycle("z", "2026-11-16", {
          from: "2026-11-09",
          commissionPaise: null,
          feesPaise: null,
          taxesPaise: null,
          gstPaise: null,
          adsPaise: null,
          grossSalesPaise: null,
        }),
      ],
      orders: [
        {
          cycleId: "z",
          orderId: "o-1",
          date: "2026-11-10",
          netPayoutPaise: 40_000,
          grossSalesPaise: 60_000,
          commissionPaise: 5_000,
          feesPaise: 1_000,
          taxesPaise: 200,
          tdsPaise: 40,
          tcsPaise: 20,
          gstCollectedPaise: 300,
        },
        {
          cycleId: "z",
          orderId: "o-2",
          date: "2026-11-11",
          netPayoutPaise: 20_000,
          grossSalesPaise: 30_000,
          commissionPaise: 2_500,
          feesPaise: 500,
          taxesPaise: 100,
          tdsPaise: 10,
          tcsPaise: null,
          gstCollectedPaise: null,
          gstDeductionPaise: 100,
        },
      ],
      adjustments: [
        { cycleId: "z", label: "ADS", amountPaise: 2_000_000 },
        { cycleId: "z", label: "ADS", amountPaise: 52_800 },
        { cycleId: "z", label: "Packaging recovery", amountPaise: 15_000 },
      ],
      selectedId: "z",
    });
    const paise = (id: string) => screen.breakdown.find((row) => row.id === id)?.paise;
    expect(paise("sales")).toBe(90_000);
    expect(paise("commission")).toBe(9_000);
    expect(paise("tax")).toBe(370);
    expect(paise("gst")).toBe(400);
    expect(paise("ads")).toBe(2_052_800);
    expect(paise("adjustments")).toBe(15_000);
    expect(paise("discounts")).toBeNull();
    expect(paise("complaints")).toBeNull();
    for (const id of ["commission", "tax", "gst", "ads", "adjustments"]) {
      expect(paise(id)).not.toBe(0);
      expect(paise(id)).not.toBeNull();
    }
    expect(screen.breakdown.find((row) => row.id === "gst")?.label).toBe("GST collected");
  });

  it("labels each app's own dates and adds the open period that has no report", () => {
    const periods = paymentPeriods([
      { platform: "zomato" as const, from: "2026-11-09", to: "2026-11-16" },
      { platform: "swiggy" as const, from: "2026-11-08", to: "2026-11-15" },
    ]);
    expect(periods).toHaveLength(2);
    expect(periods.map((period) => paymentPeriodLabel(period))).toEqual([
      "Zomato 9–15 Nov",
      "Swiggy 8–14 Nov",
    ]);
    expect(periods.every((period) => period.zomato == null || period.swiggy == null)).toBe(true);
    const words = { paid: "Paid", expected: "Expected", missing: "Report not in yet" };
    const header = payoutAppFigures([
      {
        platform: "zomato" as const,
        from: "2026-11-09",
        to: "2026-11-16",
        bankBasis: "net" as const,
        paidAmountPaise: null,
        expectedPaise: 8_091_300,
      },
      {
        platform: "swiggy" as const,
        from: "2026-11-08",
        to: "2026-11-15",
        bankBasis: "paid" as const,
        paidAmountPaise: 8_067_400,
        expectedPaise: 8_067_400,
      },
    ]);
    const lines = [
      payoutAppLine("Zomato", header.zomato, words),
      payoutAppLine("Swiggy", header.swiggy, words),
    ];
    expect(lines).toEqual(["Zomato 9–15 Nov · Expected ₹80,913", "Swiggy 8–14 Nov · Paid ₹80,674"]);
    expect(lines.join(" ")).not.toContain("₹1,61,587");
    const windows = unstoredPayoutWindows(
      [
        { platform: "zomato", from: "2026-11-02", to: "2026-11-09" },
        { platform: "zomato", from: "2026-11-09", to: "2026-11-16" },
        { platform: "swiggy", from: "2026-11-08", to: "2026-11-15" },
      ],
      "2026-11-22",
    );
    expect(windows).toEqual([
      { platform: "zomato", from: "2026-11-16", to: "2026-11-23" },
      { platform: "swiggy", from: "2026-11-15", to: "2026-11-22" },
    ]);
    const deduction = composeOwnerPayments({
      cycles: [cycle("z", "2026-11-16", { gstPaise: null, gstKind: undefined })],
      orders: [
        {
          cycleId: "z",
          orderId: "o",
          date: "2026-11-10",
          netPayoutPaise: 1,
          gstCollectedPaise: null,
          gstDeductionPaise: 718_500,
        },
      ],
      adjustments: [],
      selectedId: "z",
    });
    expect(deduction.breakdown.find((row) => row.id === "gst")?.label).toBe("− GST");
  });

  it("labels an exclusive cycle end through the day before, and the next open period with no shared day", () => {
    const stored = { platform: "swiggy" as const, from: "2026-11-08", to: "2026-11-15" };
    expect(paymentPeriodLabel({ zomato: null, swiggy: stored })).toBe("Swiggy 8–14 Nov");
    const open = unstoredPayoutWindows([stored], "2026-11-22")[0];
    expect(open).toEqual({ platform: "swiggy", from: "2026-11-15", to: "2026-11-22" });
    expect(paymentPeriodLabel({ zomato: null, swiggy: open ?? null })).toBe("Swiggy 15–21 Nov");
    expect(
      payoutAppLine(
        "Swiggy",
        { basis: "missing", paise: null, from: "2026-11-15", to: "2026-11-22" },
        { paid: "Paid", expected: "Expected", missing: "Report not in yet" },
      ),
    ).toBe("Swiggy 15–21 Nov · Report not in yet");
  });

  it("rounds breakdown rupees so they add to the displayed total", () => {
    const parts = [
      { id: "a", paise: 33_350 },
      { id: "b", paise: 33_350 },
      { id: "c", paise: 33_300 },
    ];
    const shown = largestRemainderRupees(parts, 100_000);
    const rupees = Object.values(shown).reduce((sum, paise) => sum + Math.round(paise / 100), 0);
    expect(rupees).toBe(1_000);
    const naive = parts.reduce((sum, part) => sum + Math.round(part.paise / 100), 0);
    expect(naive).toBe(1_001);
  });

  it("signs a positive other adjustment as a credit", () => {
    const screen = composeOwnerPayments({
      cycles: [
        cycle("c", "2026-11-16", {
          paidAmountPaise: 70_800,
          grossSalesPaise: 100_000,
          discountsPaise: 20_000,
          commissionPaise: 10_000,
          adsPaise: 4_000,
        }),
      ],
      orders: [],
      adjustments: [],
      selectedId: null,
    });
    expect(screen.breakdown.find((row) => row.id === "other")).toMatchObject({
      label: "+ Other adjustments",
      paise: 4_800,
    });
    expect(screen.breakdown.find((row) => row.id === "bank")?.label).toBe("= Paid to your bank");
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
          createdAt: "2026-11-10T03:30:00.000Z",
        },
      ],
    });
    expect(labelled.reports.map((report) => report.kind)).toEqual(["weekly", "daily"]);
    expect(labelled.reports.find((report) => report.kind === "daily")?.createdAt).toBe(
      "2026-11-10T03:30:00.000Z",
    );
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
      poorRatedOrders: 0,
    });
    expect(told.apps.find((app) => app.platform === "swiggy")?.complaints[0]).toMatchObject({
      count: 0,
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

  it("states poorly rated orders as a percent of the same day's orders", () => {
    const screen = composeOwnerRatings({
      rating: null,
      reviews: [],
      apps: [{ platform: "zomato", poorRatedOrders: 2, orders: 8, complaints: {} }],
    });
    expect(screen.apps.find((app) => app.platform === "zomato")?.poorRatedPct).toBe(25);
    const missing = composeOwnerRatings({
      rating: null,
      reviews: [],
      apps: [{ platform: "zomato", poorRatedOrders: 2, complaints: {} }],
    });
    expect(missing.apps.find((app) => app.platform === "zomato")?.poorRatedPct).toBeNull();
    const summed = composeOwnerRatings(
      ratingsFromRows([
        { platform: "zomato", key: "rating", value: 4.1, rowRole: "platform_check" },
        { platform: "zomato", key: "rating", value: 0, rowRole: "fact" },
        { platform: "zomato", key: "complaints_missing", value: 4, rowRole: "fact" },
        { platform: "zomato", key: "complaints_missing", value: 2, rowRole: "fact" },
        { platform: "swiggy", key: "complaints_missing", value: 1, rowRole: "fact" },
        { platform: "zomato", key: "poor_rated_orders", value: 3, rowRole: "fact" },
        { platform: "zomato", key: "poor_rated_orders", value: 1, rowRole: "fact" },
        { platform: "zomato", key: "rated_orders", value: 10, rowRole: "fact" },
        { platform: "zomato", key: "rated_orders", value: 10, rowRole: "fact" },
      ]),
    );
    expect(summed.rating).toBe(4.1);
    expect(summed.apps.find((app) => app.platform === "zomato")?.complaints[0]?.count).toBe(6);
    expect(summed.apps.find((app) => app.platform === "swiggy")?.complaints[0]?.count).toBe(1);
    expect(summed.apps.find((app) => app.platform === "zomato")?.poorRatedPct).toBe(20);
  });

  it("sums the four weeks ending on the last day both apps have data", () => {
    const screen = ratingsForWindow(
      [
        {
          platform: "zomato",
          key: "ops_sales_paise",
          value: 1,
          rowRole: "fact",
          date: "2026-11-20",
        },
        {
          platform: "swiggy",
          key: "swiggy_net_sales_paise",
          value: 1,
          rowRole: "fact",
          date: "2026-11-20",
        },
        {
          platform: "zomato",
          key: "ops_sales_paise",
          value: 1,
          rowRole: "fact",
          date: "2026-11-21",
        },
        {
          platform: "zomato",
          key: "rating",
          value: 4.33,
          rowRole: "platform_check",
          date: "2026-11-20",
        },
        {
          platform: "zomato",
          key: "rating",
          value: 0,
          rowRole: "fact",
          date: "2026-11-20",
        },
        {
          platform: "zomato",
          key: "complaints_missing",
          value: 9,
          rowRole: "fact",
          date: "2026-11-20",
        },
        {
          platform: "swiggy",
          key: "complaints_missing",
          value: 7,
          rowRole: "fact",
          date: "2026-11-20",
        },
        {
          platform: "zomato",
          key: "complaints_missing",
          value: 100,
          rowRole: "fact",
          date: "2026-11-21",
        },
        {
          platform: "zomato",
          key: "complaints_missing",
          value: 50,
          rowRole: "fact",
          date: "2026-10-01",
        },
        {
          platform: "swiggy",
          key: "complaints_quality",
          value: 5,
          rowRole: "fact",
          date: "2026-11-20",
        },
        {
          platform: "zomato",
          key: "complaints_quality",
          value: 8,
          rowRole: "fact",
          date: "2026-11-20",
        },
      ],
      "2026-11-22",
    );
    expect(screen.from).toBe("2026-10-24");
    expect(screen.to).toBe("2026-11-20");
    expect(screen.rating).toBe(4.33);
    const missing = screen.totals?.find((row) => row.id === "complaints_missing")?.count;
    const zomato = screen.apps.find((app) => app.platform === "zomato");
    const swiggy = screen.apps.find((app) => app.platform === "swiggy");
    const zMissing = zomato?.complaints.find((row) => row.id === "complaints_missing")?.count ?? 0;
    const sMissing = swiggy?.complaints.find((row) => row.id === "complaints_missing")?.count ?? 0;
    expect(missing).toBe(16);
    expect(zMissing + sMissing).toBe(missing);
    const quality = screen.totals?.find((row) => row.id === "complaints_quality")?.count;
    expect(quality).toBe(13);
    expect(
      (zomato?.complaints.find((row) => row.id === "complaints_quality")?.count ?? 0) +
        (swiggy?.complaints.find((row) => row.id === "complaints_quality")?.count ?? 0),
    ).toBe(quality);
  });
});
