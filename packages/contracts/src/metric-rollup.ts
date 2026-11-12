import { addIsoDays, daysBetween } from "./metric-dates.js";
import type {
  AggregationKind,
  MetricAccuracy,
  MetricGranularity,
  MetricKey,
  MetricPlatform,
  MetricUnit,
} from "./metric-dictionary.js";
import {
  CROSS_PLATFORM_KEYS,
  METRIC_KEYS,
  metricDefinition,
  requireMetric,
  resolveCheck,
} from "./metric-dictionary.js";

export interface RollupFact {
  key: string;
  platform: MetricPlatform;
  granularity: string;
  periodStart: string;
  periodEnd: string;
  value: number | null;
  rowRole: "fact" | "platform_check";
}

export interface RollupQuery {
  platform: MetricPlatform | "combined";
  /** Inclusive ISO date. */
  from: string;
  /** Exclusive ISO date. */
  to: string;
  /** ISO date used to mark the 7-day re-fetch window as provisional. */
  today: string;
  basis: "order_date" | "settlement_date";
}

export interface RollupValue {
  key: string;
  platform: MetricPlatform | "combined";
  unit: MetricUnit;
  kind: AggregationKind;
  accuracy: MetricAccuracy;
  value: number | null;
  status: "ok" | "not_available";
  reason?: string;
  coverageDays: number;
  expectedDays: number;
  missingDays: string[];
  partialDays: string[];
  asOf?: string;
  /** True when the value is a stored platform window, not a rollup of days. */
  windowMatch: boolean;
}

export interface MetricRollup {
  basis: "order_date" | "settlement_date";
  from: string;
  to: string;
  provisional: boolean;
  values: RollupValue[];
}

const NOT_COMBINED = "This figure is not combined across platforms.";
const NOT_WINDOW =
  "Not available for this date range. The platform only publishes this figure for a matching day, week, or month.";
const NOT_SETTLEMENT = "Settlement-date totals need payout orders, which are not stored yet.";
const NOT_DISTINCT = "Distinct customers are counted from payout orders, which are not stored yet.";
const NOT_HOURS =
  "Online percentage needs each day's scheduled hours. No platform figure is stored for this exact window.";

interface DayIndex {
  days: string[];
  /** platform, date, key → fact value. Missing means no row. */
  facts: Map<string, number | null>;
  /** Day-grain platform checks, such as a daily online percentage. */
  dayChecks: Map<string, number | null>;
  /** Exact [from, to) rows, facts and platform checks. */
  window: RollupFact[];
}

export function rollupMetrics(rows: readonly RollupFact[], query: RollupQuery): MetricRollup {
  const days = daysBetween(query.from, query.to);
  const provisional =
    query.to > addIsoDays(query.today, -7) && query.from < addIsoDays(query.today, 1);
  if (query.basis === "settlement_date") {
    return {
      basis: query.basis,
      from: query.from,
      to: query.to,
      provisional,
      values: settlementValues(query.platform, days),
    };
  }
  const index = indexFacts(rows, query.from, query.to, days);
  const platform = query.platform;
  const values =
    platform === "combined"
      ? CROSS_PLATFORM_KEYS.map((key) => combinedSum(key, index))
      : METRIC_KEYS.filter((key) => requireMetric(key).platforms.includes(platform)).map((key) =>
          rollOne(key, platform, index),
        );
  if (platform !== "combined") {
    values.push(...derivedPayouts(platform, index));
  }
  return { basis: query.basis, from: query.from, to: query.to, provisional, values };
}

function indexFacts(
  rows: readonly RollupFact[],
  from: string,
  to: string,
  days: string[],
): DayIndex {
  const facts = new Map<string, number | null>();
  const dayChecks = new Map<string, number | null>();
  const window: RollupFact[] = [];
  const daySet = new Set(days);
  for (const row of rows) {
    if (row.periodStart === from && row.periodEnd === to) window.push(row);
    if (row.granularity !== "day" || !daySet.has(row.periodStart)) continue;
    const slot = `${row.platform}\t${row.periodStart}\t${row.key}`;
    if (row.rowRole === "fact") facts.set(slot, row.value);
    else if (row.rowRole === "platform_check") dayChecks.set(slot, row.value);
  }
  return { days, facts, dayChecks, window };
}

function fact(
  index: DayIndex,
  platform: MetricPlatform,
  day: string,
  key: string,
): number | null | undefined {
  const slot = `${platform}\t${day}\t${key}`;
  return index.facts.has(slot) ? index.facts.get(slot) : undefined;
}

