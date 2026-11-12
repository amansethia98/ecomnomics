import { METRIC_KEYS, OwnerMetricsQuerySchema, ownerMetricsErrorMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type {
  OwnerAdjustmentFact,
  OwnerMetricsInput,
  OwnerOrderFact,
} from "./owner-metrics-assemble.js";
import { assembleOwnerMetrics, spreadShares } from "./owner-metrics-assemble.js";

const north = { id: "outlet-north", name: "North" };
const south = { id: "outlet-south", name: "South" };

function query(
  overrides: Partial<OwnerMetricsInput["query"]> & Pick<OwnerMetricsInput["query"], "keys">,
): OwnerMetricsInput["query"] {
  return {
    platform: "zomato",
    from: "2026-01-01",
    to: "2026-01-04",
    basis: "order_date",
    likeForLike: false,
    ...overrides,
    outletIds: overrides.outletIds,
  };
}

function order(overrides: Partial<OwnerOrderFact> = {}): OwnerOrderFact {
  return {
    outletId: north.id,
    platform: "zomato",
    orderDate: "2026-01-01",
    settlementStatus: "settled",
    settlementDate: "2026-01-10",
    utrLast4: "0201",
    category: null,
    customerHash: "hash-a",
    grossSalesPaise: 1000,
    discountPaise: 0,
    commissionPaise: 100,
    platformFeesPaise: 20,
    taxesPaise: 18,
    tdsPaise: 0,
    tcsPaise: 0,
    cvPaise: 1000,
    gstCollectedPaise: 0,
    complaintsCancellationChargesPaise: 0,
    netPayoutPaise: 800,
    paidAmountPaise: null,
    ...overrides,
  };
}

function adjustment(overrides: Partial<OwnerAdjustmentFact> = {}): OwnerAdjustmentFact {
  return {
    outletId: north.id,
    platform: "zomato",
    type: "Ads",
    periodFrom: "2026-01-01",
    periodTo: "2026-01-04",
    amountPaise: 100,
    settlementDate: "2026-01-10",
    settlementStatus: "settled",
    ...overrides,
  };
}

function read(overrides: Partial<OwnerMetricsInput> & Pick<OwnerMetricsInput, "query">) {
  return assembleOwnerMetrics({
    today: "2026-02-01",
    outlets: [north],
    facts: [],
    fetches: [],
    history: [],
    orders: [],
    adjustments: [],
    cycles: [],
    ...overrides,
  });
}

describe("owner metrics read", () => {
  it("spreads an adjustment across its own days and leaves the order net alone", () => {
    expect(spreadShares("2026-01-01", "2026-01-04", 100)).toEqual([
      ["2026-01-01", 34],
      ["2026-01-02", 33],
      ["2026-01-03", 33],
    ]);
    const result = read({
      query: query({ keys: ["net_payout_paise"], from: "2026-01-01", to: "2026-01-03" }),
      orders: [order({ netPayoutPaise: 800 })],
      adjustments: [adjustment()],
    });
    expect(result.values.find((value) => value.key === "net_payout_paise")?.value).toBe(800);
    expect(result.adjustments.amountPaise).toBe(67);
    expect(result.adjustments.byDate).toEqual([
      { date: "2026-01-01", amountPaise: 34 },
      { date: "2026-01-02", amountPaise: 33 },
    ]);
    expect(result.gap.adjustmentsPaise).toBe(67);
  });

  it("returns the gap between the order-date and settlement-date views", () => {
    const orders = [
      order({ orderDate: "2025-12-20", settlementDate: "2026-01-10", netPayoutPaise: 400 }),
      order({
        orderDate: "2026-01-10",
        settlementStatus: "pending",
        settlementDate: null,
        netPayoutPaise: 150,
      }),
    ];
    const result = read({
      query: query({
        keys: ["net_payout_paise"],
        basis: "settlement_date",
        from: "2026-01-10",
        to: "2026-01-11",
      }),
      orders,
      adjustments: [
        adjustment({ amountPaise: 90, periodFrom: "2025-12-01", periodTo: "2025-12-02" }),
      ],
    });
    expect(result.values.find((value) => value.key === "net_payout_paise")?.value).toBe(400);
    expect(result.adjustments.amountPaise).toBe(90);
    expect(result.gap).toEqual({
      settledFromEarlierPaise: 400,
      notYetSettledPaise: 150,
      adjustmentsPaise: 90,
    });
    expect(result.settlements).toEqual([
      {
        outletId: north.id,
        platform: "zomato",
        settlementDate: "2026-01-10",
        utrLast4: "0201",
      },
    ]);
  });

  it("marks a month restated when a later fetch replaced a stored day", () => {
    const result = read({
      query: query({
        keys: ["delivered_orders"],
        from: "2026-01-01",
        to: "2026-03-01",
        grain: "month",
      }),
      facts: [
        {
          outletId: north.id,
          platform: "zomato",
          key: "delivered_orders",
          date: "2026-01-15",
          value: 4,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-16",
        },
        {
          outletId: north.id,
          platform: "zomato",
          key: "delivered_orders",
          date: "2026-02-02",
          value: 1,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-02-03",
        },
      ],
      history: [
        {
          outletId: north.id,
          platform: "zomato",
          key: "delivered_orders",
          from: "2026-01-15",
          to: "2026-01-16",
        },
      ],
    });
    const january = result.series?.find((point) => point.from === "2026-01-01");
    const february = result.series?.find((point) => point.from === "2026-02-01");
    expect(january?.restated).toBe(true);
    expect(january?.values[0]?.restated).toBe(true);
    expect(february?.restated).toBe(false);
    expect(result.values[0]?.restated).toBe(true);
  });

  it("marks provisional days inside the re-fetch window, a pending settlement, and the lag banner", () => {
    const recent = read({
      today: "2026-01-10",
      query: query({ keys: ["delivered_orders"], from: "2026-01-08", to: "2026-01-09" }),
      facts: [
        {
          outletId: north.id,
          platform: "zomato",
          key: "delivered_orders",
          date: "2026-01-08",
          value: 2,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-09",
        },
      ],
    });
    expect(recent.values[0]?.provisional).toBe(true);
    expect(recent.lagBanner).toBeNull();

    const pending = read({
      query: query({ keys: ["net_payout_paise"], from: "2026-01-01", to: "2026-01-02" }),
      orders: [order({ settlementStatus: "pending", settlementDate: null, netPayoutPaise: 50 })],
    });
    expect(pending.values[0]?.provisional).toBe(true);
    expect(pending.gap.notYetSettledPaise).toBe(50);

    const lagged = read({
      query: query({
        platform: "swiggy",
        keys: ["delivered_orders"],
        from: "2026-01-01",
        to: "2026-01-03",
      }),
      facts: [
        {
          outletId: north.id,
          platform: "swiggy",
          key: "delivered_orders",
          date: "2026-01-01",
          value: 3,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-02",
        },
        {
          outletId: north.id,
          platform: "swiggy",
          key: "lag_banner",
          date: "2026-01-02",
          value: null,
          valueBoolean: true,
          granularity: "day",
          periodEnd: "2026-01-03",
        },
      ],
    });
    expect(lagged.lagBanner).toBe(true);
    expect(lagged.values[0]?.provisional).toBe(true);
  });

  it("counts a fetch gap as missing and does not turn it into zero", () => {
    const result = read({
      query: query({ keys: ["delivered_orders"], from: "2026-01-01", to: "2026-01-04" }),
      facts: [
        {
          outletId: north.id,
          platform: "zomato",
          key: "delivered_orders",
          date: "2026-01-01",
          value: 5,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-02",
        },
        {
          outletId: north.id,
          platform: "zomato",
          key: "delivered_orders",
          date: "2026-01-02",
          value: 0,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-03",
        },
      ],
      fetches: [
        {
          outletId: north.id,
          platform: "zomato",
          from: "2026-01-01",
          to: "2026-01-03",
          status: "stored",
        },
      ],
    });
    const value = result.values[0];
    expect(value?.value).toBe(5);
    expect(value?.coverageDays).toBe(2);
    expect(value?.expectedDays).toBe(3);
    expect(value?.missingDates).toEqual(["2026-01-03"]);
    expect(result.note).toContain("North has no data on 2026-01-03");
  });

  it("refuses a cross-platform total for a figure that is not combined", () => {
    const result = read({
      query: query({
        platform: "all",
        keys: ["delivered_orders", "discount_paise"],
        from: "2026-01-01",
        to: "2026-01-02",
      }),
      facts: [
        {
          outletId: north.id,
          platform: "zomato",
          key: "delivered_orders",
          date: "2026-01-01",
          value: 2,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-02",
        },
        {
          outletId: north.id,
          platform: "swiggy",
          key: "delivered_orders",
          date: "2026-01-01",
          value: 3,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-02",
        },
        {
          outletId: north.id,
          platform: "zomato",
          key: "discount_paise",
          date: "2026-01-01",
          value: 10,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-02",
        },
        {
          outletId: north.id,
          platform: "swiggy",
          key: "discount_paise",
          date: "2026-01-01",
          value: 40,
          valueBoolean: null,
          granularity: "day",
          periodEnd: "2026-01-02",
        },
      ],
    });
    expect(result.values.find((value) => value.key === "delivered_orders")).toMatchObject({
      platform: "all",
      value: 5,
      status: "ok",
    });
    const discounts = result.values.filter((value) => value.key === "discount_paise");
    expect(discounts.map((value) => value.platform).sort()).toEqual(["swiggy", "zomato"]);
    expect(discounts.find((value) => value.platform === "all")).toBeUndefined();
    expect(
      result.values.some(
        (value) => value.reason === "This figure is not combined across platforms.",
      ),
    ).toBe(false);
  });

  it("limits a like-for-like total to outlets that cover every day", () => {
    const facts = [
      {
        outletId: north.id,
        platform: "zomato" as const,
        key: "delivered_orders",
        date: "2026-01-01",
        value: 2,
        valueBoolean: null,
        granularity: "day",
        periodEnd: "2026-01-02",
      },
      {
        outletId: north.id,
        platform: "zomato" as const,
        key: "delivered_orders",
        date: "2026-01-02",
        value: 3,
        valueBoolean: null,
        granularity: "day",
        periodEnd: "2026-01-03",
      },
      {
        outletId: south.id,
        platform: "zomato" as const,
        key: "delivered_orders",
        date: "2026-01-02",
        value: 9,
        valueBoolean: null,
        granularity: "day",
        periodEnd: "2026-01-03",
      },
    ];
    const open = read({
      outlets: [north, south],
      query: query({ keys: ["delivered_orders"], from: "2026-01-01", to: "2026-01-03" }),
      facts,
    });
    expect(open.values[0]?.value).toBe(14);
    expect(open.note).toContain("South has no data on 2026-01-01");
    expect(open.outlets.find((outlet) => outlet.id === south.id)?.included).toBe(true);

    const matched = read({
      outlets: [north, south],
      query: query({
        keys: ["delivered_orders"],
        from: "2026-01-01",
        to: "2026-01-03",
        likeForLike: true,
      }),
      facts,
    });
    expect(matched.values[0]?.value).toBe(5);
    expect(matched.outlets.find((outlet) => outlet.id === south.id)?.included).toBe(false);
    expect(matched.note).toContain("The total uses only outlets with data on every day.");
  });

  it("keeps train and Toing inside the Swiggy total and lists them apart", () => {
    const result = read({
      query: query({
        platform: "swiggy",
        keys: ["payout_orders", "net_payout_paise"],
        from: "2026-01-01",
        to: "2026-01-02",
      }),
      orders: [
        order({
          platform: "swiggy",
          category: "TRAIN_ORDER",
          netPayoutPaise: 10,
          grossSalesPaise: 30,
        }),
        order({ platform: "swiggy", category: "Toing", netPayoutPaise: 15, grossSalesPaise: 40 }),
        order({ platform: "swiggy", category: null, netPayoutPaise: 20, grossSalesPaise: 50 }),
      ],
    });
    expect(result.values.find((value) => value.key === "payout_orders")?.value).toBe(3);
    expect(result.values.find((value) => value.key === "net_payout_paise")?.value).toBe(45);
    expect(result.categories).toEqual([
      { platform: "swiggy", category: "other", orders: 1, grossSalesPaise: 50, netPayoutPaise: 20 },
      { platform: "swiggy", category: "toing", orders: 1, grossSalesPaise: 40, netPayoutPaise: 15 },
      { platform: "swiggy", category: "train", orders: 1, grossSalesPaise: 30, netPayoutPaise: 10 },
    ]);
  });

  it("rejects a range over 400 days, more than 100 keys, and a bad date in a sentence", () => {
    const longRange = OwnerMetricsQuerySchema.safeParse({
      platform: "all",
      from: "2025-01-01",
      to: "2026-02-06",
      keys: ["delivered_orders"],
      basis: "order_date",
      likeForLike: false,
    });
    expect(longRange.success).toBe(false);
    if (!longRange.success) {
      expect(ownerMetricsErrorMessage(longRange.error)).toBe(
        "A date range can be at most 400 days.",
      );
    }

    const tooMany = OwnerMetricsQuerySchema.safeParse({
      platform: "zomato",
      from: "2026-01-01",
      to: "2026-01-02",
      keys: [...METRIC_KEYS, ...METRIC_KEYS.slice(0, 40)],
      basis: "order_date",
      likeForLike: false,
    });
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(ownerMetricsErrorMessage(tooMany.error)).toBe("Send at most 100 metric keys.");
    }

    const backwards = OwnerMetricsQuerySchema.safeParse({
      platform: "zomato",
      from: "2026-01-05",
      to: "2026-01-05",
      keys: ["delivered_orders"],
      basis: "order_date",
      likeForLike: false,
    });
    expect(backwards.success).toBe(false);
    if (!backwards.success) {
      expect(ownerMetricsErrorMessage(backwards.error)).toBe("to must be after from.");
    }

    const unknown = OwnerMetricsQuerySchema.safeParse({
      platform: "zomato",
      from: "2026-01-01",
      to: "2026-01-02",
      keys: ["orders"],
      basis: "order_date",
      likeForLike: false,
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(ownerMetricsErrorMessage(unknown.error)).toBe('Unknown metric key "orders".');
    }
  });
});
