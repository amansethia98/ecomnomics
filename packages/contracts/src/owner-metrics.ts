import * as z from "zod";
import { addIsoDays, daysBetween, isoWeekday } from "./metric-dates.js";
import type {
  AggregationKind,
  MetricAccuracy,
  MetricPlatform,
  MetricUnit,
} from "./metric-dictionary.js";
import { METRIC_KEYS, metricDefinition } from "./metric-dictionary.js";
import type { RollupFact, RollupValue } from "./metric-rollup.js";
import { rollupMetrics } from "./metric-rollup.js";
import {
  NO_CUSTOMER_HASH,
  NO_SETTLED_AMOUNT,
  NOT_CYCLE_TOTAL,
  NOT_SETTLEMENT_FIGURE,
  NOT_ZOMATO_CUSTOMERS,
} from "./payout-read.js";

const METRIC_BASES = ["order_date", "settlement_date"] as const;

/** Computed on read. Kept here so this module does not import the agent schema. */
const DERIVED_KEYS = [
  "effective_discount_pct",
  "ads_pct",
  "payout_pct",
  "burn_pct",
  "fees_incl_gst_paise",
  "ops_aov_paise",
  "gross_aov_paise",
] as const;

const DERIVED_DEPENDENCIES: Record<string, readonly string[]> = {
  effective_discount_pct: ["discount_paise", "gross_sales_paise"],
  ads_pct: ["ad_spend_paise", "gross_sales_paise"],
  payout_pct: ["net_payout_paise", "gross_sales_paise"],
  burn_pct: ["net_payout_paise", "gross_sales_paise"],
  fees_incl_gst_paise: ["commission_paise", "platform_fees_paise", "taxes_paise"],
  ops_aov_paise: ["ops_sales_paise", "delivered_orders"],
  gross_aov_paise: ["gross_sales_paise", "delivered_orders"],
};

export const OWNER_PLATFORMS = ["zomato", "swiggy", "all"] as const;
export type OwnerPlatform = (typeof OWNER_PLATFORMS)[number];

export const OWNER_GRAINS = ["day", "week_mon_sun", "week_sun_sat", "month"] as const;
export type OwnerGrain = (typeof OWNER_GRAINS)[number];

export const MAX_OWNER_RANGE_DAYS = 400;
export const MAX_OWNER_KEYS = 100;

const NOT_PUBLISHED = {
  zomato: "This figure is not published for Zomato.",
  swiggy: "This figure is not published for Swiggy.",
} as const;
const SNAPSHOT_OUTLET = "This figure is a snapshot for one outlet. Ask for one outlet.";
const NO_FULL_COVERAGE = "No outlet has data for every day in this range.";
const NO_OUTLETS = "This restaurant has no outlets.";
const LIKE_FOR_LIKE_NOTE = "The total uses only outlets with data on every day.";

const KNOWN_KEYS = new Set<string>([...METRIC_KEYS, ...DERIVED_KEYS]);

const ORDER_SUM_KEYS = [
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
  "payout_orders",
] as const;

const SETTLEMENT_KEYS = new Set<string>([
  ...ORDER_SUM_KEYS,
  "paid_amount_paise",
  "platform_net_payout_paise",
  "unique_customers",
  "commission_pg_gst_paise",
]);

const PER_OUTLET_KINDS = new Set<AggregationKind>([
  "snapshot_latest",
  "snapshot_mean",
  "platform_only",
  "distinct",
]);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use a date as YYYY-MM-DD." });

export const OwnerMetricsQuerySchema = z
  .object({
    outletIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    platform: z.enum(OWNER_PLATFORMS, { error: "platform must be zomato, swiggy, or all." }),
    from: IsoDate,
    to: IsoDate,
    keys: z.array(z.string().trim().min(1).max(80)),
    basis: z.enum(METRIC_BASES, { error: "basis must be order_date or settlement_date." }),
    grain: z
      .enum(OWNER_GRAINS, {
        error: "grain must be day, week_mon_sun, week_sun_sat, or month.",
      })
      .optional(),
    likeForLike: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!realDate(value.from)) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "Use a date as YYYY-MM-DD." });
    }
    if (!realDate(value.to)) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Use a date as YYYY-MM-DD." });
    }
    if (realDate(value.from) && realDate(value.to) && value.to <= value.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from." });
    }
    if (
      realDate(value.from) &&
      realDate(value.to) &&
      value.to > value.from &&
      daysBetween(value.from, value.to).length > MAX_OWNER_RANGE_DAYS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "A date range can be at most 400 days.",
      });
    }
    if (value.keys.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["keys"],
        message: "Send at least one metric key.",
      });
    }
    if (value.keys.length > MAX_OWNER_KEYS) {
      ctx.addIssue({
        code: "custom",
        path: ["keys"],
        message: "Send at most 100 metric keys.",
      });
    }
    const unknown = [...new Set(value.keys.filter((key) => !KNOWN_KEYS.has(key)))];
    if (unknown.length > 0) {
      const quoted = unknown.map((key) => `"${key}"`).join(", ");
      ctx.addIssue({
        code: "custom",
        path: ["keys"],
        message: `Unknown metric key ${quoted}.`,
      });
    }
    if (value.outletIds?.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["outletIds"],
        message: "Name at least one outlet, or omit outletIds to read every outlet.",
      });
    }
  })
  .transform((value) => {
    const { outletIds, ...rest } = value;
    return {
      ...rest,
      keys: [...new Set(value.keys)],
      ...(outletIds ? { outletIds: [...new Set(outletIds)] } : {}),
    };
  });

