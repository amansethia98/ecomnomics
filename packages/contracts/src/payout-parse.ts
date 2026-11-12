import { createHmac } from "node:crypto";
import type { CellValue, Worksheet } from "exceljs";
import { addIsoDays } from "./metric-dates.js";
import type { MetricPlatform } from "./metric-dictionary.js";
import { PAISE_SUM_TOLERANCE } from "./metric-dictionary.js";
import type { ObservedReportIdentity } from "./metric-parse.js";
import { costPaise, discountPaise, rupeesToPaise, signedPaise } from "./payout-money.js";
import { openPayoutWorkbook } from "./payout-workbook.js";

export const PAYOUT_PARSER_VERSION = "2026-11-12.payout.3";

export interface PayoutOrderAmounts {
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

export interface ParsedPayoutOrder extends PayoutOrderAmounts {
  platformOrderId: string;
  orderDate: string;
  orderStatus: string;
  category: string | null;
  cancelledBy: string | null;
  settlementStatus: "settled" | "pending";
  settlementDate: string | null;
  utrLast4: string | null;
  customerHash: string | null;
  mfrMarked: boolean | null;
  mfrAccurate: boolean | null;
  /// Bank paid amount for this order, when the file has a per-order settled amount.
  paidAmountPaise: number | null;
  recomputedNetPaise: number;
}

export interface ParsedAdjustment {
  type: string;
  invoiceId: string;
  periodFrom: string;
  periodTo: string;
  amountPaise: number;
  bookedCycle: string;
}

export interface ParsedCycleTotals {
  orderCount: number | null;
  grossSalesPaise: number | null;
  discountPaise: number | null;
  cvPaise: number | null;
  commissionPaise: number | null;
  platformFeesPaise: number | null;
  taxesPaise: number | null;
  tdsPaise: number | null;
  tcsPaise: number | null;
  gstCollectedPaise: number | null;
  complaintsCancellationChargesPaise: number | null;
  adSpendPaise: number | null;
  platformNetPayoutPaise: number | null;
  /// Bank paid amount. Zomato Amount Settled, or the Swiggy summary total payout. Null when the file has neither.
  paidAmountPaise: number | null;
}

export interface PayoutCheck {
  key: string;
  rebuiltValue: number;
  platformValue: number;
  gap: number;
  tolerance: number;
  pass: boolean;
}

export interface ParsedPayoutFile {
  observed: ObservedReportIdentity;
  cycleId: string;
  cycleStart: string;
  cycleEnd: string;
  settlementStatus: "settled" | "pending";
  settlementDate: string | null;
  utrLast4: string | null;
  orders: ParsedPayoutOrder[];
  adjustments: ParsedAdjustment[];
  totals: ParsedCycleTotals;
  checks: PayoutCheck[];
  warnings: string[];
}

export type PayoutParseResult =
  | { ok: true; payout: ParsedPayoutFile }
  | { ok: false; reason: string; observed: ObservedReportIdentity | null };

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export async function parsePayoutWorkbook(
  bytes: Uint8Array,
  platform: MetricPlatform,
  customerHashSalt: string | null,
): Promise<PayoutParseResult> {
  let workbook: Awaited<ReturnType<typeof openPayoutWorkbook>>;
  try {
    workbook = await openPayoutWorkbook(bytes);
  } catch {
    return { ok: false, reason: "The file is not a payout workbook.", observed: null };
  }
  const sheets = new Map<string, string[][]>();
  for (const sheet of workbook.worksheets) {
    sheets.set(norm(sheet.name), grid(sheet));
  }
  return platform === "swiggy"
    ? parseSwiggy(sheets, customerHashSalt)
    : parseZomato(sheets, customerHashSalt);
}

function parseZomato(sheets: Map<string, string[][]>, salt: string | null): PayoutParseResult {
  const summary = sheets.get("summary") ?? [];
  const hidden = sheets.get("hsummary") ?? [];
  const identity = zomatoIdentity(summary, hidden);
  const range = firstRange(summary) ?? firstRange(hidden);
  if (!identity.restaurantId || !range) {
    return {
      ok: false,
      reason: "The file has no restaurant id or payout cycle.",
      observed: identity.observed,
    };
  }
  const ordersSheet = sheetNamed(sheets, "order", "level");
  if (!ordersSheet) {
    return {
      ok: false,
      reason: "The workbook has no Order Level sheet.",
      observed: identity.observed,
    };
  }
  const header = headerRow(ordersSheet, "order id", "order status");
  if (!header) {
    return {
      ok: false,
      reason: "The Order Level sheet has no header row with Order ID and Order status.",
      observed: identity.observed,
    };
  }
  const warnings: string[] = [];
  if (!salt)
    warnings.push("Customer hashes were not stored because CUSTOMER_HASH_SALT is not set.");
  const orders: ParsedPayoutOrder[] = [];
  const seen = new Set<string>();
  for (const row of ordersSheet.slice(header.index + 1)) {
    const rawId = cell(row, col(header.header, "order id"));
    if (isJunk(rawId)) continue;
    const platformOrderId = rawId.trim().replace(/\.0$/, "");
    if (!platformOrderId) continue;
    if (seen.has(platformOrderId)) {
      return {
        ok: false,
        reason: `The file repeats order ${platformOrderId}.`,
        observed: identity.observed,
      };
    }
    seen.add(platformOrderId);
    const orderDate = parseCivilDate(cell(row, col(header.header, "order date")), range.year);
    if (!orderDate) {
      return {
        ok: false,
        reason: `Order ${platformOrderId} has no order date.`,
        observed: identity.observed,
      };
    }
    const status = orderStatus(cell(row, col(header.header, "order status")));
    const delivered = status === "DELIVERED";
    const subtotal = costPaise(cell(row, col(header.header, "subtotal")));
    const packaging = costPaise(cell(row, col(header.header, "packaging")));
    const promo = discountPaise(cell(row, colIncludes(header.header, "discount", "promo")));
    const otherDiscount = discountPaise(otherDiscountCell(header.header, row));
    const gross = delivered ? subtotal + packaging : 0;
    const discount = delivered ? promo + otherDiscount : 0;
    const commission = costPaise(cell(row, serviceFeeColumn(header.header)));
    const payment = costPaise(cell(row, paymentFeeColumn(header.header)));
    const taxes = costPaise(cell(row, colIncludes(header.header, "taxes on service")));
    const tds = costPaise(cell(row, colIncludes(header.header, "tds")));
    const tcs = tcsColumns(header.header).reduce(
      (total, index) => total + costPaise(cell(row, index)),
      0,
    );
    const complaints = costPaise(
      cell(
        row,
        column(
          header.header,
          (label) => label.includes("compensation") || label.includes("recoupment"),
        ),
      ),
    );
    const additions = signedPaise(cell(row, colIncludes(header.header, "net additions")));
    const cvParsed = rupeesToPaise(cell(row, colIncludes(header.header, "commissionable")));
    const cv = cvParsed == null ? Math.max(0, gross - discount) : Math.abs(cvParsed);
    const recomputed = cv - commission - payment - taxes - tds - tcs - complaints + additions;
    const printed = signedPaise(cell(row, colIncludes(header.header, "order level payout")));
    const settlementDate = parseCivilDate(
      cell(row, colIncludes(header.header, "settlement date")),
      range.year,
    );
    orders.push({
      platformOrderId,
      orderDate,
      orderStatus: status,
      category: null,
      cancelledBy: blankToNull(cell(row, colIncludes(header.header, "cancelled by"))),
      settlementStatus: inferSettlement(
        cell(row, colIncludes(header.header, "settlement status")),
        settlementDate,
      ),
      settlementDate,
      utrLast4: last4(cell(row, colIncludes(header.header, "utr"))),
      customerHash: hashCustomer(cell(row, colIncludes(header.header, "customer id")), salt),
      mfrMarked: null,
      mfrAccurate: null,
      grossSalesPaise: gross,
      discountPaise: discount,
      commissionPaise: commission,
      platformFeesPaise: payment,
      taxesPaise: taxes,
      tdsPaise: tds,
      tcsPaise: tcs,
      cvPaise: cv,
      gstCollectedPaise: costPaise(cell(row, colIncludes(header.header, "gst collected"))),
      complaintsCancellationChargesPaise: complaints,
      netPayoutPaise: printed,
      paidAmountPaise: orderPaid(header.header, row),
      recomputedNetPaise: recomputed,
    });
  }
  if (orders.length === 0) {
    return {
      ok: false,
      reason: "The Order Level sheet has no order rows.",
      observed: identity.observed,
    };
  }
  const cycle = cycleFromOrders(identity.restaurantId, "zomato", range, orders);
  const summaryDate = summarySettlementDate(summary, range.year);
  if (summaryDate) cycle.settlementDate = summaryDate;
  const summaryReference = last4(labeledText(summary, "bank utr"));
  if (summaryReference) cycle.utrLast4 = summaryReference;
  const adjustments = zomatoAdjustments(sheets.get("addition deductions details") ?? []);
  const totals = zomatoTotals(sheets.get("payout breakup") ?? []);
  applyPaidTotal(totals, orders, summaryPaid(summary));
  const observed = withPeriod(identity.observed, cycle.cycleStart, cycle.cycleEnd);
  return {
    ok: true,
    payout: finish("zomato", observed, cycle, orders, adjustments, totals, warnings),
  };
}

function parseSwiggy(sheets: Map<string, string[][]>, _salt: string | null): PayoutParseResult {
  const summary = sheets.get("summary");
  if (!summary) return { ok: false, reason: "The file has no Summary sheet.", observed: null };
  const identity = swiggyIdentity(summary);
  const printed = swiggyPeriod(summary);
  if (!identity.restaurantId || !printed) {
    return {
      ok: false,
      reason: "The Summary sheet has no restaurant id or payout period.",
      observed: identity.observed,
    };
  }
  const ordersSheet = sheetNamed(sheets, "order", "level");
  if (!ordersSheet) {
    return {
      ok: false,
      reason: "The workbook has no Order Level sheet.",
      observed: identity.observed,
    };
  }
  const header = headerRow(ordersSheet, "order id", "order status");
  if (!header) {
    return {
      ok: false,
      reason: "The Order Level sheet has no header row with Order ID and Order status.",
      observed: identity.observed,
    };
  }
  const draft: Array<Omit<ParsedPayoutOrder, "orderDate"> & { orderDate: string | null }> = [];
  const seen = new Set<string>();
  for (const row of ordersSheet.slice(header.index + 1)) {
    const rawId = cell(row, col(header.header, "order id"));
    if (isJunk(rawId)) continue;
    const platformOrderId = rawId.trim().replace(/\.0$/, "");
    if (!/^\d+(\.0)?$/.test(rawId.trim()) && !/^[A-Za-z0-9-]{4,}$/.test(platformOrderId)) continue;
    if (seen.has(platformOrderId)) {
      return {
        ok: false,
        reason: `The file repeats order ${platformOrderId}.`,
        observed: identity.observed,
      };
    }
    seen.add(platformOrderId);
    const item = costPaise(cell(row, colIncludes(header.header, "item total")));
    const packaging = costPaise(cell(row, colIncludes(header.header, "packaging")));
    const discount = discountPaise(
      cell(
        row,
        column(header.header, (label) => label.includes("discount share")) ??
          colIncludes(header.header, "discount"),
      ),
    );
    const gross = item + packaging;
    const commission = costPaise(cell(row, exactCol(header.header, "commission")));
    const totalFees = costPaise(cell(row, colIncludes(header.header, "total swiggy fees")));
    const gstOnFees = costPaise(cell(row, colIncludes(header.header, "gst on service")));
    const platformFees = Math.max(0, totalFees - commission - gstOnFees);
    const tds = costPaise(cell(row, exactCol(header.header, "tds")));
    const tcs = costPaise(cell(row, exactCol(header.header, "tcs")));
    const complaints = costPaise(
      cell(
        row,
        column(
          header.header,
          (label) => label.includes("complaint") && label.includes("cancellation"),
        ) ?? colIncludes(header.header, "complaint"),
      ),
    );
    const cvParsed = rupeesToPaise(cell(row, colIncludes(header.header, "net bill")));
    const cv = cvParsed == null ? Math.max(0, gross - discount) : Math.abs(cvParsed);
    const recomputed = cv - commission - platformFees - gstOnFees - tds - tcs - complaints;
    const settlementDate = parseCivilDate(
      cell(row, colIncludes(header.header, "settlement date")),
      null,
    );
    draft.push({
      platformOrderId,
      orderDate: parseCivilDate(cell(row, orderDateColumn(header.header)), null),
      orderStatus: orderStatus(cell(row, col(header.header, "order status"))),
      category: swiggyCategory(cell(row, colIncludes(header.header, "category"))),
      cancelledBy: blankToNull(cell(row, colIncludes(header.header, "cancelled by"))),
      settlementStatus: inferSettlement(
        cell(row, colIncludes(header.header, "settlement status")),
        settlementDate,
      ),
      settlementDate,
      utrLast4: last4(cell(row, colIncludes(header.header, "utr"))),
      customerHash: null,
      mfrMarked: flag(
        cell(
          row,
          colIncludes(header.header, "mfr pressed") ?? colIncludes(header.header, "mfr marked"),
        ),
      ),
      mfrAccurate: flag(cell(row, colIncludes(header.header, "mfr accurate"))),
      grossSalesPaise: gross,
      discountPaise: discount,
      commissionPaise: commission,
      platformFeesPaise: platformFees,
      taxesPaise: gstOnFees,
      tdsPaise: tds,
      tcsPaise: tcs,
      cvPaise: cv,
      gstCollectedPaise: costPaise(cell(row, colIncludes(header.header, "gst collected"))),
      complaintsCancellationChargesPaise: complaints,
      netPayoutPaise: signedPaise(cell(row, colIncludes(header.header, "net payout"))),
      paidAmountPaise: orderPaid(header.header, row),
      recomputedNetPaise: recomputed,
    });
  }
  const dated = draft.flatMap((order) => (order.orderDate ? [order.orderDate] : []));
  if (dated.length === 0) {
    return {
      ok: false,
      reason: "The Order Level sheet has no order dates.",
      observed: identity.observed,
    };
  }
  const corrected = correctSwiggyPeriod(printed, dated);
  const orders: ParsedPayoutOrder[] = [];
  for (const order of draft) {
    const orderDate = order.orderDate;
    if (!orderDate) {
      return {
        ok: false,
        reason: `Order ${order.platformOrderId} has no order date.`,
        observed: identity.observed,
      };
    }
    orders.push({ ...order, orderDate });
  }
  const cycle = {
    cycleId: `swiggy:${identity.restaurantId}:${corrected.start}:${corrected.end}`,
    cycleStart: corrected.start,
    cycleEnd: corrected.end,
    settlementStatus: orders.some((order) => order.settlementStatus === "pending")
      ? ("pending" as const)
      : ("settled" as const),
    settlementDate: mode(
      orders.flatMap((order) => (order.settlementDate ? [order.settlementDate] : [])),
    ),
    utrLast4: mode(orders.flatMap((order) => (order.utrLast4 ? [order.utrLast4] : []))),
  };
  const summaryDate = summarySettlementDate(summary, Number(corrected.start.slice(0, 4)));
  if (summaryDate) cycle.settlementDate = summaryDate;
  const summaryReference = last4(labeledText(summary, "bank utr"));
  if (summaryReference) cycle.utrLast4 = summaryReference;
  const growth = sheetNamed(sheets, "growth") ?? [];
  const adjustments = swiggyGrowthAdjustments(growth, corrected);
  const totals = swiggyTotals(sheets.get("payout breakup") ?? []);
  const marketing = adjustments
    .filter((row) => /marketing|co-branded/i.test(row.type))
    .reduce((total, row) => total + row.amountPaise, 0);
  if (totals.adSpendPaise != null || marketing !== 0) {
    totals.adSpendPaise = (totals.adSpendPaise ?? 0) + marketing;
  }
  applyPaidTotal(totals, orders, summaryPaid(summary));
  const observed = withPeriod(identity.observed, cycle.cycleStart, cycle.cycleEnd);
  return { ok: true, payout: finish("swiggy", observed, cycle, orders, adjustments, totals, []) };
}

interface CycleFields {
  cycleId: string;
  cycleStart: string;
  cycleEnd: string;
  settlementStatus: "settled" | "pending";
  settlementDate: string | null;
  utrLast4: string | null;
}

function finish(
  platform: MetricPlatform,
  observed: ObservedReportIdentity,
  cycle: CycleFields,
  orders: ParsedPayoutOrder[],
  adjustments: ParsedAdjustment[],
  totals: ParsedCycleTotals,
  warnings: string[],
): ParsedPayoutFile {
  return {
    observed,
    ...cycle,
    orders,
    adjustments: adjustments.map((row) => ({ ...row, bookedCycle: cycle.cycleId })),
    totals,
    checks: buildChecks(platform, orders, adjustments, totals),
    warnings,
  };
}

function buildChecks(
  _platform: MetricPlatform,
  orders: ParsedPayoutOrder[],
  adjustments: ParsedAdjustment[],
  totals: ParsedCycleTotals,
): PayoutCheck[] {
  const checks: PayoutCheck[] = [];
  for (const order of orders) {
    checks.push(moneyCheck("net_payout_paise", order.recomputedNetPaise, order.netPayoutPaise));
  }
  const sum = (pick: (order: ParsedPayoutOrder) => number) =>
    orders.reduce((total, order) => total + pick(order), 0);
  const compare = (key: string, rebuilt: number, platformValue: number | null, count = false) => {
    if (platformValue == null) return;
    checks.push(
      count ? countCheck(key, rebuilt, platformValue) : moneyCheck(key, rebuilt, platformValue),
    );
  };
  compare("payout_orders", orders.length, totals.orderCount, true);
  compare(
    "gross_sales_paise",
    sum((order) => order.grossSalesPaise),
    totals.grossSalesPaise,
  );
  compare(
    "discount_paise",
    sum((order) => order.discountPaise),
    totals.discountPaise,
  );
  compare(
    "cv_paise",
    sum((order) => order.cvPaise),
    totals.cvPaise,
  );
  compare(
    "commission_paise",
    sum((order) => order.commissionPaise),
    totals.commissionPaise,
  );
  compare(
    "platform_fees_paise",
    sum((order) => order.platformFeesPaise),
    totals.platformFeesPaise,
  );
  compare(
    "taxes_paise",
    sum((order) => order.taxesPaise),
    totals.taxesPaise,
  );
  compare(
    "tds_paise",
    sum((order) => order.tdsPaise),
    totals.tdsPaise,
  );
  compare(
    "tcs_paise",
    sum((order) => order.tcsPaise),
    totals.tcsPaise,
  );
  compare(
    "gst_collected_paise",
    sum((order) => order.gstCollectedPaise),
    totals.gstCollectedPaise,
  );
  compare(
    "complaints_cancellation_charges_paise",
    sum((order) => order.complaintsCancellationChargesPaise),
    totals.complaintsCancellationChargesPaise,
  );
  const ads = adjustments
    .filter((row) => isAds(row.type))
    .reduce((total, row) => total + row.amountPaise, 0);
  compare("ad_spend_paise", ads, totals.adSpendPaise);
  const deduction = adjustments.reduce((total, row) => total + row.amountPaise, 0);
  compare(
    "platform_net_payout_paise",
    sum((order) => order.netPayoutPaise) - deduction,
    totals.platformNetPayoutPaise,
  );
  if (totals.paidAmountPaise != null && orders.every((order) => order.paidAmountPaise != null)) {
    compare(
      "paid_amount_paise",
      orders.reduce((total, order) => total + (order.paidAmountPaise ?? 0), 0),
      totals.paidAmountPaise,
    );
  }
  return checks;
}

function moneyCheck(key: string, rebuilt: number, platformValue: number): PayoutCheck {
  const gap = Math.abs(rebuilt - platformValue);
  return {
    key,
    rebuiltValue: rebuilt,
    platformValue,
    gap,
    tolerance: PAISE_SUM_TOLERANCE,
    pass: gap <= PAISE_SUM_TOLERANCE,
  };
}

function countCheck(key: string, rebuilt: number, platformValue: number): PayoutCheck {
  const gap = Math.abs(rebuilt - platformValue);
  return { key, rebuiltValue: rebuilt, platformValue, gap, tolerance: 0, pass: gap === 0 };
}

function zomatoAdjustments(rows: string[][]): ParsedAdjustment[] {
  let section = "";
  let header: string[] | null = null;
  const found: ParsedAdjustment[] = [];
  for (const row of rows) {
    const joined = row.map(norm).filter(Boolean).join(" ");
    if (/^[a-d]\)/.test(joined) || joined.startsWith("section ")) {
      section = joined;
      header = null;
      continue;
    }
    if (joined.includes("total deductions") || joined.startsWith("total ")) {
      header = null;
      continue;
    }
    if (col(row, "type") != null && (col(row, "adjusted") != null || col(row, "amount") != null)) {
      header = row;
      continue;
    }
    if (!header || !section) continue;
    const type = cell(row, col(header, "type"));
    if (!type || norm(type).startsWith("total")) continue;
    const amount = costPaise(cell(row, col(header, "adjusted") ?? col(header, "total amount")));
    if (!amount) continue;
    const period = inclusiveRange(cell(row, col(header, "period") ?? col(header, "deduction")));
    if (!period) continue;
    found.push({
      type: type.trim(),
      invoiceId: (cell(row, col(header, "invoice") ?? col(header, "campaign")) || "").trim(),
      periodFrom: period.start,
      periodTo: period.end,
      amountPaise: amount,
      bookedCycle: "",
    });
  }
  return found;
}

