import * as z from "zod";
import { commandVariableName } from "./bot-secrets.js";
import type { MetricKey } from "./metric-dictionary.js";
import {
  GRANULARITIES,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  RETIRED_METRIC_KEYS,
  requireMetric,
} from "./metric-dictionary.js";

export {
  civilDayBounds,
  civilRangeBounds,
  indiaCivilDate,
  utcMidnight,
} from "./metric-dates.js";
export type {
  AggregationKind,
  CheckRule,
  MetricAccuracy,
  MetricDefinition,
  MetricGranularity,
  MetricKey,
  MetricPlatform,
  MetricUnit,
} from "./metric-dictionary.js";
export {
  AGGREGATION_KINDS,
  APPROX_METRIC_KEYS,
  CROSS_PLATFORM_KEYS,
  checkExclusions,
  FILE_IDENTITY_ATTEMPT_LIMIT,
  GRANULARITIES,
  isCrossPlatformKey,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  METRIC_PARSER_VERSION,
  METRIC_PLATFORMS,
  METRIC_UNITS,
  metricDefinition,
  RETIRED_METRIC_KEYS,
  requireMetric,
  resolveCheck,
  SWIGGY_DAILY_MAX_DAYS,
} from "./metric-dictionary.js";
export type {
  ExpectedReportIdentity,
  IdentityAssessment,
  ObservedReportIdentity,
  ParsedMetricRow,
  ParsedWindowItem,
  ReportEvaluation,
  ReportKind,
  ReportPeriod,
} from "./metric-parse.js";
export {
  canonicalRestaurantId,
  checkObservedIdentity,
  evaluateBusinessReport,
  expectedPeriods,
  missingPlatformIdReason,
  reportGranularity,
} from "./metric-parse.js";
export type {
  MetricRollup,
  PayoutRollupInput,
  RollupFact,
  RollupQuery,
  RollupValue,
} from "./metric-rollup.js";
export { comparePlatformValue, rollupMetrics } from "./metric-rollup.js";
export type { ReplacePlan, StoredWindowRow, WindowWrite } from "./metric-window.js";
export { planReplaceWindow } from "./metric-window.js";

export const METRIC_KEY_MEANINGS = Object.fromEntries(
  METRIC_KEYS.map((key) => [key, METRIC_DEFINITIONS[key].definition]),
) as Record<MetricKey, string>;

/**
 * Recomputed from stored money and counts. The API rejects these names.
 * `fees_incl_gst_paise` is commission plus other fees plus GST on fees, which
 * is the combined dashboard fee tile: Zomato's fee row includes that GST and
 * Swiggy's does not.
 */
export const DERIVED_METRIC_KEYS = [
  "effective_discount_pct",
  "ads_pct",
  "payout_pct",
  "burn_pct",
  "fees_incl_gst_paise",
  "ops_aov_paise",
  "gross_aov_paise",
] as const;

const METRIC_KEY_SET = new Set<string>(METRIC_KEYS);
const RETIRED_KEYS = RETIRED_METRIC_KEYS as Record<string, string>;

export const PLATFORMS = ["zomato", "swiggy"] as const;
export type RestaurantPlatform = (typeof PLATFORMS)[number];

export const ACTION_TYPES = [
  "discount",
  "ad_campaign",
  "price_change",
  "menu_change",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "executing",
  "executed",
  "failed",
  "reverted",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Edges the server allows. The same status again is an idempotent retry. */
export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  proposed: ["approved", "rejected"],
  approved: ["executing", "rejected"],
  rejected: [],
  executing: ["executed", "failed"],
  executed: ["reverted"],
  failed: ["reverted"],
  reverted: [],
};

export const JOB_RUN_STATUSES = ["running", "succeeded", "failed", "needs_owner"] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export const REPORT_STATUSES = ["green", "amber", "red"] as const;

