import {
  addDays,
  formatAxisDay,
  formatCivilDay,
  formatCompactRupees,
  formatInclusiveRange,
  formatPct1,
  formatWeekdayName,
  pctChange,
  weekMonday,
} from "./ops/format.js";
import type { OpsPlatform } from "./ops/types.js";
import type { OwnerRange, OwnerViewPlatform } from "./owner-app.js";
import { ownerRangeDays } from "./owner-app.js";

export type DashState = "ok" | "pending" | "missing" | "updating";

export interface DashReading {
  from: string;
  grain: "day" | "week";
  platform: OpsPlatform;
  key: string;
  value: number | null;
  state: DashState;
}

export interface OwnerDashboardInput {
  today: string;
  range: OwnerRange;
  from: string;
  to: string;
  platform: OwnerViewPlatform;
  holidays: readonly string[];
  readings: readonly DashReading[];
  historyDays: number;
}

export type TileWord =
  | "growing"
  | "falling"
  | "steady"
  | "slower"
  | "faster"
  | "rising"
  | "improving";

export interface DashSplit {
  platform: OpsPlatform;
  value: number | null;
  /** False when that app's report does not carry this metric. A real zero stays a value. */
  inReport: boolean;
  /** `no_spend` is sales with a zero spend file. `missing` is absent from the report. */
  gap: "missing" | "no_spend" | null;
}

export interface DashTile {
  id: string;
  value: number | null;
  format: "paise" | "count" | "pct" | "minutes" | "rating" | "ratio";
  changePct: number | null;
  spark: Array<number | null>;
  word: TileWord | null;
  weeks: number;
  good: boolean | null;
  state: "value" | "pending" | "missing" | "updating" | "na" | "not_in_report" | "no_ads" | "empty";
  festival: boolean;
  splits: DashSplit[];
  /** The same window the value and the percent used, in words. */
  basis: string;
  /** Compared span on the trend tag: `7 days`, or `3 of 12 weeks` when fewer were compared. */
  span: string;
}

export interface DashPin {
  week: string;
  n: number;
  kind: "festival" | "discount" | "offline";
  label: string;
}

export interface SalesPanel {
  platform: OpsPlatform;
  points: Array<{ week: string; sales: number | null; pending: boolean; missing: boolean }>;
}

export interface OwnerDashboardModel {
  answer: {
    direction: "up" | "down" | "flat" | "none";
    pct: number | null;
    weeks: number;
    flatPlatform: OpsPlatform | null;
    flatWeeks: number;
    dipped: { platform: OpsPlatform; pct: number; against: string } | null;
    festival: boolean;
    pendingPlatform: OpsPlatform | null;
    /** Day when the selector is two weeks or shorter. Otherwise week. */
    unit: "day" | "week";
  };
  panels: SalesPanel[];
  pins: DashPin[];
  shadeWeek: string | null;
  tiles: DashTile[];
  heatmap: Array<{ week: string; weekday: string; orders: number | null; pending: boolean }>;
  funnel: Array<{
    step: "menu" | "cart" | "order";
    platform: OpsPlatform;
    points: Array<{ week: string; pct: number | null }>;
  }>;
  pendingNote: string | null;
  /** The pending day left out of both sides, when one app is behind. */
  pendingDate?: string | null;
  missingNote: string | null;
  compared: { kept: number; expected: number } | null;
  /** The words for the one window the headline, tiles, and footnote share. */
  periodPhrase: string;
  heatmapLine: string | null;
  funnelLine: string | null;
  comparisonsStart: string | null;
  onePlatform: boolean;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const SALES_KEY: Record<OpsPlatform, string> = {
  zomato: "ops_sales_paise",
  swiggy: "swiggy_net_sales_paise",
};

interface TileDef {
  id: string;
  format: DashTile["format"];
  goodUp: boolean;
  word: "plain" | "prep" | "rejects" | "ads";
}

const TILES: TileDef[] = [
  { id: "sales", format: "paise", goodUp: true, word: "plain" },
  { id: "orders", format: "count", goodUp: true, word: "plain" },
  { id: "aov", format: "paise", goodUp: true, word: "plain" },
  { id: "online", format: "pct", goodUp: true, word: "plain" },
  { id: "prep", format: "minutes", goodUp: false, word: "prep" },
  { id: "rejected", format: "count", goodUp: false, word: "rejects" },
  { id: "rating", format: "rating", goodUp: true, word: "plain" },
  { id: "ads", format: "ratio", goodUp: true, word: "ads" },
];

export function composeOwnerDashboard(input: OwnerDashboardInput): OwnerDashboardModel {
  const platforms = selected(input);
  const bounded = { ...input, to: clampEnd(input.to, input.today) };
  const window = comparisonWindow(bounded, platforms);
  const chart = { grain: window.grain, starts: periodStarts(window) };
  const trendWeeks = completeWeeks(bounded.today, 12);
  const panels = platforms.map((platform) =>
    salesPanel(bounded.readings, platform, chart.starts, chart.grain),
  );
  const pinWeeks = chart.grain === "week" ? chart.starts : weekBuckets(chart.starts);
  const pins = pinsFor(bounded, pinWeeks, platforms);
  const aligned =
    window.unit === "week" && window.count >= 12
      ? blockSales(bounded.readings, platforms, window)
      : alignedSales(bounded.readings, platforms, window);
  const earliest = earliestDay(bounded.readings);
  const young = bounded.historyDays < 7;
  const comparisonsStart = young && earliest ? addDays(earliest, 7) : null;
  const tiles = TILES.map((tile) =>
    tileFor(tile, bounded, platforms, trendWeeks, young, windowHasHoliday(bounded), window),
  );
  const answer = answerFor(panels, bounded, platforms, chart.grain);
  const direction =
    young || aligned.change == null
      ? "none"
      : Math.abs(aligned.change) < 3
        ? "flat"
        : aligned.change > 0
          ? "up"
          : "down";
  const heatmap = heatmapFor(bounded.readings, trendWeeks, platforms);
  const funnel = funnelFor(bounded.readings, chart.starts, chart.grain, platforms);
  const funnelWeeks = funnelFor(
    bounded.readings,
    recentMondays(bounded.today, 12),
    "week",
    platforms,
  );
  const week = lastCompleteWeekChange(bounded.readings, platforms, bounded.today);
  const dipped =
    window.unit === "week" && week && week.pct <= -3
      ? {
          platform: platforms[0] ?? "zomato",
          pct: week.pct,
          against: formatInclusiveRange(week.from, week.to),
        }
      : answer.dipped;
  return {
    answer: {
      ...answer,
      direction,
      pct: young ? null : aligned.change,
      weeks: window.count,
      unit: window.unit,
      dipped,
    },
    panels,
    pins,
    shadeWeek: window.unit === "week" ? (chart.starts.at(-1) ?? null) : null,
    tiles,
    heatmap,
    funnel,
    pendingNote: laggingPlatform(bounded.readings, platforms),
    pendingDate: pendingDateIn(bounded.readings, platforms, window),
    missingNote: missingNote(bounded.readings, platforms, chart.starts, chart.grain),
    compared: null,
    periodPhrase: periodPhrase(window.unit, window.count),
    heatmapLine: heatmapHeadline(heatmap),
    funnelLine: funnelHeadline(funnelWeeks),
    comparisonsStart,
    onePlatform: platforms.length === 1,
  };
}

function clampEnd(to: string, today: string): string {
  const tomorrow = addDays(today, 1);
  return to > tomorrow ? tomorrow : to;
}

function selected(input: OwnerDashboardInput): OpsPlatform[] {
  if (input.platform === "both") return ["zomato", "swiggy"];
  return [input.platform];
}

interface ComparedWindow {
  unit: "day" | "week";
  count: number;
  length: number;
  grain: "day" | "week";
  step: number;
  currentFrom: string;
  currentTo: string;
  previousFrom: string;
  previousTo: string;
}

/** Last day at or before `through` with an ok sales reading for a selected app. */
function lastSalesDay(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  through: string,
): string | null {
  const dates = readings
    .filter(
      (reading) =>
        reading.grain === "day" &&
        platforms.includes(reading.platform) &&
        reading.key === SALES_KEY[reading.platform] &&
        reading.state === "ok" &&
        reading.value != null &&
        reading.from <= through,
    )
    .map((reading) => reading.from);
  dates.sort();
  return dates.at(-1) ?? null;
}

/** Monday of the last week that has fully ended by `today`, at or before `onOrBefore`. */
function recentMondays(today: string, count: number): string[] {
  const end = completeMonday(today, today);
  const starts: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) starts.push(addDays(end, -7 * index));
  return starts;
}