function zomatoTotals(rows: string[][]): ParsedCycleTotals {
  const header = headerRow(rows, "particular");
  const totals = emptyTotals();
  if (!header) return totals;
  const labelCol = col(header.header, "particular") ?? 0;
  const totalCol = col(header.header, "total") ?? header.header.length - 1;
  const lookup = rows.slice(header.index + 1).map((row) => ({
    label: norm(cell(row, labelCol)),
    amount: cell(row, totalCol),
  }));
  const pick = (accept: (label: string) => boolean) => {
    const hit = lookup.find((row) => accept(row.label) && rupeesToPaise(row.amount) != null);
    return hit ? costPaise(hit.amount) : null;
  };
  const signed = (accept: (label: string) => boolean) => {
    const hit = lookup.find((row) => accept(row.label) && rupeesToPaise(row.amount) != null);
    return hit ? signedPaise(hit.amount) : null;
  };
  totals.orderCount = countCell(
    lookup.find((row) => row.label.includes("number of orders"))?.amount ?? "",
  );
  const subtotal = pick((label) => label.includes("subtotal"));
  const packaging = pick((label) => label.includes("packaging"));
  totals.grossSalesPaise =
    subtotal == null && packaging == null ? null : (subtotal ?? 0) + (packaging ?? 0);
  const promo = pick((label) => label.includes("discount") && label.includes("promo"));
  const other = lookup.find(
    (row) =>
      row.label.includes("restaurant discount") &&
      !row.label.includes("promo") &&
      rupeesToPaise(row.amount) != null,
  );
  totals.discountPaise =
    promo == null && !other ? null : (promo ?? 0) + (other ? costPaise(other.amount) : 0);
  totals.commissionPaise = pick(
    (label) => label.includes("service fee") && !label.includes("payment") && !label.includes("%"),
  );
  totals.platformFeesPaise = pick(
    (label) =>
      label.includes("payment mechanism") && !label.includes("service") && !label.includes("tax"),
  );
  totals.taxesPaise = pick((label) => label.includes("taxes on service"));
  totals.tdsPaise = pick((label) => label.includes("tds"));
  totals.tcsPaise = pick(
    (label) =>
      label.includes("tax collected at source") ||
      (label.includes("tcs") && label.includes("igst")),
  );
  totals.gstCollectedPaise = pick((label) => label.includes("gst collected"));
  totals.complaintsCancellationChargesPaise = pick(
    (label) => label.includes("compensation") || label.includes("recoupment"),
  );
  totals.adSpendPaise = pick((label) => label.includes("total ads"));
  totals.platformNetPayoutPaise = signed((label) => label.includes("net payout"));
  totals.paidAmountPaise = signed(
    (label) => label === "amount settled" || label.startsWith("amount settled"),
  );
  const cv = totals.grossSalesPaise;
  const discount = totals.discountPaise;
  totals.cvPaise = cv == null || discount == null ? null : cv - discount;
  return totals;
}

