import * as z from "zod";
import { SWIGGY_DAILY_MAX_DAYS } from "./metric-dictionary.js";

/**
 * Fetch windows use Asia/Kolkata civil dates.
 * `periodStart` is inclusive and `periodEnd` is exclusive: the day after the
 * last day. That is the same window `expectedPeriods` checks.
 *
 * Daily is the seven days ending yesterday, every day, and never today.
 * Zomato weekly is the previous Monday–Sunday, and only on Monday.
 * Swiggy weekly is the previous Sunday–Saturday, and only on Tuesday.
 * Monthly is the previous calendar month, and only on the 3rd.
 * Payouts are only on Thursday: the last four paid cycles, plus stored cycles
 * that are still pending or under the lag banner, and never the cycle that
 * contains the plan date. A Swiggy Sunday–Saturday cycle that crosses a month
 * end is returned as one window per part.
 * Missing days in the last 90, outside that daily window, are backfilled in
 * chunks of at most 30 days on Zomato and 7 on Swiggy, and at most 90 days a
 * night across both platforms.
 */
export const FETCH_DAILY_DAYS = 7;
export const FETCH_HORIZON_DAYS = 90;
export const FETCH_ZOMATO_CHUNK_DAYS = 30;
export const FETCH_SWIGGY_CHUNK_DAYS = SWIGGY_DAILY_MAX_DAYS;
export const FETCH_BACKFILL_NIGHT_DAYS = 90;

export const FETCH_REPORTS = ["daily", "weekly", "monthly", "payout"] as const;
export type FetchReport = (typeof FETCH_REPORTS)[number];

export const LOG_FETCH_STATUSES = [
  "signed_out",
  "download_failed",
  "ui_changed",
  "local_mismatch",
  "missing_platform_id",
] as const;
export type LogFetchStatus = (typeof LOG_FETCH_STATUSES)[number];

export const FETCH_STATUSES = [
  "stored",
  "skipped",
  "rejected_mismatch",
  "needs_owner",
  ...LOG_FETCH_STATUSES,
] as const;
export type FetchStatus = (typeof FETCH_STATUSES)[number];

export const FETCH_WINDOW_REASONS = ["scheduled", "pending", "lag_banner", "backfill"] as const;
export type FetchWindowReason = (typeof FETCH_WINDOW_REASONS)[number];

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, { error: "sha256 must be 64 hex characters." });

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use a date as YYYY-MM-DD." });
const OutletId = z.string().trim().min(1).max(200);
const ReasonCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, { error: "Use a short reason code." });

export const FetchPlanQuerySchema = z
  .object({
    outletId: OutletId,
    date: IsoDate.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.date !== undefined && !realDate(value.date)) {
      ctx.addIssue({ code: "custom", path: ["date"], message: "Use a date as YYYY-MM-DD." });
    }
  });
export type FetchPlanQuery = z.infer<typeof FetchPlanQuerySchema>;

export interface FetchPlanWindow {
  report: FetchReport;
  reasons: FetchWindowReason[];
  /** Inclusive civil date. */
  periodStart: string;
  /** Exclusive civil date, the day after the last day. */
  periodEnd: string;
}

export interface FetchPlanPlatform {
  platform: "zomato" | "swiggy";
  /** Zomato restaurant id or Swiggy RID. Null when the outlet has none. */
  platformId: string | null;
  /** Set when this outlet has no id for the platform. `windows` is then empty. */
  reason: "missing_platform_id" | null;
  windows: FetchPlanWindow[];
}

export interface FetchPlanResponse {
  /** Asia/Kolkata civil date the plan was built for. */
  date: string;
  outletId: string;
  platforms: FetchPlanPlatform[];
}

const CheckFileSchema = z
  .object({
    sha256: Sha256Schema,
    rawSha256: Sha256Schema.optional(),
    report: z.enum(FETCH_REPORTS),
    periodStart: IsoDate,
    periodEnd: IsoDate,
    parserVersion: z.string().trim().min(1).max(80),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!realDate(value.periodStart)) {
      ctx.addIssue({
        code: "custom",
        path: ["periodStart"],
        message: "Use a date as YYYY-MM-DD.",
      });
    }
    if (!realDate(value.periodEnd)) {
      ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "Use a date as YYYY-MM-DD." });
    }
    if (
      realDate(value.periodStart) &&
      realDate(value.periodEnd) &&
      value.periodEnd <= value.periodStart
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart.",
      });
    }
  });

export const CheckStoredFetchesSchema = z
  .object({
    outletId: OutletId,
    platform: z.enum(["zomato", "swiggy"]),
    files: z.array(CheckFileSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.files.length > 100) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "Send at most 100 files." });
    }
  });
export type CheckStoredFetchesInput = z.infer<typeof CheckStoredFetchesSchema>;

export interface StoredFetchCheck {
  sha256: string;
  rawSha256: string | null;
  report: FetchReport;
  periodStart: string;
  periodEnd: string;
  stored: boolean;
  fetchId: string | null;
}

export interface CheckStoredFetchesResponse {
  files: StoredFetchCheck[];
}

export const ListFetchesQuerySchema = z
  .object({
    outletId: OutletId,
    since: z.string().datetime({ offset: true }).optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/, { error: "limit must be from 1 to 200." })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.limit === undefined) return;
    const limit = Number(value.limit);
    if (limit < 1 || limit > 200) {
      ctx.addIssue({ code: "custom", path: ["limit"], message: "limit must be from 1 to 200." });
    }
  })
  .transform((value) => ({
    outletId: value.outletId,
    since: value.since,
    limit: value.limit === undefined ? 50 : Number(value.limit),
  }));
export type ListFetchesQuery = z.infer<typeof ListFetchesQuerySchema>;

export interface MetricFetchListItem {
  fetchId: string;
  status: FetchStatus;
  rejectedMismatch: boolean;
  needsOwner: boolean;
  warnings: string[];
  /** Short code for a log row. Null when the row stored a file. */
  reason: string | null;
  platform: "zomato" | "swiggy";
  report: FetchReport;
  window: { periodStart: string; periodEnd: string };
  sha256: string | null;
  createdAt: string;
}

export interface MetricFetchListResponse {
  fetches: MetricFetchListItem[];
}

export const LogFetchSchema = z
  .object({
    outletId: OutletId,
    platform: z.enum(["zomato", "swiggy"]),
    report: z.enum(FETCH_REPORTS),
    periodStart: IsoDate,
    periodEnd: IsoDate,
    runId: z.string().trim().min(1).max(200),
    status: z.enum(LOG_FETCH_STATUSES),
    reason: ReasonCode,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!realDate(value.periodStart)) {
      ctx.addIssue({
        code: "custom",
        path: ["periodStart"],
        message: "Use a date as YYYY-MM-DD.",
      });
    }
    if (!realDate(value.periodEnd)) {
      ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "Use a date as YYYY-MM-DD." });
    }
    if (
      realDate(value.periodStart) &&
      realDate(value.periodEnd) &&
      value.periodEnd <= value.periodStart
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart.",
      });
    }
  });
export type LogFetchInput = z.infer<typeof LogFetchSchema>;

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