function completeMonday(today: string, onOrBefore: string): string {
  let monday = weekMonday(onOrBefore);
  if (addDays(monday, 7) > today) monday = addDays(monday, -7);
  return monday;
}

function rangeCap(to: string, today: string): string {
  const end = to < addDays(today, 1) ? to : addDays(today, 1);
  return addDays(end, -1);
}

/**
 * A day range stays its full length and ends on the last day before today that has sales.
 * A week range ends on the last complete week, so a trailing partial week is never a point.
 */
function comparisonWindow(input: OwnerDashboardInput, platforms: OpsPlatform[]): ComparedWindow {
  const span = Math.max(1, daysBetween(input.from, input.to));
  const unit = span <= 14 ? "day" : "week";
  if (unit === "day") {
    const cap = rangeCap(input.to, input.today);
    const end = lastSalesDay(input.readings, platforms, cap) ?? cap;
    const currentTo = addDays(end, 1);
    const currentFrom = addDays(currentTo, -span);
    return {
      unit,
      count: span,
      length: span,
      grain: "day",
      step: 1,
      currentFrom,
      currentTo,
      previousFrom: addDays(currentFrom, -span),
      previousTo: addDays(currentTo, -span),
    };
  }
  const count = Math.max(1, Math.round(span / 7));
  const length = count * 7;
  const endMonday = completeMonday(input.today, rangeCap(input.to, input.today));
  const currentTo = addDays(endMonday, 7);
  const currentFrom = addDays(currentTo, -length);
  return {
    unit,
    count,
    length,
    grain: "week",
    step: 7,
    currentFrom,
    currentTo,
    previousFrom: addDays(currentFrom, -length),
    previousTo: addDays(currentTo, -length),
  };
}

/** Last 4 complete weeks against the first 4 inside a 12-week window. The value is the whole window. */
function blockSales(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  window: ComparedWindow,
): AlignedSales {
  const weeks = periodStarts(window);
  const sum = (slice: readonly string[]): number | null => {
    let total = 0;
    let any = false;
    for (const week of slice) {
      const keys = salesKeys(readings, platforms, week, "week");
      if (keys.size === 0) continue;
      any = true;
      for (const value of keys.values()) total += value;
    }
    return any ? total : null;
  };
  const current = sum(weeks);
  const first = sum(weeks.slice(0, 4));
  const last = sum(weeks.slice(-4));
  return {
    current,
    change: first != null && last != null && first !== 0 ? pctChange(last, first) : null,
    kept: weeks.length,
  };
}

/** One percent for "last week", shared by the dashboard subtitle and the chief of staff. */
export function lastCompleteWeekChange(
  readings: readonly DashReading[],
  platforms: readonly OpsPlatform[],
  today: string,
): {
  pct: number;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
} | null {
  const from = completeMonday(today, addDays(today, -1));
  const to = addDays(from, 6);
  const previousFrom = addDays(from, -7);
  const previousTo = addDays(to, -7);
  const current = sumSales(readings, platforms, from, addDays(to, 1));
  const previous = sumSales(readings, platforms, previousFrom, addDays(previousTo, 1));
  if (current == null || previous == null || previous === 0) return null;
  const pct = pctChange(current, previous);
  if (pct == null) return null;
  return { pct, from, to, previousFrom, previousTo };
}

function sumSales(
  readings: readonly DashReading[],
  platforms: readonly OpsPlatform[],
  from: string,
  to: string,
): number | null {
  let total = 0;
  let any = false;
  for (let day = from; day < to; day = addDays(day, 1)) {
    const keys = salesKeys(readings, platforms, day, "day");
    if (keys.size === 0) continue;
    any = true;
    for (const value of keys.values()) total += value;
  }
  if (any) return total;
  for (const platform of platforms) {
    const row = readings.find(
      (reading) =>
        reading.grain === "week" &&
        reading.platform === platform &&
        reading.key === SALES_KEY[platform] &&
        reading.from === from &&
        reading.state === "ok" &&
        reading.value != null,
    );
    if (row?.value == null) continue;
    any = true;
    total += row.value;
  }
  return any ? total : null;
}

interface AlignedSales {
  current: number | null;
  change: number | null;
  kept: number;
}

/** Sum only apps that exist on a day and on the same day in the previous window. */
function alignedSales(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  window: ComparedWindow,
): AlignedSales {
  let shown = 0;
  let pairedNow = 0;
  let pairedThen = 0;
  let any = false;
  let kept = 0;
  for (let day = window.currentFrom; day < window.currentTo; day = addDays(day, window.step)) {
    const now = salesKeys(readings, platforms, day, window.grain);
    if (now.size === 0) continue;
    any = true;
    for (const value of now.values()) shown += value;
    const prior = salesKeys(readings, platforms, addDays(day, -window.length), window.grain);
    const shared = [...now.keys()].filter((key) => prior.has(key));
    if (shared.length === 0) continue;
    kept += 1;
    for (const key of shared) {
      pairedNow += now.get(key) ?? 0;
      pairedThen += prior.get(key) ?? 0;
    }
  }
  if (!any) return { current: null, change: null, kept };
  return {
    current: kept > 0 ? pairedNow : shown,
    change: kept > 0 && pairedThen !== 0 ? pctChange(pairedNow, pairedThen) : null,
    kept,
  };
}

function salesKeys(
  readings: readonly DashReading[],
  platforms: readonly OpsPlatform[],
  from: string,
  grain: "day" | "week",
): Map<OpsPlatform, number> {
  const keys = new Map<OpsPlatform, number>();
  for (const platform of platforms) {
    const row = readings.find(
      (reading) =>
        reading.grain === grain &&
        reading.platform === platform &&
        reading.key === SALES_KEY[platform] &&
        reading.from === from &&
        reading.state === "ok" &&
        reading.value != null,
    );
    if (row?.value != null) keys.set(platform, row.value);
  }
  return keys;
}

/** `in 12 weeks`, `last 4 weeks vs the 4 before`, or `last 7 days vs the same 7 days before`. */
export function periodPhrase(unit: "day" | "week", count: number): string {
  if (unit === "week" && count >= 12) return "in 12 weeks";
  if (unit === "week") {
    const noun = count === 1 ? "week" : "weeks";
    return `last ${count} ${noun} vs the ${count} before`;
  }
  const noun = count === 1 ? "day" : "days";
  return `last ${count} ${noun} vs the same ${count} ${noun} before`;
}

function weekBuckets(days: readonly string[]): string[] {
  return [...new Set(days.map((date) => weekMonday(date)))].sort();
}

function salesPanel(
  readings: readonly DashReading[],
  platform: OpsPlatform,
  starts: string[],
  grain: "day" | "week",
): SalesPanel {
  const key = SALES_KEY[platform];
  return {
    platform,
    points: starts.map((week) => {
      const row = readings.find(
        (reading) =>
          reading.grain === grain &&
          reading.platform === platform &&
          reading.key === key &&
          reading.from === week,
      );
      return {
        week,
        sales: row && row.state === "ok" ? row.value : null,
        pending: row?.state === "pending",
        missing: row?.state === "missing",
      };
    }),
  };
}

