import {
  addIsoDays,
  daysBetween,
  isoDate,
  isoWeekday,
  isoWeekRange,
  monthIndex,
  nextMonth,
} from "./metric-dates.js";
import type { MetricGranularity, MetricKey, MetricPlatform } from "./metric-dictionary.js";
import { requireMetric, SWIGGY_DAILY_MAX_DAYS } from "./metric-dictionary.js";

export type ReportKind = "daily" | "weekly" | "monthly";

export interface ReportPeriod {
  start: string;
  end: string;
  label: string;
}

export interface ObservedReportIdentity {
  restaurantId: string;
  name: string;
  /** Swiggy area or Zomato subzone. A mismatch is a warning, not a rejection. */
  area?: string;
  city: string;
  periods: ReportPeriod[];
}

export interface IdentityAssessment {
  /** Set only for a wrong platform id, a wrong window, or a request that cannot be read. */
  reject: string | null;
  warnings: string[];
}

export interface ExpectedReportIdentity {
  platform: MetricPlatform;
  report: ReportKind | "payout";
  restaurantId: string;
  name: string;
  city: string;
  /** Inclusive ISO date. */
  periodStart: string;
  /** Exclusive ISO date. */
  periodEnd: string;
}

export interface ParsedMetricRow {
  key: string;
  periodStart: string;
  periodEnd: string;
  value: number | null;
  rowRole: "fact" | "platform_check";
  source: string;
}

export interface ParsedWindowItem {
  periodStart: string;
  periodEnd: string;
  rank: number;
  itemName: string;
  revenuePaise: number;
}

export type ReportEvaluation =
  | {
      ok: true;
      observed: ObservedReportIdentity;
      granularity: MetricGranularity;
      rows: ParsedMetricRow[];
      items: ParsedWindowItem[];
      /** Name, city, or area differed. The file is still stored. */
      warnings: string[];
    }
  | { ok: false; reason: string; observed: ObservedReportIdentity | null };

const SWIGGY_HEADER = ["Restaurant ID", "Restaurant name", "Area", "City", "Overview", "Metric"];
const ZOMATO_HEADER = ["Restaurant ID", "Restaurant name", "Subzone", "City", "Overview", "Metric"];

export function canonicalRestaurantId(value: string): string {
  const trimmed = value.trim();
  return /^\d+\.0+$/.test(trimmed) ? trimmed.replace(/\.0+$/, "") : trimmed;
}

export function reportGranularity(platform: MetricPlatform, report: ReportKind): MetricGranularity {
  if (report === "daily") return "day";
  if (report === "monthly") return "month";
  return platform === "swiggy" ? "week_sun_sat" : "week_mon_sun";
}

/** The periods a request must contain. A string is the reason the request itself is invalid. */
export function expectedPeriods(expected: ExpectedReportIdentity): ReportPeriod[] | string {
  if (expected.periodEnd <= expected.periodStart) return "The requested window is empty.";
  if (expected.report === "payout") {
    return [{ start: expected.periodStart, end: expected.periodEnd, label: "payout" }];
  }
  if (expected.report === "daily") {
    const days = daysBetween(expected.periodStart, expected.periodEnd);
    if (days.length === 0) return "The requested window is empty.";
    if (expected.platform === "swiggy" && days.length > SWIGGY_DAILY_MAX_DAYS) {
      return `Swiggy Daily accepts at most ${SWIGGY_DAILY_MAX_DAYS} days per file. Split the backfill into chunks of ${SWIGGY_DAILY_MAX_DAYS} days or fewer.`;
    }
    return days.map((start) => ({ start, end: addIsoDays(start, 1), label: start }));
  }
  if (expected.report === "weekly") {
    const weekday = expected.platform === "swiggy" ? 0 : 1;
    const days = daysBetween(expected.periodStart, expected.periodEnd);
    if (days.length === 0 || days.length % 7 !== 0) {
      return "The requested week window is not a whole number of weeks.";
    }
    if (isoWeekday(expected.periodStart) !== weekday) {
      return expected.platform === "swiggy"
        ? "A Swiggy week starts on Sunday."
        : "A Zomato week starts on Monday.";
    }
    const periods: ReportPeriod[] = [];
    for (let index = 0; index < days.length; index += 7) {
      const start = days[index] ?? expected.periodStart;
      periods.push({ start, end: addIsoDays(start, 7), label: start });
    }
    return periods;
  }
  if (!expected.periodStart.endsWith("-01"))
    return "A month window starts on the first of the month.";
  const periods: ReportPeriod[] = [];
  let cursor = expected.periodStart;
  while (cursor < expected.periodEnd) {
    const end = nextMonth(cursor);
    if (end > expected.periodEnd) return "A month window ends on the first of a month.";
    periods.push({ start: cursor, end, label: cursor.slice(0, 7) });
    cursor = end;
  }
  if (periods.length === 0) return "The requested window is empty.";
  return periods;
}