function swiggyGrowthAdjustments(
  rows: string[][],
  period: { start: string; end: string },
): ParsedAdjustment[] {
  let header: string[] | null = null;
  const found: ParsedAdjustment[] = [];
  for (const row of rows) {
    if (
      col(row, "period from") != null &&
      (col(row, "adjustment type") != null || col(row, "type") != null)
    ) {
      header = row;
      continue;
    }
    if (!header) continue;
    const type = cell(row, col(header, "adjustment type") ?? col(header, "type")).trim();
    if (!type || norm(type).startsWith("total")) continue;
    const settled = rupeesToPaise(cell(row, col(header, "settled")));
    const total = rupeesToPaise(cell(row, col(header, "total amount")));
    const amount =
      settled != null && settled !== 0 ? Math.abs(settled) : total == null ? 0 : Math.abs(total);
    if (!amount) continue;
    const from = parseCivilDate(cell(row, col(header, "period from")), null);
    const to = parseCivilDate(cell(row, col(header, "period to")), null);
    found.push({
      type,
      invoiceId: cell(row, col(header, "invoice")).trim(),
      periodFrom: from ?? period.start,
      periodTo: to ? addIsoDays(to, 1) : period.end,
      amountPaise: amount,
      bookedCycle: "",
    });
  }
  return found.length > 0 ? found : swiggyAdjustments(rows, period);
}