const FESTIVAL_NAMES: Record<string, string> = {
  "2026-09-14": "Ganesh Chaturthi",
  "2026-10-11": "Navratri",
  "2026-10-12": "Navratri",
  "2026-10-13": "Navratri",
  "2026-10-14": "Navratri",
  "2026-10-15": "Navratri",
  "2026-10-16": "Navratri",
  "2026-10-17": "Navratri",
  "2026-10-18": "Navratri",
  "2026-10-19": "Navratri",
  "2026-10-20": "Dussehra",
  "2026-11-08": "Diwali",
};

function festivalLabel(dates: readonly string[]): string {
  const names: string[] = [];
  for (const date of dates) {
    const name = FESTIVAL_NAMES[date] ?? formatCivilDay(date);
    if (!names.includes(name)) names.push(name);
  }
  return names.join(" · ");
}

function pinsFor(input: OwnerDashboardInput, weeks: string[], platforms: OpsPlatform[]): DashPin[] {
  const pins: Array<Omit<DashPin, "n">> = [];
  for (const week of weeks) {
    const through = addDays(week, 7);
    const holidays = input.holidays.filter((date) => date >= week && date < through);
    if (holidays.length > 0) {
      pins.push({ week, kind: "festival", label: festivalLabel(holidays) });
    }
    if (discountEnded(input.readings, week, platforms)) {
      pins.push({ week, kind: "discount", label: "Discount ended" });
    }
    if (wentOffline(input.readings, week, platforms)) {
      pins.push({ week, kind: "offline", label: "Offline" });
    }
  }
  return pins.map((pin, index) => ({ ...pin, n: index + 1 }));
}

function discountEnded(
  readings: readonly DashReading[],
  week: string,
  platforms: OpsPlatform[],
): boolean {
  const previous = addDays(week, -7);
  const now = sumKey(readings, "week", "discount_paise", week, platforms);
  const before = sumKey(readings, "week", "discount_paise", previous, platforms);
  return before.ok && before.total > 0 && now.ok && now.total === 0;
}

function wentOffline(
  readings: readonly DashReading[],
  week: string,
  platforms: OpsPlatform[],
): boolean {
  return platforms.some((platform) => {
    const row = readings.find(
      (reading) =>
        reading.grain === "week" &&
        reading.platform === platform &&
        reading.key === "online_pct" &&
        reading.from === week &&
        reading.state === "ok",
    );
    return row?.value != null && row.value < 50;
  });
}

function answerFor(
  panels: SalesPanel[],
  input: OwnerDashboardInput,
  platforms: OpsPlatform[],
  grain: "day" | "week",
): OwnerDashboardModel["answer"] {
  const finished = panels.map((panel) => ({
    ...panel,
    points: panel.points.filter((point) =>
      grain === "day"
        ? point.week < input.today && !point.pending
        : addDays(point.week, 7) <= input.today,
    ),
  }));
  const totals = finished[0]?.points.map((point, index) => {
    const values = finished.map((panel) => panel.points[index]);
    if (values.some((item) => item?.pending))
      return { week: point.week, sales: null as number | null };
    const present = values.filter((item) => item?.sales != null);
    if (present.length === 0) return { week: point.week, sales: null };
    return { week: point.week, sales: present.reduce((sum, item) => sum + (item?.sales ?? 0), 0) };
  });
  const usable = (totals ?? []).filter((point) => point.sales != null);
  const first = usable[0];
  const last = usable[usable.length - 1];
  const pct =
    first?.sales != null && last?.sales != null ? pctChange(last.sales, first.sales) : null;
  const direction = pct == null ? "none" : Math.abs(pct) < 3 ? "flat" : pct > 0 ? "up" : "down";
  const flat = platforms
    .map((platform) => ({
      platform,
      weeks: flatTail(finished.find((panel) => panel.platform === platform)),
    }))
    .filter((item) => item.weeks >= 3)
    .sort((left, right) => right.weeks - left.weeks)[0];
  const dipped = lastDip(finished, input.readings, grain);
  const lastWeek = panels[0]?.points.at(-1)?.week;
  const festival =
    lastWeek != null &&
    input.holidays.some((date) => date >= addDays(lastWeek, -7) && date < addDays(lastWeek, 7));
  return {
    direction,
    pct,
    weeks: usable.length,
    flatPlatform: flat && flat.weeks >= 3 ? flat.platform : null,
    flatWeeks: flat?.weeks ?? 0,
    dipped,
    festival,
    pendingPlatform: laggingPlatform(input.readings, platforms),
    unit: grain === "day" ? "day" : "week",
  };
}

function flatTail(panel: SalesPanel | undefined): number {
  const values = (panel?.points ?? [])
    .map((point) => point.sales)
    .filter((value): value is number => value != null);
  if (values.length < 3) return 0;
  let count = 1;
  for (let index = values.length - 1; index > 0; index -= 1) {
    const current = values[index] ?? 0;
    const previous = values[index - 1] ?? 0;
    const change = pctChange(current, previous);
    if (change == null || Math.abs(change) > 3) break;
    count += 1;
  }
  return count;
}

function lastDip(
  panels: SalesPanel[],
  readings: readonly DashReading[],
  grain: "day" | "week",
): OwnerDashboardModel["answer"]["dipped"] {
  if (grain === "day" && panels.length > 1) {
    const combined = combinedDayDip(panels, readings);
    if (combined !== undefined) return combined;
  }
  let worst: OwnerDashboardModel["answer"]["dipped"] = null;
  for (const panel of panels) {
    const points = panel.points.filter((point) => point.sales != null);
    const current = points.at(-1);
    if (current?.sales == null) continue;
    const sameDay = grain === "day" ? addDays(current.week, -7) : null;
    const same = sameDay
      ? readings.find(
          (reading) =>
            reading.grain === "day" &&
            reading.platform === panel.platform &&
            reading.key === SALES_KEY[panel.platform] &&
            reading.from === sameDay &&
            reading.state === "ok" &&
            reading.value != null,
        )
      : undefined;
    const previous = points.at(-2);
    const baseline = same?.value ?? previous?.sales ?? null;
    if (baseline == null) continue;
    const change = pctChange(current.sales, baseline);
    if (change == null || change >= -3) continue;
    const against =
      same?.value != null
        ? `last ${formatWeekdayName(current.week)}`
        : grain === "day"
          ? "the day before"
          : "the week before";
    if (!worst || change < worst.pct) worst = { platform: panel.platform, pct: change, against };
  }
  return worst;
}

/** Both apps on the same last day: one combined change. `undefined` when an app is missing. */
function combinedDayDip(
  panels: SalesPanel[],
  readings: readonly DashReading[],
): OwnerDashboardModel["answer"]["dipped"] | undefined {
  const latest = panels.map((panel) => panel.points.filter((point) => point.sales != null).at(-1));
  const day = latest[0]?.week;
  if (!day || latest.some((point) => point?.week !== day || point.sales == null)) return undefined;
  const current = latest.reduce((sum, point) => sum + (point?.sales ?? 0), 0);
  const sameDay = addDays(day, -7);
  let baseline = 0;
  for (const panel of panels) {
    const same = readings.find(
      (reading) =>
        reading.grain === "day" &&
        reading.platform === panel.platform &&
        reading.key === SALES_KEY[panel.platform] &&
        reading.from === sameDay &&
        reading.state === "ok" &&
        reading.value != null,
    );
    if (same?.value == null) return undefined;
    baseline += same.value;
  }
  const change = pctChange(current, baseline);
  if (change == null || change >= -3) return null;
  return {
    platform: panels[0]?.platform ?? "zomato",
    pct: change,
    against: `last ${formatWeekdayName(day)}`,
  };
}

