import * as z from "zod";
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
  complaintsPaise: number | null;
}

export interface PaymentOrder {
  cycleId: string;
  orderId: string;
  date: string;
  netPayoutPaise: number | null;
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
  const payouts = [...input.cycles]
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
        outletName: cycle.outletName,
        bankBasis: bankBasis(cycle),
        status: PAYOUT_CHECK,
      };
    });
  const selected = payouts.find((payout) => payout.id === input.selectedId) ?? payouts[0] ?? null;
  const cycle = selected ? input.cycles.find((item) => item.id === selected.id) : undefined;
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

/** Null is unreported. A stored zero stays zero. */
function reportedFigure(value: number | null | undefined): number | null {
  if (value == null) return null;
  return value;
}

export function composeOwnerRatings(input: {
  rating: number | null;
  reviews: readonly OwnerReview[];
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

function paymentBreakdown(
  cycle: PaymentCycle,
  adjustments: readonly PaymentAdjustment[],
): OwnerPayments["breakdown"] {
  const basis = bankBasis(cycle);
  const adjustmentPaise = adjustments.reduce((total, row) => total + row.amountPaise, 0);
  const ads = cycle.adsPaise ?? (adjustmentPaise !== 0 ? adjustmentPaise : null);
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
  return [
    { id: "sales", label: "Your sales", paise: cycle.grossSalesPaise, basis: null },
    { id: "discounts", label: "Discounts you paid for", paise: cycle.discountsPaise, basis: null },
    {
      id: "commission",
      label: "Commission & fees",
      paise: sumPaise(cycle.commissionPaise, cycle.feesPaise),
      basis: null,
    },
    { id: "ads", label: "Ads", paise: ads, basis: null },
    {
      id: "tax",
      label: "GST & TDS",
      paise: sumPaise(cycle.taxesPaise, cycle.tdsPaise, cycle.tcsPaise),
      basis: null,
    },
    {
      id: "complaints",
      label: "Complaints and cancellations",
      paise: cycle.complaintsPaise,
      basis: null,
    },
    { id: "other", label: "Other adjustments", paise: other, basis: null },
    basis === "paid"
      ? { id: "bank", label: "Paid to your bank", paise: settled, basis: "paid" }
      : {
          id: "net",
          label: "Expected from the file",
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
    });
  }
  return rows;
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
