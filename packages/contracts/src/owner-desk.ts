import * as z from "zod";
import { addDays, formatExclusiveRange, formatRupees } from "./ops/format.js";
import type { OwnerPlot } from "./owner-dashboard.js";
import { settledPayoutPaise } from "./owner-home.js";

/** The payout pill until a reconciliation check exists. It is not a match. */
export const PAYOUT_CHECK = "pending_check" as const;

const DEDUCTIONS = [
  ["commission", "Commission"],
  ["fees", "Fees"],
  ["taxes", "Taxes"],
  ["tds", "TDS"],
  ["tcs", "TCS"],
  ["ads", "Ads"],
  ["discounts", "Discounts"],
  ["gst", "GST"],
  ["complaints", "Complaints"],
] as const;

export interface PaymentCycle {
  id: string;
  outletId: string;
  platform: "zomato" | "swiggy";
  from: string;
  to: string;
  orderCount: number | null;
  netPayoutPaise: number | null;
  /** Amount settled, when the payout file has it. Null is not the same as the net. */
  paidAmountPaise: number | null;
  grossSalesPaise: number | null;
  outletName: string | null;
  commissionPaise: number | null;
  feesPaise: number | null;
  taxesPaise: number | null;
  tdsPaise: number | null;
  tcsPaise: number | null;
  adsPaise: number | null;
  discountsPaise: number | null;
  gstPaise: number | null;
  /** Collected GST is not a deduction. A deduction is the amount taken off the payout. */
  gstKind?: "collected" | "deduction";
  complaintsPaise: number | null;
}

export interface PaymentOrder {
  cycleId: string;
  orderId: string;
  date: string;
  netPayoutPaise: number | null;
  grossSalesPaise?: number | null;
  discountPaise?: number | null;
  commissionPaise?: number | null;
  feesPaise?: number | null;
  taxesPaise?: number | null;
  tdsPaise?: number | null;
  tcsPaise?: number | null;
  gstCollectedPaise?: number | null;
  gstDeductionPaise?: number | null;
  complaintsPaise?: number | null;
}

export interface PaymentAdjustment {
  cycleId: string;
  label: string;
  amountPaise: number;
}

export interface OwnerPayments {
  payouts: Array<{
    id: string;
    outletId: string;
    platform: "zomato" | "swiggy";
    from: string;
    to: string;
    orderCount: number | null;
    netPayoutPaise: number | null;
    paidAmountPaise: number | null;
    /** File net after adjustments. Separate from the bank payment. */
    expectedPaise: number | null;
    outletName: string | null;
    /** paid uses the settled amount. net is the payout-file net, not the bank. */
    bankBasis: "paid" | "net" | "missing";
    status: typeof PAYOUT_CHECK;
  }>;
  breakdown: Array<{
    id: string;
    label: string;
    paise: number | null;
    /** Set on the closing line. Null on the lines above it. */
    basis: "paid" | "net" | null;
  }>;
  selectedId: string | null;
  deductions: Array<{ id: string; label: string; paise: number }>;
  plot: OwnerPlot | null;
  orders: PaymentOrder[];
  adjustments: PaymentAdjustment[];
}

export interface OwnerMenuRow {
  name: string;
  platforms: Array<"zomato" | "swiggy">;
  revenuePaise: number;
  missingApp: boolean;
}

export interface OwnerMenuFacts {
  score: number | null;
  photoPct: number | null;
  descriptionPct: number | null;
  top5RevenuePaise: number | null;
  /** Last day the score was present. Later empty days do not erase it. */
  scoreAsOf?: string | null;
  /** Top dishes as a percent of Swiggy sales over the same window. */
  top5SharePct?: number | null;
  /** Menu score, oldest to newest, only the points that were stored. */
  scorePoints?: number[];
}

export interface OwnerMenu {
  /** Editing is not part of this screen. */
  editing: false;
  rows: OwnerMenuRow[];
  missingCount: number;
  /** Swiggy menu facts. Null when this restaurant has no Swiggy menu readings. */
  swiggy: OwnerMenuFacts | null;
}