function tileFor(
  tile: TileDef,
  input: OwnerDashboardInput,
  platforms: OpsPlatform[],
  weeks: string[],
  young: boolean,
  festival: boolean,
  window: ComparedWindow,
): DashTile {
  if (tile.id === "rating" && !platforms.includes("zomato")) {
    return emptyTile(tile, "not_in_report");
  }
  const spark = weeks.map((week) => weekValue(tile, input.readings, week, platforms));
  const days = salesDays(input.readings, platforms, window);
  const measured =
    window.unit === "week" && window.count >= 12
      ? measureBlock(tile, input.readings, platforms, window)
      : measureTile(tile, input, platforms, window, days);
  const splits = platforms.map((platform) => {
    const part =
      window.unit === "week" && window.count >= 12
        ? measureBlock(tile, input.readings, [platform], window)
        : measureTile(tile, input, [platform], window, days);
    const gap: DashSplit["gap"] =
      part.state === "na" ? "no_spend" : part.state === "value" ? null : "missing";
    return {
      platform,
      value: part.current,
      inReport: part.state === "value",
      gap,
    };
  });
  if (measured.state !== "value") return { ...emptyTile(tile, measured.state), spark, splits };
  const change = young ? null : measured.change;
  const trend = wordFromChange(tile, change, window.unit === "week" ? measured.pairs : 0);
  return {
    id: tile.id,
    value: measured.current,
    format: tile.format,
    changePct: change,
    spark: spark,
    word: trend.word,
    weeks: trend.weeks,
    good: trend.good,
    state: "value",
    festival,
    splits,
    basis: basisPhrase(window, measured.pairs),
    span: spanLabel(window, measured.pairs),
  };
}

interface SalesDay {
  day: string;
  platforms: OpsPlatform[];
}

/** Value, percent, and per-app split for one tile, all from the same paired periods. */
function measureTile(
  tile: TileDef,
  input: OwnerDashboardInput,
  platforms: OpsPlatform[],
  window: ComparedWindow,
  days: readonly SalesDay[],
): { state: DashTile["state"]; current: number | null; change: number | null; pairs: number } {
  const usable = days.length > 0 ? days : periodStarts(window).map((day) => ({ day, platforms }));
  let shown = 0;
  let shownCount = 0;
  let now = 0;
  let then = 0;
  let pairs = 0;
  let pending = false;
  let updating = false;
  let missing = false;
  for (const entry of usable) {
    const use = entry.platforms.filter((platform) => platforms.includes(platform));
    if (use.length === 0) continue;
    const current = onePeriod(tile, input.readings, window, entry.day, use);
    if (current.kind === "pending") pending = true;
    if (current.kind === "updating") updating = true;
    if (current.kind === "missing") missing = true;
    if (current.kind !== "value" || current.total == null) continue;
    shown += current.total;
    shownCount += 1;
    const prior = onePeriod(tile, input.readings, window, addDays(entry.day, -window.length), use);
    if (prior.kind !== "value" || prior.total == null) continue;
    now += current.total;
    then += prior.total;
    pairs += 1;
  }
  if (tile.id === "ads") return measureAds(input.readings, window, usable, platforms);
  if (shownCount === 0) {
    const state = updating ? "updating" : pending ? "pending" : missing ? "not_in_report" : "empty";
    return { state, current: null, change: null, pairs: 0 };
  }
  const average =
    tile.id === "aov" || tile.id === "online" || tile.id === "prep" || tile.id === "rating";
  const current = pairs > 0 ? (average ? now / pairs : now) : average ? shown / shownCount : shown;
  const previous = pairs > 0 ? (average ? then / pairs : then) : null;
  const change =
    tile.id === "rating"
      ? previous != null
        ? current - previous
        : null
      : previous != null && previous !== 0
        ? pctChange(current, previous)
        : null;
  return { state: "value", current, change, pairs };
}

/** 12-week value is the whole window. The percent is the last 4 weeks against the first 4. */
function measureBlock(
  tile: TileDef,
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  window: ComparedWindow,
): { state: DashTile["state"]; current: number | null; change: number | null; pairs: number } {
  if (tile.id === "ads") {
    const weeks = periodStarts(window).map((day) => ({ day, platforms }));
    const current = adsOverDays(readings, window, weeks, platforms);
    const first = adsOverDays(readings, window, weeks.slice(0, 4), platforms);
    const last = adsOverDays(readings, window, weeks.slice(-4), platforms);
    if (current.kind === "no_ads")
      return { state: "no_ads", current: null, change: null, pairs: 0 };
    if (current.kind === "na") return { state: "na", current: null, change: null, pairs: 0 };
    if (current.kind !== "value" || current.total == null) {
      return { state: "empty", current: null, change: null, pairs: 0 };
    }
    const change =
      first.kind === "value" &&
      last.kind === "value" &&
      first.total != null &&
      last.total != null &&
      first.total !== 0
        ? pctChange(last.total, first.total)
        : null;
    return { state: "value", current: current.total, change, pairs: window.count };
  }
  const values = periodStarts(window).map((week) =>
    onePeriod(tile, readings, window, week, platforms),
  );
  const numbers = values.flatMap((item) =>
    item.kind === "value" && item.total != null ? [item.total] : [],
  );
  if (numbers.length === 0) {
    const pending = values.some((item) => item.kind === "pending" || item.kind === "updating");
    return { state: pending ? "pending" : "empty", current: null, change: null, pairs: 0 };
  }
  const average =
    tile.id === "aov" || tile.id === "online" || tile.id === "prep" || tile.id === "rating";
  const fold = (slice: typeof values): number | null => {
    const present = slice.flatMap((item) =>
      item.kind === "value" && item.total != null ? [item.total] : [],
    );
    if (present.length === 0) return null;
    const total = present.reduce((sum, value) => sum + value, 0);
    return average ? total / present.length : total;
  };
  const current = fold(values);
  const first = fold(values.slice(0, 4));
  const last = fold(values.slice(-4));
  const change =
    tile.id === "rating"
      ? first != null && last != null
        ? last - first
        : null
      : first != null && last != null && first !== 0
        ? pctChange(last, first)
        : null;
  return { state: "value", current, change, pairs: window.count };
}

function measureAds(
  readings: readonly DashReading[],
  window: ComparedWindow,
  days: readonly SalesDay[],
  platforms: OpsPlatform[],
): { state: DashTile["state"]; current: number | null; change: number | null; pairs: number } {
  const paired = days.filter((entry) => {
    const use = entry.platforms.filter((platform) => platforms.includes(platform));
    if (use.length === 0) return false;
    const prior = addDays(entry.day, -window.length);
    return (
      adsOn(readings, window, entry.day, use).kind === "value" &&
      adsOn(readings, window, prior, use).kind === "value"
    );
  });
  const used = paired.length > 0 ? paired : days;
  const current = adsOverDays(readings, window, used, platforms);
  const previous = adsOverDays(
    readings,
    window,
    used.map((entry) => ({ ...entry, day: addDays(entry.day, -window.length) })),
    platforms,
  );
  if (current.kind === "no_ads") return { state: "no_ads", current: null, change: null, pairs: 0 };
  if (current.kind === "na") return { state: "na", current: null, change: null, pairs: 0 };
  if (current.kind !== "value" || current.total == null) {
    return {
      state: current.kind === "pending" ? "pending" : "empty",
      current: null,
      change: null,
      pairs: 0,
    };
  }
  return {
    state: "value",
    current: current.total,
    change:
      paired.length > 0 &&
      previous.kind === "value" &&
      previous.total != null &&
      previous.total !== 0
        ? pctChange(current.total, previous.total)
        : null,
    pairs: paired.length,
  };
}

function adsOn(
  readings: readonly DashReading[],
  window: ComparedWindow,
  day: string,
  platforms: OpsPlatform[],
): WindowTotal {
  return adsRatio(readings, window.grain, day, addDays(day, window.step), platforms);
}

