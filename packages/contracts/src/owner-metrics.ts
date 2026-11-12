import * as z from "zod";
import { daysBetween } from "./metric-dates.js";
import type {
  AggregationKind,
  MetricAccuracy,
  MetricPlatform,
  MetricUnit,
} from "./metric-dictionary.js";
import { METRIC_KEYS } from "./metric-dictionary.js";

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

export const OWNER_PLATFORMS = ["zomato", "swiggy", "all"] as const;
export type OwnerPlatform = (typeof OWNER_PLATFORMS)[number];

export const OWNER_GRAINS = ["day", "week_mon_sun", "week_sun_sat", "month"] as const;
export type OwnerGrain = (typeof OWNER_GRAINS)[number];

export const MAX_OWNER_RANGE_DAYS = 400;
export const MAX_OWNER_KEYS = 100;

const KNOWN_KEYS = new Set<string>([...METRIC_KEYS, ...DERIVED_KEYS]);

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