function swiggyAdjustments(
  rows: string[][],
  period: { start: string; end: string },
): ParsedAdjustment[] {
  const header = headerRow(rows, "particular");
  if (!header) return [];
  const labelCol = col(header.header, "particular") ?? 0;
  const codeCol = Math.max(0, labelCol - 1);
  const totalCol = col(header.header, "total") ?? header.header.length - 1;
  let section = "";
  const found: ParsedAdjustment[] = [];
  for (const row of rows.slice(header.index + 1)) {
    const code = cell(row, codeCol).trim();
    const label = cell(row, labelCol).trim();
    if (!label) continue;
    if (/^[A-G]$/.test(code)) section = code;
    if (section !== "D" && section !== "E") continue;
    if (code === section) continue;
    const amount = costPaise(cell(row, totalCol));
    if (!amount) continue;
    if (section === "E" && !isAds(label)) continue;
    found.push({
      type: label,
      invoiceId: "",
      periodFrom: period.start,
      periodTo: period.end,
      amountPaise: amount,
      bookedCycle: "",
    });
  }
  return found;
}

function swiggyTotals(rows: string[][]): ParsedCycleTotals {
  const header = headerRow(rows, "particular");
  const totals = emptyTotals();
  if (!header) return totals;
  const labelCol = col(header.header, "particular") ?? 0;
  const totalCol = col(header.header, "total") ?? header.header.length - 1;
  const lookup = rows.slice(header.index + 1).map((row) => ({
    label: norm(cell(row, labelCol)),
    amount: cell(row, totalCol),
  }));
  const pick = (...needles: string[]) => {
    const hit = lookup.find((row) => needles.every((needle) => row.label.includes(needle)));
    return hit ? costPaise(hit.amount) : null;
  };
  totals.orderCount = countCell(
    lookup.find((row) => row.label === "orders" || row.label.includes("number of orders"))
      ?.amount ?? "",
  );
  const item = pick("item total");
  const packaging = pick("packaging");
  totals.grossSalesPaise =
    item == null && packaging == null ? null : (item ?? 0) + (packaging ?? 0);
  const discountRows = lookup.filter(
    (row) => row.label.includes("restaurant discount") && rupeesToPaise(row.amount) != null,
  );
  totals.discountPaise =
    discountRows.length === 0
      ? null
      : discountRows.reduce((total, row) => total + costPaise(row.amount), 0);
  const fees = pick("swiggy fees");
  const commission = pick("commission");
  totals.commissionPaise = commission;
  totals.platformFeesPaise =
    fees == null ? null : commission == null ? fees : Math.max(0, fees - commission);
  totals.taxesPaise = pick("gst on service");
  totals.tdsPaise = pick("tds");
  totals.tcsPaise = pick("tcs");
  totals.gstCollectedPaise = pick("gst collected");
  totals.complaintsCancellationChargesPaise = pick("complaint");
  totals.adSpendPaise = pick("growth") ?? pick("ads");
  const net = lookup.find((row) => row.label.startsWith("net payout") || row.label === "g");
  totals.platformNetPayoutPaise = net ? signedPaise(net.amount) : pick("net payout");
  totals.cvPaise =
    totals.grossSalesPaise == null || totals.discountPaise == null
      ? null
      : totals.grossSalesPaise - totals.discountPaise;
  return totals;
}