function adsOverDays(
  readings: readonly DashReading[],
  window: ComparedWindow,
  days: readonly SalesDay[],
  platforms: OpsPlatform[],
): WindowTotal {
  if (days.length === 0) return { kind: "empty", total: null };
  let sales = 0;
  let spend = 0;
  let any = false;
  let pending = false;
  let unspent = false;
  let explicitZero = false;
  for (const entry of days) {
    const use = entry.platforms.filter((platform) => platforms.includes(platform));
    for (const platform of use) {
      const salesKey = platform === "zomato" ? "ads_sales_paise" : "cpc_sales_paise";
      const spendKey = platform === "zomato" ? "ad_spend_paise" : "cpc_spend_paise";
      const to = addDays(entry.day, window.step);
      const sold = reduceRows(
        rowsIn(readings, window.grain, salesKey, entry.day, to, [platform]),
        false,
      );
      const spent = reduceRows(
        rowsIn(readings, window.grain, spendKey, entry.day, to, [platform]),
        false,
      );
      if (sold.kind === "pending" || spent.kind === "pending") {
        pending = true;
        continue;
      }
      if (sold.total == null && spent.total == null) continue;
      if ((spent.total ?? 0) <= 0) {
        if ((sold.total ?? 0) > 0) unspent = true;
        else if (sold.kind === "value" && spent.kind === "value") explicitZero = true;
        continue;
      }
      any = true;
      sales += sold.total ?? 0;
      spend += spent.total ?? 0;
    }
  }
  if (!any) {
    if (unspent) return { kind: "na", total: null };
    if (explicitZero) return { kind: "no_ads", total: null };
    return pending ? { kind: "pending", total: null } : { kind: "empty", total: null };
  }
  if (spend === 0 && sales === 0) return { kind: "no_ads", total: null };
  if (spend === 0) return { kind: "na", total: null };
  return { kind: "value", total: sales / spend };
}

function onePeriod(
  tile: TileDef,
  readings: readonly DashReading[],
  window: ComparedWindow,
  day: string,
  platforms: OpsPlatform[],
): WindowTotal {
  const total = windowKeys(tile, readings, window.grain, day, addDays(day, window.step), platforms);
  if (total.kind === "missing") return { kind: "missing", total: null };
  return total;
}

/** Apps that have sales on this day and on the same day in the previous window. */
function salesDays(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  window: ComparedWindow,
): SalesDay[] {
  const days: SalesDay[] = [];
  for (let day = window.currentFrom; day < window.currentTo; day = addDays(day, window.step)) {
    const now = salesKeys(readings, platforms, day, window.grain);
    if (now.size === 0) continue;
    const prior = salesKeys(readings, platforms, addDays(day, -window.length), window.grain);
    const shared = [...now.keys()].filter((key) => prior.has(key));
    if (shared.length === 0) continue;
    days.push({ day, platforms: shared });
  }
  return days;
}

function periodStarts(window: ComparedWindow): string[] {
  const dates: string[] = [];
  for (let day = window.currentFrom; day < window.currentTo; day = addDays(day, window.step)) {
    dates.push(day);
  }
  return dates;
}

function spanLabel(window: ComparedWindow, _pairs: number): string {
  const count = window.count;
  const noun =
    window.unit === "week" ? (count === 1 ? "week" : "weeks") : count === 1 ? "day" : "days";
  return count === 1 ? `1 ${noun}` : `${count} ${noun}`;
}

function basisPhrase(window: ComparedWindow, _pairs: number): string {
  return periodPhrase(window.unit, window.count);
}

function wordFromChange(
  tile: TileDef,
  change: number | null,
  weeks: number,
): { word: TileWord | null; weeks: number; good: boolean | null } {
  const flatAt = tile.format === "rating" ? 0.1 : 3;
  if (change == null || Math.abs(change) < flatAt) {
    return {
      word: change == null ? null : "steady",
      weeks: change == null ? 0 : weeks,
      good: null,
    };
  }
  const up = change > 0;
  const good = tile.goodUp ? up : !up;
  const word: TileWord =
    tile.format === "rating"
      ? up
        ? "improving"
        : "falling"
      : tile.word === "prep"
        ? up
          ? "slower"
          : "faster"
        : tile.word === "rejects"
          ? up
            ? "rising"
            : "falling"
          : tile.word === "ads"
            ? up
              ? "improving"
              : "falling"
            : up
              ? "growing"
              : "falling";
  return { word, weeks, good };
}

function emptyTile(tile: TileDef, state: DashTile["state"]): DashTile {
  return {
    id: tile.id,
    value: null,
    format: tile.format,
    changePct: null,
    spark: [],
    word: null,
    weeks: 0,
    good: null,
    state,
    festival: false,
    splits: [],
    basis: "",
    span: "",
  };
}

interface WindowTotal {
  kind: "value" | "pending" | "missing" | "updating" | "na" | "empty" | "no_ads";
  total: number | null;
}

function weekValue(
  tile: TileDef,
  readings: readonly DashReading[],
  week: string,
  platforms: OpsPlatform[],
): number | null {
  const total = windowKeys(tile, readings, "week", week, addDays(week, 7), platforms);
  return total.kind === "value" ? total.total : null;
}

function lastCompleteDay(readings: readonly DashReading[], platform: OpsPlatform): string | null {
  const dates = readings
    .filter(
      (reading) =>
        reading.grain === "day" &&
        reading.platform === platform &&
        reading.key === SALES_KEY[platform] &&
        reading.state === "ok" &&
        reading.value != null,
    )
    .map((reading) => reading.from);
  dates.sort();
  return dates.at(-1) ?? null;
}

/** The app whose last complete sales day is behind the other. A tie names nobody. */
function laggingPlatform(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
): OpsPlatform | null {
  const ranked = platforms.map((platform) => ({
    platform,
    date: lastCompleteDay(readings, platform),
  }));
  const newest = ranked.reduce<string | null>(
    (max, item) => (item.date != null && (max == null || item.date > max) ? item.date : max),
    null,
  );
  if (platforms.length === 1) {
    const only = platforms[0];
    if (!only) return null;
    const last = ranked[0]?.date;
    const pendingLater = readings.some(
      (reading) =>
        reading.grain === "day" &&
        reading.platform === only &&
        reading.key === SALES_KEY[only] &&
        (reading.state === "pending" || reading.state === "updating") &&
        (last == null || reading.from > last),
    );
    return pendingLater ? only : null;
  }
  if (newest == null) return null;
  const behind = ranked
    .filter((item) => (item.date ?? "") < newest)
    .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? ""));
  return behind[0]?.platform ?? null;
}

function windowKeys(
  tile: TileDef,
  readings: readonly DashReading[],
  grain: "day" | "week",
  from: string,
  to: string,
  platforms: OpsPlatform[],
): WindowTotal {
  if (tile.id === "ads") return adsRatio(readings, grain, from, to, platforms);
  if (tile.id === "sales") return salesTotal(readings, grain, from, to, platforms);
  if (tile.id === "rejected") return rejectedTotal(readings, grain, from, to, platforms);
  if (tile.id === "rating" && !platforms.includes("zomato"))
    return { kind: "missing", total: null };
  const key =
    tile.id === "orders"
      ? "delivered_orders"
      : tile.id === "aov"
        ? "aov_paise"
        : tile.id === "online"
          ? "online_pct"
          : tile.id === "prep"
            ? "kpt_minutes"
            : "rating";
  const rows = rowsIn(
    readings,
    grain,
    key,
    from,
    to,
    tile.id === "rating" ? ["zomato"] : platforms,
  );
  return reduceRows(
    rows,
    tile.id === "aov" || tile.id === "online" || tile.id === "prep" || tile.id === "rating",
  );
}

function salesTotal(
  readings: readonly DashReading[],
  grain: "day" | "week",
  from: string,
  to: string,
  platforms: OpsPlatform[],
): WindowTotal {
  const parts = platforms.map((platform) =>
    reduceRows(rowsIn(readings, grain, SALES_KEY[platform], from, to, [platform]), false),
  );
  const values = parts.filter((part) => part.kind === "value" && part.total != null);
  if (values.length > 0) {
    return { kind: "value", total: values.reduce((sum, part) => sum + (part.total ?? 0), 0) };
  }
  if (parts.some((part) => part.kind === "updating")) return { kind: "updating", total: null };
  if (parts.some((part) => part.kind === "pending")) return { kind: "pending", total: null };
  return parts[0] ?? { kind: "empty", total: null };
}