export type OwnerMetricsQuery = z.infer<typeof OwnerMetricsQuerySchema>;

export function ownerMetricsErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "ZodError") return null;
  const issues = (error as { issues?: Array<{ message?: string }> }).issues;
  const message = issues?.[0]?.message;
  return message && message.length > 0 ? message : "The metrics request is not valid.";
}

export interface OwnerOutletRef {
  id: string;
  name: string;
}

export interface OwnerMetricFact {
  outletId: string;
  platform: MetricPlatform;
  key: string;
  date: string;
  value: number | null;
  valueBoolean: boolean | null;
  granularity: string;
  periodEnd: string;
}

export interface OwnerFetchSpan {
  outletId: string;
  platform: MetricPlatform;
  from: string;
  to: string;
  status: string;
}

export interface OwnerHistoryMark {
  outletId: string;
  platform: MetricPlatform;
  key: string;
  /** Inclusive civil start of the superseded window. */
  from: string;
  /** Exclusive civil end of the superseded window. */
  to: string;
}

export interface OwnerOrderFact {
  outletId: string;
  platform: MetricPlatform;
  orderDate: string;
  settlementStatus: "settled" | "pending";
  settlementDate: string | null;
  utrLast4: string | null;
  category: string | null;
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
  paidAmountPaise: number | null;
}

export interface OwnerAdjustmentFact {
  outletId: string;
  platform: MetricPlatform;
  type: string;
  periodFrom: string;
  periodTo: string;
  amountPaise: number;
  settlementDate: string | null;
  settlementStatus: "settled" | "pending";
}

export interface OwnerCycleFact {
  outletId: string;
  platform: MetricPlatform;
  settlementStatus: "settled" | "pending";
  settlementDate: string | null;
  utrLast4: string | null;
  platformNetPayoutPaise: number | null;
  paidAmountPaise: number | null;
}

export interface OwnerMetricValue {
  key: string;
  platform: OwnerPlatform;
  unit: MetricUnit | "pct" | "paise" | "count";
  kind: AggregationKind;
  accuracy: MetricAccuracy;
  value: number | null;
  status: "ok" | "not_available";
  reason?: string;
  coverageDays: number;
  expectedDays: number;
  missingDates: string[];
  partialDates: string[];
  provisional: boolean;
  restated: boolean;
}

export interface OwnerAdjustmentLine {
  amountPaise: number;
  byDate: Array<{ date: string; amountPaise: number }>;
}

export interface OwnerMetricsGap {
  settledFromEarlierPaise: number;
  notYetSettledPaise: number;
  adjustmentsPaise: number;
}

export interface OwnerMetricsSeriesPoint {
  from: string;
  to: string;
  restated: boolean;
  provisional: boolean;
  values: OwnerMetricValue[];
  adjustments: OwnerAdjustmentLine;
}

export interface OwnerMetricsResponse {
  basis: "order_date" | "settlement_date";
  platform: OwnerPlatform;
  from: string;
  to: string;
  grain: OwnerGrain | null;
  likeForLike: boolean;
  provisional: boolean;
  lagBanner: boolean | null;
  outlets: Array<{
    id: string;
    name: string;
    partial: boolean;
    partialDates: string[];
    included: boolean;
  }>;
  note: string | null;
  values: OwnerMetricValue[];
  series: OwnerMetricsSeriesPoint[] | null;
  adjustments: OwnerAdjustmentLine;
  gap: OwnerMetricsGap;
  settlements: Array<{
    outletId: string;
    platform: MetricPlatform;
    settlementDate: string;
    utrLast4: string | null;
  }>;
  categories: Array<{
    platform: "swiggy";
    category: string;
    orders: number;
    grossSalesPaise: number;
    netPayoutPaise: number;
  }>;
}

export interface OwnerMetricsInput {
  query: OwnerMetricsQuery;
  today: string;
  outlets: readonly OwnerOutletRef[];
  facts: readonly OwnerMetricFact[];
  fetches: readonly OwnerFetchSpan[];
  history: readonly OwnerHistoryMark[];
  orders: readonly OwnerOrderFact[];
  adjustments: readonly OwnerAdjustmentFact[];
  cycles: readonly OwnerCycleFact[];
}

/** Keys the read has to load so a ratio can be rebuilt from its parts. */
export function ownerMetricLoadKeys(keys: readonly string[]): string[] {
  const needed = new Set<string>(keys);
  needed.add("lag_banner");
  for (const key of keys) {
    const definition = metricDefinition(key);
    if (definition) {
      if (definition.numeratorKey) needed.add(definition.numeratorKey);
      if (definition.denominatorKey) needed.add(definition.denominatorKey);
      if (definition.valueKey) needed.add(definition.valueKey);
      if (definition.weightKey) needed.add(definition.weightKey);
      for (const extra of Object.values(definition.numeratorByPlatform ?? {})) {
        if (extra) needed.add(extra);
      }
      if (definition.formula === "zomato_ads_roi") {
        for (const part of [
          "ads_sales_paise",
          "discount_paise",
          "ad_orders",
          "ad_spend_paise",
          "delivered_orders",
        ]) {
          needed.add(part);
        }
      }
    }
    for (const part of DERIVED_DEPENDENCIES[key] ?? []) needed.add(part);
  }
  return [...needed];
}