function emptyTotals(): ParsedCycleTotals {
  return {
    orderCount: null,
    grossSalesPaise: null,
    discountPaise: null,
    cvPaise: null,
    commissionPaise: null,
    platformFeesPaise: null,
    taxesPaise: null,
    tdsPaise: null,
    tcsPaise: null,
    gstCollectedPaise: null,
    complaintsCancellationChargesPaise: null,
    adSpendPaise: null,
    platformNetPayoutPaise: null,
    paidAmountPaise: null,
  };
}

function cycleFromOrders(
  restaurantId: string,
  platform: MetricPlatform,
  range: { start: string; end: string },
  orders: ParsedPayoutOrder[],
): CycleFields {
  return {
    cycleId: `${platform}:${restaurantId}:${range.start}:${range.end}`,
    cycleStart: range.start,
    cycleEnd: range.end,
    settlementStatus: orders.some((order) => order.settlementStatus === "pending")
      ? "pending"
      : "settled",
    settlementDate: mode(
      orders.flatMap((order) => (order.settlementDate ? [order.settlementDate] : [])),
    ),
    utrLast4: mode(orders.flatMap((order) => (order.utrLast4 ? [order.utrLast4] : []))),
  };
}

function zomatoIdentity(
  summary: string[][],
  hidden: string[][],
): { restaurantId: string; observed: ObservedReportIdentity } {
  const labeled = labeledIdentity(summary);
  if (labeled.restaurantId) return labeled;
  const row = hidden.find((cells) => cells.some((value) => value.trim())) ?? [];
  const restaurantId = (row[5] ?? "").trim().replace(/\.0$/, "");
  const place = placeFromAddress(row[9] ?? "");
  return {
    restaurantId,
    observed: {
      restaurantId,
      name: (row[8] ?? "").trim(),
      city: place.city,
      area: place.area,
      periods: [],
    },
  };
}