function rejectedTotal(
  readings: readonly DashReading[],
  grain: "day" | "week",
  from: string,
  to: string,
  platforms: OpsPlatform[],
): WindowTotal {
  const parts: WindowTotal[] = [];
  if (platforms.includes("zomato")) {
    parts.push(reduceRows(rowsIn(readings, grain, "rejected_orders", from, to, ["zomato"]), false));
  }
  if (platforms.includes("swiggy")) {
    parts.push(
      reduceRows(
        rowsIn(readings, grain, "restaurant_cancelled_orders", from, to, ["swiggy"]),
        false,
      ),
    );
  }
  const values = parts.filter((part) => part.kind === "value" && part.total != null);
  if (values.length > 0) {
    return { kind: "value", total: values.reduce((sum, part) => sum + (part.total ?? 0), 0) };
  }
  if (parts.some((part) => part.kind === "pending")) return { kind: "pending", total: null };
  if (parts.some((part) => part.kind === "missing")) return { kind: "missing", total: null };
  return { kind: "empty", total: null };
}

function adsRatio(
  readings: readonly DashReading[],
  grain: "day" | "week",
  from: string,
  to: string,
  platforms: OpsPlatform[],
  only?: ReadonlySet<string>,
): WindowTotal {
  let sales = 0;
  let spend = 0;
  let any = false;
  let pending = false;
  for (const platform of platforms) {
    const salesKey = platform === "zomato" ? "ads_sales_paise" : "cpc_sales_paise";
    const spendKey = platform === "zomato" ? "ad_spend_paise" : "cpc_spend_paise";
    const sold = reduceRows(rowsIn(readings, grain, salesKey, from, to, [platform], only), false);
    const spent = reduceRows(rowsIn(readings, grain, spendKey, from, to, [platform], only), false);
    if (sold.kind === "pending" || spent.kind === "pending") {
      pending = true;
      continue;
    }
    if (sold.total == null && spent.total == null) continue;
    any = true;
    sales += sold.total ?? 0;
    spend += spent.total ?? 0;
  }
  if (!any) return pending ? { kind: "pending", total: null } : { kind: "empty", total: null };
  if (spend === 0 && sales === 0) return { kind: "no_ads", total: null };
  if (spend === 0) return { kind: "na", total: null };
  return { kind: "value", total: sales / spend };
}

function rowsIn(
  readings: readonly DashReading[],
  grain: "day" | "week",
  key: string,
  from: string,
  to: string,
  platforms: OpsPlatform[],
  only?: ReadonlySet<string>,
): DashReading[] {
  return readings.filter(
    (reading) =>
      reading.grain === grain &&
      reading.key === key &&
      platforms.includes(reading.platform) &&
      reading.from >= from &&
      reading.from < to &&
      (only == null || only.has(reading.from)),
  );
}

function reduceRows(rows: DashReading[], average: boolean): WindowTotal {
  if (rows.length === 0) return { kind: "empty", total: null };
  const ok = rows.filter((row) => row.state === "ok" && row.value != null);
  if (ok.length === 0) {
    if (rows.some((row) => row.state === "updating")) return { kind: "updating", total: null };
    if (rows.some((row) => row.state === "pending")) return { kind: "pending", total: null };
    return { kind: rows.some((row) => row.state === "missing") ? "missing" : "empty", total: null };
  }
  const total = ok.reduce((sum, row) => sum + (row.value ?? 0), 0);
  if (average && ok.length > 0 && rows.some((row) => row.value === 0 && row.key === "aov_paise")) {
    return { kind: "na", total: null };
  }
  return { kind: "value", total: average ? total / ok.length : total };
}

function heatmapFor(readings: readonly DashReading[], weeks: string[], platforms: OpsPlatform[]) {
  const cells: OwnerDashboardModel["heatmap"] = [];
  for (const week of weeks) {
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(week, offset);
      const rows = rowsIn(readings, "day", "delivered_orders", date, addDays(date, 1), platforms);
      const pending = rows.some((row) => row.state === "pending");
      const orders = pending
        ? null
        : rows.filter((row) => row.state === "ok").reduce((sum, row) => sum + (row.value ?? 0), 0);
      cells.push({
        week,
        weekday: WEEKDAYS[offset] ?? "Mon",
        orders: rows.length === 0 ? null : orders,
        pending,
      });
    }
  }
  return cells;
}

function funnelFor(
  readings: readonly DashReading[],
  starts: string[],
  grain: "day" | "week",
  platforms: OpsPlatform[],
) {
  const steps = ["menu", "cart", "order"] as const;
  const span = grain === "day" ? 1 : 7;
  const series: OwnerDashboardModel["funnel"] = [];
  for (const step of steps) {
    for (const platform of platforms) {
      series.push({
        step,
        platform,
        points: starts.map((week) => ({
          week,
          pct: funnelPct(readings, step, platform, week, addDays(week, span)),
        })),
      });
    }
  }
  return series;
}

/** Days where orders exceed carts, or carts are zero. Those days are not a rate. */
export function incomparableFunnelDays(readings: readonly DashReading[]): string[] {
  const dates = new Set<string>();
  for (const reading of readings) {
    if (reading.grain !== "day" || reading.key !== "cart_builds" || reading.state !== "ok")
      continue;
    const ordersKey = reading.platform === "swiggy" ? "swiggy_funnel_orders" : "placed_orders";
    const orders = readings.find(
      (row) =>
        row.grain === "day" &&
        row.platform === reading.platform &&
        row.key === ordersKey &&
        row.from === reading.from &&
        row.state === "ok",
    );
    const carts = reading.value;
    const placed = orders?.value ?? null;
    if (carts == null || carts === 0 || (placed != null && placed > carts)) dates.add(reading.from);
  }
  return [...dates].sort();
}

function funnelPct(
  readings: readonly DashReading[],
  step: "menu" | "cart" | "order",
  platform: OpsPlatform,
  from: string,
  to: string,
): number | null {
  const numerator =
    step === "menu"
      ? "menu_opens"
      : step === "cart"
        ? "cart_builds"
        : platform === "swiggy"
          ? "swiggy_funnel_orders"
          : "placed_orders";
  const denominator =
    step === "menu" ? "impressions" : step === "cart" ? "menu_opens" : "cart_builds";
  const dailyTop = rowsIn(readings, "day", numerator, from, to, [platform]);
  const dailyBottom = rowsIn(readings, "day", denominator, from, to, [platform]);
  if (dailyTop.length > 0 || dailyBottom.length > 0) {
    const days = new Set([...dailyTop, ...dailyBottom].map((row) => row.from));
    let top = 0;
    let bottom = 0;
    let any = false;
    for (const day of days) {
      const sold = dailyTop.find((row) => row.from === day && row.state === "ok")?.value;
      const base = dailyBottom.find((row) => row.from === day && row.state === "ok")?.value;
      if (sold == null || base == null || base === 0) continue;
      if (step === "order" && sold > base) continue;
      top += sold;
      bottom += base;
      any = true;
    }
    if (!any || bottom === 0) return null;
    return Math.min(100, Math.max(0, (top / bottom) * 100));
  }
  const top = rowsIn(readings, "week", numerator, from, to, [platform])[0];
  const bottom = rowsIn(readings, "week", denominator, from, to, [platform])[0];
  if (!top || !bottom || top.state !== "ok" || bottom.state !== "ok") return null;
  if (bottom.value == null || bottom.value === 0 || top.value == null) return null;
  if (step === "order" && top.value > bottom.value) return null;
  return Math.min(100, Math.max(0, (top.value / bottom.value) * 100));
}

function pendingDateIn(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  window: ComparedWindow,
): string | null {
  const dates = readings
    .filter(
      (reading) =>
        platforms.includes(reading.platform) &&
        reading.key === SALES_KEY[reading.platform] &&
        (reading.state === "pending" || reading.state === "updating") &&
        reading.from >= window.currentFrom &&
        reading.from < window.currentTo,
    )
    .map((reading) => reading.from);
  dates.sort();
  return dates.at(-1) ?? null;
}

