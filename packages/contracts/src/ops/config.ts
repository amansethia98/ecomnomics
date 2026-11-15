import { z } from "zod";

/**
 * One operator-facing number. Every default is a placeholder until the
 * operator signs the set off. An override replaces `value` and leaves the flag.
 */
export interface OpsThreshold {
  value: number;
  placeholder: true;
}

export interface OpsRulesConfig {
  configVersion: string;
  salesDrop: {
    watchAbovePct: OpsThreshold;
    actNowAbovePct: OpsThreshold;
  };
  delayed: {
    watchAbovePct: OpsThreshold;
    actNowAbovePct: OpsThreshold;
  };
  badOrders: {
    watchAbovePct: OpsThreshold;
    actNowAbovePct: OpsThreshold;
  };
  foodReady: {
    watchBelowPct: OpsThreshold;
    actNowBelowPct: OpsThreshold;
  };
  online: {
    watchBelowPct: OpsThreshold;
    actNowBelowPct: OpsThreshold;
  };
  prep: {
    watchAboveMinutes: OpsThreshold;
    actNowAboveMinutes: OpsThreshold;
    minRiseMinutes: OpsThreshold;
  };
  rating: {
    watchBelow: OpsThreshold;
    actNowBelow: OpsThreshold;
    watchDrop: OpsThreshold;
  };
  complaints: {
    watchCount: OpsThreshold;
    watchAbovePct: OpsThreshold;
    actNowCount: OpsThreshold;
    actNowAbovePct: OpsThreshold;
  };
  cancellations: {
    watchCount: OpsThreshold;
    watchAbovePct: OpsThreshold;
    actNowCount: OpsThreshold;
    actNowAbovePct: OpsThreshold;
  };
  guards: {
    salesBaselinePaise: OpsThreshold;
    rateMinDelivered: OpsThreshold;
    rateMinNumerator: OpsThreshold;
    zeroOrdersBaselineDelivered: OpsThreshold;
  };
  lifecycle: {
    watchEscalateDays: OpsThreshold;
    clearResolveDays: OpsThreshold;
    watchDeescalateDays: OpsThreshold;
    staleDays: OpsThreshold;
    reopenDays: OpsThreshold;
    backAgainDays: OpsThreshold;
  };
  /** Days a zero or missing day stays "not in yet" before it is treated as real. */
  blank: { waitDays: OpsThreshold };
  /** Delivered below this fraction of the comparison day is a partial day. */
  partial: { deliveredRatio: OpsThreshold };
  /** When true, the runner stores the brief and does not push it. */
  shadowMode: boolean;
  /** Empty until a holiday list is supplied. Sales comparisons are not softened. */
  holidayDates: string[];
}

function placeholder(value: number): OpsThreshold {
  return { value, placeholder: true };
}

/** The only numbers the daily rules and the alert windows read. */
export const DEFAULT_OPS_RULES_CONFIG = {
  configVersion: "ops-daily/2026-11-15.3",
  salesDrop: {
    watchAbovePct: placeholder(25),
    actNowAbovePct: placeholder(40),
  },
  delayed: {
    watchAbovePct: placeholder(8),
    actNowAbovePct: placeholder(15),
  },
  badOrders: {
    watchAbovePct: placeholder(12),
    actNowAbovePct: placeholder(20),
  },
  foodReady: {
    watchBelowPct: placeholder(85),
    actNowBelowPct: placeholder(75),
  },
  online: {
    watchBelowPct: placeholder(85),
    actNowBelowPct: placeholder(70),
  },
  prep: {
    watchAboveMinutes: placeholder(18),
    actNowAboveMinutes: placeholder(22),
    minRiseMinutes: placeholder(2),
  },
  rating: {
    watchBelow: placeholder(4),
    actNowBelow: placeholder(3.8),
    watchDrop: placeholder(0.05),
  },
  complaints: {
    watchCount: placeholder(3),
    watchAbovePct: placeholder(5),
    actNowCount: placeholder(6),
    actNowAbovePct: placeholder(10),
  },
  cancellations: {
    watchCount: placeholder(3),
    watchAbovePct: placeholder(5),
    actNowCount: placeholder(6),
    actNowAbovePct: placeholder(10),
  },
  guards: {
    salesBaselinePaise: placeholder(300_000),
    rateMinDelivered: placeholder(15),
    rateMinNumerator: placeholder(2),
    zeroOrdersBaselineDelivered: placeholder(5),
  },
  lifecycle: {
    watchEscalateDays: placeholder(3),
    clearResolveDays: placeholder(2),
    watchDeescalateDays: placeholder(2),
    staleDays: placeholder(7),
    reopenDays: placeholder(7),
    backAgainDays: placeholder(3),
  },
  blank: { waitDays: placeholder(3) },
  partial: { deliveredRatio: placeholder(0.5) },
  shadowMode: true,
  holidayDates: [],
} satisfies OpsRulesConfig;

const thresholdOverride = z.object({ value: z.number().finite() }).strict();