/** This outlet cannot be matched by name. The file is rejected until a platform id is saved. */
export function missingPlatformIdReason(platform: MetricPlatform): string {
  const which = platform === "swiggy" ? "Swiggy restaurant id" : "Zomato restaurant id";
  return `This outlet has no ${which}. The file was not stored.`;
}

/**
 * Shared by the business-report parser and by payout files, once the payout
 * header has been extracted. A wrong platform id or a wrong window rejects the
 * file. A different name, city, or area is a warning and the file can be stored.
 */
export function checkObservedIdentity(
  observed: ObservedReportIdentity,
  expected: ExpectedReportIdentity,
): IdentityAssessment {
  const warnings: string[] = [];
  const wanted = expectedPeriods(expected);
  if (typeof wanted === "string") return { reject: wanted, warnings };
  if (!expected.restaurantId.trim()) {
    return { reject: missingPlatformIdReason(expected.platform), warnings };
  }
  if (
    canonicalRestaurantId(observed.restaurantId) !== canonicalRestaurantId(expected.restaurantId)
  ) {
    return {
      reject: `The file is for restaurant ${observed.restaurantId.trim()}, not ${expected.restaurantId.trim()}.`,
      warnings,
    };
  }
  if (observed.periods.length !== wanted.length) {
    return {
      reject: `The file has ${observed.periods.length} periods and the request has ${wanted.length}.`,
      warnings,
    };
  }
  for (let index = 0; index < wanted.length; index += 1) {
    const got = observed.periods[index];
    const need = wanted[index];
    if (!got || !need || got.start !== need.start || got.end !== need.end) {
      return {
        reject: `Column ${got?.label ?? index + 1} is ${got?.start ?? "unreadable"} to ${got?.end ?? "unreadable"}, not ${need?.start} to ${need?.end}.`,
        warnings,
      };
    }
  }
  if (observed.name.trim() !== expected.name.trim()) {
    warnings.push(`The file names ${observed.name.trim()}, not ${expected.name.trim()}.`);
  }
  const area = observed.area?.trim() ?? "";
  const city = observed.city.trim();
  const stored = expected.city.trim();
  if (city !== stored) {
    warnings.push(
      area && area !== stored
        ? `The file is for ${city} (area ${area}), not ${stored}.`
        : `The file is for ${city || area}, not ${stored}.`,
    );
  }
  return { reject: null, warnings };
}

export function evaluateBusinessReport(
  csv: string,
  expected: ExpectedReportIdentity,
): ReportEvaluation {
  if (expected.report === "payout") {
    return {
      ok: false,
      reason:
        "Payout files are spreadsheets. Extract the outlet and the period, then call checkObservedIdentity.",
      observed: null,
    };
  }
  const table = parseCsv(csv);
  const header = table[0];
  if (!header) return { ok: false, reason: "The file has no header.", observed: null };
  const prefix = expected.platform === "swiggy" ? SWIGGY_HEADER : ZOMATO_HEADER;
  if (prefix.some((name, index) => header[index]?.trim() !== name)) {
    return {
      ok: false,
      reason: `This file is not a ${expected.platform} business report.`,
      observed: null,
    };
  }
  const periods: ReportPeriod[] = [];
  for (const label of header.slice(prefix.length)) {
    const period = parsePeriodLabel(label.trim(), expected);
    if (!period) {
      return { ok: false, reason: `Could not read a date from "${label.trim()}".`, observed: null };
    }
    periods.push(period);
  }
  if (periods.length === 0)
    return { ok: false, reason: "The file has no date columns.", observed: null };

  const identities = new Set<string>();
  const grid: Array<{ section: string; metric: string; cells: Cell[] }> = [];
  for (const row of table.slice(1)) {
    if (row.every((cell) => cell.trim() === "")) continue;
    const restaurantId = row[0] ?? "";
    const name = row[1] ?? "";
    const area = row[2] ?? "";
    const city = row[3] ?? "";
    identities.add(
      `${canonicalRestaurantId(restaurantId)}\t${name.trim()}\t${area.trim()}\t${city.trim()}`,
    );
    grid.push({
      section: (row[4] ?? "").trim(),
      metric: (row[5] ?? "").trim(),
      cells: row.slice(prefix.length).map(parseCell),
    });
  }
  const first = table.slice(1).find((row) => row.some((cell) => cell.trim() !== ""));
  const observed: ObservedReportIdentity = {
    restaurantId: (first?.[0] ?? "").trim(),
    name: (first?.[1] ?? "").trim(),
    area: (first?.[2] ?? "").trim(),
    city: (first?.[3] ?? "").trim(),
    periods,
  };
  if (!first) return { ok: false, reason: "The file has no metric rows.", observed };
  if (identities.size !== 1) {
    return { ok: false, reason: "The file contains more than one restaurant.", observed };
  }
  const identity = checkObservedIdentity(observed, expected);
  if (identity.reject) return { ok: false, reason: identity.reject, observed };

  const rows: ParsedMetricRow[] = [];
  const items: ParsedWindowItem[] = [];
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    if (!period) continue;
    const cells = new Map<string, Cell>();
    const itemCells: Array<{ name: string; pct: number | null }> = [];
    for (const line of grid) {
      if (line.metric.endsWith(" Revenue %")) {
        itemCells.push({
          name: line.metric.slice(0, -" Revenue %".length),
          pct: line.cells[index]?.value ?? null,
        });
        continue;
      }
      const cell = line.cells[index];
      if (cell) cells.set(`${line.section}\t${line.metric}`, cell);
    }
    if (expected.platform === "swiggy") emitSwiggy(expected.report, period, cells, rows);
    else emitZomato(expected.report, period, cells, rows);
    if (expected.platform === "swiggy") emitItems(period, cells, itemCells, items);
  }
  return {
    ok: true,
    observed,
    granularity: reportGranularity(expected.platform, expected.report),
    rows,
    items,
    warnings: identity.warnings,
  };
}