function completeWeeks(today: string, count: number): string[] {
  const end = completeMonday(today, addDays(today, -1));
  const start = addDays(end, -7 * (count - 1));
  const weeks: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) weeks.push(cursor);
  return weeks;
}

function missingNote(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  starts: readonly string[],
  grain: "day" | "week",
): string | null {
  const keys = new Set(platforms.map((platform) => SALES_KEY[platform]));
  const days = new Set(starts);
  const row = readings.find(
    (reading) =>
      reading.state === "missing" &&
      reading.grain === grain &&
      keys.has(reading.key) &&
      platforms.includes(reading.platform) &&
      days.has(reading.from),
  );
  return row ? row.from : null;
}

function earliestDay(readings: readonly DashReading[]): string | null {
  const days = readings
    .filter((reading) => reading.grain === "day" && reading.state === "ok")
    .map((reading) => reading.from);
  days.sort();
  return days[0] ?? null;
}

function sumKey(
  readings: readonly DashReading[],
  grain: "day" | "week",
  key: string,
  from: string,
  platforms: OpsPlatform[],
): { ok: boolean; total: number } {
  const rows = rowsIn(
    readings,
    grain,
    key,
    from,
    addDays(from, grain === "week" ? 7 : 1),
    platforms,
  );
  if (rows.length === 0 || rows.some((row) => row.state !== "ok")) return { ok: false, total: 0 };
  return { ok: true, total: rows.reduce((sum, row) => sum + (row.value ?? 0), 0) };
}

function windowHasHoliday(input: OwnerDashboardInput): boolean {
  const length =
    input.range === "custom" ? daysBetween(input.from, input.to) : ownerRangeDays(input.range);
  const start = addDays(input.to, -2 * length);
  return input.holidays.some((date) => date >= start && date < input.to);
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export interface OwnerPlotMark {
  type: "lineY" | "areaY" | "linearRegressionY" | "ruleX" | "text" | "cell" | "rect" | "rectY";
  data?: unknown[];
  options?: Record<string, unknown>;
}

export interface OwnerPlot {
  id: string;
  marks: OwnerPlotMark[];
  x?: Record<string, unknown>;
  y?: Record<string, unknown>;
  color?: Record<string, unknown>;
  marginLeft?: number;
  marginRight?: number;
  width: number;
  height: number;
}

const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function withDate<T extends { week: string }>(rows: readonly T[]) {
  return rows.map((row) => ({ ...row, at: utcDate(row.week) }));
}

/** Dates only. The domain stops at the end of the last day, and no tick falls after it. */
export function ownerDateAxis(dates: readonly string[]): Record<string, unknown> {
  const known = dates.filter((date) => date.length > 0);
  const first = known[0];
  const last = known[known.length - 1];
  return {
    label: null,
    type: "utc",
    format: "date",
    domain: first && last ? [first, addDays(last, 1)] : undefined,
    ticks: tickDates(known),
    clamp: true,
    padding: 0,
  };
}

function tickDates(dates: readonly string[]): string[] {
  if (dates.length === 0) return [];
  if (dates.length <= 6) return [...dates];
  const last = dates.length - 1;
  const picks = [0, Math.round(last / 3), Math.round((2 * last) / 3), last];
  return [...new Set(picks)].map((index) => dates[index] ?? dates[0] ?? "");
}

/** Paise on the axis, drawn as rupees. The domain stays on the series, not on a zero baseline. */
export function ownerRupeeAxis(values: readonly number[] = []): Record<string, unknown> {
  const known = values.filter((value) => Number.isFinite(value));
  const min = known.length > 0 ? Math.min(...known) : null;
  const max = known.length > 0 ? Math.max(...known) : null;
  const pad = min != null && max != null ? Math.max((max - min) * 0.2, max * 0.05, 1) : null;
  return {
    label: null,
    grid: true,
    ...(min != null && max != null && pad != null ? { domain: [min - pad, max + pad] } : {}),
    format: "inr",
  };
}

/** Turn stored format keys into the functions a chart needs. The stored spec stays plain JSON. */
export function resolveOwnerPlot<
  T extends {
    x?: Record<string, unknown>;
    y?: Record<string, unknown>;
    marks: ReadonlyArray<{ data?: unknown[] }>;
  },
>(plot: T): T {
  return {
    ...plot,
    x: resolveAxis(plot.x),
    y: resolveAxis(plot.y),
    marks: plot.marks.map((mark) => ({
      ...mark,
      data: mark.data?.map((row) => {
        if (!row || typeof row !== "object") return row;
        const next = { ...(row as Record<string, unknown>) };
        for (const key of ["at", "x1", "x2"]) {
          const value = next[key];
          if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
            next[key] = utcDate(value.slice(0, 10));
          }
        }
        return next;
      }),
    })),
  };
}

function resolveAxis(
  axis: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!axis) return axis;
  const format = axis.format;
  const next: Record<string, unknown> = { ...axis };
  delete next.format;
  if (format === "date") {
    next.tickFormat = (value: Date) => formatAxisDay(value);
    if (Array.isArray(next.domain))
      next.domain = next.domain.map((value) => utcDate(String(value).slice(0, 10)));
    if (Array.isArray(next.ticks))
      next.ticks = next.ticks.map((value) => utcDate(String(value).slice(0, 10)));
  }
  if (format === "inr") next.tickFormat = (value: number) => formatCompactRupees(Number(value));
  if (format === "pct") next.tickFormat = (value: number) => `${Math.round(Number(value))}%`;
  if (format === "civil")
    next.tickFormat = (value: string) => formatAxisDay(utcDate(String(value).slice(0, 10)));
  return next;
}

export function ownerUtcDate(iso: string): Date {
  return utcDate(iso);
}

const PLATFORM_STROKE: Record<OpsPlatform, string> = {
  zomato: "var(--owner-zomato)",
  swiggy: "var(--owner-swiggy)",
};

/** Chart specs for the dashboard. Colours are the owner-shell tokens, used only on series. */
export function dashboardPlots(model: OwnerDashboardModel): OwnerPlot[] {
  const dated = [
    ...new Set(model.panels.flatMap((panel) => panel.points.map((point) => point.week))),
  ].sort();
  const ticks = [
    ...new Set(
      model.panels.flatMap((panel) =>
        panel.points.filter((point) => point.sales != null).map((point) => point.week),
      ),
    ),
  ].sort();
  const axis = ownerDateAxis(ticks.length > 0 ? ticks : dated);
  const span = model.answer.unit === "week" ? 7 : 1;
  if (dated[0] && dated.at(-1)) axis.domain = [dated[0], addDays(dated.at(-1) ?? dated[0], span)];
  const plots: OwnerPlot[] = model.panels.map((panel) => salesPlotFor(model, panel, axis));
  const heatWeeks = [...new Set(model.heatmap.map((cell) => cell.week))].sort();
  const cell = 30;
  plots.push({
    id: "heatmap",
    width: 44 + Math.max(heatWeeks.length, 1) * cell,
    height: 16 + WEEKDAY_ORDER.length * cell,
    marginLeft: 44,
    x: {
      label: null,
      domain: heatWeeks,
      padding: 0.2,
      ticks: heatWeeks.filter((_, index) => index % 3 === 0),
      format: "civil",
    },
    y: { label: null, domain: [...WEEKDAY_ORDER], padding: 0 },
    color: {
      type: "sqrt",
      scheme: "purples",
      domain: heatmapDomain(model.heatmap),
    },
    marks: [
      {
        type: "cell",
        data: model.heatmap,
        options: { x: "week", y: "weekday", fill: "orders", inset: 2 },
      },
      ...(model.heatmap.some((item) => item.pending)
        ? [
            {
              type: "cell" as const,
              data: model.heatmap.filter((item) => item.pending),
              options: {
                x: "week",
                y: "weekday",
                fill: "transparent",
                stroke: "var(--border)",
                strokeDasharray: "3 2",
                inset: 2,
              },
            },
          ]
        : []),
    ],
  });
  for (const step of ["menu", "cart", "order"] as const) {
    const rows = model.funnel
      .filter((series) => series.step === step)
      .flatMap((series) => series.points.map((point) => ({ ...point, platform: series.platform })));
    const weeks = [...new Set(rows.map((row) => row.week))].sort();
    plots.push({
      id: `funnel-${step}`,
      width: 640,
      height: 80,
      marginLeft: 36,
      x: ownerDateAxis(weeks),
      y: { label: null, format: "pct" },
      marks: (["zomato", "swiggy"] as const).flatMap((platform) => {
        const data = withDate(rows.filter((row) => row.platform === platform));
        return data.length === 0
          ? []
          : [
              {
                type: "lineY" as const,
                data,
                options: {
                  x: "at",
                  y: "pct",
                  stroke: PLATFORM_STROKE[platform],
                  strokeWidth: 1.5,
                },
              },
            ];
      }),
    });
  }
  return plots;
}

