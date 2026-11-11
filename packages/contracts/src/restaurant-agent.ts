import * as z from "zod";

/**
 * Canonical metric keys. Definitions and the Zomato and Swiggy source fields
 * for each key belong in docs/metric-dictionary.md.
 */
export const METRIC_KEYS = [
  "gross_sales_paise",
  "net_payout_paise",
  "orders",
  "aov_paise",
  "commission_paise",
  "platform_fees_paise",
  "taxes_paise",
  "discount_paise",
  "ad_spend_paise",
  "ad_orders",
  "cancelled_orders",
  "rating",
  "menu_conversion_pct",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_KEY_MEANINGS: Record<MetricKey, string> = {
  gross_sales_paise: "Menu value of orders before commission, fees, and taxes, in paise.",
  net_payout_paise: "Amount the platform is expected to pay the restaurant, in paise.",
  orders: "Count of orders in the period.",
  aov_paise: "Average order value, in paise.",
  commission_paise: "Platform commission on the orders, in paise.",
  platform_fees_paise: "Platform fees other than commission, in paise.",
  taxes_paise: "Taxes on the orders, in paise.",
  discount_paise: "Discounts on the orders, in paise.",
  ad_spend_paise: "Ad spend in the period, in paise.",
  ad_orders: "Orders attributed to ads.",
  cancelled_orders: "Orders cancelled in the period.",
  rating: "Average rating for the period.",
  menu_conversion_pct: "Share of menu views that became orders, as a percent.",
};

const METRIC_KEY_SET = new Set<string>(METRIC_KEYS);

const INTEGER_METRIC_KEYS = new Set<MetricKey>([
  "gross_sales_paise",
  "net_payout_paise",
  "orders",
  "aov_paise",
  "commission_paise",
  "platform_fees_paise",
  "taxes_paise",
  "discount_paise",
  "ad_spend_paise",
  "ad_orders",
  "cancelled_orders",
]);

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
    value: z.number().finite(),
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
    if (INTEGER_METRIC_KEYS.has(row.key)) {
      if (!Number.isSafeInteger(row.value) || row.value < 0) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: `${row.key} must be a non-negative integer`,
        });
      }
      return;
    }
    if (row.value < 0 || decimalPlaces(row.value) > 4) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `${row.key} must be a non-negative number with at most 4 decimal places`,
      });
    }
    if (row.key === "rating" && row.value > 5) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "rating must be from 0 to 5" });
    }
    if (row.key === "menu_conversion_pct" && row.value > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "menu_conversion_pct must be from 0 to 100",
      });
    }
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
    startedAt: IsoTime,
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
    if (value.endedAt && Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
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

/** Env passed into one restaurant's computer. Never set this on the shared API process. */
export function restaurantComputerEnv(token: string): Record<string, string> {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) throw new Error("Not a restaurant agent token");
  return { [RESTAURANT_AGENT_TOKEN_ENV]: token };
}