export function assembleOwnerMetrics(input: OwnerMetricsInput): OwnerMetricsResponse {
  const { query } = input;
  const days = daysBetween(query.from, query.to);
  const platforms = query.platform === "all" ? (["zomato", "swiggy"] as const) : [query.platform];
  const selected = resolveOutlets(input, days, platforms);
  const included = new Set(selected.filter((outlet) => outlet.included).map((outlet) => outlet.id));
  const window = readWindow(input, query.from, query.to, included, platforms, days);
  const series = query.grain
    ? bucketRanges(query.from, query.to, query.grain).map((bucket) => {
        const bucketDays = daysBetween(bucket.from, bucket.to);
        const point = readWindow(input, bucket.from, bucket.to, included, platforms, bucketDays);
        return {
          from: bucket.from,
          to: bucket.to,
          restated: point.values.some((value) => value.restated),
          provisional: point.values.some((value) => value.provisional),
          values: point.values,
          adjustments: point.adjustments,
        };
      })
    : null;
  return {
    basis: query.basis,
    platform: query.platform,
    from: query.from,
    to: query.to,
    grain: query.grain ?? null,
    likeForLike: query.likeForLike,
    provisional: window.values.some((value) => value.provisional) || window.lagTouches,
    lagBanner: lagBanner(input, query.from, query.to, included),
    outlets: selected,
    note: partialNote(selected, query.likeForLike),
    values: window.values,
    series,
    adjustments: window.adjustments,
    gap: window.gap,
    settlements:
      query.basis === "settlement_date" ? settlementsIn(input, query.from, query.to, included) : [],
    categories: categoriesIn(input, query, included),
  };
}

function resolveOutlets(
  input: OwnerMetricsInput,
  days: readonly string[],
  platforms: readonly MetricPlatform[],
): OwnerMetricsResponse["outlets"] {
  const listed = input.query.outletIds
    ? input.outlets.filter((outlet) => input.query.outletIds?.includes(outlet.id))
    : input.outlets;
  return listed.map((outlet) => {
    const partialDates = uncoveredDays(input, outlet.id, days, platforms);
    const partial = partialDates.length > 0;
    const included = input.query.likeForLike ? !partial : true;
    return { ...outlet, partial, partialDates, included };
  });
}

function uncoveredDays(
  input: OwnerMetricsInput,
  outletId: string,
  days: readonly string[],
  platforms: readonly MetricPlatform[],
): string[] {
  const covered = new Set<string>();
  for (const fact of input.facts) {
    if (fact.outletId !== outletId || !platforms.includes(fact.platform)) continue;
    if (fact.value == null && fact.valueBoolean == null) continue;
    if (fact.granularity === "day") covered.add(fact.date);
  }
  for (const fetch of input.fetches) {
    if (fetch.outletId !== outletId || fetch.status !== "stored") continue;
    if (!platforms.includes(fetch.platform)) continue;
    for (const day of days) {
      if (day >= fetch.from && day < fetch.to) covered.add(day);
    }
  }
  for (const order of input.orders) {
    if (order.outletId !== outletId || !platforms.includes(order.platform)) continue;
    const date = input.query.basis === "settlement_date" ? order.settlementDate : order.orderDate;
    if (date) covered.add(date);
  }
  return days.filter((day) => !covered.has(day));
}

function readWindow(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platforms: readonly MetricPlatform[],
  days: readonly string[],
): {
  values: OwnerMetricValue[];
  adjustments: OwnerAdjustmentLine;
  gap: OwnerMetricsGap;
  lagTouches: boolean;
} {
  const adjustments = adjustmentLine(input, from, to, included);
  const gap = gapLine(input, from, to, included, adjustments.amountPaise);
  if (included.size === 0) {
    const reason = input.outlets.length === 0 ? NO_OUTLETS : NO_FULL_COVERAGE;
    return {
      values: input.query.keys.map((key) =>
        unavailable(key, input.query.platform, reason, days.length),
      ),
      adjustments,
      gap,
      lagTouches: false,
    };
  }
  const values =
    input.query.basis === "settlement_date"
      ? settlementValues(input, from, to, included, platforms, days)
      : orderValues(input, from, to, included, platforms, days);
  return {
    values,
    adjustments,
    gap,
    lagTouches: values.some((value) => value.provisional),
  };
}

function orderValues(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platforms: readonly MetricPlatform[],
  days: readonly string[],
): OwnerMetricValue[] {
  const prepared = prepareOrderFacts(input, from, to, included, platforms);
  const rolled = new Map<MetricPlatform, Map<string, RollupValue>>();
  for (const platform of platforms) {
    rolled.set(
      platform,
      indexRollup(
        rollupMetrics(prepared.byPlatform.get(platform) ?? [], {
          platform,
          from,
          to,
          today: input.today,
          basis: "order_date",
        }),
      ),
    );
  }
  const combined =
    input.query.platform === "all"
      ? indexRollup(
          rollupMetrics(
            platforms.flatMap((platform) => prepared.byPlatform.get(platform) ?? []),
            {
              platform: "combined",
              from,
              to,
              today: input.today,
              basis: "order_date",
            },
          ),
        )
      : undefined;
  const payoutPlatforms = new Set(
    input.orders.filter((order) => included.has(order.outletId)).map((order) => order.platform),
  );
  for (const cycle of input.cycles) {
    if (included.has(cycle.outletId)) payoutPlatforms.add(cycle.platform);
  }
  return input.query.keys.flatMap((key) =>
    placeKey(input, key, from, to, included, platforms, days, rolled, combined, (platform) => {
      if (
        (key === "paid_amount_paise" || key === "platform_net_payout_paise") &&
        payoutPlatforms.has(platform)
      ) {
        return unavailable(key, platform, NOT_CYCLE_TOTAL, days.length);
      }
      if (key === "unique_customers")
        return customers(input, from, to, included, platform, "order_date", days);
      if (key === "commission_pg_gst_paise" && payoutPlatforms.has(platform)) {
        return commissionGst(input, from, to, included, platform, "order_date", days);
      }
      return undefined;
    }),
  );
}

