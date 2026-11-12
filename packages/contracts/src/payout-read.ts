import { daysBetween } from "./metric-dates.js";
import type { MetricPlatform } from "./metric-dictionary.js";

export const NOT_SETTLEMENT_FIGURE = "This figure is not part of the settlement-date payout.";
export const NOT_ZOMATO_CUSTOMERS = "Distinct customers are counted from Zomato payout orders.";
export const NOT_CYCLE_TOTAL = "The platform's cycle total is a settlement figure.";

export interface PayoutOrderFact {
  platform: MetricPlatform;
  orderDate: string;
  settlementStatus: "settled" | "pending";
  settlementDate: string | null;
  customerHash: string | null;
  grossSalesPaise: number;
  discountPaise: number;
  commissionPaise: number;
  platformFeesPaise: number;
  taxesPaise: number;
  tdsPaise: number;
  tcsPaise: number;
  cvPaise: number;
  gstCollectedPaise: number;
  complaintsCancellationChargesPaise: number;
  netPayoutPaise: number;
}

export interface PayoutAdjustmentFact {
  platform: MetricPlatform;
  type: string;
  periodFrom: string;
  periodTo: string;
  amountPaise: number;
  bookedCycle: string;
  settlementDate: string | null;
  settlementStatus: "settled" | "pending";
}

export interface PayoutCycleFact {
  platform: MetricPlatform;
  settlementStatus: "settled" | "pending";
  settlementDate: string | null;
  platformNetPayoutPaise: number | null;
}

export interface PayoutGap {
  settledFromEarlierPaise: number;
  notYetSettledPaise: number;
  adjustmentsPaise: number;
}

export interface PayoutReadValue {
  key: string;
  value: number | null;
  status: "ok" | "not_available";
  reason?: string;
}

export interface PayoutRead {
  values: PayoutReadValue[];
  gap: PayoutGap;
  provisional: boolean;
}

const AMOUNT_KEYS = [
  "gross_sales_paise",
  "discount_paise",
  "cv_paise",
  "commission_paise",
  "platform_fees_paise",
  "taxes_paise",
  "tds_paise",
  "tcs_paise",
  "gst_collected_paise",
  "complaints_cancellation_charges_paise",
  "net_payout_paise",
] as const;

type AmountKey = (typeof AMOUNT_KEYS)[number];

const FIELD: Record<Exclude<AmountKey, "net_payout_paise">, keyof PayoutOrderFact> = {
  gross_sales_paise: "grossSalesPaise",
  discount_paise: "discountPaise",
  cv_paise: "cvPaise",
  commission_paise: "commissionPaise",
  platform_fees_paise: "platformFeesPaise",
  taxes_paise: "taxesPaise",
  tds_paise: "tdsPaise",
  tcs_paise: "tcsPaise",
  gst_collected_paise: "gstCollectedPaise",
  complaints_cancellation_charges_paise: "complaintsCancellationChargesPaise",
};

export function readPayoutWindow(input: {
  platform: MetricPlatform | "combined";
  basis: "order_date" | "settlement_date";
  from: string;
  to: string;
  orders: readonly PayoutOrderFact[];
  adjustments: readonly PayoutAdjustmentFact[];
  cycles: readonly PayoutCycleFact[];
}): PayoutRead {
  const platforms: MetricPlatform[] =
    input.platform === "combined" ? ["zomato", "swiggy"] : [input.platform];
  const orders = input.orders.filter((order) => platforms.includes(order.platform));
  const adjustments = input.adjustments.filter((row) => platforms.includes(row.platform));
  const cycles = input.cycles.filter((row) => platforms.includes(row.platform));
  const inWindow = (date: string | null) => date != null && date >= input.from && date < input.to;
  const provisional = [...orders, ...cycles].some(
    (row) => row.settlementStatus === "pending" && overlaps(row, input),
  );

  if (input.basis === "settlement_date") {
    return settlementRead(input, orders, adjustments, cycles, inWindow, provisional);
  }
  return orderDateRead(input, orders, adjustments, provisional);
}

function settlementRead(
  input: { platform: MetricPlatform | "combined"; from: string; to: string },
  orders: PayoutOrderFact[],
  adjustments: PayoutAdjustmentFact[],
  cycles: PayoutCycleFact[],
  inWindow: (date: string | null) => boolean,
  provisional: boolean,
): PayoutRead {
  const settled = orders.filter(
    (order) => order.settlementStatus === "settled" && inWindow(order.settlementDate),
  );
  const booked = adjustments.filter((row) => inWindow(row.settlementDate));
  const sums = sumOrders(settled);
  const adjustmentTotal = booked.reduce((total, row) => total + row.amountPaise, 0);
  const ads = booked
    .filter((row) => isAds(row.type))
    .reduce((total, row) => total + row.amountPaise, 0);
  sums.net_payout_paise -= adjustmentTotal;
  const values: PayoutReadValue[] = AMOUNT_KEYS.map((key) => ok(key, sums[key]));
  values.push(ok("ad_spend_paise", ads));
  values.push(ok("payout_orders", settled.length));
  const platformNet = cycles
    .filter((row) => inWindow(row.settlementDate))
    .reduce((total, row) => total + (row.platformNetPayoutPaise ?? 0), 0);
  values.push(ok("platform_net_payout_paise", platformNet));
  values.push(commissionGst(input.platform, sums));
  values.push(customers(input.platform, settled));
  const earlier = settled
    .filter((order) => order.orderDate < input.from)
    .reduce((total, order) => total + order.netPayoutPaise, 0);
  const pending = orders
    .filter((order) => order.settlementStatus === "pending" && inWindow(order.orderDate))
    .reduce((total, order) => total + order.netPayoutPaise, 0);
  return {
    values,
    provisional,
    gap: {
      settledFromEarlierPaise: earlier,
      notYetSettledPaise: pending,
      adjustmentsPaise: adjustmentTotal,
    },
  };
}

