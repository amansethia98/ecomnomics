import type {
  FetchPlanPlatform,
  FetchPlanResponse,
  FetchPlanWindow,
  FetchReport,
  FetchWindowReason,
} from "@rakazo/contracts";
import {
  addIsoDays,
  daysBetween,
  FETCH_BACKFILL_NIGHT_DAYS,
  FETCH_DAILY_DAYS,
  FETCH_HORIZON_DAYS,
  FETCH_SWIGGY_CHUNK_DAYS,
  FETCH_WINDOW_REASONS,
  FETCH_ZOMATO_CHUNK_DAYS,
  isoWeekday,
  nextMonth,
} from "@rakazo/contracts";
import type { OwnerFetchSpan, OwnerMetricFact } from "./owner-metrics-assemble.js";
import { coveredCivilDays, latestLagBanner } from "./owner-metrics-assemble.js";

const PLATFORMS = ["zomato", "swiggy"] as const;
type Platform = (typeof PLATFORMS)[number];

export interface FetchPlanCycle {
  platform: Platform;
  periodStart: string;
  periodEnd: string;
  settlementStatus: "pending" | "settled";
}

export interface FetchPlanFacts {
  outletId: string;
  zomatoResId: string | null;
  swiggyRid: string | null;
  /** Civil date the plan is for. Today in Asia/Kolkata unless the caller overrides it. */
  date: string;
  facts: readonly OwnerMetricFact[];
  fetches: readonly OwnerFetchSpan[];
  orders: ReadonlyArray<{
    outletId: string;
    platform: Platform;
    orderDate: string;
    settlementDate: string | null;
  }>;
  cycles: readonly FetchPlanCycle[];
  /** Platforms whose fetching is paused. Their plan has no windows. */
  held?: ReadonlySet<Platform>;
}

interface Span {
  periodStart: string;
  periodEnd: string;
}

/** The windows a fetch job should download for one outlet on one civil date. */
export function buildFetchPlan(input: FetchPlanFacts): FetchPlanResponse {
  const ids = { zomato: cleanId(input.zomatoResId), swiggy: cleanId(input.swiggyRid) };
  const backfill = chunkBackfill(
    ids.zomato ? missingDays(input, "zomato") : [],
    ids.swiggy ? missingDays(input, "swiggy") : [],
  );
  return {
    date: input.date,
    outletId: input.outletId,
    platforms: PLATFORMS.map((platform) =>
      platformPlan(input, platform, ids[platform], backfill[platform]),
    ),
  };
}

function platformPlan(
  input: FetchPlanFacts,
  platform: Platform,
  platformId: string | null,
  backfill: readonly Span[],
): FetchPlanPlatform {
  const held = input.held?.has(platform) ?? false;
  if (held || !platformId) {
    return {
      platform,
      platformId,
      reason: platformId ? null : "missing_platform_id",
      held,
      windows: [],
    };
  }
  const windows: FetchPlanWindow[] = [windowFor("daily", ["scheduled"], dailyWindow(input.date))];
  const weekly = weeklyWindow(platform, input.date);
  if (weekly) windows.push(windowFor("weekly", ["scheduled"], weekly));
  const monthly = monthlyWindow(input.date);
  if (monthly) windows.push(windowFor("monthly", ["scheduled"], monthly));
  if (isoWeekday(input.date) === 4) {
    for (const payout of payoutWindows(input, platform)) windows.push(payout);
  }
  for (const span of backfill) windows.push(windowFor("daily", ["backfill"], span));
  return { platform, platformId, reason: null, held: false, windows };
}

function payoutWindows(input: FetchPlanFacts, platform: Platform): FetchPlanWindow[] {
  const open = new Map<string, Set<FetchWindowReason>>();
  const add = (span: Span, reason: FetchWindowReason) => {
    if (span.periodEnd <= span.periodStart) return;
    if (span.periodStart <= input.date && input.date < span.periodEnd) return;
    const key = `${span.periodStart}|${span.periodEnd}`;
    const reasons = open.get(key) ?? new Set<FetchWindowReason>();
    reasons.add(reason);
    open.set(key, reasons);
  };
  const paid =
    platform === "zomato" ? zomatoPaidWindows(input.date) : swiggyPaidWindows(input.date);
  for (const span of paid) add(span, "scheduled");
  const outlet = new Set([input.outletId]);
  for (const cycle of input.cycles) {
    if (cycle.platform !== platform) continue;
    if (cycle.periodEnd <= cycle.periodStart) continue;
    const span = { periodStart: cycle.periodStart, periodEnd: cycle.periodEnd };
    if (cycle.settlementStatus === "pending") add(span, "pending");
    if (
      platform === "swiggy" &&
      latestLagBanner(input.facts, outlet, cycle.periodStart, cycle.periodEnd) === true
    ) {
      add(span, "lag_banner");
    }
  }
  return [...open.entries()]
    .map(([key, reasons]) => {
      const [periodStart, periodEnd] = key.split("|");
      return windowFor("payout", orderedReasons(reasons), {
        periodStart: periodStart ?? "",
        periodEnd: periodEnd ?? "",
      });
    })
    .sort(
      (a, b) =>
        a.periodStart.localeCompare(b.periodStart) || a.periodEnd.localeCompare(b.periodEnd),
    );
}