function settlementValues(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platforms: readonly MetricPlatform[],
  days: readonly string[],
): OwnerMetricValue[] {
  const prepared = prepareSettlementFacts(input, from, to, included, platforms);
  const rolled = new Map<MetricPlatform, Map<string, RollupValue>>();
  for (const platform of platforms) {
    rolled.set(
      platform,
      indexRollup(
        rollupMetrics(prepared.get(platform) ?? [], {
          platform,
          from,
          to,
          today: input.today,
          basis: "order_date",
        }),
      ),
    );
  }
  const combined =
    input.query.platform === "all"
      ? indexRollup(
          rollupMetrics(
            platforms.flatMap((platform) => prepared.get(platform) ?? []),
            {
              platform: "combined",
              from,
              to,
              today: input.today,
              basis: "order_date",
            },
          ),
        )
      : undefined;
  return input.query.keys.flatMap((key) => {
    if (!SETTLEMENT_KEYS.has(key)) {
      const described = describeKey(key);
      const platform =
        input.query.platform === "all" && described?.crossPlatform && described.kind === "sum"
          ? "all"
          : (platformsForKey(input, key, platforms)[0] ?? "zomato");
      if (
        input.query.platform === "all" &&
        !(described?.crossPlatform && described.kind === "sum")
      ) {
        return platformsForKey(input, key, platforms).map((name) =>
          unavailable(key, name, NOT_SETTLEMENT_FIGURE, days.length),
        );
      }
      return [unavailable(key, platform, NOT_SETTLEMENT_FIGURE, days.length)];
    }
    return placeKey(
      input,
      key,
      from,
      to,
      included,
      platforms,
      days,
      rolled,
      combined,
      (platform) => {
        if (key === "paid_amount_paise")
          return paidAmount(input, from, to, included, platform, days);
        if (key === "platform_net_payout_paise") {
          return platformNet(input, from, to, included, platform, days);
        }
        if (key === "unique_customers") {
          return customers(input, from, to, included, platform, "settlement_date", days);
        }
        if (key === "commission_pg_gst_paise") {
          return commissionGst(input, from, to, included, platform, "settlement_date", days);
        }
        return undefined;
      },
    );
  });
}

function combineOverrides(
  key: string,
  overrides: readonly OwnerMetricValue[],
  expectedDays: number,
): OwnerMetricValue {
  const blocked = overrides.find((value) => value.status === "not_available");
  if (blocked) return { ...blocked, platform: "all" };
  const described = describeKey(key);
  return okValue(
    key,
    "all",
    described?.unit ?? "paise",
    "sum",
    described?.accuracy ?? "exact",
    overrides.reduce((total, value) => total + (value.value ?? 0), 0),
    expectedDays,
    [],
  );
}

function placeKey(
  input: OwnerMetricsInput,
  key: string,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platforms: readonly MetricPlatform[],
  days: readonly string[],
  rolled: Map<MetricPlatform, Map<string, RollupValue>>,
  combined: Map<string, RollupValue> | undefined,
  special: (platform: MetricPlatform) => OwnerMetricValue | undefined,
): OwnerMetricValue[] {
  const described = describeKey(key);
  if (!described)
    return [
      unavailable(key, platforms[0] ?? "zomato", `Unknown metric key "${key}".`, days.length),
    ];
  const many = included.size > 1;
  if (input.query.platform === "all" && described.crossPlatform && described.kind === "sum") {
    const overrides = described.platforms
      .filter((platform) => platforms.includes(platform))
      .map((platform) => special(platform))
      .filter((value): value is OwnerMetricValue => value != null);
    if (overrides.length > 0) {
      return [
        finish(
          input,
          combineOverrides(key, overrides, days.length),
          key,
          "all",
          from,
          to,
          included,
        ),
      ];
    }
    const found = combined?.get(key);
    return [
      finish(
        input,
        found
          ? fromRollup(found, days.length)
          : unavailable(key, "all", NOT_SETTLEMENT_FIGURE, days.length),
        key,
        "all",
        from,
        to,
        included,
      ),
    ];
  }
  const targets =
    input.query.platform === "all"
      ? described.platforms.filter((platform) => platforms.includes(platform))
      : [input.query.platform];
  if (targets.length === 0) {
    const platform = input.query.platform === "all" ? "swiggy" : input.query.platform;
    return [unavailable(key, platform, NOT_PUBLISHED[platform], days.length)];
  }
  return targets.map((platform) => {
    if (input.query.platform !== "all" && !described.platforms.includes(platform)) {
      return finish(
        input,
        unavailable(key, platform, NOT_PUBLISHED[platform], days.length),
        key,
        platform,
        from,
        to,
        included,
      );
    }
    if (many && PER_OUTLET_KINDS.has(described.kind) && key !== "unique_customers") {
      return finish(
        input,
        unavailable(key, platform, SNAPSHOT_OUTLET, days.length),
        key,
        platform,
        from,
        to,
        included,
      );
    }
    const override = special(platform);
    if (override) return finish(input, override, key, platform, from, to, included);
    const found = rolled.get(platform)?.get(key);
    return finish(
      input,
      found
        ? fromRollup(found, days.length)
        : unavailable(key, platform, NOT_SETTLEMENT_FIGURE, days.length),
      key,
      platform,
      from,
      to,
      included,
    );
  });
}

