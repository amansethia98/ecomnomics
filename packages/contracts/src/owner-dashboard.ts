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
  const chart = chartSeries(input);
  const trendWeeks = weekStarts(input.today, 12);
  const shade = chart.starts[chart.starts.length - 1] ?? null;
  const panels = platforms.map((platform) =>
    salesPanel(input.readings, platform, chart.starts, chart.grain),
  );
  const pinWeeks = chart.grain === "week" ? chart.starts : weekBuckets(chart.starts);
  const pins = pinsFor(input, pinWeeks, platforms);
  const answer = answerFor(panels, input, platforms, chart.grain);
  const earliest = earliestDay(input.readings);
  const young = input.historyDays < 7;
  const comparisonsStart = young && earliest ? addDays(earliest, 7) : null;
  const tiles = TILES.map((tile) =>
    tileFor(tile, input, platforms, trendWeeks, young, windowHasHoliday(input)),
  );
  return {
    answer,
    panels,
    pins,
    shadeWeek: shade,
    tiles,
    heatmap: heatmapFor(input.readings, pinWeeks, platforms),
    funnel: funnelFor(input.readings, pinWeeks, platforms),
    pendingNote: laggingPlatform(input.readings, platforms),
    missingNote: missingNote(input.readings, platforms),
    compared: comparedDays(input, platforms),
    comparisonsStart,
    onePlatform: platforms.length === 1,
  };
}