type CellKind = "money" | "pct" | "minutes" | "number" | "blank";

interface Cell {
  raw: string;
  value: number | null;
  kind: CellKind;
}

function parseCell(input: string): Cell {
  const text = input.trim();
  if (!text || text === "-" || text.toLowerCase() === "na") {
    return { raw: "", value: null, kind: "blank" };
  }
  if (text.includes("₹") || /^rs\.?/i.test(text)) {
    const raw = text.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
    return { raw, value: Number(raw), kind: "money" };
  }
  if (text.endsWith("%")) {
    const raw = text.slice(0, -1).replace(/,/g, "").trim();
    return { raw, value: Number(raw), kind: "pct" };
  }
  if (/mins?$/i.test(text)) {
    const raw = text
      .replace(/mins?$/i, "")
      .trim()
      .replace(/,/g, "");
    return { raw, value: Number(raw), kind: "minutes" };
  }
  const raw = text.replace(/,/g, "");
  return { raw, value: Number(raw), kind: "number" };
}

function textToPaise(raw: string): number | null {
  if (!raw || Number.isNaN(Number(raw))) return null;
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = raw.replace("-", "").split(".");
  const digits = `${fraction}000`.slice(0, 3);
  let paise = Number(whole) * 100 + Number(digits.slice(0, 2));
  if ((digits[2] ?? "0") >= "5") paise += 1;
  return negative ? -paise : paise;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

interface Column {
  report: ReportKind;
  period: ReportPeriod;
  cells: Map<string, Cell>;
  rows: ParsedMetricRow[];
}

function read(column: Column, section: string, label: string): Cell | undefined {
  return column.cells.get(`${section}\t${label}`);
}

function asNumber(cell: Cell | undefined): number | null {
  if (!cell || cell.kind === "blank" || cell.value == null || Number.isNaN(cell.value)) return null;
  return cell.value;
}

function asPaise(cell: Cell | undefined): number | null {
  if (!cell || cell.kind === "blank") return null;
  return textToPaise(cell.raw);
}

function asCount(cell: Cell | undefined): number | null {
  const value = asNumber(cell);
  return value == null ? null : Math.round(value);
}

function push(column: Column, key: MetricKey, value: number | null, source: string): void {
  const definition = requireMetric(key);
  if (column.report !== "daily" && (definition.derivation || key.startsWith("rating_snapshot_")))
    return;
  const display =
    definition.kind === "ratio" ||
    definition.kind === "weighted_avg" ||
    definition.kind === "snapshot_mean";
  const windowFact =
    definition.kind === "platform_only" ||
    definition.kind === "snapshot_latest" ||
    definition.kind === "distinct";
  const rowRole =
    column.report === "daily"
      ? display
        ? "platform_check"
        : "fact"
      : windowFact
        ? "fact"
        : "platform_check";
  const stored = definition.skipZero && value === 0 ? null : value;
  column.rows.push({
    key,
    periodStart: column.period.start,
    periodEnd: column.period.end,
    value: stored,
    rowRole,
    source: rowRole === "platform_check" ? "platform_check" : source,
  });
}

function roundPct(pct: number | null, denominator: number | null): number | null {
  if (denominator === 0) return 0;
  if (pct == null || denominator == null) return null;
  return Math.round((pct * denominator) / 100);
}

const SWIGGY_SUMS: ReadonlyArray<
  readonly [string, string, MetricKey, "paise" | "count" | "decimal"]
> = [
  ["SALES", "Net Sales", "swiggy_net_sales_paise", "paise"],
  ["SALES", "Delivered Orders", "delivered_orders", "count"],
  ["SALES", "Restaurant Cancelled Orders", "restaurant_cancelled_orders", "count"],
  ["SALES", "Cancelled Order Loss", "cancelled_order_loss_paise", "paise"],
  ["SALES", "Number of Orders below ₹250", "orders_band_lt250", "count"],
  ["SALES", "Number of Orders between ₹250 and ₹450", "orders_band_250_450", "count"],
  ["SALES", "Number of Orders between ₹450 and ₹650", "orders_band_450_650", "count"],
  ["SALES", "Number of Orders between ₹650 and ₹850", "orders_band_650_850", "count"],
  ["SALES", "Number of Orders above ₹850", "orders_band_gt850", "count"],
  ["BOLT", "Orders", "bolt_orders", "count"],
  ["BOLT", "Delayed Orders (>5 mins)", "bolt_delayed_orders_gt5", "count"],
  ["RATINGS", "total rated orders", "rated_orders", "count"],
  ["RATINGS", "Poor Rated Orders", "poor_rated_orders", "count"],
  ["CONVERSION_FUNNEL", "Impressions", "impressions", "decimal"],
  ["CONVERSION_FUNNEL", "Menu Opens", "menu_opens", "count"],
  ["CONVERSION_FUNNEL", "Carts Builds", "cart_builds", "count"],
  ["CONVERSION_FUNNEL", "Orders Placed", "swiggy_funnel_orders", "count"],
  ["CUSTOMERS", "New Customers", "swiggy_new_customers", "count"],
  ["CUSTOMERS", "Repeat Customers", "swiggy_repeat_customers", "count"],
  ["CUSTOMERS", "Dormant Customers", "swiggy_dormant_customers", "count"],
  ["ADS_CPC", "CPC Driven Sales", "cpc_sales_paise", "paise"],
  ["ADS_CPC", "CPC Orders", "cpc_orders", "count"],
  ["ADS_CPC", "Total CPC Spends", "cpc_spend_paise", "paise"],
  ["ADS_CPC", "CPC Menu Visits", "cpc_menu_opens", "count"],
  ["ADS_CBA", "CBA Driven Sales", "cba_sales_paise", "paise"],
  ["ADS_CBA", "CBA Orders", "cba_orders", "count"],
  ["ADS_CBA", "Total CBA Spends", "cba_spend_paise", "paise"],
  ["ADS_CBA", "Ad Impressions", "cba_impressions", "decimal"],
  ["ADS_CBA", "CBA Menu Visits", "cba_menu_opens", "count"],
  ["DISCOUNTS", "Discount Given by Restaurant(RDGMV)", "discount_paise", "paise"],
  ["COMPLAINTS", "Non-refunded Complaints", "non_refunded_complaints", "count"],
  ["COMPLAINTS", "Customer Refunded Complaints", "refunded_complaints", "count"],
  ["COMPLAINTS", "Missing Items", "complaints_missing", "count"],
  ["COMPLAINTS", "Quality Issues", "complaints_quality", "count"],
  ["COMPLAINTS", "Quantity Issues", "complaints_quantity", "count"],
  ["COMPLAINTS", "Wrong Items", "complaints_wrong", "count"],
  ["COMPLAINTS", "Packaging & Spillage", "complaints_packaging", "count"],
  ["MENU", "Top Selling Items (Gross Revenue)", "top5_items_revenue_paise", "paise"],
];

function emitSwiggy(
  report: ReportKind,
  period: ReportPeriod,
  cells: Map<string, Cell>,
  rows: ParsedMetricRow[],
): void {
  const column: Column = { report, period, cells, rows };
  for (const [section, label, key, mode] of SWIGGY_SUMS) {
    const cell = read(column, section, label);
    const value =
      mode === "paise"
        ? asPaise(cell)
        : mode === "count"
          ? asCount(cell)
          : round4(asNumber(cell) ?? Number.NaN);
    push(
      column,
      key,
      mode === "decimal" && asNumber(cell) == null ? null : value,
      `column:${label}`,
    );
  }
  const delivered = asCount(read(column, "SALES", "Delivered Orders"));
  const boltOrders = asCount(read(column, "BOLT", "Orders"));
  push(
    column,
    "market_share_pct",
    asNumber(read(column, "SALES", "Market Share")),
    "column:Market Share",
  );
  push(column, "aov_paise", asPaise(read(column, "SALES", "Net AOV")), "platform_check");
  push(
    column,
    "bolt_orders_pct",
    asNumber(read(column, "BOLT", "% of Bolt Orders")),
    "platform_check",
  );
  const boltAov = asPaise(read(column, "BOLT", "AOV"));
  push(
    column,
    "bolt_sales_paise",
    boltOrders === 0
      ? 0
      : boltAov == null || boltOrders == null
        ? null
        : Math.round(boltAov * boltOrders),
    "derived:round(bolt_aov_paise*bolt_orders)",
  );
  const boltPrep = asNumber(read(column, "BOLT", "Avg Prep Time"));
  push(column, "bolt_prep_minutes", boltOrders === 0 ? null : boltPrep, "platform_check");
  push(
    column,
    "bolt_prep_wsum",
    boltOrders == null || boltOrders === 0 || boltPrep == null
      ? null
      : round4(boltPrep * boltOrders),
    "derived:bolt_prep_minutes*bolt_orders",
  );
  const fastPct = asNumber(read(column, "BOLT", "Orders with <6 min Prep time"));
  push(column, "bolt_fast_prep_pct", fastPct, "platform_check");
  push(
    column,
    "bolt_fast_prep_orders",
    roundPct(fastPct, boltOrders),
    "derived:round(bolt_fast_prep_pct*bolt_orders/100)",
  );
  derivedPct(
    column,
    "CUSTOMERS",
    "New Customer Order %",
    "swiggy_new_customer_pct",
    "swiggy_new_customer_orders",
    "round(new_customer_pct*delivered_orders/100)",
    delivered,
  );
  derivedPct(
    column,
    "CUSTOMERS",
    "Repeat Customer Order %",
    "swiggy_repeat_customer_pct",
    "swiggy_repeat_customer_orders",
    "round(repeat_customer_pct*delivered_orders/100)",
    delivered,
  );
  derivedPct(
    column,
    "CUSTOMERS",
    "Dormant Customer Order %",
    "dormant_customer_pct",
    "dormant_user_orders",
    "round(dormant_customer_pct*delivered_orders/100)",
    delivered,
  );
  for (const [label, key] of [
    ["Impressions to Menu", "impressions_to_menu_pct"],
    ["Menu to Cart", "menu_to_cart_pct"],
    ["Cart to Order", "cart_to_orders_pct"],
  ] as const) {
    push(column, key, asNumber(read(column, "CONVERSION_FUNNEL", label)), "platform_check");
  }
  push(column, "cpc_roas", asNumber(read(column, "ADS_CPC", "ROAS")), "platform_check");
  push(
    column,
    "cpc_ads_depth_pct",
    asNumber(read(column, "ADS_CPC", "CPC Ads Depth")),
    "platform_check",
  );
  push(
    column,
    "cba_ads_depth_pct",
    asNumber(read(column, "ADS_CBA", "CBA Ads Depth")),
    "platform_check",
  );
  push(
    column,
    "cba_avg_cost_per_impression_paise",
    asPaise(read(column, "ADS_CBA", "Avg Cost Per Impressions")),
    "platform_check",
  );
  const discount = asPaise(read(column, "DISCOUNTS", "Discount Given by Restaurant(RDGMV)"));
  const discountPct = asNumber(read(column, "DISCOUNTS", "Discount GMV %"));
  push(column, "discount_gmv_pct", discountPct, "platform_check");
  push(
    column,
    "swiggy_gmv_paise",
    discount == null || discount === 0 || discountPct == null || discountPct === 0
      ? null
      : Math.round((discount * 100) / discountPct),
    "derived:discount_paise/(discount_gmv_pct/100)",
  );
  derivedPct(
    column,
    "DISCOUNTS",
    "Discounted Orders %",
    "discounted_orders_pct",
    "discounted_orders",
    "round(discounted_orders_pct*delivered_orders/100)",
    delivered,
  );
  push(
    column,
    "rdpo_paise",
    asPaise(read(column, "DISCOUNTS", "Restaurant Discount Per Order(RDPO)")),
    "platform_check",
  );
  push(
    column,
    "online_pct",
    asNumber(read(column, "OPERATIONS", "Online Availability %")),
    "platform_check",
  );
  const kpt = asNumber(read(column, "OPERATIONS", "Kitchen Prep Time"));
  push(column, "kpt_minutes", kpt, "platform_check");
  push(
    column,
    "kpt_weighted_sum",
    kpt == null || delivered == null ? null : round4(kpt * delivered),
    "derived:kpt_minutes*delivered_orders",
  );
  derivedPct(
    column,
    "OPERATIONS",
    "Food Ready Accuracy (MFR)",
    "food_ready_accuracy_pct",
    "mfr_accurate_orders",
    "round(mfr_pct*delivered_orders/100)",
    delivered,
  );
  derivedPct(
    column,
    "OPERATIONS",
    "Delayed Orders (> 10 mins)",
    "delayed_orders_gt10_pct",
    "delayed_orders_gt10",
    "round(delayed_gt10_pct*delivered_orders/100)",
    delivered,
  );
  for (const [label, key] of [
    ["Menu Score(Out of 100)", "menu_score"],
    ["Category Score(Out of 100)", "menu_category_score"],
    ["Item Score(Out of 100)", "menu_item_score"],
    ["Addon Score(Out of 100)", "menu_addon_score"],
    ["Combo Score(Out of 100)", "menu_combo_score"],
  ] as const) {
    push(column, key, asNumber(read(column, "MENU", label)), `column:${label}`);
  }
  push(
    column,
    "menu_photo_pct",
    asNumber(read(column, "MENU", "Items with Photos")),
    "column:Items with Photos",
  );
  push(
    column,
    "menu_desc_pct",
    asNumber(read(column, "MENU", "Items with Descriptions")),
    "column:Items with Descriptions",
  );
  const nonRefunded = asCount(read(column, "COMPLAINTS", "Non-refunded Complaints"));
  const refunded = asCount(read(column, "COMPLAINTS", "Customer Refunded Complaints"));
  push(
    column,
    "complaints",
    nonRefunded == null || refunded == null ? null : nonRefunded + refunded,
    "column:Non-refunded Complaints",
  );
  derivedPct(
    column,
    "COMPLAINTS",
    "% Orders with Complaints",
    "complaint_orders_pct",
    "complaint_orders",
    "round(complaint_orders_pct*delivered_orders/100)",
    delivered,
  );
}

function derivedPct(
  column: Column,
  section: string,
  label: string,
  pctKey: MetricKey,
  countKey: MetricKey,
  formula: string,
  denominator: number | null,
): void {
  const pct = asNumber(read(column, section, label));
  push(column, pctKey, pct, "platform_check");
  push(column, countKey, roundPct(pct, denominator), `derived:${formula}`);
}

function emitZomato(
  report: ReportKind,
  period: ReportPeriod,
  cells: Map<string, Cell>,
  rows: ParsedMetricRow[],
): void {
  const column: Column = { report, period, cells, rows };
  const sums: ReadonlyArray<readonly [string, string, MetricKey, "paise" | "count" | "decimal"]> = [
    ["Sales", "Delivered orders", "delivered_orders", "count"],
    ["Sales", "Sales (Rs)", "ops_sales_paise", "paise"],
    ["Customer experience", "Rated orders", "rated_orders", "count"],
    ["Customer experience", "Bad orders", "bad_orders", "count"],
    ["Customer experience", "Rejected orders", "rejected_orders", "count"],
    ["Customer experience", "KPT+10 delayed orders", "delayed_orders_kpt10", "count"],
    ["Customer experience", "Poor rated orders", "poor_rated_orders", "count"],
    ["Customer experience", "Total complaints", "complaints", "count"],
    ["Customer experience", "Non-refunded complaints", "non_refunded_complaints", "count"],
    ["Customer experience", "Total complaints - Poor packaging", "complaints_packaging", "count"],
    ["Customer experience", "Total complaints - Poor quality", "complaints_quality", "count"],
    ["Customer experience", "Total complaints - Wrong order", "complaints_wrong", "count"],
    ["Customer experience", "Total complaints - Missing items", "complaints_missing", "count"],
    ["Customer experience", "Self logs other ors", "self_logged_ors", "count"],
    ["Customer experience", "Lost sales (Rs)", "lost_sales_paise", "paise"],
    ["Customer funnel", "Impressions", "impressions", "decimal"],
    ["Customer funnel", "Menu opens", "menu_opens", "count"],
    ["Customer funnel", "Cart builds", "cart_builds", "count"],
    ["Customer funnel", "Placed Orders", "placed_orders", "count"],
    ["Customer segmentation", "New user orders", "new_user_orders", "count"],
    ["Customer segmentation", "Repeat user orders", "repeat_user_orders", "count"],
    ["Customer segmentation", "Lapsed user orders", "lapsed_user_orders", "count"],
    ["Customer segmentation", "Breakfast orders", "breakfast_orders", "count"],
    ["Customer segmentation", "Lunch orders", "lunch_orders", "count"],
    ["Customer segmentation", "Snacks orders", "snacks_orders", "count"],
    ["Customer segmentation", "Dinner orders", "dinner_orders", "count"],
    ["Customer segmentation", "Late night orders", "late_night_orders", "count"],
    ["Ads", "Sales from ads (Rs)", "ads_sales_paise", "paise"],
    ["Ads", "Ads impressions", "ads_impressions", "decimal"],
    ["Ads", "Ads menu opens", "ads_menu_opens", "count"],
    ["Ads", "Ads orders", "ad_orders", "count"],
    ["Ads", "Ads spend (Rs)", "ad_spend_paise", "paise"],
    ["Offers", "Discount given (Rs)", "discount_paise", "paise"],
  ];
  for (const [section, label, key, mode] of sums) {
    const cell = read(column, section, label);
    const number = asNumber(cell);
    const value =
      mode === "paise"
        ? asPaise(cell)
        : mode === "count"
          ? asCount(cell)
          : number == null
            ? null
            : round4(number);
    push(column, key, value, `column:${label}`);
  }
  const offers = assignOffers(
    read(column, "Offers", "Orders with offers"),
    read(column, "Offers", "Gross sales from offers (Rs)"),
  );
  push(column, "offer_gross_sales_paise", offers.salesPaise, "column:offer gross sales");
  push(column, "offer_orders", offers.orders, "column:offer orders");
  push(
    column,
    "market_share_pct",
    asNumber(read(column, "Sales", "Market share (%)")),
    "column:Market share (%)",
  );
  const rating = asNumber(read(column, "Customer experience", "Average rating"));
  push(column, "rating_snapshot_sum", rating, "column:Average rating");
  push(column, "rating_snapshot_days", rating == null ? null : 1, "column:Average rating");
  push(column, "rating", rating, "platform_check");
  push(
    column,
    "offline_time_hours",
    asNumber(read(column, "Customer experience", "Offline time (in hours)")),
    "column:Offline time (in hours)",
  );
  push(
    column,
    "online_pct",
    asNumber(read(column, "Customer experience", "Online %")),
    "platform_check",
  );
  const delivered = asCount(read(column, "Sales", "Delivered orders"));
  const kpt = asNumber(read(column, "Customer experience", "KPT (in minutes)"));
  push(column, "kpt_minutes", kpt, "platform_check");
  push(
    column,
    "kpt_weighted_sum",
    kpt == null || delivered == null ? null : round4(kpt * delivered),
    "derived:kpt_minutes*delivered_orders",
  );
  const forPct = asNumber(read(column, "Customer experience", "FOR accuracy (%)"));
  push(column, "for_accuracy_pct", forPct, "platform_check");
  push(
    column,
    "for_accurate_est",
    forPct == null || delivered == null ? null : round4((forPct / 100) * delivered),
    "derived:for_pct/100*delivered_orders",
  );
  for (const [label, key] of [
    ["Impressions to menu (%)", "impressions_to_menu_pct"],
    ["Menu to cart (%)", "menu_to_cart_pct"],
    ["Cart to orders (%)", "cart_to_orders_pct"],
  ] as const) {
    push(column, key, asNumber(read(column, "Customer funnel", label)), "platform_check");
  }
  push(column, "ads_ctr_pct", asNumber(read(column, "Ads", "Ads CTR (%)")), "platform_check");
  push(column, "ads_roi", asNumber(read(column, "Ads", "Ads ROI")), "platform_check");
  push(
    column,
    "offer_discount_pct",
    asNumber(read(column, "Offers", "Effective discount (%)")),
    "platform_check",
  );
}

function assignOffers(
  ordersLabel: Cell | undefined,
  grossLabel: Cell | undefined,
): { salesPaise: number | null; orders: number | null } {
  const left = asNumber(ordersLabel);
  const right = asNumber(grossLabel);
  if (left == null && right == null) return { salesPaise: null, orders: null };
  const leftIntegral =
    ordersLabel?.kind !== "blank" &&
    ordersLabel?.raw !== undefined &&
    /^-?\d+$/.test(ordersLabel.raw);
  const rightIntegral =
    grossLabel?.kind !== "blank" && grossLabel?.raw !== undefined && /^-?\d+$/.test(grossLabel.raw);
  let sales = ordersLabel;
  let orders = grossLabel;
  if (leftIntegral !== rightIntegral) {
    sales = leftIntegral ? grossLabel : ordersLabel;
    orders = leftIntegral ? ordersLabel : grossLabel;
  } else if (left != null && right != null && (left >= right * 50 || right >= left * 50)) {
    sales = left >= right ? ordersLabel : grossLabel;
    orders = left >= right ? grossLabel : ordersLabel;
  }
  return { salesPaise: asPaise(sales), orders: asCount(orders) };
}

function emitItems(
  period: ReportPeriod,
  cells: Map<string, Cell>,
  itemCells: Array<{ name: string; pct: number | null }>,
  items: ParsedWindowItem[],
): void {
  const top5 = asPaise(cells.get("MENU\tTop Selling Items (Gross Revenue)"));
  itemCells.forEach((item, index) => {
    if (top5 == null || item.pct == null) return;
    items.push({
      periodStart: period.start,
      periodEnd: period.end,
      rank: index + 1,
      itemName: item.name,
      revenuePaise: Math.round((top5 * item.pct) / 100),
    });
  });
}

function parsePeriodLabel(
  label: string,
  expected: ExpectedReportIdentity,
): ReportPeriod | undefined {
  if (expected.platform === "zomato" && expected.report === "weekly") {
    const week = /^Week\s+(\d{1,2}),\s*(\d{4})$/.exec(label);
    if (!week) return undefined;
    const range = isoWeekRange(Number(week[2]), Number(week[1]));
    return range ? { ...range, label } : undefined;
  }
  if (expected.platform === "zomato" && expected.report === "monthly") {
    const month = /^([A-Za-z]+)\s+(\d{4})$/.exec(label);
    if (!month) return undefined;
    const index = monthIndex(month[1] ?? "");
    if (index === undefined) return undefined;
    const start = isoDate(Number(month[2]), index, 1);
    return start ? { start, end: nextMonth(start), label } : undefined;
  }
  if (expected.platform === "zomato") {
    const day = /^(\d{1,2})\s+([A-Za-z]+),?\s*(\d{4})$/.exec(label);
    if (!day) return undefined;
    const index = monthIndex(day[2] ?? "");
    if (index === undefined) return undefined;
    const start = isoDate(Number(day[3]), index, Number(day[1]));
    return start ? { start, end: addIsoDays(start, 1), label } : undefined;
  }
  if (expected.report === "daily") {
    const day = /^(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s+(\d{4})$/.exec(label);
    if (!day) return undefined;
    const index = monthIndex(day[2] ?? "");
    if (index === undefined) return undefined;
    const start = isoDate(Number(day[3]), index, Number(day[1]));
    return start ? { start, end: addIsoDays(start, 1), label } : undefined;
  }
  return parseSwiggyRange(label);
}

function parseSwiggyRange(label: string): ReportPeriod | undefined {
  const crossed =
    /^(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s+-\s+(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s*(\d{4})$/.exec(
      label,
    );
  if (crossed) {
    const year = Number(crossed[5]);
    const startMonth = monthIndex(crossed[2] ?? "");
    const endMonth = monthIndex(crossed[4] ?? "");
    if (startMonth === undefined || endMonth === undefined) return undefined;
    const start = isoDate(year, startMonth, Number(crossed[1]));
    const endDay = isoDate(endMonth < startMonth ? year + 1 : year, endMonth, Number(crossed[3]));
    return start && endDay ? { start, end: addIsoDays(endDay, 1), label } : undefined;
  }
  const same =
    /^(\d{1,2})(?:st|nd|rd|th)\s+-\s+(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s*(\d{4})$/.exec(label);
  if (!same) return undefined;
  const year = Number(same[4]);
  const month = monthIndex(same[3] ?? "");
  if (month === undefined) return undefined;
  const startDay = Number(same[1]);
  const endDay = Number(same[2]);
  const start = isoDate(year, month, startDay);
  const end = isoDate(
    endDay < startDay ? (month === 11 ? year + 1 : year) : year,
    endDay < startDay ? (month + 1) % 12 : month,
    endDay,
  );
  return start && end ? { start, end: addIsoDays(end, 1), label } : undefined;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char ?? "";
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}