function prepareOrderFacts(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platforms: readonly MetricPlatform[],
): { byPlatform: Map<MetricPlatform, RollupFact[]> } {
  const totals = new Map<string, number>();
  const single = included.size === 1 ? [...included][0] : undefined;
  const windows: RollupFact[] = [];
  for (const fact of input.facts) {
    if (!included.has(fact.outletId) || !platforms.includes(fact.platform)) continue;
    if (fact.granularity !== "day") {
      if (single && fact.periodEnd === to && fact.date === from && fact.value != null) {
        windows.push(
          toRollup(
            fact.platform,
            fact.key,
            fact.date,
            fact.periodEnd,
            fact.value,
            fact.granularity,
          ),
        );
      }
      continue;
    }
    if (fact.date < from || fact.date >= to || fact.value == null) continue;
    const slot = slotOf(fact.platform, fact.date, fact.key);
    totals.set(slot, (totals.get(slot) ?? 0) + fact.value);
  }
  const grouped = new Map<string, OwnerOrderFact[]>();
  for (const order of input.orders) {
    if (!included.has(order.outletId) || !platforms.includes(order.platform)) continue;
    if (order.orderDate < from || order.orderDate >= to) continue;
    const slot = `${order.platform}|${order.orderDate}`;
    const list = grouped.get(slot) ?? [];
    list.push(order);
    grouped.set(slot, list);
  }
  for (const [slot, orders] of grouped) {
    const [platform, date] = slot.split("|") as [MetricPlatform, string];
    for (const key of ORDER_SUM_KEYS) {
      totals.set(slotOf(platform, date, key), sumOrderKey(orders, key));
    }
  }
  const byPlatform = new Map<MetricPlatform, RollupFact[]>();
  for (const platform of platforms) byPlatform.set(platform, []);
  for (const [slot, value] of totals) {
    const [platform, date, key] = slot.split("|") as [MetricPlatform, string, string];
    byPlatform
      .get(platform)
      ?.push(toRollup(platform, key, date, addIsoDays(date, 1), value, "day"));
  }
  for (const fact of windows) byPlatform.get(fact.platform)?.push(fact);
  return { byPlatform };
}

function prepareSettlementFacts(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platforms: readonly MetricPlatform[],
): Map<MetricPlatform, RollupFact[]> {
  const grouped = new Map<string, OwnerOrderFact[]>();
  for (const order of input.orders) {
    if (!included.has(order.outletId) || !platforms.includes(order.platform)) continue;
    if (order.settlementStatus !== "settled" || !order.settlementDate) continue;
    if (order.settlementDate < from || order.settlementDate >= to) continue;
    const slot = `${order.platform}|${order.settlementDate}`;
    const list = grouped.get(slot) ?? [];
    list.push(order);
    grouped.set(slot, list);
  }
  const byPlatform = new Map<MetricPlatform, RollupFact[]>();
  for (const platform of platforms) byPlatform.set(platform, []);
  for (const [slot, orders] of grouped) {
    const [platform, date] = slot.split("|") as [MetricPlatform, string];
    for (const key of ORDER_SUM_KEYS) {
      byPlatform
        .get(platform)
        ?.push(toRollup(platform, key, date, addIsoDays(date, 1), sumOrderKey(orders, key), "day"));
    }
  }
  return byPlatform;
}

function adjustmentLine(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
): OwnerAdjustmentLine {
  const byDate = new Map<string, number>();
  for (const row of input.adjustments) {
    if (!included.has(row.outletId)) continue;
    if (input.query.platform !== "all" && row.platform !== input.query.platform) continue;
    if (input.query.basis === "settlement_date") {
      if (!row.settlementDate || row.settlementDate < from || row.settlementDate >= to) continue;
      byDate.set(row.settlementDate, (byDate.get(row.settlementDate) ?? 0) + row.amountPaise);
      continue;
    }
    for (const [date, share] of spreadShares(row.periodFrom, row.periodTo, row.amountPaise)) {
      if (date < from || date >= to) continue;
      byDate.set(date, (byDate.get(date) ?? 0) + share);
    }
  }
  const entries = [...byDate.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amountPaise]) => ({ date, amountPaise }));
  return {
    amountPaise: entries.reduce((total, entry) => total + entry.amountPaise, 0),
    byDate: entries,
  };
}

/** Integer paise spread across each civil day of the adjustment's own period. */
export function spreadShares(
  periodFrom: string,
  periodTo: string,
  amountPaise: number,
): Array<[string, number]> {
  const days = daysBetween(periodFrom, periodTo);
  if (days.length === 0) return [];
  const base = Math.trunc(amountPaise / days.length);
  let remainder = amountPaise - base * days.length;
  return days.map((day) => {
    let share = base;
    if (remainder > 0) {
      share += 1;
      remainder -= 1;
    } else if (remainder < 0) {
      share -= 1;
      remainder += 1;
    }
    return [day, share];
  });
}

