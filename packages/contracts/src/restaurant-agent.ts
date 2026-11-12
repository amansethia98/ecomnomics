import * as z from "zod";
import { commandVariableName } from "./bot-secrets.js";

/**
 * How a stored metric value is checked. Money is integer paise. A missing
 * figure is null, never a guessed zero. Derived figures are not keys.
 */
export const METRIC_UNITS = [
  "paise",
  "count",
  "percent",
  "rating",
  "minutes",
  "hours",
  "ratio",
  "boolean",
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

type MetricDefinition = { readonly unit: MetricUnit; readonly definition: string };

/**
 * Canonical metric keys. Source fields and the figures that must stay derived
 * live in docs/metric-dictionary.md. `orders` is not a key: send
 * `delivered_orders` or `payout_orders`.
 */
export const METRIC_DEFINITIONS = {
  gross_sales_paise: {
    unit: "paise",
    definition:
      "Item total plus packaging (ST+PC), before GST and before restaurant-funded discounts. Not the weekly ops Sales tile.",
  },
  net_payout_paise: {
    unit: "paise",
    definition:
      "Owner's Net Payout: commissionable value minus ads minus commission, other fees, and GST on fees. Not the amount paid under the bank UTR.",
  },
  aov_paise: {
    unit: "paise",
    definition:
      "Average order value as shown on the weekly ops screen. Not an average computed from payout sales.",
  },
  commission_paise: {
    unit: "paise",
    definition:
      "Platform commission or base service fee only, not long-distance, payment-gateway, or GST on fees.",
  },
  commission_pg_gst_paise: {
    unit: "paise",
    definition:
      "The payout calculator's Comm.+PG+GST row: platform commission plus payment-gateway fees plus GST, as that row is printed. Swiggy's row excludes GST on fees.",
  },
  platform_fees_paise: {
    unit: "paise",
    definition: "Other platform fees besides commission, excluding GST on fees.",
  },
  taxes_paise: {
    unit: "paise",
    definition: "18% GST on platform fees only. Not customer GST, and not TDS or TCS.",
  },
  discount_paise: {
    unit: "paise",
    definition: "Discounts the restaurant pays for. Not platform-funded discounts.",
  },
  ad_spend_paise: {
    unit: "paise",
    definition: "Ads charged to the restaurant for that period, counted once.",
  },
  ad_orders: {
    unit: "count",
    definition: "Orders attributed to ads.",
  },
  cancelled_orders: {
    unit: "count",
    definition:
      "Cancelled orders for this platform. Do not add Zomato and Swiggy figures together.",
  },
  rating: {
    unit: "rating",
    definition: "Average customer star rating, from 0 to 5.",
  },
  menu_conversion_pct: {
    unit: "percent",
    definition:
      "Starter funnel rate. Prefer impressions_to_menu_pct, menu_to_cart_pct, and cart_to_orders_pct until one meaning is chosen.",
  },
  delivered_orders: {
    unit: "count",
    definition: "Orders delivered in the ops week (what the ops card means by orders).",
  },
  payout_orders: {
    unit: "count",
    definition:
      "Payout-file total orders: delivered plus cancelled or rejected, for the payout period.",
  },
  ops_sales_paise: {
    unit: "paise",
    definition: "Sales as shown on the weekly ops dashboard, stored separately from gross sales.",
  },
  bad_orders_pct: {
    unit: "percent",
    definition: "Share of orders Zomato treats as bad.",
  },
  rejected_orders: {
    unit: "count",
    definition: "Rejected orders in Zomato's bad-orders breakdown.",
  },
  delayed_orders: {
    unit: "count",
    definition: "Orders delayed past the kitchen or prep threshold.",
  },
  poor_rated_orders: {
    unit: "count",
    definition: "Orders with a poor customer rating.",
  },
  bad_order_complaints: {
    unit: "count",
    definition:
      "Complaints slice inside Zomato's bad-orders breakdown. It can differ from total complaints.",
  },
  complaints: {
    unit: "count",
    definition: "Total complaints for the week.",
  },
  lost_sales_paise: {
    unit: "paise",
    definition: "Sales Zomato reports as lost, for example from being offline or rejecting.",
  },
  cancelled_order_loss_paise: {
    unit: "paise",
    definition: "Money Swiggy reports as lost to restaurant-cancelled orders.",
  },
  online_pct: {
    unit: "percent",
    definition: "Share of time the outlet was online or available.",
  },
  kpt_minutes: {
    unit: "minutes",
    definition: "Kitchen preparation time, in minutes to one decimal.",
  },
  food_ready_accuracy_pct: {
    unit: "percent",
    definition: "Swiggy food-ready accuracy (MFR) on the weekly screen.",
  },
  for_accuracy_pct: {
    unit: "percent",
    definition: "Zomato food-order-ready accuracy, from the monthly export only.",
  },
  offline_time_hours: {
    unit: "hours",
    definition: "Time the outlet was offline, in hours.",
  },
  rated_orders: {
    unit: "count",
    definition: "How many orders received a rating.",
  },
  lag_banner: {
    unit: "boolean",
    definition:
      "Whether Swiggy showed the 48-hour lag banner on this week. The numbers on screen are still stored.",
  },
  cv_paise: {
    unit: "paise",
    definition:
      "Commissionable value: item total plus packaging, minus the restaurant-funded discount.",
  },
  platform_net_payout_paise: {
    unit: "paise",
    definition: "The platform's own net payout figure, before comparing it to the bank.",
  },
  paid_amount_paise: {
    unit: "paise",
    definition: "Amount marked paid on the Payouts screen, tied to a bank UTR.",
  },
  tds_paise: {
    unit: "paise",
    definition: "Tax deducted at source and withheld from the payout. A tax credit, not a cost.",
  },
  tcs_paise: {
    unit: "paise",
    definition: "Tax collected at source, including TCS IGST where it is present.",
  },
  gst_collected_paise: {
    unit: "paise",
    definition: "GST collected from customers. Not restaurant revenue on delivery orders.",
  },
  complaints_cancellation_charges_paise: {
    unit: "paise",
    definition: "Complaint refunds and cancellation charges deducted from the payout.",
  },
  placed_orders: {
    unit: "count",
    definition: "Orders placed in the calendar month.",
  },
  ads_sales_paise: {
    unit: "paise",
    definition: "Sales from ads.",
  },
  ads_roi: {
    unit: "ratio",
    definition: "Platform-reported ads ROI. Not a 0 to 100 percent.",
  },
  ads_ctr_pct: {
    unit: "percent",
    definition: "Ads click-through rate.",
  },
  impressions: {
    unit: "count",
    definition: "Menu impressions.",
  },
  menu_opens: {
    unit: "count",
    definition: "Menu opens.",
  },
  cart_builds: {
    unit: "count",
    definition: "Cart builds.",
  },
  impressions_to_menu_pct: {
    unit: "percent",
    definition: "Share of impressions that became menu opens.",
  },
  menu_to_cart_pct: {
    unit: "percent",
    definition: "Share of menu opens that became cart builds.",
  },
  cart_to_orders_pct: {
    unit: "percent",
    definition: "Share of cart builds that became orders.",
  },
  new_user_orders: {
    unit: "count",
    definition: "Orders from new users.",
  },
  repeat_user_orders: {
    unit: "count",
    definition: "Orders from repeat users.",
  },
  lapsed_user_orders: {
    unit: "count",
    definition: "Orders from lapsed users.",
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;

export const METRIC_KEYS = Object.keys(METRIC_DEFINITIONS) as [MetricKey, ...MetricKey[]];

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

export const PLATFORMS = ["zomato", "swiggy"] as const;
export type RestaurantPlatform = (typeof PLATFORMS)[number];

export const GRANULARITIES = ["day", "week", "month"] as const;
export type MetricGranularity = (typeof GRANULARITIES)[number];

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
  const quoted = keys.map((key) => `"${key}"`).join(", ");
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
  const unit = METRIC_DEFINITIONS[key].unit;
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
  if (unit === "percent") {
    if (places > 2 || value > 100) {
      return `${key} must be from 0 to 100 with at most 2 decimal places`;
    }
    return undefined;
  }
  if (unit === "rating") {
    if (places > 2 || value > 5) return `${key} must be from 0 to 5 with at most 2 decimal places`;
    return undefined;
  }
  if (unit === "minutes") {
    return places > 1 ? `${key} must have at most 1 decimal place` : undefined;
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
