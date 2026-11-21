import {
  addDays,
  formatAxisDay,
  formatCompactRupees,
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
    dipped: { platform: OpsPlatform; pct: number } | null;
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
  const chart = chartSeries(bounded);
  const trendWeeks = weekStarts(bounded.today, 12);
  const panels = platforms.map((platform) =>
    salesPanel(bounded.readings, platform, chart.starts, chart.grain),
  );
  const pinWeeks = chart.grain === "week" ? chart.starts : weekBuckets(chart.starts);
  const pins = pinsFor(bounded, pinWeeks, platforms);
  const window = comparisonWindow(bounded, platforms);
  const aligned = alignedSales(bounded.readings, platforms, window);
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
  const heatmap = heatmapFor(bounded.readings, pinWeeks, platforms);
  const funnel = funnelFor(bounded.readings, pinWeeks, platforms);
  return {
    answer: {
      ...answer,
      direction,
      pct: young ? null : aligned.change,
      weeks: window.count,
      unit: window.unit,
    },
    panels,
    pins,
    shadeWeek: chart.starts.filter((date) => date < bounded.today).at(-1) ?? null,
    tiles,
    heatmap,
    funnel,
    pendingNote: laggingPlatform(bounded.readings, platforms),
    missingNote: missingNote(bounded.readings, platforms, chart.starts, chart.grain),
    compared: { kept: aligned.kept, expected: window.count },
    periodPhrase: periodPhrase(window.unit, window.count),
    heatmapLine: heatmapHeadline(heatmap),
    funnelLine: funnelHeadline(funnel),
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

/** The selected range, trimmed so it never runs past today, and the window before it. */
function comparisonWindow(input: OwnerDashboardInput, platforms: OpsPlatform[]): ComparedWindow {
  const span = Math.max(1, daysBetween(input.from, input.to));
  const unit = span <= 14 ? "day" : "week";
  const count = unit === "day" ? span : Math.max(1, Math.round(span / 7));
  const length = unit === "day" ? span : count * 7;
  const step = unit === "day" ? 1 : 7;
  const grain = unit;
  const currentTo = unit === "week" ? addDays(weekMonday(addDays(input.to, -1)), 7) : input.to;
  const currentFrom = addDays(currentTo, -length);
  const lag = salesLag(input.readings, platforms, currentFrom, currentTo, grain);
  const trimmedTo = addDays(currentTo, -lag * step);
  return {
    unit,
    count,
    length,
    grain,
    step,
    currentFrom,
    currentTo: trimmedTo,
    previousFrom: addDays(currentFrom, -length),
    previousTo: addDays(trimmedTo, -length),
  };
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
    if (shared.length === 0 || shared.length !== now.size) continue;
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
  platforms: OpsPlatform[],
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

/** `last 4 weeks vs the 4 before`, or `last 7 days vs the same 7 days before`. */
export function periodPhrase(unit: "day" | "week", count: number): string {
  if (unit === "week") {
    const noun = count === 1 ? "week" : "weeks";
    return `last ${count} ${noun} vs the ${count} before`;
  }
  const noun = count === 1 ? "day" : "days";
  return `last ${count} ${noun} vs the same ${count} ${noun} before`;
}

function chartSeries(input: OwnerDashboardInput): { grain: "day" | "week"; starts: string[] } {
  const span =
    input.range === "custom"
      ? Math.max(1, daysBetween(input.from, input.to))
      : ownerRangeDays(input.range);
  if (span <= 14) {
    const starts: string[] = [];
    for (let cursor = input.from; cursor < input.to; cursor = addDays(cursor, 1))
      starts.push(cursor);
    return { grain: "day", starts };
  }
  const count = Math.max(1, Math.round(span / 7));
  const end = weekMonday(addDays(input.to, -1));
  const start = addDays(end, -7 * (count - 1));
  const starts: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) starts.push(cursor);
  return { grain: "week", starts };
}

function weekBuckets(days: readonly string[]): string[] {
  return [...new Set(days.map((date) => weekMonday(date)))].sort();
}

function weekStarts(today: string, count: number): string[] {
  const end = weekMonday(addDays(today, -1));
  const start = addDays(end, -7 * (count - 1));
  const weeks: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) weeks.push(cursor);
  return weeks;
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

function pinsFor(input: OwnerDashboardInput, weeks: string[], platforms: OpsPlatform[]): DashPin[] {
  const pins: Array<Omit<DashPin, "n">> = [];
  for (const week of weeks) {
    const through = addDays(week, 7);
    if (input.holidays.some((date) => date >= week && date < through)) {
      pins.push({ week, kind: "festival", label: "Festival" });
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
  const dipped = lastDip(finished);
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

function lastDip(panels: SalesPanel[]): OwnerDashboardModel["answer"]["dipped"] {
  let worst: { platform: OpsPlatform; pct: number } | null = null;
  for (const panel of panels) {
    const values = panel.points
      .map((point) => point.sales)
      .filter((value): value is number => value != null);
    const current = values.at(-1);
    const previous = values.at(-2);
    if (current == null || previous == null) continue;
    const change = pctChange(current, previous);
    if (change == null || change >= -3) continue;
    if (!worst || change < worst.pct) worst = { platform: panel.platform, pct: change };
  }
  return worst;
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
  const dates = pairedSalesDates(input.readings, platforms, window);
  const measured = measureTile(tile, input, platforms, window, dates);
  const splits = platforms.map((platform) => {
    const part = measureTile(tile, input, [platform], window, dates);
    return {
      platform,
      value: part.current,
      inReport: part.state === "value",
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
  };
}

/** Value, percent, and per-app split for one tile, all from the same paired periods. */
function measureTile(
  tile: TileDef,
  input: OwnerDashboardInput,
  platforms: OpsPlatform[],
  window: ComparedWindow,
  dates: readonly string[],
): { state: DashTile["state"]; current: number | null; change: number | null; pairs: number } {
  const usable = dates.length > 0 ? dates : periodStarts(window);
  let shown = 0;
  let shownCount = 0;
  let now = 0;
  let then = 0;
  let pairs = 0;
  let pending = false;
  let updating = false;
  let missing = false;
  for (const day of usable) {
    const current = onePeriod(tile, input.readings, window, day, platforms);
    if (current.kind === "pending") pending = true;
    if (current.kind === "updating") updating = true;
    if (current.kind === "missing" || current.kind === "not_in_report") missing = true;
    if (current.kind !== "value" || current.total == null) continue;
    shown += current.total;
    shownCount += 1;
    const prior = onePeriod(tile, input.readings, window, addDays(day, -window.length), platforms);
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
  return {
    state: "value",
    current,
    change: previous != null && previous !== 0 ? pctChange(current, previous) : null,
    pairs,
  };
}

function measureAds(
  readings: readonly DashReading[],
  window: ComparedWindow,
  dates: readonly string[],
  platforms: OpsPlatform[],
): { state: DashTile["state"]; current: number | null; change: number | null; pairs: number } {
  const paired = dates.filter((day) => {
    const prior = addDays(day, -window.length);
    return (
      adsOn(readings, window, day, platforms).kind === "value" &&
      adsOn(readings, window, prior, platforms).kind === "value"
    );
  });
  const used = paired.length > 0 ? paired : dates;
  const current = adsOver(readings, window, used, platforms);
  const previous = adsOver(
    readings,
    window,
    used.map((day) => addDays(day, -window.length)),
    platforms,
  );
  if (current.kind === "no_ads") return { state: "no_ads", current: null, change: null, pairs: 0 };
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

function adsOver(
  readings: readonly DashReading[],
  window: ComparedWindow,
  dates: readonly string[],
  platforms: OpsPlatform[],
): WindowTotal {
  if (dates.length === 0) return { kind: "empty", total: null };
  const only = new Set(dates);
  return adsRatio(
    readings,
    window.grain,
    dates[0] ?? "",
    addDays(dates.at(-1) ?? "", window.step),
    platforms,
    only,
  );
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

function pairedSalesDates(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  window: ComparedWindow,
): string[] {
  const dates: string[] = [];
  for (let day = window.currentFrom; day < window.currentTo; day = addDays(day, window.step)) {
    const now = salesKeys(readings, platforms, day, window.grain);
    if (now.size === 0) continue;
    const prior = salesKeys(readings, platforms, addDays(day, -window.length), window.grain);
    const shared = [...now.keys()].filter((key) => prior.has(key));
    if (shared.length === 0 || shared.length !== now.size) continue;
    dates.push(day);
  }
  return dates;
}

function periodStarts(window: ComparedWindow): string[] {
  const dates: string[] = [];
  for (let day = window.currentFrom; day < window.currentTo; day = addDays(day, window.step)) {
    dates.push(day);
  }
  return dates;
}

function basisPhrase(window: ComparedWindow, pairs: number): string {
  if (pairs > 0 && pairs !== window.count) {
    const noun =
      window.unit === "week" ? (pairs === 1 ? "week" : "weeks") : pairs === 1 ? "day" : "days";
    return `${pairs} of ${window.count} ${noun} vs the same ${noun} before`;
  }
  return periodPhrase(window.unit, window.count);
}

function wordFromChange(
  tile: TileDef,
  change: number | null,
  weeks: number,
): { word: TileWord | null; weeks: number; good: boolean | null } {
  if (change == null || Math.abs(change) < 3) {
    return {
      word: change == null ? null : "steady",
      weeks: change == null ? 0 : weeks,
      good: null,
    };
  }
  const up = change > 0;
  const good = tile.goodUp ? up : !up;
  const word: TileWord =
    tile.word === "prep"
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

/** Trailing days or weeks where a selected app is still pending. */
function salesLag(
  readings: readonly DashReading[],
  platforms: OpsPlatform[],
  from: string,
  to: string,
  grain: "day" | "week",
): number {
  const step = grain === "week" ? 7 : 1;
  let lag = 0;
  for (let date = addDays(to, -step); date >= from; date = addDays(date, -step)) {
    const pending = platforms.some((platform) => {
      const row = readings.find(
        (reading) =>
          reading.grain === grain &&
          reading.platform === platform &&
          reading.key === SALES_KEY[platform] &&
          reading.from === date,
      );
      return row?.state === "pending" || row?.state === "updating";
    });
    if (!pending) break;
    lag += 1;
  }
  return lag;
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

function funnelFor(readings: readonly DashReading[], weeks: string[], platforms: OpsPlatform[]) {
  const steps = ["menu", "cart", "order"] as const;
  const series: OwnerDashboardModel["funnel"] = [];
  for (const step of steps) {
    for (const platform of platforms) {
      series.push({
        step,
        platform,
        points: weeks.map((week) => ({ week, pct: funnelPct(readings, step, platform, week) })),
      });
    }
  }
  return series;
}

function funnelPct(
  readings: readonly DashReading[],
  step: "menu" | "cart" | "order",
  platform: OpsPlatform,
  week: string,
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
  const top = rowsIn(readings, "week", numerator, week, addDays(week, 7), [platform])[0];
  const bottom = rowsIn(readings, "week", denominator, week, addDays(week, 7), [platform])[0];
  if (!top || !bottom || top.state !== "ok" || bottom.state !== "ok") return null;
  if (bottom.value == null || bottom.value === 0 || top.value == null) return null;
  return (top.value / bottom.value) * 100;
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
  type: "lineY" | "linearRegressionY" | "ruleX" | "text" | "cell" | "rect" | "rectY";
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
        if (!row || typeof row !== "object" || !("at" in row)) return row;
        const at = (row as { at?: unknown }).at;
        if (typeof at !== "string") return row;
        return { ...row, at: utcDate(at.slice(0, 10)) };
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
  if (dated[0] && dated.at(-1)) axis.domain = [dated[0], addDays(dated.at(-1) ?? dated[0], 1)];
  const plots: OwnerPlot[] = [
    {
      id: "sales",
      width: 640,
      height: 220,
      marginLeft: 16,
      marginRight: 108,
      x: axis,
      y: { label: null, domain: [-0.2, 1.25], grid: true, ticks: [] },
      marks: combinedSalesMarks(model),
    },
  ];
  const heatWeeks = [...new Set(model.heatmap.map((cell) => cell.week))].sort();
  const cell = 28;
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
        options: { x: "week", y: "weekday", fill: "orders", inset: 3 },
      },
    ],
  });
  for (const step of ["menu", "cart", "order"] as const) {
    const rows = model.funnel
      .filter((series) => series.step === step)
      .flatMap((series) => series.points.map((point) => ({ ...point, platform: series.platform })));
    const weeks = [...new Set(rows.map((row) => row.week))].sort();
    plots.push({
      id: `funnel-${step}`,
      width: 280,
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

function combinedSalesMarks(model: OwnerDashboardModel): OwnerPlotMark[] {
  const marks: OwnerPlotMark[] = [];
  if (model.shadeWeek) {
    marks.push({
      type: "rect",
      data: [{ x1: model.shadeWeek, x2: addDays(model.shadeWeek, 7), y1: -0.2, y2: 1.25 }],
      options: { x1: "x1", x2: "x2", y1: "y1", y2: "y2", fill: "var(--muted)" },
    });
  }
  for (const panel of model.panels) {
    const knownValues = panel.points.flatMap((point) => (point.sales == null ? [] : [point.sales]));
    const low = knownValues.length > 0 ? Math.min(...knownValues) : 0;
    const high = knownValues.length > 0 ? Math.max(...knownValues) : 1;
    const span = high - low || 1;
    const rows = panel.points.map((point) => ({
      at: point.week,
      y: point.sales == null ? null : (point.sales - low) / span,
      sales: point.sales,
    }));
    marks.push({
      type: "lineY",
      data: rows,
      options: { x: "at", y: "y", stroke: PLATFORM_STROKE[panel.platform], strokeWidth: 1.5 },
    });
    const known = rows.filter((row) => row.sales != null);
    if (known.length >= 2) {
      marks.push({
        type: "linearRegressionY",
        data: known,
        options: {
          x: "at",
          y: "y",
          stroke: PLATFORM_STROKE[panel.platform],
          strokeDasharray: "4 3",
        },
      });
    }
    const last = known.at(-1);
    if (last?.sales != null) {
      marks.push({
        type: "text",
        data: [
          {
            at: last.at,
            y: last.y,
            label: `${panel.platform === "zomato" ? "Zomato" : "Swiggy"} ${formatCompactRupees(last.sales)}`,
          },
        ],
        options: { x: "at", y: "y", text: "label", dx: 6, anchor: "start" },
      });
    }
    if (model.pendingNote === panel.platform) {
      const pending = panel.points.filter((point) => point.pending);
      const step = model.answer.unit === "day" ? 1 : 7;
      if (pending.length > 0) {
        marks.push({
          type: "rect",
          data: pending.map((point) => ({
            x1: point.week,
            x2: addDays(point.week, step),
            y1: -0.2,
            y2: 1.25,
          })),
          options: { x1: "x1", x2: "x2", y1: "y1", y2: "y2", fill: "var(--muted)" },
        });
        marks.push({
          type: "text",
          data: pending.map((point) => ({ at: point.week, y: 1.05, label: "Pending" })),
          options: { x: "at", y: "y", text: "label" },
        });
      }
    }
  }
  for (const pin of model.pins) {
    marks.push(
      { type: "ruleX", data: [{ at: pin.week }], options: { x: "at", stroke: "var(--border)" } },
      {
        type: "text",
        data: [{ at: pin.week, y: 1.15, n: String(pin.n) }],
        options: { x: "at", y: "y", text: "n", dy: -4 },
      },
    );
  }
  return marks;
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