function gapLine(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  adjustmentsPaise: number,
): OwnerMetricsGap {
  let settledFromEarlierPaise = 0;
  let notYetSettledPaise = 0;
  for (const order of input.orders) {
    if (!included.has(order.outletId)) continue;
    if (input.query.platform !== "all" && order.platform !== input.query.platform) continue;
    if (
      order.settlementStatus === "settled" &&
      order.settlementDate &&
      order.settlementDate >= from &&
      order.settlementDate < to &&
      order.orderDate < from
    ) {
      settledFromEarlierPaise += order.netPayoutPaise;
    }
    if (order.settlementStatus === "pending" && order.orderDate >= from && order.orderDate < to) {
      notYetSettledPaise += order.netPayoutPaise;
    }
  }
  return { settledFromEarlierPaise, notYetSettledPaise, adjustmentsPaise };
}

function customers(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platform: MetricPlatform,
  basis: "order_date" | "settlement_date",
  days: readonly string[],
): OwnerMetricValue {
  if (platform !== "zomato")
    return unavailable("unique_customers", platform, NOT_ZOMATO_CUSTOMERS, days.length);
  const orders = input.orders.filter((order) => {
    if (!included.has(order.outletId) || order.platform !== "zomato") return false;
    if (basis === "order_date") return order.orderDate >= from && order.orderDate < to;
    return (
      order.settlementStatus === "settled" &&
      order.settlementDate != null &&
      order.settlementDate >= from &&
      order.settlementDate < to
    );
  });
  if (orders.length === 0) {
    return {
      ...unavailable(
        "unique_customers",
        platform,
        "Distinct customers are counted from payout orders, which are not stored yet.",
        days.length,
      ),
      status: "not_available",
    };
  }
  if (orders.some((order) => order.customerHash == null)) {
    return unavailable("unique_customers", platform, NO_CUSTOMER_HASH, days.length);
  }
  return okValue(
    "unique_customers",
    platform,
    "count",
    "distinct",
    "exact",
    new Set(orders.map((order) => order.customerHash)).size,
    days.length,
    [],
  );
}

function paidAmount(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platform: MetricPlatform,
  days: readonly string[],
): OwnerMetricValue {
  const cycles = input.cycles.filter(
    (cycle) =>
      included.has(cycle.outletId) &&
      cycle.platform === platform &&
      cycle.settlementDate != null &&
      cycle.settlementDate >= from &&
      cycle.settlementDate < to,
  );
  if (cycles.length === 0 || cycles.some((cycle) => cycle.paidAmountPaise == null)) {
    return unavailable("paid_amount_paise", platform, NO_SETTLED_AMOUNT, days.length);
  }
  return okValue(
    "paid_amount_paise",
    platform,
    "paise",
    "sum",
    "exact",
    cycles.reduce((total, cycle) => total + (cycle.paidAmountPaise ?? 0), 0),
    days.length,
    [],
  );
}

function platformNet(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platform: MetricPlatform,
  days: readonly string[],
): OwnerMetricValue {
  const cycles = input.cycles.filter(
    (cycle) =>
      included.has(cycle.outletId) &&
      cycle.platform === platform &&
      cycle.settlementDate != null &&
      cycle.settlementDate >= from &&
      cycle.settlementDate < to,
  );
  if (cycles.length === 0 || cycles.some((cycle) => cycle.platformNetPayoutPaise == null)) {
    return unavailable(
      "platform_net_payout_paise",
      platform,
      "The platform's cycle total is not stored for this window.",
      days.length,
    );
  }
  return okValue(
    "platform_net_payout_paise",
    platform,
    "paise",
    "sum",
    "exact",
    cycles.reduce((total, cycle) => total + (cycle.platformNetPayoutPaise ?? 0), 0),
    days.length,
    [],
  );
}

function commissionGst(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
  platform: MetricPlatform,
  basis: "order_date" | "settlement_date",
  days: readonly string[],
): OwnerMetricValue {
  const orders = input.orders.filter((order) => {
    if (!included.has(order.outletId) || order.platform !== platform) return false;
    if (basis === "order_date") return order.orderDate >= from && order.orderDate < to;
    return (
      order.settlementStatus === "settled" &&
      order.settlementDate != null &&
      order.settlementDate >= from &&
      order.settlementDate < to
    );
  });
  const fees = orders.reduce(
    (total, order) => total + order.commissionPaise + order.platformFeesPaise,
    0,
  );
  const taxes = orders.reduce((total, order) => total + order.taxesPaise, 0);
  return okValue(
    "commission_pg_gst_paise",
    platform,
    "paise",
    "sum",
    "exact",
    platform === "swiggy" ? fees : fees + taxes,
    days.length,
    [],
  );
}