function rollOne(key: MetricKey, platform: MetricPlatform, index: DayIndex): RollupValue {
  const definition = requireMetric(key);
  const base = shell(
    key,
    platform,
    definition.unit,
    definition.kind,
    definition.accuracy,
    index.days,
  );
  if (definition.kind === "platform_only") return exactOnly(base, index, platform, key, NOT_WINDOW);
  if (definition.kind === "distinct") return exactOnly(base, index, platform, key, NOT_DISTINCT);
  if (definition.kind === "snapshot_latest")
    return latest(base, index, platform, key, definition.skipZero === true);
  if (definition.kind === "snapshot_mean" || definition.kind === "weighted_avg") {
    return weighted(base, index, platform, key);
  }
  if (definition.kind === "ratio") return ratio(base, index, platform, key);
  return sum(base, index, platform, key);
}

function sum(
  base: RollupValue,
  index: DayIndex,
  platform: MetricPlatform,
  key: string,
): RollupValue {
  let total = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const day of index.days) {
    const value = fact(index, platform, day, key);
    if (value == null) missing.push(day);
    else {
      total += value;
      covered += 1;
    }
  }
  return {
    ...base,
    value: covered === 0 ? null : round4(total),
    coverageDays: covered,
    missingDays: missing,
    status: "ok",
  };
}

function ratio(
  base: RollupValue,
  index: DayIndex,
  platform: MetricPlatform,
  key: MetricKey,
): RollupValue {
  const definition = requireMetric(key);
  if (definition.formula === "zomato_ads_roi") return adsRoi(base, index, platform);
  const numerator = definition.numeratorByPlatform?.[platform] ?? definition.numeratorKey;
  const denominator = definition.denominatorKey;
  if (!numerator || !denominator) {
    return { ...base, status: "not_available", reason: "This rate has no stored parts." };
  }
  return divideParts(base, index, platform, numerator, denominator, definition.presentAs === "pct");
}

function divideParts(
  base: RollupValue,
  index: DayIndex,
  platform: MetricPlatform,
  numerator: string,
  denominator: string,
  asPct: boolean,
): RollupValue {
  let num = 0;
  let den = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const day of index.days) {
    const left = fact(index, platform, day, numerator);
    const right = fact(index, platform, day, denominator);
    if (left == null || right == null) missing.push(day);
    else {
      num += left;
      den += right;
      covered += 1;
    }
  }
  if (covered === 0 || den === 0) {
    return { ...base, value: null, missingDays: missing, coverageDays: covered, status: "ok" };
  }
  const value = asPct ? (num / den) * 100 : num / den;
  return {
    ...base,
    value: round4(value),
    coverageDays: covered,
    missingDays: missing,
    status: "ok",
  };
}

function adsRoi(base: RollupValue, index: DayIndex, platform: MetricPlatform): RollupValue {
  let sales = 0;
  let spend = 0;
  let adjustment = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const day of index.days) {
    const adSales = fact(index, platform, day, "ads_sales_paise");
    const discount = fact(index, platform, day, "discount_paise");
    const orders = fact(index, platform, day, "ad_orders");
    const adSpend = fact(index, platform, day, "ad_spend_paise");
    const delivered = fact(index, platform, day, "delivered_orders");
    if (
      adSales == null ||
      discount == null ||
      orders == null ||
      adSpend == null ||
      delivered == null
    ) {
      missing.push(day);
      continue;
    }
    sales += adSales;
    spend += adSpend;
    adjustment += delivered === 0 ? 0 : (discount * orders) / delivered;
    covered += 1;
  }
  if (covered === 0 || spend === 0) {
    return { ...base, value: null, missingDays: missing, coverageDays: covered, status: "ok" };
  }
  return {
    ...base,
    value: round4((sales + adjustment) / spend),
    coverageDays: covered,
    missingDays: missing,
    status: "ok",
  };
}

function weighted(
  base: RollupValue,
  index: DayIndex,
  platform: MetricPlatform,
  key: MetricKey,
): RollupValue {
  const definition = requireMetric(key);
  const valueKey = definition.valueKey;
  const weightKey = definition.weightKey;
  if (key === "online_pct") return onlinePercent(base, index, platform);
  if (!valueKey || !weightKey) return exactOnly(base, index, platform, key, NOT_WINDOW);
  const divided = divideParts(
    base,
    index,
    platform,
    valueKey,
    weightKey,
    definition.presentAs === "pct",
  );
  return divided.value != null ? divided : exactOnly(divided, index, platform, key, NOT_WINDOW);
}

function dailyCheck(
  index: DayIndex,
  platform: MetricPlatform,
  day: string,
  key: string,
): number | null | undefined {
  const slot = `${platform}\t${day}\t${key}`;
  return index.dayChecks.has(slot) ? index.dayChecks.get(slot) : undefined;
}