function group<const T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict().partial();
}

/** A restaurant may replace any threshold. Missing keys keep the default. */
export const OpsRulesOverrideSchema = z
  .object({
    salesDrop: group({
      watchAbovePct: thresholdOverride,
      actNowAbovePct: thresholdOverride,
    }).optional(),
    delayed: group({
      watchAbovePct: thresholdOverride,
      actNowAbovePct: thresholdOverride,
    }).optional(),
    badOrders: group({
      watchAbovePct: thresholdOverride,
      actNowAbovePct: thresholdOverride,
    }).optional(),
    foodReady: group({
      watchBelowPct: thresholdOverride,
      actNowBelowPct: thresholdOverride,
    }).optional(),
    online: group({
      watchBelowPct: thresholdOverride,
      actNowBelowPct: thresholdOverride,
    }).optional(),
    prep: group({
      watchAboveMinutes: thresholdOverride,
      actNowAboveMinutes: thresholdOverride,
      minRiseMinutes: thresholdOverride,
    }).optional(),
    rating: group({
      watchBelow: thresholdOverride,
      actNowBelow: thresholdOverride,
      watchDrop: thresholdOverride,
    }).optional(),
    complaints: group({
      watchCount: thresholdOverride,
      watchAbovePct: thresholdOverride,
      actNowCount: thresholdOverride,
      actNowAbovePct: thresholdOverride,
    }).optional(),
    cancellations: group({
      watchCount: thresholdOverride,
      watchAbovePct: thresholdOverride,
      actNowCount: thresholdOverride,
      actNowAbovePct: thresholdOverride,
    }).optional(),
    guards: group({
      salesBaselinePaise: thresholdOverride,
      rateMinDelivered: thresholdOverride,
      rateMinNumerator: thresholdOverride,
      zeroOrdersBaselineDelivered: thresholdOverride,
    }).optional(),
    lifecycle: group({
      watchEscalateDays: thresholdOverride,
      clearResolveDays: thresholdOverride,
      watchDeescalateDays: thresholdOverride,
      staleDays: thresholdOverride,
      reopenDays: thresholdOverride,
      backAgainDays: thresholdOverride,
    }).optional(),
    blank: group({ waitDays: thresholdOverride }).optional(),
    partial: group({ deliveredRatio: thresholdOverride }).optional(),
    shadowMode: z.boolean().optional(),
    holidayDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  })
  .strict();

export type OpsRulesOverride = z.infer<typeof OpsRulesOverrideSchema>;

export function resolveOpsRulesConfig(override?: OpsRulesOverride | null): OpsRulesConfig {
  const parsed = OpsRulesOverrideSchema.parse(override ?? {});
  return {
    configVersion: DEFAULT_OPS_RULES_CONFIG.configVersion,
    salesDrop: mergeGroup(DEFAULT_OPS_RULES_CONFIG.salesDrop, parsed.salesDrop),
    delayed: mergeGroup(DEFAULT_OPS_RULES_CONFIG.delayed, parsed.delayed),
    badOrders: mergeGroup(DEFAULT_OPS_RULES_CONFIG.badOrders, parsed.badOrders),
    foodReady: mergeGroup(DEFAULT_OPS_RULES_CONFIG.foodReady, parsed.foodReady),
    online: mergeGroup(DEFAULT_OPS_RULES_CONFIG.online, parsed.online),
    prep: mergeGroup(DEFAULT_OPS_RULES_CONFIG.prep, parsed.prep),
    rating: mergeGroup(DEFAULT_OPS_RULES_CONFIG.rating, parsed.rating),
    complaints: mergeGroup(DEFAULT_OPS_RULES_CONFIG.complaints, parsed.complaints),
    cancellations: mergeGroup(DEFAULT_OPS_RULES_CONFIG.cancellations, parsed.cancellations),
    guards: mergeGroup(DEFAULT_OPS_RULES_CONFIG.guards, parsed.guards),
    lifecycle: mergeGroup(DEFAULT_OPS_RULES_CONFIG.lifecycle, parsed.lifecycle),
    blank: mergeGroup(DEFAULT_OPS_RULES_CONFIG.blank, parsed.blank),
    partial: mergeGroup(DEFAULT_OPS_RULES_CONFIG.partial, parsed.partial),
    shadowMode: parsed.shadowMode ?? DEFAULT_OPS_RULES_CONFIG.shadowMode,
    holidayDates: parsed.holidayDates ?? DEFAULT_OPS_RULES_CONFIG.holidayDates,
  };
}

function mergeGroup<T extends Record<string, OpsThreshold>>(
  base: T,
  override: Partial<Record<keyof T, { value: number }>> | undefined,
): T {
  if (!override) return base;
  const next = { ...base };
  for (const key of Object.keys(base) as Array<keyof T>) {
    const replacement = override[key];
    if (!replacement) continue;
    next[key] = { value: replacement.value, placeholder: true } as T[keyof T];
  }
  return next;
}