export interface OwnerReview {
  id: string;
  platform: "zomato" | "swiggy";
  rating: number | null;
  text: string;
  /** Words the owner can copy. Nothing here is sent to an app. */
  reply: string | null;
  date: string;
}

export interface OwnerRatingApp {
  platform: "zomato" | "swiggy";
  rating: number | null;
  /** Swiggy's rating is not in its reports. */
  ratingState: "ok" | "not_in_report";
  poorRatedOrders: number | null;
  /** Poorly rated orders divided by orders on the same day. Null when that day has no order count. */
  poorRatedPct: number | null;
  complaints: Array<{ id: string; label: string; count: number | null }>;
}

export interface OwnerRatings {
  rating: number | null;
  reviews: OwnerReview[];
  apps: OwnerRatingApp[];
  /** Inclusive civil dates of the four-week window. Null when neither app has a shared day. */
  from?: string | null;
  to?: string | null;
  /** Complaint counts, each one the sum of the two apps. */
  totals?: Array<{ id: string; count: number }>;
}

export interface OwnerReportArchiveItem {
  id: string;
  kind: "daily" | "weekly" | "payout" | "report";
  from: string;
  to: string;
  createdOn: string;
  /** When the report was stored. Absent on older rows that only kept the day. */
  createdAt?: string | null;
  /** Act-now count parsed from the stored brief. Null when the brief has no count. */
  urgent?: number | null;
}

export interface OwnerDocuments {
  reference: string | null;
  expiresOn: string | null;
  gstin: string | null;
  /** Set while the expiry is inside 30 days, inside 7 days, or already past. */
  reminder: "30" | "7" | "expired" | null;
  daysLeft: number | null;
  reports: OwnerReportArchiveItem[];
}

export const LicencePatchSchema = z
  .object({
    reference: z.string().trim().max(40).nullable(),
    expiresOn: z.string().nullable(),
    gstin: z.string().trim().max(20).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expiresOn != null && !isCivilDate(value.expiresOn)) {
      ctx.addIssue({ code: "custom", path: ["expiresOn"] });
    }
  });

export function civilDateOrNull(value: string | null): string | null {
  if (value == null || value.trim() === "") return null;
  if (!isCivilDate(value)) return null;
  return value;
}

export function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
  );
}