function finish(
  input: OwnerMetricsInput,
  value: OwnerMetricValue,
  key: string,
  platform: OwnerPlatform,
  from: string,
  to: string,
  included: ReadonlySet<string>,
): OwnerMetricValue {
  const refetch =
    input.query.basis === "order_date" &&
    overlaps(from, to, addIsoDays(input.today, -7), addIsoDays(input.today, 1));
  const pending = input.orders.some((order) => {
    if (!included.has(order.outletId) || order.settlementStatus !== "pending") return false;
    if (platform !== "all" && order.platform !== platform) return false;
    const date = input.query.basis === "settlement_date" ? order.settlementDate : order.orderDate;
    return date != null && date >= from && date < to;
  });
  const lagged =
    lagBanner(input, from, to, included) === true && (platform === "swiggy" || platform === "all");
  return {
    ...value,
    platform,
    provisional: value.status === "ok" && (refetch || pending || lagged),
    restated: restated(input, key, platform, from, to, included),
  };
}

function restated(
  input: OwnerMetricsInput,
  key: string,
  platform: OwnerPlatform,
  from: string,
  to: string,
  included: ReadonlySet<string>,
): boolean {
  return input.history.some(
    (mark) =>
      included.has(mark.outletId) &&
      mark.key === key &&
      (platform === "all" || mark.platform === platform) &&
      mark.from < to &&
      mark.to > from,
  );
}

function lagBanner(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
): boolean | null {
  if (input.query.platform === "zomato") return null;
  let latest: { date: string; value: boolean } | undefined;
  for (const fact of input.facts) {
    if (fact.key !== "lag_banner" || fact.platform !== "swiggy") continue;
    if (!included.has(fact.outletId) || fact.date < from || fact.date >= to) continue;
    const value = fact.valueBoolean ?? (fact.value == null ? null : fact.value !== 0);
    if (value == null) continue;
    if (!latest || fact.date >= latest.date) latest = { date: fact.date, value };
  }
  return latest ? latest.value : null;
}

function settlementsIn(
  input: OwnerMetricsInput,
  from: string,
  to: string,
  included: ReadonlySet<string>,
): OwnerMetricsResponse["settlements"] {
  const seen = new Set<string>();
  const rows: OwnerMetricsResponse["settlements"] = [];
  const push = (
    outletId: string,
    platform: MetricPlatform,
    settlementDate: string | null,
    utrLast4: string | null,
  ) => {
    if (!included.has(outletId) || !settlementDate) return;
    if (input.query.platform !== "all" && platform !== input.query.platform) return;
    if (settlementDate < from || settlementDate >= to) return;
    const slot = `${outletId}|${platform}|${settlementDate}|${utrLast4 ?? ""}`;
    if (seen.has(slot)) return;
    seen.add(slot);
    rows.push({ outletId, platform, settlementDate, utrLast4 });
  };
  for (const order of input.orders) {
    if (order.settlementStatus !== "settled") continue;
    push(order.outletId, order.platform, order.settlementDate, order.utrLast4);
  }
  for (const cycle of input.cycles) {
    if (cycle.settlementStatus !== "settled") continue;
    push(cycle.outletId, cycle.platform, cycle.settlementDate, cycle.utrLast4);
  }
  return rows.sort((a, b) =>
    `${a.settlementDate}|${a.outletId}|${a.platform}`.localeCompare(
      `${b.settlementDate}|${b.outletId}|${b.platform}`,
    ),
  );
}

function categoriesIn(
  input: OwnerMetricsInput,
  query: OwnerMetricsQuery,
  included: ReadonlySet<string>,
): OwnerMetricsResponse["categories"] {
  if (query.platform === "zomato") return [];
  const groups = new Map<
    string,
    { orders: number; grossSalesPaise: number; netPayoutPaise: number }
  >();
  for (const order of input.orders) {
    if (order.platform !== "swiggy" || !included.has(order.outletId)) continue;
    const date = query.basis === "settlement_date" ? order.settlementDate : order.orderDate;
    if (!date || date < query.from || date >= query.to) continue;
    if (query.basis === "settlement_date" && order.settlementStatus !== "settled") continue;
    const category = categoryLabel(order.category);
    const group = groups.get(category) ?? { orders: 0, grossSalesPaise: 0, netPayoutPaise: 0 };
    group.orders += 1;
    group.grossSalesPaise += order.grossSalesPaise;
    group.netPayoutPaise += order.netPayoutPaise;
    groups.set(category, group);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, group]) => ({ platform: "swiggy" as const, category, ...group }));
}

function categoryLabel(value: string | null): string {
  const text = value?.trim().toLowerCase() ?? "";
  if (text.includes("train")) return "train";
  if (text.includes("toing")) return "toing";
  return text || "other";
}

function partialNote(
  outlets: OwnerMetricsResponse["outlets"],
  likeForLike: boolean,
): string | null {
  const partial = outlets.filter((outlet) => outlet.partial);
  if (partial.length === 0) return null;
  const sentences = partial.map(
    (outlet) => `${outlet.name} has no data on ${listDates(outlet.partialDates)}.`,
  );
  if (likeForLike) sentences.push(LIKE_FOR_LIKE_NOTE);
  return sentences.join(" ");
}

function listDates(dates: readonly string[]): string {
  if (dates.length <= 8) return dates.join(", ");
  return `${dates.length} days, from ${dates[0]} through ${dates[dates.length - 1]}`;
}

export function bucketRanges(
  from: string,
  to: string,
  grain: OwnerGrain,
): Array<{ from: string; to: string }> {
  const buckets: Array<{ from: string; to: string }> = [];
  let cursor = from;
  while (cursor < to) {
    const start = bucketStart(cursor, grain);
    const end =
      grain === "day"
        ? addIsoDays(cursor, 1)
        : grain === "month"
          ? monthAfter(start)
          : addIsoDays(start, 7);
    const clippedFrom = start < from ? from : start;
    const clippedTo = end > to ? to : end;
    buckets.push({ from: clippedFrom, to: clippedTo });
    cursor = end > cursor ? end : addIsoDays(cursor, 1);
    if (cursor <= clippedFrom) cursor = addIsoDays(clippedFrom, 1);
  }
  return buckets;
}