function missingDays(input: FetchPlanFacts, platform: Platform): string[] {
  const start = addIsoDays(input.date, -FETCH_HORIZON_DAYS);
  const dailyStart = addIsoDays(input.date, -FETCH_DAILY_DAYS);
  const days = daysBetween(start, dailyStart);
  const covered = coveredCivilDays(
    {
      facts: input.facts,
      fetches: input.fetches,
      orders: input.orders,
      basis: "order_date",
    },
    input.outletId,
    days,
    [platform],
  );
  return days.filter((day) => !covered.has(day));
}

/** Oldest chosen days first, split where a gap or the platform's chunk size starts a new window. */
function chunkMissing(platform: Platform, days: readonly string[], budget: number): Span[] {
  const max = platform === "zomato" ? FETCH_ZOMATO_CHUNK_DAYS : FETCH_SWIGGY_CHUNK_DAYS;
  const spans: Span[] = [];
  let current: { periodStart: string; periodEnd: string; days: number } | null = null;
  let used = 0;
  const close = () => {
    if (!current) return;
    spans.push({ periodStart: current.periodStart, periodEnd: current.periodEnd });
    current = null;
  };
  for (const day of days) {
    if (used >= budget) break;
    const continues = current !== null && current.periodEnd === day && current.days < max;
    if (continues && current) {
      current.periodEnd = addIsoDays(day, 1);
      current.days += 1;
    } else {
      close();
      current = { periodStart: day, periodEnd: addIsoDays(day, 1), days: 1 };
    }
    used += 1;
  }
  close();
  return spans;
}

/** Both platforms share one nightly budget. Zomato is taken first on a tied day. */
export function chunkBackfill(
  zomatoDays: readonly string[],
  swiggyDays: readonly string[],
  budget = FETCH_BACKFILL_NIGHT_DAYS,
): { zomato: Span[]; swiggy: Span[] } {
  const items = [
    ...zomatoDays.map((day) => ({ platform: "zomato" as const, day })),
    ...swiggyDays.map((day) => ({ platform: "swiggy" as const, day })),
  ].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      (a.platform === b.platform ? 0 : a.platform === "zomato" ? -1 : 1),
  );
  const chosen: { zomato: string[]; swiggy: string[] } = { zomato: [], swiggy: [] };
  for (const item of items) {
    if (chosen.zomato.length + chosen.swiggy.length >= budget) break;
    chosen[item.platform].push(item.day);
  }
  return {
    zomato: chunkMissing("zomato", chosen.zomato, chosen.zomato.length),
    swiggy: chunkMissing("swiggy", chosen.swiggy, chosen.swiggy.length),
  };
}

function dailyWindow(date: string): Span {
  return { periodStart: addIsoDays(date, -FETCH_DAILY_DAYS), periodEnd: date };
}

function weeklyWindow(platform: Platform, date: string): Span | null {
  if (platform === "zomato") {
    if (isoWeekday(date) !== 1) return null;
    return { periodStart: addIsoDays(date, -7), periodEnd: date };
  }
  if (isoWeekday(date) !== 2) return null;
  return { periodStart: addIsoDays(date, -9), periodEnd: addIsoDays(date, -2) };
}

function monthlyWindow(date: string): Span | null {
  if (!date.endsWith("-03")) return null;
  const periodEnd = `${date.slice(0, 7)}-01`;
  return { periodStart: previousMonth(periodEnd), periodEnd };
}

function zomatoPaidWindows(date: string): Span[] {
  const weekday = isoWeekday(date);
  const sinceMonday = weekday === 0 ? 6 : weekday - 1;
  const thisMonday = addIsoDays(date, -sinceMonday);
  const windows: Span[] = [];
  for (let week = 4; week >= 1; week -= 1) {
    const periodStart = addIsoDays(thisMonday, -7 * week);
    windows.push({ periodStart, periodEnd: addIsoDays(periodStart, 7) });
  }
  return windows;
}

function swiggyPaidWindows(date: string): Span[] {
  const sunday = addIsoDays(date, -isoWeekday(date));
  const newestFirst: Span[] = [];
  for (let week = 0; week < 8 && newestFirst.length < 4; week += 1) {
    const parts = swiggyWeekParts(addIsoDays(sunday, -7 * week)).filter(
      (part) => part.periodEnd <= date,
    );
    for (const part of [...parts].reverse()) {
      newestFirst.push(part);
      if (newestFirst.length === 4) break;
    }
  }
  return newestFirst.reverse();
}

/** A Sunday–Saturday week, split where it crosses a month boundary. */
function swiggyWeekParts(sunday: string): Span[] {
  const weekEnd = addIsoDays(sunday, 7);
  const parts: Span[] = [];
  let cursor = sunday;
  while (cursor < weekEnd) {
    const monthEnd = nextMonth(`${cursor.slice(0, 7)}-01`);
    let periodEnd = weekEnd;
    if (monthEnd < periodEnd) periodEnd = monthEnd;
    if (periodEnd <= cursor) break;
    parts.push({ periodStart: cursor, periodEnd });
    cursor = periodEnd;
  }
  return parts;
}

function previousMonth(monthStart: string): string {
  const [year, month] = monthStart.split("-").map(Number);
  if (month === 1) return `${(year ?? 1) - 1}-12-01`;
  return `${year}-${String((month ?? 2) - 1).padStart(2, "0")}-01`;
}

function windowFor(report: FetchReport, reasons: FetchWindowReason[], span: Span): FetchPlanWindow {
  return { report, reasons, periodStart: span.periodStart, periodEnd: span.periodEnd };
}

function orderedReasons(reasons: ReadonlySet<FetchWindowReason>): FetchWindowReason[] {
  return FETCH_WINDOW_REASONS.filter((reason) => reasons.has(reason));
}

function cleanId(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