function labeledIdentity(rows: string[][]): {
  restaurantId: string;
  observed: ObservedReportIdentity;
} {
  let restaurantId = "";
  let name = "";
  let city = "";
  let area = "";
  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      const label = norm(row[index] ?? "");
      const value = (row[index + 1] ?? "").trim();
      if (!value || norm(value) === "#ref!") continue;
      if (label.includes("restaurant id") || label === "res. id" || label === "res id")
        restaurantId = value;
      else if (label === "res name" || (label.includes("name") && !name)) name = value;
      else if (label === "city") city = value;
      else if (label === "area" || label === "subzone") area = value;
      else if (label === "address") {
        const place = placeFromAddress(value);
        if (!city) city = place.city;
        if (!area) area = place.area;
      }
    }
  }
  return {
    restaurantId: restaurantId.replace(/\.0$/, ""),
    observed: { restaurantId, name, city, area, periods: [] },
  };
}

function placeFromAddress(address: string): { city: string; area: string } {
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const state = parts.findIndex((part) => /\bstate\b|\d{6}/i.test(part));
  if (state <= 0) return { city: "", area: "" };
  return { city: parts[state - 1] ?? "", area: state > 1 ? (parts[state - 2] ?? "") : "" };
}

function swiggyIdentity(rows: string[][]): {
  restaurantId: string;
  observed: ObservedReportIdentity;
} {
  const lines = rows
    .map((row) =>
      row
        .map((value) => value.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
  const idIndex = lines.findIndex((line) => /rest\.?\s*id\s*[-:]/i.test(line));
  const idLine = idIndex >= 0 ? lines[idIndex] : "";
  const id = idLine?.match(/rest\.?\s*id\s*[-:]\s*(\S+)/i);
  const restaurantId = id?.[1]?.replace(/\.0$/, "") ?? "";
  const before = lines.slice(0, Math.max(idIndex, 0));
  const name = before.at(-3) ?? "";
  const area = before.length >= 2 ? (before.at(-2) ?? "") : "";
  const city = before.length >= 1 ? (before.at(-1) ?? "") : "";
  return { restaurantId, observed: { restaurantId, name, city, area, periods: [] } };
}

function swiggyPeriod(
  rows: string[][],
): { startDay: number; startMonth: number; endDay: number; endMonth: number } | null {
  for (const row of rows) {
    const joined = row.join(" ");
    const match = joined.match(
      /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s*[-–]\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)/,
    );
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) continue;
    const startMonth = monthIndex(match[2]);
    const endMonth = monthIndex(match[4]);
    if (startMonth == null || endMonth == null) continue;
    return {
      startDay: Number(match[1]),
      startMonth,
      endDay: Number(match[3]),
      endMonth,
    };
  }
  return null;
}