export const AGENT_TOKEN_PREFIX = "ecom_agent_";
export const RESTAURANT_AGENT_TOKEN_ENV = "RESTAURANT_AGENT_TOKEN";
export const RESTAURANT_AGENT_API_BASE_URL_ENV = "RESTAURANT_AGENT_API_BASE_URL";
/** Vault name exported as `RESTAURANT_AGENT_TOKEN`. */
export const RESTAURANT_AGENT_TOKEN_NAME = "restaurant_agent_token";
/** Vault name exported as `RESTAURANT_AGENT_API_BASE_URL`. */
export const RESTAURANT_AGENT_API_BASE_URL_NAME = "restaurant_agent_api_base_url";

const PLATFORM_COMMAND_VARIABLES = new Set<string>([
  RESTAURANT_AGENT_TOKEN_ENV,
  RESTAURANT_AGENT_API_BASE_URL_ENV,
]);

/** A vault name that would export a platform-managed restaurant variable. */
export function isPlatformCommandVariable(name: string): boolean {
  return PLATFORM_COMMAND_VARIABLES.has(commandVariableName(name));
}

const IsoTime = z.string().datetime({ offset: true });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use a date as YYYY-MM-DD" });
const FileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/, { error: "Use a plain file name" });
const ContentType = z
  .string()
  .regex(/^[\w.+-]+\/[\w.+-]+$/, { error: "Use a content type such as text/csv" });

export const ReportFileInputSchema = z
  .object({
    name: FileName,
    contentType: ContentType,
  })
  .strict();

const paise = z
  .number()
  .int({ error: "Money is an integer number of paise" })
  .nonnegative({ error: "Money cannot be negative" })
  .max(2_000_000_000);

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 99;
  const text = value.toString().toLowerCase();
  if (text.includes("e")) {
    const [coeff, expRaw] = text.split("e");
    const exp = Number(expRaw);
    const fraction = (coeff?.split(".")[1] ?? "").length;
    return Math.max(0, fraction - exp);
  }
  return (text.split(".")[1] ?? "").length;
}

export function unknownMetricKeys(body: unknown): string[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { rows?: unknown }).rows)) {
    return [];
  }
  const found = new Set<string>();
  for (const row of (body as { rows: unknown[] }).rows) {
    if (!row || typeof row !== "object") continue;
    const key = (row as { key?: unknown }).key;
    if (typeof key === "string" && !METRIC_KEY_SET.has(key)) found.add(key);
  }
  return [...found];
}

export function unknownMetricKeyMessage(keys: readonly string[]): string {
  const quoted = keys
    .map((key) => {
      const retired = RETIRED_KEYS[key];
      return retired ? `"${key}" (${retired})` : `"${key}"`;
    })
    .join(", ");
  return `Unknown metric key ${quoted}. Allowed keys: ${METRIC_KEYS.join(", ")}.`;
}

const MetricRowSchema = z
  .object({
    outletId: z.string().trim().min(1).max(200),
    platform: z.enum(PLATFORMS),
    granularity: z.enum(GRANULARITIES),
    periodStart: IsoTime,
    periodEnd: IsoTime,
    key: z.enum(METRIC_KEYS),
    value: z.union([z.number().finite(), z.boolean(), z.null()]),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (Date.parse(row.periodEnd) <= Date.parse(row.periodStart)) {
      ctx.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart",
      });
    }
    const issue = metricValueIssue(row.key, row.value);
    if (issue) ctx.addIssue({ code: "custom", path: ["value"], message: issue });
  });

export const PutMetricsSchema = z
  .object({
    runId: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(200),
    capturedAt: IsoTime,
    rows: z.array(MetricRowSchema).min(1).max(500),
  })
  .strict();
export type PutMetricsInput = z.infer<typeof PutMetricsSchema>;

export const METRIC_BASES = ["order_date", "settlement_date"] as const;
export type MetricBasis = (typeof METRIC_BASES)[number];