function orderDateRead(
  input: { platform: MetricPlatform | "combined"; from: string; to: string },
  orders: PayoutOrderFact[],
  adjustments: PayoutAdjustmentFact[],
  provisional: boolean,
): PayoutRead {
  const placed = orders.filter(
    (order) => order.orderDate >= input.from && order.orderDate < input.to,
  );
  const sums = sumOrders(placed);
  const spreadAds = spreadInWindow(
    adjustments.filter((row) => isAds(row.type)),
    input.from,
    input.to,
  );
  const spreadAll = spreadInWindow(adjustments, input.from, input.to);
  const values: PayoutReadValue[] = AMOUNT_KEYS.map((key) => ok(key, sums[key]));
  values.push(ok("ad_spend_paise", spreadAds));
  values.push(ok("payout_orders", placed.length));
  values.push({
    key: "platform_net_payout_paise",
    value: null,
    status: "not_available",
    reason: NOT_CYCLE_TOTAL,
  });
  values.push(commissionGst(input.platform, sums));
  values.push(customers(input.platform, placed));
  const pending = placed
    .filter((order) => order.settlementStatus === "pending")
    .reduce((total, order) => total + order.netPayoutPaise, 0);
  return {
    values,
    provisional: provisional || pending !== 0,
    gap: {
      settledFromEarlierPaise: 0,
      notYetSettledPaise: pending,
      adjustmentsPaise: spreadAll,
    },
  };
}

function sumOrders(orders: readonly PayoutOrderFact[]): Record<AmountKey, number> {
  const sums = {
    gross_sales_paise: 0,
    discount_paise: 0,
    cv_paise: 0,
    commission_paise: 0,
    platform_fees_paise: 0,
    taxes_paise: 0,
    tds_paise: 0,
    tcs_paise: 0,
    gst_collected_paise: 0,
    complaints_cancellation_charges_paise: 0,
    net_payout_paise: 0,
  };
  for (const order of orders) {
    for (const key of Object.keys(FIELD) as Array<keyof typeof FIELD>) {
      const field = FIELD[key];
      sums[key] += Number(order[field]);
    }
    sums.net_payout_paise += order.netPayoutPaise;
  }
  return sums;
}

function spreadInWindow(rows: readonly PayoutAdjustmentFact[], from: string, to: string): number {
  let total = 0;
  for (const row of rows) {
    const days = daysBetween(row.periodFrom, row.periodTo);
    if (days.length === 0) continue;
    const base = Math.trunc(row.amountPaise / days.length);
    let remainder = row.amountPaise - base * days.length;
    for (const day of days) {
      let share = base;
      if (remainder > 0) {
        share += 1;
        remainder -= 1;
      } else if (remainder < 0) {
        share -= 1;
        remainder += 1;
      }
      if (day >= from && day < to) total += share;
    }
  }
  return total;
}

function commissionGst(
  platform: MetricPlatform | "combined",
  sums: Record<AmountKey, number>,
): PayoutReadValue {
  if (platform === "combined") {
    return {
      key: "commission_pg_gst_paise",
      value: null,
      status: "not_available",
      reason: NOT_SETTLEMENT_FIGURE,
    };
  }
  const fees = sums.commission_paise + sums.platform_fees_paise;
  return ok("commission_pg_gst_paise", platform === "swiggy" ? fees : fees + sums.taxes_paise);
}

function customers(
  platform: MetricPlatform | "combined",
  orders: readonly PayoutOrderFact[],
): PayoutReadValue {
  if (platform !== "zomato") {
    return {
      key: "unique_customers",
      value: null,
      status: "not_available",
      reason: NOT_ZOMATO_CUSTOMERS,
    };
  }
  const hashes = new Set(
    orders.flatMap((order) => (order.customerHash ? [order.customerHash] : [])),
  );
  return ok("unique_customers", hashes.size);
}

function overlaps(
  row: { orderDate?: string; settlementDate?: string | null; settlementStatus: string },
  input: { from: string; to: string },
): boolean {
  const orderDate = "orderDate" in row ? row.orderDate : null;
  const settlement = row.settlementDate ?? null;
  return (
    (orderDate != null && orderDate >= input.from && orderDate < input.to) ||
    (settlement != null && settlement >= input.from && settlement < input.to)
  );
}

function isAds(label: string): boolean {
  return /\b(ads?|advertis\w*|cpc|sponsored)\b|growth|investment/i.test(label);
}

function ok(key: string, value: number): PayoutReadValue {
  return { key, value, status: "ok" };
}

export function payoutOrderDate(orderDate: Date): string {
  return orderDate.toISOString().slice(0, 10);
}