function correctSwiggyPeriod(
  printed: { startDay: number; startMonth: number; endDay: number; endMonth: number },
  orderDates: string[],
): { start: string; end: string; year: number } {
  const years = orderDates.map((date) => Number(date.slice(0, 4)));
  const year = mode(years.map(String));
  const baseYear = Number(year ?? orderDates[0]?.slice(0, 4) ?? "2026");
  const plain = inclusiveToRange(
    isoDate(baseYear, printed.startMonth, printed.startDay),
    isoDate(
      baseYear + (printed.endMonth < printed.startMonth ? 1 : 0),
      printed.endMonth,
      printed.endDay,
    ),
  );
  const shifted = {
    start: addIsoDays(plain.start, 1),
    end: addIsoDays(plain.end, 1),
  };
  const min = [...orderDates].sort()[0] ?? plain.start;
  const maxExclusive = addIsoDays([...orderDates].sort().at(-1) ?? plain.start, 1);
  if (min === shifted.start && maxExclusive === shifted.end) {
    return { ...shifted, year: Number(shifted.start.slice(0, 4)) };
  }
  if (min === plain.start && maxExclusive === plain.end) return { ...plain, year: baseYear };
  return { start: min, end: maxExclusive, year: Number(min.slice(0, 4)) };
}

function orderPaid(header: string[], row: string[]): number | null {
  return rupeesToPaise(cell(row, paidColumn(header)));
}

function paidColumn(header: string[]): number | null {
  const found = header.findIndex((value) => {
    const label = norm(value);
    if (label.includes("unsettled")) return false;
    return (
      label.includes("amount settled") ||
      label.includes("settled amount") ||
      label.includes("amount paid") ||
      label === "paid amount"
    );
  });
  return found < 0 ? null : found;
}

function applyPaidTotal(
  totals: ParsedCycleTotals,
  orders: ParsedPayoutOrder[],
  summary: number | null,
): void {
  if (summary != null) {
    totals.paidAmountPaise = summary;
    return;
  }
  if (totals.paidAmountPaise != null) return;
  if (orders.length > 0 && orders.every((order) => order.paidAmountPaise != null)) {
    totals.paidAmountPaise = orders.reduce(
      (total, order) => total + (order.paidAmountPaise ?? 0),
      0,
    );
  }
}

function summaryPaid(rows: string[][]): number | null {
  return (
    labeledMoney(rows, "amount settled") ??
    labeledMoney(rows, "total payout") ??
    labeledMoney(rows, "payout amount")
  );
}

function summarySettlementDate(rows: string[][], year: number | null): string | null {
  const text =
    labeledText(rows, "payout settlement date") ||
    labeledText(rows, "settlement date") ||
    labeledText(rows, "payout date");
  return text ? parseCivilDate(text, year) : null;
}

function labeledMoney(rows: string[][], needle: string): number | null {
  const value = labeledText(rows, needle);
  return value ? rupeesToPaise(value) : null;
}

function labeledText(rows: string[][], needle: string): string {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    for (let index = 0; index < row.length; index += 1) {
      const label = norm(row[index] ?? "");
      if (!label.includes(needle) || label === "#ref!") continue;
      const next = (row[index + 1] ?? "").trim();
      if (next && norm(next) !== "#ref!") return next;
      const below = (rows[rowIndex + 1]?.[index] ?? "").trim();
      if (below && norm(below) !== "#ref!") return below;
      const inline = (row[index] ?? "").replace(/^[^:：-]*[:：-]\s*/, "").trim();
      if (inline && norm(inline) !== label && norm(inline) !== "#ref!") return inline;
    }
  }
  return "";
}

function firstRange(rows: string[][]): { start: string; end: string; year: number } | null {
  for (const row of rows) {
    const range = inclusiveRange(row.join(" "));
    if (range) return { ...range, year: Number(range.start.slice(0, 4)) };
  }
  return null;
}

function inclusiveRange(text: string): { start: string; end: string } | null {
  const match = text.match(
    /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{2,4})\s*[-–]\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{2,4})/,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) return null;
  const startMonth = monthIndex(match[2]);
  const endMonth = monthIndex(match[5]);
  if (startMonth == null || endMonth == null) return null;
  const start = isoDate(expandYear(match[3]), startMonth, Number(match[1]));
  const endInclusive = isoDate(expandYear(match[6]), endMonth, Number(match[4]));
  return { start, end: addIsoDays(endInclusive, 1) };
}

function expandYear(year: string): number {
  const value = Number(year);
  if (year.length === 4) return value;
  return value >= 70 ? 1900 + value : 2000 + value;
}

function inclusiveToRange(start: string, endInclusive: string): { start: string; end: string } {
  return { start, end: addIsoDays(endInclusive, 1) };
}

function parseCivilDate(input: string, fallbackYear: number | null): string | null {
  const text = input.trim();
  if (!text || norm(text) === "#ref!") return null;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match?.[1] && match[2] && match[3]) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (match?.[1] && match[2] && match[3])
    return isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{4}))?/);
  if (match?.[1] && match[2]) {
    const month = monthIndex(match[2]);
    const year = match[3] ? Number(match[3]) : fallbackYear;
    if (month == null || year == null) return null;
    return isoDate(year, month, Number(match[1]));
  }
  return null;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthIndex(name: string): number | null {
  const found = MONTHS.findIndex((month) => month.startsWith(name.toLowerCase().slice(0, 3)));
  return found < 0 ? null : found + 1;
}