/** Hours when every covered day has them. A day without hours counts as weight 1. */
function onlinePercent(base: RollupValue, index: DayIndex, platform: MetricPlatform): RollupValue {
  let weighted = 0;
  let weight = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const day of index.days) {
    const hours = fact(index, platform, day, "scheduled_hours");
    const online = fact(index, platform, day, "online_hours");
    if (hours != null && hours > 0 && online != null) {
      weighted += online * 100;
      weight += hours;
      covered += 1;
      continue;
    }
    const pct =
      fact(index, platform, day, "online_pct") ?? dailyCheck(index, platform, day, "online_pct");
    if (pct != null) {
      weighted += pct;
      weight += 1;
      covered += 1;
      continue;
    }
    missing.push(day);
  }
  if (covered === 0 || weight === 0) {
    const fallback = exactOnly(base, index, platform, "online_pct", NOT_HOURS, true);
    return fallback.windowMatch ? fallback : { ...fallback, reason: NOT_HOURS };
  }
  return {
    ...base,
    value: round4(weighted / weight),
    accuracy: "approx",
    coverageDays: covered,
    missingDays: missing,
    status: "ok",
  };
}

function latest(
  base: RollupValue,
  index: DayIndex,
  platform: MetricPlatform,
  key: string,
  skipZero: boolean,
): RollupValue {
  const missing: string[] = [];
  let found: { day: string; value: number } | undefined;
  for (const day of [...index.days].reverse()) {
    const value = fact(index, platform, day, key);
    const usable = value != null && !(skipZero && value === 0);
    if (!usable) missing.push(day);
    else if (!found) found = { day, value };
  }
  missing.reverse();
  if (found) {
    return {
      ...base,
      value: found.value,
      asOf: found.day,
      coverageDays: index.days.length - missing.length,
      missingDays: missing,
      status: "ok",
    };
  }
  return exactOnly({ ...base, missingDays: missing }, index, platform, key, NOT_WINDOW);
}

function exactOnly(
  base: RollupValue,
  index: DayIndex,
  platform: MetricPlatform,
  key: string,
  reason: string,
  allowCheck = false,
): RollupValue {
  const stored = index.window.find(
    (row) =>
      row.platform === platform && row.key === key && row.value != null && row.rowRole === "fact",
  );
  const check = allowCheck
    ? index.window.find(
        (row) =>
          row.platform === platform &&
          row.key === key &&
          row.value != null &&
          row.rowRole === "platform_check",
      )
    : undefined;
  const match = stored ?? check;
  if (!match || match.value == null) {
    return { ...base, value: null, status: "not_available", reason, windowMatch: false };
  }
  const definition = metricDefinition(key);
  return {
    ...base,
    value: match.value,
    asOf: definition?.kind === "snapshot_latest" ? addIsoDays(match.periodEnd, -1) : undefined,
    coverageDays: base.expectedDays,
    missingDays: [],
    status: "ok",
    windowMatch: true,
  };
}

function combinedSum(key: MetricKey, index: DayIndex): RollupValue {
  const definition = requireMetric(key);
  const base = shell(key, "combined", definition.unit, "sum", definition.accuracy, index.days);
  if (definition.kind !== "sum") {
    return { ...base, status: "not_available", reason: NOT_COMBINED };
  }
  let total = 0;
  let any = false;
  const missing: string[] = [];
  const partial: string[] = [];
  let covered = 0;
  for (const day of index.days) {
    const zomato = fact(index, "zomato", day, key);
    const swiggy = fact(index, "swiggy", day, key);
    if (zomato == null && swiggy == null) missing.push(day);
    else {
      if (zomato == null || swiggy == null) partial.push(day);
      else covered += 1;
      total += (zomato ?? 0) + (swiggy ?? 0);
      any = true;
    }
  }
  if (!any) return { ...base, missingDays: missing, status: "ok", value: null };
  return {
    ...base,
    value: round4(total),
    coverageDays: covered,
    missingDays: missing,
    partialDays: partial,
    status: "ok",
  };
}

interface DerivedRatio {
  key: string;
  numerator: string;
  denominator: string;
  pct: boolean;
  /** When the denominator is 0 the result is 0, matching the payout table. */
  zeroWhenEmpty: boolean;
}