function bucketStart(day: string, grain: OwnerGrain): string {
  if (grain === "day") return day;
  if (grain === "month") return `${day.slice(0, 7)}-01`;
  const weekday = isoWeekday(day);
  if (grain === "week_mon_sun") return addIsoDays(day, weekday === 0 ? -6 : 1 - weekday);
  return addIsoDays(day, -weekday);
}

function monthAfter(first: string): string {
  const [year, month] = first.split("-").map(Number);
  const nextMonth = (month ?? 1) + 1;
  if (nextMonth === 13) return `${(year ?? 0) + 1}-01-01`;
  return `${year}-${String(nextMonth).padStart(2, "0")}-01`;
}

function platformsForKey(
  input: OwnerMetricsInput,
  key: string,
  platforms: readonly MetricPlatform[],
) {
  const described = describeKey(key);
  if (!described) return platforms;
  if (input.query.platform !== "all") return [input.query.platform];
  const published = described.platforms.filter((platform) => platforms.includes(platform));
  return published.length > 0 ? published : platforms;
}

interface KeyShape {
  unit: OwnerMetricValue["unit"];
  kind: AggregationKind;
  accuracy: MetricAccuracy;
  crossPlatform: boolean;
  platforms: readonly MetricPlatform[];
}

function describeKey(key: string): KeyShape | undefined {
  const definition = metricDefinition(key);
  if (definition) return definition;
  const derived: Record<string, KeyShape> = {
    effective_discount_pct: ratioShape(false),
    ads_pct: ratioShape(false),
    payout_pct: ratioShape(false),
    burn_pct: ratioShape(false),
    ops_aov_paise: {
      unit: "paise",
      kind: "ratio",
      accuracy: "exact",
      crossPlatform: false,
      platforms: ["zomato", "swiggy"],
    },
    gross_aov_paise: {
      unit: "paise",
      kind: "ratio",
      accuracy: "exact",
      crossPlatform: false,
      platforms: ["zomato", "swiggy"],
    },
    fees_incl_gst_paise: {
      unit: "paise",
      kind: "sum",
      accuracy: "exact",
      crossPlatform: false,
      platforms: ["zomato", "swiggy"],
    },
  };
  return derived[key];
}

function ratioShape(crossPlatform: boolean): KeyShape {
  return {
    unit: "pct",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform,
    platforms: ["zomato", "swiggy"],
  };
}

function indexRollup(rollup: { values: RollupValue[] }): Map<string, RollupValue> {
  return new Map(rollup.values.map((value) => [value.key, value]));
}

function fromRollup(value: RollupValue, expectedDays: number): OwnerMetricValue {
  return {
    key: value.key,
    platform: value.platform === "combined" ? "all" : value.platform,
    unit: value.unit,
    kind: value.kind,
    accuracy: value.accuracy,
    value: value.value,
    status: value.status,
    reason: value.reason,
    coverageDays: value.coverageDays,
    expectedDays: value.expectedDays || expectedDays,
    missingDates: value.missingDays,
    partialDates: value.partialDays,
    provisional: false,
    restated: false,
  };
}

function okValue(
  key: string,
  platform: OwnerPlatform,
  unit: OwnerMetricValue["unit"],
  kind: AggregationKind,
  accuracy: MetricAccuracy,
  value: number,
  expectedDays: number,
  missingDates: string[],
): OwnerMetricValue {
  return {
    key,
    platform,
    unit,
    kind,
    accuracy,
    value,
    status: "ok",
    coverageDays: expectedDays - missingDates.length,
    expectedDays,
    missingDates,
    partialDates: [],
    provisional: false,
    restated: false,
  };
}

function unavailable(
  key: string,
  platform: OwnerPlatform,
  reason: string,
  expectedDays: number,
): OwnerMetricValue {
  const described = describeKey(key);
  return {
    key,
    platform,
    unit: described?.unit ?? "count",
    kind: described?.kind ?? "sum",
    accuracy: described?.accuracy ?? "exact",
    value: null,
    status: "not_available",
    reason,
    coverageDays: 0,
    expectedDays,
    missingDates: [],
    partialDates: [],
    provisional: false,
    restated: false,
  };
}

function sumOrderKey(
  orders: readonly OwnerOrderFact[],
  key: (typeof ORDER_SUM_KEYS)[number],
): number {
  if (key === "payout_orders") return orders.length;
  const field = {
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
    net_payout_paise: "netPayoutPaise",
  } as const;
  const name = field[key as keyof typeof field];
  return orders.reduce((total, order) => total + order[name], 0);
}

function toRollup(
  platform: MetricPlatform,
  key: string,
  periodStart: string,
  periodEnd: string,
  value: number,
  granularity: string,
): RollupFact {
  return { key, platform, granularity, periodStart, periodEnd, value, rowRole: "fact" };
}

function slotOf(platform: string, date: string, key: string): string {
  return `${platform}|${date}|${key}`;
}

function overlaps(from: string, to: string, start: string, end: string): boolean {
  return from < end && to > start;
}

function realDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
  );
}