function hashCustomer(id: string, salt: string | null): string | null {
  const trimmed = id.trim();
  if (!trimmed || norm(trimmed) === "#ref!" || !salt) return null;
  return createHmac("sha256", salt).update(trimmed).digest("hex");
}

function last4(value: string): string | null {
  const compact = value.replace(/[^A-Za-z0-9]/g, "");
  if (compact.length < 4) return null;
  return compact.slice(-4);
}

function orderStatus(value: string): string {
  const text = value.trim().toUpperCase();
  if (text.includes("CANCEL")) return "CANCELLED";
  if (text.includes("REJECT")) return "REJECTED";
  if (text.includes("DELIVER")) return "DELIVERED";
  return text || "UNKNOWN";
}

function inferSettlement(value: string, date: string | null): "settled" | "pending" {
  const text = norm(value);
  if (
    text === "pending" ||
    text === "processing" ||
    text === "unsettled" ||
    text === "estimated" ||
    text === "partial"
  ) {
    return "pending";
  }
  if (text === "paid" || text === "settled" || text === "success") return "settled";
  if (!text) return date ? "settled" : "pending";
  return "pending";
}

function flag(value: string): boolean | null {
  const text = norm(value);
  if (!text) return null;
  if (["yes", "y", "true", "1", "accurate"].includes(text)) return true;
  if (["no", "n", "false", "0", "inaccurate"].includes(text)) return false;
  return null;
}

function swiggyCategory(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (norm(text).includes("train")) return "TRAIN_ORDER";
  if (norm(text).includes("toing")) return "Toing";
  return text;
}

function isAds(label: string): boolean {
  return /\b(ads?|advertis\w*|cpc|sponsored|hyperboost|marketing)\b|top picks|co-branded/i.test(
    label,
  );
}

function withPeriod(
  observed: ObservedReportIdentity,
  start: string,
  end: string,
): ObservedReportIdentity {
  return { ...observed, periods: [{ start, end, label: "payout" }] };
}

function mode(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  );
}

function isJunk(value: string): boolean {
  const text = norm(value);
  return !text || text === "#ref!" || text === "order id";
}

function blankToNull(value: string): string | null {
  const text = value.trim();
  return text && norm(text) !== "#ref!" ? text : null;
}

function grid(sheet: Worksheet): string[][] {
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as CellValue[];
    const width = Array.isArray(values) ? values.length : 0;
    const cells: string[] = [];
    for (let index = 1; index < width; index += 1) cells.push(cellText(values[index]));
    if (cells.some((value) => value.trim() !== "")) rows.push(cells);
  });
  return rows;
}

function cellText(value: CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("result" in value) return cellText(value.result as CellValue);
    if ("text" in value && typeof value.text === "string") return value.text;
    return "";
  }
  return String(value);
}

function headerRow(
  rows: string[][],
  ...needles: string[]
): { index: number; header: string[] } | null {
  for (let index = 0; index < rows.length; index += 1) {
    const header = rows[index] ?? [];
    if (needles.every((needle) => col(header, needle) != null)) return { index, header };
  }
  return null;
}

function col(header: string[], needle: string): number | null {
  const found = header.findIndex((value) => norm(value).includes(needle));
  return found < 0 ? null : found;
}

function colIncludes(header: string[], ...needles: string[]): number | null {
  const found = header.findIndex((value) => {
    const label = norm(value);
    return needles.every((needle) => label.includes(needle));
  });
  return found < 0 ? null : found;
}

function exactCol(header: string[], needle: string): number | null {
  const found = header.findIndex((value) => norm(value) === needle);
  return found < 0 ? null : found;
}

function otherDiscountCell(header: string[], row: string[]): string {
  for (let index = 0; index < header.length; index += 1) {
    const label = norm(header[index] ?? "");
    if (label.includes("restaurant discount") && !label.includes("promo")) return row[index] ?? "";
  }
  return "";
}

function orderDateColumn(header: string[]): number | null {
  return (
    exactCol(header, "order date") ??
    column(header, (label) => label.includes("order date") && !label.includes("settlement"))
  );
}

function serviceFeeColumn(header: string[]): number | null {
  return column(
    header,
    (label) =>
      label.includes("service fee") &&
      !label.includes("%") &&
      !label.includes("payment") &&
      !label.includes("tax"),
  );
}

function paymentFeeColumn(header: string[]): number | null {
  return column(
    header,
    (label) =>
      label.includes("payment mechanism") && !label.includes("service") && !label.includes("tax"),
  );
}

function tcsColumns(header: string[]): number[] {
  const found: number[] = [];
  header.forEach((value, index) => {
    const label = norm(value);
    if (label.includes("applicable")) return;
    if (
      label.includes("tax collected at source") ||
      label.includes("tcs igst") ||
      label === "tcs"
    ) {
      found.push(index);
    }
  });
  return found;
}

function column(header: string[], accept: (label: string) => boolean): number | null {
  const found = header.findIndex((value) => accept(norm(value)));
  return found < 0 ? null : found;
}

function cell(row: string[], index: number | null): string {
  if (index == null) return "";
  return row[index] ?? "";
}

function sheetNamed(sheets: Map<string, string[][]>, ...needles: string[]): string[][] | null {
  for (const [name, rows] of sheets) {
    if (needles.every((needle) => name.includes(needle))) return rows;
  }
  return null;
}

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function countCell(input: string): number | null {
  const text = input.trim().replace(/,/g, "");
  if (!/^\d+(\.0+)?$/.test(text)) return null;
  return Number(text);
}