/** `to` is exclusive. Dates are civil dates in Asia/Kolkata. */
export const ReadMetricsQuerySchema = z
  .object({
    outletId: z.string().trim().min(1).max(200),
    platform: z.enum(["zomato", "swiggy", "combined"]),
    from: IsoDate,
    to: IsoDate,
    basis: z.enum(METRIC_BASES).default("order_date"),
  })
  .strict()
  .refine((value) => value.to > value.from, { error: "to must be after from" });
export type ReadMetricsQuery = z.infer<typeof ReadMetricsQuerySchema>;

export const REPORT_KINDS = ["daily", "weekly", "monthly"] as const;

/** A business-report file. The server parses it and checks the outlet before storing anything. */
export const IngestMetricReportSchema = z
  .object({
    outletId: z.string().trim().min(1).max(200),
    platform: z.enum(PLATFORMS),
    report: z.enum(REPORT_KINDS),
    periodStart: IsoDate,
    periodEnd: IsoDate,
    csv: z.string().min(1).max(1_500_000),
    attempt: z.number().int().positive().max(20).optional(),
    runId: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(200),
    capturedAt: IsoTime,
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, {
    error: "periodEnd must be after periodStart",
  });
export type IngestMetricReportInput = z.infer<typeof IngestMetricReportSchema>;

/** A payout workbook, base64-encoded. The server parses it and checks the outlet before storing orders. */
export const IngestPayoutReportSchema = z
  .object({
    outletId: z.string().trim().min(1).max(200),
    platform: z.enum(PLATFORMS),
    periodStart: IsoDate,
    periodEnd: IsoDate,
    fileBase64: z.string().min(1).max(12_000_000),
    attempt: z.number().int().positive().max(20).optional(),
    runId: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(200),
    capturedAt: IsoTime,
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, {
    error: "periodEnd must be after periodStart",
  });
export type IngestPayoutReportInput = z.infer<typeof IngestPayoutReportSchema>;

export const CreateReportSchema = z
  .object({
    type: z.string().trim().min(1).max(80),
    outletId: z.string().trim().min(1).max(200).nullable(),
    periodStart: IsoTime,
    periodEnd: IsoTime,
    status: z.enum(REPORT_STATUSES).nullable(),
    summaryMarkdown: z.string().max(100_000),
    files: z.array(ReportFileInputSchema).max(20),
    clientNonce: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => Date.parse(value.periodEnd) > Date.parse(value.periodStart), {
    error: "periodEnd must be after periodStart",
  });
export type CreateReportInput = z.infer<typeof CreateReportSchema>;

export const CreateActionSchema = z
  .object({
    outletId: z.string().trim().min(1).max(200).nullable(),
    platform: z.enum(PLATFORMS),
    type: z.enum(ACTION_TYPES),
    title: z.string().trim().min(1).max(200),
    details: z.record(z.string(), z.unknown()),
    estCostPaise: paise.nullable(),
    chatMessageId: z.string().trim().min(1).max(200).nullable(),
    clientNonce: z.string().trim().min(1).max(200).optional(),
    evidenceFiles: z.array(ReportFileInputSchema).max(10).optional(),
  })
  .strict();
export type CreateActionInput = z.infer<typeof CreateActionSchema>;

export const PatchActionSchema = z
  .object({
    status: z.enum(ACTION_STATUSES),
    approvedByMessageId: z.string().trim().min(1).max(200).optional(),
    result: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type PatchActionInput = z.infer<typeof PatchActionSchema>;

const usdMicros = z
  .number()
  .int({ error: "costUsdMicros must be an integer" })
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const fxRate = z
  .number()
  .positive({ error: "fxRate must be a USD to INR rate greater than 0" })
  .max(1_000_000)
  .refine((value) => decimalPlaces(value) <= 6, {
    error: "fxRate must have at most 6 decimal places",
  });

export const CreateJobRunSchema = z
  .object({
    runId: z.string().trim().min(1).max(200),
    skill: z.string().trim().min(1).max(120),
    status: z.enum(JOB_RUN_STATUSES),
    // Required the first time a runId is posted. A repeat may omit it; the stored start stays.
    startedAt: IsoTime.optional(),
    endedAt: IsoTime.nullable().optional(),
    costPaise: paise.nullable().optional(),
    costUsdMicros: usdMicros.nullable().optional(),
    fxRate: fxRate.nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    outletId: z.string().trim().min(1).max(200).nullable().optional(),
    error: z.string().max(4_000).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.startedAt &&
      value.endedAt &&
      Date.parse(value.endedAt) < Date.parse(value.startedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "endedAt must be at or after startedAt",
      });
    }
    // costPaise is the INR figure. It is only accepted with the USD source and the rate.
    if (value.costPaise !== undefined && value.costPaise !== null) {
      if (value.costUsdMicros === undefined || value.costUsdMicros === null) {
        ctx.addIssue({
          code: "custom",
          path: ["costUsdMicros"],
          message:
            "Send costUsdMicros with costPaise. costUsdMicros is the summed model cost in millionths of a US dollar.",
        });
      }
      if (value.fxRate === undefined || value.fxRate === null) {
        ctx.addIssue({
          code: "custom",
          path: ["fxRate"],
          message:
            "Send fxRate with costPaise. fxRate is the USD to INR rate used for that figure.",
        });
      }
    }
  });
export type CreateJobRunInput = z.infer<typeof CreateJobRunSchema>;

export function actionTransition(from: ActionStatus, to: ActionStatus): "ok" | "same" | "illegal" {
  if (from === to) return "same";
  return ACTION_TRANSITIONS[from].includes(to) ? "ok" : "illegal";
}

/** Statuses that require a chat message a person in the restaurant sent. */
export function actionStatusNeedsApproval(status: ActionStatus): boolean {
  return status === "approved" || status === "executing" || status === "executed";
}

export function parsePlatformAdminEmails(value: string | undefined): string[] {
  const emails = (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  return [...new Set(emails)];
}

export function isPlatformAdminEmail(
  email: string,
  allowlist: readonly string[],
  verified: boolean,
): boolean {
  return verified && allowlist.includes(email.trim().toLowerCase());
}

const PAISE_MAX = 2_000_000_000;

/** Why this value cannot be stored for the key, or undefined when it can. Null is missing. */
export function metricValueIssue(
  key: MetricKey,
  value: number | boolean | null,
): string | undefined {
  const definition = requireMetric(key);
  const unit = definition.unit;
  if (value === null) return undefined;
  if (unit === "boolean") {
    return typeof value === "boolean" ? undefined : `${key} must be true, false, or null`;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `${key} must be a non-negative number or null`;
  }
  if (unit === "paise" || unit === "count") {
    if (!Number.isSafeInteger(value)) return `${key} must be a non-negative integer or null`;
    if (unit === "paise" && value > PAISE_MAX) return `${key} is too large`;
    return undefined;
  }
  const places = decimalPlaces(value);
  const decimals = definition.decimals ?? (unit === "minutes" ? 1 : 4);
  const max = definition.max;
  if (unit === "pct" || unit === "decimal" || unit === "minutes" || unit === "hours") {
    if (places > decimals) return `${key} must have at most ${decimals} decimal places`;
    if (max !== undefined && value > max) return `${key} must be from 0 to ${max}`;
    if (value >= 1e16) return `${key} is too large`;
    return undefined;
  }
  if (places > 4) return `${key} must have at most 4 decimal places`;
  if (value >= 1e16) return `${key} is too large`;
  return undefined;
}

/**
 * The two variables a restaurant command receives. They are injected from the
 * vault for that command, not written into the container.
 */
export function restaurantComputerEnv(token: string, apiBaseUrl: string): Record<string, string> {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) throw new Error("Not a restaurant agent token");
  return {
    [RESTAURANT_AGENT_TOKEN_ENV]: token,
    [RESTAURANT_AGENT_API_BASE_URL_ENV]: apiBaseUrl,
  };
}