function salesPlotFor(
  model: OwnerDashboardModel,
  panel: SalesPanel,
  axis: Record<string, unknown>,
): OwnerPlot {
  const values = panel.points.flatMap((point) => (point.sales == null ? [] : [point.sales]));
  const y = ownerRupeeAxis(values);
  const domain = y.domain as [number, number] | undefined;
  const y1 = domain?.[0] ?? 0;
  const y2 = domain?.[1] ?? 1;
  const step = model.answer.unit === "day" ? 1 : 7;
  const marks: OwnerPlotMark[] = [];
  if (model.shadeWeek && model.answer.unit === "week") {
    const shadeEnd = addDays(model.shadeWeek, step);
    marks.push({
      type: "rect",
      data: [{ x1: model.shadeWeek, x2: shadeEnd, y1, y2 }],
      options: { x1: "x1", x2: "x2", y1: "y1", y2: "y2", fill: "var(--muted)" },
    });
  }
  const rows = panel.points.map((point) => ({ at: point.week, y: point.sales }));
  const known = rows.filter((row) => row.y != null);
  const stroke = PLATFORM_STROKE[panel.platform];
  if (known.length > 0) {
    marks.push({
      type: "areaY",
      data: known,
      options: { x: "at", y: "y", fill: stroke, fillOpacity: 0.12 },
    });
  }
  marks.push({
    type: "lineY",
    data: rows,
    options: { x: "at", y: "y", stroke, strokeWidth: 1.5 },
  });
  if (known.length >= 2) {
    marks.push({
      type: "linearRegressionY",
      data: known,
      options: { x: "at", y: "y", stroke, strokeDasharray: "4 3", ci: 0 },
    });
  }
  const last = known.at(-1);
  const first = known[0];
  if (last?.y != null) {
    const change =
      first?.y != null && first.y !== 0 && first !== last ? pctChange(last.y, first.y) : null;
    const arrow =
      change == null
        ? ""
        : change >= 0
          ? ` ▲${formatPct1(change)}%`
          : ` ▼${formatPct1(Math.abs(change))}%`;
    const unit = model.answer.unit === "week" ? "/wk" : "";
    marks.push({
      type: "text",
      data: [{ at: last.at, y: last.y, label: `${formatCompactRupees(last.y)}${unit}${arrow}` }],
      options: { x: "at", y: "y", text: "label", dx: -8, dy: -12, textAnchor: "end" },
    });
  }
  if (model.pendingNote === panel.platform && model.answer.unit === "day" && last) {
    const end = panel.points.at(-1)?.week;
    if (end && last.at < end) {
      const label = panel.platform === "swiggy" ? "Swiggy pending" : "Zomato pending";
      marks.push({
        type: "rect",
        data: [{ x1: addDays(last.at, step), x2: addDays(end, step), y1, y2 }],
        options: { x1: "x1", x2: "x2", y1: "y1", y2: "y2", fill: "var(--muted)" },
      });
      marks.push({
        type: "text",
        data: [{ at: addDays(last.at, step), y: y2, label }],
        options: { x: "at", y: "y", text: "label", dy: 12, textAnchor: "start" },
      });
    }
  }
  const top = values.length > 0 ? Math.max(...values) : y2;
  for (const pin of model.pins) {
    marks.push(
      { type: "ruleX", data: [{ at: pin.week }], options: { x: "at", stroke: "var(--border)" } },
      {
        type: "text",
        data: [{ at: pin.week, y: top, n: String(pin.n) }],
        options: { x: "at", y: "y", text: "n", dy: -4 },
      },
    );
  }
  return {
    id: `sales-${panel.platform}`,
    width: 960,
    height: 200,
    marginLeft: 56,
    marginRight: 16,
    x: axis,
    y,
    marks,
  };
}

/** Keep the quietest day above the white end of the purple ramp. */
function heatmapDomain(cells: ReadonlyArray<{ orders: number | null }>): [number, number] {
  const max = Math.max(
    1,
    ...cells.flatMap((cell) => (cell.orders != null && cell.orders > 0 ? [cell.orders] : [])),
  );
  return [max / 8, max];
}

export function heatmapHeadline(
  cells: ReadonlyArray<{ weekday: string; orders: number | null }>,
): string | null {
  const totals = new Map<string, number>();
  for (const cell of cells) {
    if (cell.orders == null) continue;
    totals.set(cell.weekday, (totals.get(cell.weekday) ?? 0) + cell.orders);
  }
  const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1]);
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first[1] <= 0) return null;
  const name = WEEKDAY_NAMES[first[0]] ?? first[0];
  if (second && second[1] > 0 && second[1] >= first[1] * 0.9) {
    const pair = [first[0], second[0]].sort(
      (left, right) =>
        WEEKDAY_ORDER.indexOf(left as (typeof WEEKDAY_ORDER)[number]) -
        WEEKDAY_ORDER.indexOf(right as (typeof WEEKDAY_ORDER)[number]),
    );
    return `${pair[0]} and ${pair[1]} are your best days`;
  }
  return `${name} is your best day`;
}

const WEEKDAY_NAMES: Record<string, string> = {
  Mon: "Mon",
  Tue: "Tue",
  Wed: "Wed",
  Thu: "Thu",
  Fri: "Fri",
  Sat: "Sat",
  Sun: "Sun",
};

export function funnelHeadline(
  series: ReadonlyArray<{
    step: "menu" | "cart" | "order";
    platform: OpsPlatform;
    points: ReadonlyArray<{ pct: number | null }>;
  }>,
): string | null {
  let best: { platform: OpsPlatform; weeks: number } | null = null;
  for (const row of series) {
    if (row.step !== "menu") continue;
    const values = row.points.flatMap((point) => (point.pct == null ? [] : [point.pct]));
    let weeks = 1;
    for (let index = values.length - 1; index > 0; index -= 1) {
      if ((values[index] ?? 0) >= (values[index - 1] ?? 0)) break;
      weeks += 1;
    }
    if (weeks < 3) continue;
    if (!best || weeks > best.weeks) best = { platform: row.platform, weeks };
  }
  if (!best) return null;
  const name = best.platform === "swiggy" ? "Swiggy" : "Zomato";
  return `${name}: fewer people who see you open your menu, down ${best.weeks} weeks in a row`;
}

/** A stored null, or a number with no covered days, is not a zero and not 100%. */
export function dashReadingState(input: {
  status: "ok" | "not_available" | "updating";
  value: number | null;
  coverageDays: number;
  provisional: boolean;
}): DashState {
  if (input.status === "updating") return "updating";
  const absent = input.value == null || input.coverageDays === 0;
  if (input.status === "not_available") return absent ? "pending" : "missing";
  if (absent) return "missing";
  if (input.provisional && input.value == null) return "pending";
  return "ok";
}