export function daysUntil(today: string, date: string): number {
  const start = Date.parse(`${today}T00:00:00Z`);
  const end = Date.parse(`${date}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/** 30-day and 7-day windows, then expired. A later date has no reminder yet. */
export function licenceReminder(
  today: string,
  expiresOn: string | null,
): "30" | "7" | "expired" | null {
  if (!expiresOn) return null;
  const days = daysUntil(today, expiresOn);
  if (days < 0) return "expired";
  if (days <= 7) return "7";
  if (days <= 30) return "30";
  return null;
}

export function composeOwnerPayments(input: {
  cycles: readonly PaymentCycle[];
  orders: readonly PaymentOrder[];
  adjustments: readonly PaymentAdjustment[];
  selectedId: string | null;
}): OwnerPayments {
  const filled = new Map(
    input.cycles.map((cycle) => [
      cycle.id,
      fillCycleFromOrders(
        cycle,
        input.orders.filter((order) => order.cycleId === cycle.id),
        input.adjustments.filter((row) => row.cycleId === cycle.id),
      ),
    ]),
  );
  const payouts = [...filled.values()]
    .sort(
      (left, right) =>
        right.to.localeCompare(left.to) ||
        left.platform.localeCompare(right.platform) ||
        left.id.localeCompare(right.id),
    )
    .map((cycle) => {
      const adjustmentPaise = input.adjustments
        .filter((row) => row.cycleId === cycle.id)
        .reduce((total, row) => total + row.amountPaise, 0);
      const expected = cycle.netPayoutPaise == null ? null : cycle.netPayoutPaise - adjustmentPaise;
      const settled = settledPayoutPaise({
        paidAmountPaise: cycle.paidAmountPaise,
        netPayoutPaise: cycle.netPayoutPaise,
        adjustmentPaise,
      });
      return {
        id: cycle.id,
        outletId: cycle.outletId,
        platform: cycle.platform,
        from: cycle.from,
        to: cycle.to,
        orderCount: cycle.orderCount,
        netPayoutPaise: cycle.paidAmountPaise != null ? cycle.netPayoutPaise : settled,
        paidAmountPaise: cycle.paidAmountPaise,
        expectedPaise: expected,
        outletName: cycle.outletName,
        bankBasis: bankBasis(cycle),
        status: PAYOUT_CHECK,
      };
    });
  const selected = payouts.find((payout) => payout.id === input.selectedId) ?? payouts[0] ?? null;
  const cycle = selected ? filled.get(selected.id) : undefined;
  const deductions = cycle ? deductionRows(cycle) : [];
  return {
    payouts,
    selectedId: selected?.id ?? null,
    deductions,
    plot: null,
    breakdown: cycle
      ? paymentBreakdown(
          cycle,
          input.adjustments.filter((row) => row.cycleId === cycle.id),
        )
      : [],
    orders: selected
      ? input.orders
          .filter((order) => order.cycleId === selected.id)
          .sort(
            (left, right) =>
              right.date.localeCompare(left.date) || left.orderId.localeCompare(right.orderId),
          )
      : [],
    adjustments: selected ? input.adjustments.filter((row) => row.cycleId === selected.id) : [],
  };
}

export function composeOwnerMenu(
  items: ReadonlyArray<{
    name: string;
    platform: "zomato" | "swiggy";
    revenuePaise: number;
  }>,
  swiggy: OwnerMenuFacts | null = null,
): OwnerMenu {
  const apps = new Set(items.map((item) => item.platform));
  const byName = new Map<string, OwnerMenuRow>();
  for (const item of items) {
    const current = byName.get(item.name) ?? {
      name: item.name,
      platforms: [],
      revenuePaise: 0,
      missingApp: false,
    };
    if (!current.platforms.includes(item.platform)) current.platforms.push(item.platform);
    current.revenuePaise += item.revenuePaise;
    byName.set(item.name, current);
  }
  const rows = [...byName.values()]
    .map((row) => ({
      ...row,
      platforms: [...row.platforms].sort(),
      missingApp: apps.size > 1 && row.platforms.length < apps.size,
    }))
    .sort(
      (left, right) =>
        right.revenuePaise - left.revenuePaise || left.name.localeCompare(right.name),
    );
  return {
    editing: false,
    rows,
    missingCount: rows.filter((row) => row.missingApp).length,
    swiggy,
  };
}

const COMPLAINTS = [
  ["complaints_missing", "Missing items"],
  ["complaints_quality", "Poor quality"],
  ["complaints_packaging", "Packaging"],
  ["complaints_wrong", "Wrong items"],
] as const;

/** Poorly rated orders as a percent of orders on that same day. */
export function poorRatedPercent(
  poor: number | null,
  orders: number | null | undefined,
): number | null {
  if (poor == null || orders == null || orders <= 0) return null;
  return Math.round((poor / orders) * 1000) / 10;
}

/** Act-now count from a stored brief. Null when the brief does not say. */
export function briefUrgentCount(text: string | null | undefined): number | null {
  const match = text?.match(/Act now \((\d+)\)/);
  return match?.[1] == null ? null : Number(match[1]);
}

/** Rating from platform-check rows. Complaints and rated orders are summed facts. */
export function ratingsFromRows(
  rows: ReadonlyArray<{
    platform: string;
    key: string;
    value: number | null;
    rowRole: string;
  }>,
): {
  rating: number | null;
  reviews: readonly OwnerReview[];
  apps: NonNullable<Parameters<typeof composeOwnerRatings>[0]["apps"]>;
} {
  let rating: number | null = null;
  const sums = new Map<string, number>();
  for (const row of rows) {
    if (row.value == null) continue;
    if (row.key === "rating") {
      if (row.rowRole === "platform_check" && row.platform === "zomato" && rating == null) {
        rating = row.value;
      }
      continue;
    }
    if (row.rowRole !== "fact") continue;
    const id = `${row.platform}|${row.key}`;
    sums.set(id, (sums.get(id) ?? 0) + row.value);
  }
  const app = (platform: "zomato" | "swiggy") => ({
    platform,
    rating: platform === "zomato" ? rating : null,
    poorRatedOrders: sums.get(`${platform}|poor_rated_orders`) ?? null,
    orders: sums.get(`${platform}|rated_orders`) ?? null,
    complaints: Object.fromEntries(
      COMPLAINTS.map(([id]) => [id, sums.get(`${platform}|${id}`) ?? null]),
    ),
  });
  return { rating, reviews: [], apps: [app("zomato"), app("swiggy")] };
}

/** Last civil day both apps have a stored row, then the 28 days ending that day. */
export function ratingsForWindow(
  rows: ReadonlyArray<{
    platform: string;
    key: string;
    value: number | null;
    rowRole: string;
    date: string;
  }>,
  today: string,
): OwnerRatings {
  const present = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.value == null || row.date > today) continue;
    const apps = present.get(row.date) ?? new Set<string>();
    apps.add(row.platform);
    present.set(row.date, apps);
  }
  const end =
    [...present.entries()]
      .filter(([, apps]) => apps.has("zomato") && apps.has("swiggy"))
      .map(([date]) => date)
      .sort()
      .at(-1) ?? null;
  const from = end ? addDays(end, -27) : null;
  const inside = from && end ? rows.filter((row) => row.date >= from && row.date <= end) : [];
  const rating = inside
    .filter(
      (row) =>
        row.key === "rating" &&
        row.rowRole === "platform_check" &&
        row.platform === "zomato" &&
        row.value != null &&
        row.value !== 0,
    )
    .sort((left, right) => right.date.localeCompare(left.date));
  const summed = ratingsFromRows([
    ...rating.slice(0, 1),
    ...inside.filter((row) => row.rowRole === "fact" && row.key !== "rating"),
  ]);
  return composeOwnerRatings({ ...summed, from, to: end });
}

export interface PaymentPeriod<T extends { from: string; to: string }> {
  from: string;
  to: string;
  zomato: T | null;
  swiggy: T | null;
}

/** One entry per app per settlement. Periods are never paired, newest first. */
export function paymentPeriods<
  T extends { platform: "zomato" | "swiggy"; from: string; to: string },
>(payouts: readonly T[]): PaymentPeriod<T>[] {
  return [...payouts]
    .sort(
      (left, right) =>
        right.from.localeCompare(left.from) ||
        (left.platform === "zomato" ? 0 : 1) - (right.platform === "zomato" ? 0 : 1) ||
        right.to.localeCompare(left.to),
    )
    .map((payout) => ({
      from: payout.from,
      to: payout.to,
      zomato: payout.platform === "zomato" ? payout : null,
      swiggy: payout.platform === "swiggy" ? payout : null,
    }));
}

/** Paid is the bank figure. Pending is the computed net of a payout with no bank figure. They are not added. */
export function labeledPayoutTotals(
  payouts: readonly {
    bankBasis: "paid" | "net" | "missing";
    paidAmountPaise: number | null;
    netPayoutPaise?: number | null;
    expectedPaise: number | null;
  }[],
): { paidPaise: number | null; pendingPaise: number | null } {
  let paid = 0;
  let paidAny = false;
  let pending = 0;
  let pendingAny = false;
  for (const payout of payouts) {
    if (payout.bankBasis === "paid" && payout.paidAmountPaise != null) {
      paid += payout.paidAmountPaise;
      paidAny = true;
      continue;
    }
    const expected =
      payout.expectedPaise ?? (payout.bankBasis === "net" ? payout.netPayoutPaise : null);
    if (expected != null) {
      pending += expected;
      pendingAny = true;
    }
  }
  return {
    paidPaise: paidAny ? paid : null,
    pendingPaise: pendingAny ? pending : null,
  };
}

export interface PayoutAppFigure {
  basis: "paid" | "expected" | "missing";
  paise: number | null;
  from: string | null;
  to: string | null;
}

/** Each app's own newest period. The two figures are never added together. */
export function payoutAppFigures<
  T extends {
    platform: "zomato" | "swiggy";
    from: string;
    to: string;
    bankBasis: "paid" | "net" | "missing";
    paidAmountPaise: number | null;
    expectedPaise: number | null;
    netPayoutPaise?: number | null;
  },
>(rows: readonly T[]): { zomato: PayoutAppFigure; swiggy: PayoutAppFigure } {
  const newest = (platform: "zomato" | "swiggy"): T | null =>
    rows
      .filter((row) => row.platform === platform)
      .sort(
        (left, right) => right.from.localeCompare(left.from) || right.to.localeCompare(left.to),
      )[0] ?? null;
  const figure = (row: T | null): PayoutAppFigure => {
    if (!row) return { basis: "missing", paise: null, from: null, to: null };
    const span = { from: row.from, to: row.to };
    if (row.bankBasis === "paid" && row.paidAmountPaise != null) {
      return { basis: "paid", paise: row.paidAmountPaise, ...span };
    }
    const expected =
      row.expectedPaise ?? (row.bankBasis === "net" ? (row.netPayoutPaise ?? null) : null);
    if (expected != null) return { basis: "expected", paise: expected, ...span };
    return { basis: "missing", paise: null, ...span };
  };
  return { zomato: figure(newest("zomato")), swiggy: figure(newest("swiggy")) };
}

/** One app, its own dates, and its own state. No second app and no summed figure. */
export function payoutAppLine(
  name: string,
  app: PayoutAppFigure | null | undefined,
  words: { paid: string; expected: string; missing: string },
): string {
  if (!app) return `${name} ${words.missing}`;
  const state =
    app.basis === "paid" && app.paise != null
      ? `${words.paid} ${formatRupees(app.paise)}`
      : app.basis === "expected" && app.paise != null
        ? `${words.expected} ${formatRupees(app.paise)}`
        : words.missing;
  if (app.from && app.to) return `${name} ${formatExclusiveRange(app.from, app.to)} · ${state}`;
  return `${name} ${state}`;
}

/** Each app's own dates. A missing app is left out so two weeks are not written as one range. */
export function paymentPeriodLabel(
  period: {
    zomato: { from: string; to: string } | null;
    swiggy: { from: string; to: string } | null;
  },
  names: { zomato: string; swiggy: string } = { zomato: "Zomato", swiggy: "Swiggy" },
): string {
  const parts = [
    period.zomato
      ? `${names.zomato} ${formatExclusiveRange(period.zomato.from, period.zomato.to)}`
      : null,
    period.swiggy
      ? `${names.swiggy} ${formatExclusiveRange(period.swiggy.from, period.swiggy.to)}`
      : null,
  ].filter((part): part is string => part != null);
  return parts.join(" · ");
}

/**
 * The next settlement window after each app's latest stored cycle, when that window has
 * already started and no report is stored. Cadence is the gap between the last two ends.
 */
export function unstoredPayoutWindows(
  payouts: ReadonlyArray<{ platform: "zomato" | "swiggy"; from: string; to: string }>,
  today: string,
): Array<{ platform: "zomato" | "swiggy"; from: string; to: string }> {
  const windows: Array<{ platform: "zomato" | "swiggy"; from: string; to: string }> = [];
  for (const platform of ["zomato", "swiggy"] as const) {
    const rows = payouts
      .filter((row) => row.platform === platform)
      .sort((left, right) => left.to.localeCompare(right.to));
    const last = rows[rows.length - 1];
    if (!last || last.to > today) continue;
    const previous = rows[rows.length - 2];
    const cadence = previous ? isoSpan(previous.to, last.to) : isoSpan(last.from, last.to);
    if (cadence <= 0) continue;
    const from = last.to;
    if (from > today || rows.some((row) => row.from === from)) continue;
    windows.push({ platform, from, to: addDays(from, cadence) });
  }
  return windows;
}

function isoSpan(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Integer rupees for signed paise parts that already sum to `totalPaise`.
 * The returned paise are multiples of 100 and their rupees add to the rounded total.
 */
export function largestRemainderRupees(
  parts: ReadonlyArray<{ id: string; paise: number }>,
  totalPaise: number,
): Record<string, number> {
  const target = Math.round(totalPaise / 100);
  const exact = parts.map((part) => part.paise / 100);
  const base = exact.map((value) => Math.floor(value));
  let left = target - base.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort(
      (leftPart, rightPart) => rightPart.frac - leftPart.frac || leftPart.index - rightPart.index,
    );
  const rupees = [...base];
  if (left > 0) {
    for (const item of order) {
      if (left <= 0) break;
      rupees[item.index] = (rupees[item.index] ?? 0) + 1;
      left -= 1;
    }
  } else {
    for (const item of [...order].reverse()) {
      if (left >= 0) break;
      rupees[item.index] = (rupees[item.index] ?? 0) - 1;
      left += 1;
    }
  }
  return Object.fromEntries(parts.map((part, index) => [part.id, (rupees[index] ?? 0) * 100]));
}

/** Null is unreported. A stored zero stays zero. */
function reportedFigure(value: number | null | undefined): number | null {
  if (value == null) return null;
  return value;
}

export function composeOwnerRatings(input: {
  rating: number | null;
  reviews: readonly OwnerReview[];
  from?: string | null;
  to?: string | null;
  apps?: ReadonlyArray<{
    platform: "zomato" | "swiggy";
    rating?: number | null;
    poorRatedOrders?: number | null;
    /** Orders on the same day as the poorly-rated count. */
    orders?: number | null;
    complaints?: Readonly<Record<string, number | null>>;
  }>;
}): OwnerRatings {
  const supplied = new Map((input.apps ?? []).map((app) => [app.platform, app]));
  const apps: OwnerRatingApp[] = (["zomato", "swiggy"] as const).map((platform) => {
    const app = supplied.get(platform);
    const rating =
      platform === "swiggy" ? null : app ? (app.rating ?? null) : (input.rating ?? null);
    return {
      platform,
      rating,
      ratingState:
        platform === "swiggy" ? "not_in_report" : rating == null ? "not_in_report" : "ok",
      poorRatedOrders: reportedFigure(app?.poorRatedOrders),
      poorRatedPct: poorRatedPercent(reportedFigure(app?.poorRatedOrders), app?.orders),
      complaints: COMPLAINTS.map(([id, label]) => ({
        id,
        label,
        count: reportedFigure(app?.complaints?.[id]),
      })),
    };
  });
  return {
    rating: apps[0]?.rating ?? null,
    reviews: [...input.reviews].sort(
      (left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id),
    ),
    apps,
    from: input.from ?? null,
    to: input.to ?? null,
    totals: COMPLAINTS.map(([id]) => ({
      id,
      count: apps.reduce(
        (sum, app) => sum + (app.complaints.find((row) => row.id === id)?.count ?? 0),
        0,
      ),
    })),
  };
}

export function composeOwnerDocuments(input: {
  today: string;
  reference: string | null;
  expiresOn: string | null;
  gstin: string | null;
  reports: ReadonlyArray<{
    id: string;
    kind: string | null;
    from: string;
    to: string;
    createdOn: string;
    createdAt?: string | null;
  }>;
}): OwnerDocuments {
  return {
    reference: blank(input.reference),
    expiresOn: input.expiresOn,
    gstin: blank(input.gstin),
    reminder: licenceReminder(input.today, input.expiresOn),
    daysLeft: input.expiresOn ? daysUntil(input.today, input.expiresOn) : null,
    reports: labelledReports(input.reports),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2 Jan 2027` to an ISO civil date. Anything else is not a date. */
export function parseDisplayDate(value: string): string | null {
  const match = /^(\d{1,2}) ([A-Za-z]{3,}) (\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = MONTHS.findIndex(
    (name) => name.toLowerCase() === match[2]?.slice(0, 3).toLowerCase(),
  );
  if (month < 0) return null;
  const iso = `${match[3]}-${String(month + 1).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  return isCivilDate(iso) ? iso : null;
}

function bankBasis(cycle: PaymentCycle): "paid" | "net" | "missing" {
  if (cycle.paidAmountPaise != null) return "paid";
  if (cycle.netPayoutPaise != null) return "net";
  return "missing";
}

/** Ads rows on the detail sheet, including a GST-on-ads line. The breakup cell can omit one. */
function isAdsLabel(label: string): boolean {
  return /\b(ads?|advertis\w*|cpc|sponsored|hyperboost|marketing)\b|top picks|co-branded/i.test(
    label,
  );
}

function storedAdsPaise(adjustments: readonly PaymentAdjustment[]): number | null {
  return summedAmounts(adjustments.filter((row) => isAdsLabel(row.label)));
}

/** Non-ads adjustment rows. Null when the report has none, never a stand-in zero. */
function storedAdjustmentPaise(adjustments: readonly PaymentAdjustment[]): number | null {
  return summedAmounts(adjustments.filter((row) => !isAdsLabel(row.label)));
}

function summedAmounts(rows: readonly PaymentAdjustment[]): number | null {
  if (rows.length === 0) return null;
  return rows.reduce((total, row) => total + row.amountPaise, 0);
}

/** Collected GST is not inside the tax line and is not a deduction. A stored deduction is a minus. */
function gstLineLabel(cycle: PaymentCycle): string {
  if (cycle.gstKind === "deduction") return "− GST";
  if (cycle.gstKind === "collected") return "GST collected";
  return "GST";
}

function paymentBreakdown(
  cycle: PaymentCycle,
  adjustments: readonly PaymentAdjustment[],
): OwnerPayments["breakdown"] {
  const basis = bankBasis(cycle);
  const adjustmentPaise = adjustments.reduce((total, row) => total + row.amountPaise, 0);
  const fromRows = storedAdsPaise(adjustments);
  const ads =
    fromRows == null
      ? cycle.adsPaise
      : cycle.adsPaise == null
        ? fromRows
        : Math.max(cycle.adsPaise, fromRows);
  const adjustmentsPaise = storedAdjustmentPaise(adjustments);
  const settled = settledPayoutPaise({
    paidAmountPaise: cycle.paidAmountPaise,
    netPayoutPaise: cycle.netPayoutPaise,
    adjustmentPaise,
  });
  const target = cycle.paidAmountPaise ?? settled;
  const piece = (value: number | null) => value ?? 0;
  const other =
    cycle.grossSalesPaise != null && target != null
      ? target -
        (cycle.grossSalesPaise -
          piece(cycle.discountsPaise) -
          piece(sumPaise(cycle.commissionPaise, cycle.feesPaise)) -
          piece(ads) -
          piece(sumPaise(cycle.taxesPaise, cycle.tdsPaise, cycle.tcsPaise)) -
          piece(cycle.complaintsPaise))
      : null;
  const otherLabel =
    other == null ? "Other adjustments" : `${other >= 0 ? "+" : "−"} Other adjustments`;
  return [
    { id: "sales", label: "Your sales", paise: cycle.grossSalesPaise, basis: null },
    {
      id: "discounts",
      label: "− Discounts you paid for",
      paise: cycle.discountsPaise,
      basis: null,
    },
    {
      id: "commission",
      label: "− Commission & fees",
      paise: sumPaise(cycle.commissionPaise, cycle.feesPaise),
      basis: null,
    },
    { id: "ads", label: "− Ads", paise: ads, basis: null },
    {
      id: "tax",
      label: "− GST & TDS",
      paise: sumPaise(cycle.taxesPaise, cycle.tdsPaise, cycle.tcsPaise),
      basis: null,
    },
    {
      id: "gst",
      label: gstLineLabel(cycle),
      paise: cycle.gstPaise,
      basis: null,
    },
    {
      id: "complaints",
      label: "− Complaints and cancellations",
      paise: cycle.complaintsPaise,
      basis: null,
    },
    { id: "adjustments", label: "Adjustments", paise: adjustmentsPaise, basis: null },
    { id: "other", label: otherLabel, paise: other, basis: null },
    basis === "paid"
      ? { id: "bank", label: "= Paid to your bank", paise: settled, basis: "paid" }
      : {
          id: "net",
          label: "= Expected from the file",
          paise: settled,
          basis: basis === "net" ? "net" : null,
        },
  ];
}

function sumPaise(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null);
  if (known.length === 0) return null;
  return known.reduce((total, value) => total + value, 0);
}

function labelledReports(
  reports: ReadonlyArray<{
    id: string;
    kind: string | null;
    from: string;
    to: string;
    createdOn: string;
    createdAt?: string | null;
  }>,
): OwnerReportArchiveItem[] {
  const seen = new Set<string>();
  const rows: OwnerReportArchiveItem[] = [];
  for (const report of reports) {
    const kind = archiveKind(report.kind);
    if (!kind) continue;
    const key = `${kind}|${report.from}|${report.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: report.id,
      kind,
      from: report.from,
      to: report.to,
      createdOn: report.createdOn,
      createdAt: report.createdAt ?? null,
    });
  }
  return rows;
}

/** A null cycle cell is filled from stored order rows. A field with no stored number stays null. */
export function fillCycleFromOrders(
  cycle: PaymentCycle,
  orders: readonly PaymentOrder[],
  adjustments: readonly PaymentAdjustment[],
): PaymentCycle {
  const sum = (pick: (order: PaymentOrder) => number | null | undefined): number | null => {
    let any = false;
    let total = 0;
    for (const order of orders) {
      const value = pick(order);
      if (value == null) continue;
      any = true;
      total += value;
    }
    return any ? total : null;
  };
  const ads = storedAdsPaise(adjustments);
  const usedCollected = orders.some((order) => order.gstCollectedPaise != null);
  const usedDeduction = orders.some(
    (order) => order.gstCollectedPaise == null && order.gstDeductionPaise != null,
  );
  const gstKind =
    cycle.gstPaise != null
      ? (cycle.gstKind ?? "collected")
      : usedCollected
        ? "collected"
        : usedDeduction
          ? "deduction"
          : cycle.gstKind;
  return {
    ...cycle,
    gstKind,
    grossSalesPaise: cycle.grossSalesPaise ?? sum((order) => order.grossSalesPaise),
    discountsPaise: cycle.discountsPaise ?? sum((order) => order.discountPaise),
    commissionPaise: cycle.commissionPaise ?? sum((order) => order.commissionPaise),
    feesPaise: cycle.feesPaise ?? sum((order) => order.feesPaise),
    taxesPaise: cycle.taxesPaise ?? sum((order) => order.taxesPaise),
    tdsPaise: cycle.tdsPaise ?? sum((order) => order.tdsPaise),
    tcsPaise: cycle.tcsPaise ?? sum((order) => order.tcsPaise),
    gstPaise:
      cycle.gstPaise ??
      sum((order) =>
        order.gstCollectedPaise != null ? order.gstCollectedPaise : order.gstDeductionPaise,
      ),
    complaintsPaise: cycle.complaintsPaise ?? sum((order) => order.complaintsPaise),
    adsPaise: cycle.adsPaise ?? ads,
  };
}

function deductionRows(cycle: PaymentCycle): Array<{ id: string; label: string; paise: number }> {
  const amounts: Record<(typeof DEDUCTIONS)[number][0], number | null> = {
    commission: cycle.commissionPaise,
    fees: cycle.feesPaise,
    taxes: cycle.taxesPaise,
    tds: cycle.tdsPaise,
    tcs: cycle.tcsPaise,
    ads: cycle.adsPaise,
    discounts: cycle.discountsPaise,
    gst: cycle.gstPaise,
    complaints: cycle.complaintsPaise,
  };
  return DEDUCTIONS.flatMap(([id, label]) => {
    const paise = amounts[id];
    return paise != null && paise !== 0 ? [{ id, label, paise }] : [];
  });
}

function archiveKind(kind: string | null): OwnerReportArchiveItem["kind"] | null {
  if (kind === "daily_brief") return "daily";
  if (kind === "weekly_review") return "weekly";
  if (kind === "payout_check") return "payout";
  return null;
}

function blank(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