const DERIVED_RATIOS: readonly DerivedRatio[] = [
  {
    key: "effective_discount_pct",
    numerator: "discount_paise",
    denominator: "gross_sales_paise",
    pct: true,
    zeroWhenEmpty: false,
  },
  {
    key: "ads_pct",
    numerator: "ad_spend_paise",
    denominator: "gross_sales_paise",
    pct: true,
    zeroWhenEmpty: false,
  },
  {
    key: "payout_pct",
    numerator: "net_payout_paise",
    denominator: "gross_sales_paise",
    pct: true,
    zeroWhenEmpty: true,
  },
  {
    key: "ops_aov_paise",
    numerator: "ops_sales_paise",
    denominator: "delivered_orders",
    pct: false,
    zeroWhenEmpty: false,
  },
  {
    key: "gross_aov_paise",
    numerator: "gross_sales_paise",
    denominator: "delivered_orders",
    pct: false,
    zeroWhenEmpty: false,
  },
];

function derivedPayouts(platform: MetricPlatform, index: DayIndex): RollupValue[] {
  const values = DERIVED_RATIOS.map((item) => {
    const base = shell(
      item.key,
      platform,
      item.pct ? "pct" : "paise",
      "ratio",
      "exact",
      index.days,
    );
    const value = divideParts(base, index, platform, item.numerator, item.denominator, item.pct);
    if (value.value == null && item.zeroWhenEmpty && value.coverageDays > 0) {
      return { ...value, value: 0, status: "ok" as const, reason: undefined, windowMatch: false };
    }
    return value;
  });
  const payout = values.find((value) => value.key === "payout_pct");
  const burn = shell("burn_pct", platform, "pct", "ratio", "exact", index.days);
  values.push(
    payout?.value == null
      ? { ...burn, value: null, status: "not_available", reason: NOT_WINDOW }
      : {
          ...burn,
          value: round4(100 - payout.value),
          coverageDays: payout.coverageDays,
          missingDays: payout.missingDays,
          status: "ok",
        },
  );
  const fees = feeSum(platform, index);
  values.push(fees);
  return values;
}

function feeSum(platform: MetricPlatform, index: DayIndex): RollupValue {
  const base = shell("fees_incl_gst_paise", platform, "paise", "sum", "exact", index.days);
  const parts = ["commission_paise", "platform_fees_paise", "taxes_paise"];
  let total = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const day of index.days) {
    const numbers = parts.map((key) => fact(index, platform, day, key));
    if (numbers.some((value) => value == null)) missing.push(day);
    else {
      total += numbers.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      covered += 1;
    }
  }
  if (covered === 0) return { ...base, missingDays: missing, value: null, status: "ok" };
  return {
    ...base,
    value: round4(total),
    coverageDays: covered,
    missingDays: missing,
    status: "ok",
  };
}

function settlementValues(platform: RollupQuery["platform"], days: string[]): RollupValue[] {
  const keys = platform === "combined" ? CROSS_PLATFORM_KEYS : METRIC_KEYS;
  return keys
    .filter((key) => {
      if (platform === "combined") return true;
      return requireMetric(key).platforms.includes(platform);
    })
    .map((key) => {
      const definition = requireMetric(key);
      return {
        ...shell(
          key,
          platform,
          definition.unit,
          platform === "combined" ? "sum" : definition.kind,
          definition.accuracy,
          days,
        ),
        status: "not_available" as const,
        reason: NOT_SETTLEMENT,
      };
    });
}

function shell(
  key: string,
  platform: MetricPlatform | "combined",
  unit: MetricUnit,
  kind: AggregationKind,
  accuracy: MetricAccuracy,
  days: string[],
): RollupValue {
  return {
    key,
    platform,
    unit,
    kind,
    accuracy,
    value: null,
    status: "ok",
    coverageDays: 0,
    expectedDays: days.length,
    missingDays: [],
    partialDays: [],
    windowMatch: false,
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function comparePlatformValue(
  key: string,
  platform: MetricPlatform,
  granularity: MetricGranularity,
  rebuilt: number | null,
  platformValue: number | null,
):
  | { action: "skip" }
  | { action: "excluded"; reason: string }
  | { action: "check"; gap: number; tolerance: number; pass: boolean } {
  if (rebuilt == null || platformValue == null) return { action: "skip" };
  const definition = metricDefinition(key);
  if (!definition) return { action: "skip" };
  if (
    definition.kind === "platform_only" ||
    definition.kind === "snapshot_latest" ||
    definition.kind === "distinct"
  ) {
    return { action: "skip" };
  }
  const rule = resolveCheck(key as MetricKey, platform, granularity);
  if (rule.mode === "excluded") return { action: "excluded", reason: rule.reason };
  const gap = Math.abs(rebuilt - platformValue);
  const relative = rule.relative ?? (rule.mode === "relative" ? rule.amount : 0);
  const absolute = rule.mode === "relative" ? 0 : rule.amount;
  const tolerance = absolute + Math.abs(platformValue) * relative;
  return {
    action: "check",
    gap: round4(gap),
    tolerance: round4(tolerance),
    pass: gap <= tolerance + 1e-9,
  };
}