function selected(input: OwnerDashboardInput): OpsPlatform[] {
  if (input.platform === "both") return ["zomato", "swiggy"];
  return [input.platform];
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
): DashTile {
  if (tile.id === "rating" && !platforms.includes("zomato")) {
    return emptyTile(tile, "not_in_report");
  }
  const spark = weeks.map((week) => weekValue(tile, input.readings, week, platforms));
  const trendSpark = spark.map((value, index) =>
    addDays(weeks[index] ?? input.today, 7) <= input.today ? value : null,
  );
  const length =
    input.range === "custom" ? daysBetween(input.from, input.to) : ownerRangeDays(input.range);
  const grain = windowGrain(input);
  const step = grain === "week" ? 7 : 1;
  const lag = salesLag(input.readings, platforms, addDays(input.to, -length), input.to, grain);
  const current = windowValue(
    tile,
    input,
    platforms,
    addDays(input.to, -length),
    addDays(input.to, -lag * step),
  );
  const previous = windowValue(
    tile,
    input,
    platforms,
    addDays(input.to, -2 * length),
    addDays(input.to, -length - lag * step),
  );
  if (tile.id === "ads" && current.kind === "no_ads")
    return { ...emptyTile(tile, "no_ads"), spark: spark };
  if (current.kind === "pending") return { ...emptyTile(tile, "pending"), spark: spark };
  if (current.kind === "updating") return { ...emptyTile(tile, "updating"), spark: spark };
  if (current.kind === "missing") return { ...emptyTile(tile, "missing"), spark: spark };
  if (current.kind === "na") return { ...emptyTile(tile, "na"), spark: spark };
  if (current.kind === "empty") return { ...emptyTile(tile, "empty"), spark: spark };
  const change =
    young || previous.kind !== "value" || previous.total == null || current.total == null
      ? null
      : pctChange(current.total, previous.total);
  const trend = trendOf(trendSpark, tile);
  return {
    id: tile.id,
    value: current.total,
    format: tile.format,
    changePct: change,
    spark: spark,
    word: trend.word,
    weeks: trend.weeks,
    good: trend.good,
    state: "value",
    festival,
  };
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

function windowGrain(input: OwnerDashboardInput): "day" | "week" {
  const span =
    input.range === "custom" ? daysBetween(input.from, input.to) : ownerRangeDays(input.range);
  return span <= 14 ? "day" : "week";
}

function windowValue(
  tile: TileDef,
  input: OwnerDashboardInput,
  platforms: OpsPlatform[],
  from: string,
  to: string,
): WindowTotal {
  return windowKeys(tile, input.readings, windowGrain(input), from, to, platforms);
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
  return { kind: "empty", total: null };
}

function adsRatio(
  readings: readonly DashReading[],
  grain: "day" | "week",
  from: string,
  to: string,
  platforms: OpsPlatform[],
): WindowTotal {
  let sales = 0;
  let spend = 0;
  let any = false;
  let pending = false;
  for (const platform of platforms) {
    const salesKey = platform === "zomato" ? "ads_sales_paise" : "cpc_sales_paise";
    const spendKey = platform === "zomato" ? "ad_spend_paise" : "cpc_spend_paise";
    const sold = reduceRows(rowsIn(readings, grain, salesKey, from, to, [platform]), false);
    const spent = reduceRows(rowsIn(readings, grain, spendKey, from, to, [platform]), false);
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
): DashReading[] {
  return readings.filter(
    (reading) =>
      reading.grain === grain &&
      reading.key === key &&
      platforms.includes(reading.platform) &&
      reading.from >= from &&
      reading.from < to,
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

function trendOf(
  values: Array<number | null>,
  tile: TileDef,
): { word: TileWord | null; weeks: number; good: boolean | null } {
  const points = values.flatMap((value, index) => (value == null ? [] : [{ index, value }]));
  if (points.length < 3) return { word: null, weeks: 0, good: null };
  const first = points[0]?.value ?? 0;
  const last = points[points.length - 1]?.value ?? 0;
  const change = pctChange(last, first);
  if (change == null || Math.abs(change) < 3)
    return { word: "steady", weeks: points.length, good: null };
  const up = change > 0;
  const weeks = trailing(
    points.map((point) => point.value),
    up,
  );
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

function trailing(values: number[], up: boolean): number {
  let count = 1;
  for (let index = values.length - 1; index > 0; index -= 1) {
    const step = (values[index] ?? 0) - (values[index - 1] ?? 0);
    if ((up && step < 0) || (!up && step > 0)) break;
    count += 1;
  }
  return count;
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

function missingNote(readings: readonly DashReading[], platforms: OpsPlatform[]): string | null {
  const row = readings.find(
    (reading) => reading.state === "missing" && platforms.includes(reading.platform),
  );
  return row ? row.from : null;
}

function comparedDays(
  input: OwnerDashboardInput,
  platforms: OpsPlatform[],
): { kept: number; expected: number } | null {
  if (input.range !== "7d") return null;
  const from = addDays(input.to, -7);
  let expected = 7;
  let kept = 0;
  for (let cursor = from; cursor < input.to; cursor = addDays(cursor, 1)) {
    const rows = input.readings.filter(
      (reading) =>
        reading.grain === "day" &&
        reading.from === cursor &&
        platforms.includes(reading.platform) &&
        reading.key === SALES_KEY[reading.platform],
    );
    if (rows.some((row) => row.state === "pending" || row.state === "missing")) {
      expected -= 1;
      continue;
    }
    if (rows.some((row) => row.state === "ok")) kept += 1;
  }
  return { kept, expected };
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
  type: "lineY" | "linearRegressionY" | "ruleX" | "text" | "cell" | "rectY";
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

function dateAxis(count: number): Record<string, unknown> {
  return {
    label: null,
    type: "utc",
    ticks: count > 6 ? 4 : Math.max(count, 1),
    tickFormat: (value: Date) => formatAxisDay(value),
  };
}

function rupeeAxis(): Record<string, unknown> {
  return {
    label: null,
    grid: true,
    tickFormat: (value: number) => formatCompactRupees(Number(value)),
  };
}

const PLATFORM_STROKE: Record<OpsPlatform, string> = {
  zomato: "var(--owner-zomato)",
  swiggy: "var(--owner-swiggy)",
};

/** Chart specs for the dashboard. Colours are the owner-shell tokens, used only on series. */
export function dashboardPlots(model: OwnerDashboardModel): OwnerPlot[] {
  const plots: OwnerPlot[] = model.panels.map((panel) => ({
    id: `sales-${panel.platform}`,
    width: 640,
    height: 180,
    marginLeft: 64,
    x: dateAxis(panel.points.length),
    y: rupeeAxis(),
    marks: salesMarks(panel, model),
  }));
  const heatWeeks = new Set(model.heatmap.map((cell) => cell.week)).size;
  plots.push({
    id: "heatmap",
    width: 640,
    height: 180,
    marginLeft: 44,
    x: dateAxis(heatWeeks),
    y: { label: null, domain: [...WEEKDAY_ORDER] },
    color: { scheme: "blues" },
    marks: [
      {
        type: "cell",
        data: model.heatmap.map((cell) => ({ ...cell, at: utcDate(cell.week) })),
        options: { x: "at", y: "weekday", fill: "orders", inset: 1 },
      },
    ],
  });
  for (const step of ["menu", "cart", "order"] as const) {
    const rows = model.funnel
      .filter((series) => series.step === step)
      .flatMap((series) => series.points.map((point) => ({ ...point, platform: series.platform })));
    plots.push({
      id: `funnel-${step}`,
      width: 280,
      height: 80,
      marginLeft: 36,
      x: dateAxis(new Set(rows.map((row) => row.week)).size),
      y: { label: null },
      marks: [
        {
          type: "lineY",
          data: withDate(rows),
          options: { x: "at", y: "pct", stroke: "platform", strokeWidth: 1.5 },
        },
      ],
    });
  }
  return plots;
}

function salesMarks(panel: SalesPanel, model: OwnerDashboardModel): OwnerPlotMark[] {
  const top = Math.max(1, ...panel.points.map((point) => point.sales ?? 0));
  const marks: OwnerPlotMark[] = [
    {
      type: "lineY",
      data: withDate(panel.points),
      options: { x: "at", y: "sales", stroke: PLATFORM_STROKE[panel.platform], strokeWidth: 1.5 },
    },
    {
      type: "linearRegressionY",
      data: withDate(panel.points.filter((point) => point.sales != null)),
      options: {
        x: "at",
        y: "sales",
        stroke: PLATFORM_STROKE[panel.platform],
        strokeDasharray: "4 3",
      },
    },
  ];
  if (model.shadeWeek) {
    marks.unshift({
      type: "rectY",
      data: [{ at: utcDate(model.shadeWeek), top }],
      options: { x: "at", y1: 0, y2: "top", fill: "var(--muted)" },
    });
  }
  for (const pin of model.pins.filter((item) =>
    panel.points.some((point) => point.week === item.week),
  )) {
    const at = utcDate(pin.week);
    marks.push(
      { type: "ruleX", data: [{ ...pin, at }], options: { x: "at", stroke: "var(--border)" } },
      { type: "text", data: [{ ...pin, at }], options: { x: "at", text: "n", dy: -8 } },
    );
  }
  const pending = withDate(panel.points.filter((point) => point.pending)).map((point) => ({
    ...point,
    label: "Pending",
  }));
  if (pending.length > 0) {
    marks.push({ type: "text", data: pending, options: { x: "at", text: "label", dy: 12 } });
  }
  return marks;
}
