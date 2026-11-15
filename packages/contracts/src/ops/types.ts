import { z } from "zod";
import { metricDefinition } from "../metric-dictionary.js";
import type { OpsRulesConfig } from "./config.js";
import { DEFAULT_OPS_RULES_CONFIG } from "./config.js";

export const OPS_RULES_VERSION = DEFAULT_OPS_RULES_CONFIG.configVersion;

/** What the runner is told. The product does not schedule these itself. */
export const OPS_RUNNER_SCHEDULE = {
  zone: "Asia/Kolkata",
  dailyRun: "08:30",
  dailyDeliver: "09:00",
  dailyRetry: "11:00",
  weeklyRun: "10:00",
  weeklyDay: "Monday",
  payoutRun: "09:30",
  payoutDay: "Thursday",
} as const;

export const ALL_GOOD_CHAR_LIMIT = 700;
export const BRIEF_CHAR_LIMIT = 1_200;
export const CALLOUT_LIMIT = 3;

export const OPS_PLATFORMS = ["zomato", "swiggy"] as const;
export type OpsPlatform = (typeof OPS_PLATFORMS)[number];
export type OpsScopePlatform = OpsPlatform | "combined";
export type OpsAlertSeverity = "act_now" | "watch";
export type OpsStatus = "red" | "amber" | "green";

export const INGEST_FAILURES = [
  "signed_out",
  "download_failed",
  "layout_changed",
  "fetch_held",
  "needs_owner",
] as const;
export type OpsIngestCode = (typeof INGEST_FAILURES)[number];

export const OPS_BLOCKER_CODES = [
  "days_missing",
  "signed_out",
  "fetch_held",
  "layout_changed",
  "updating",
  "lag_missing",
  "zomato_week_missing",
] as const;
export type OpsBlockerCode = (typeof OPS_BLOCKER_CODES)[number];

/**
 * A held fetch is an identity mismatch and is never retried. A layout change
 * or an owner step will not be fixed by the 11:00 re-run either.
 */
export function ingestRetryable(code: OpsIngestCode): boolean {
  return code === "signed_out" || code === "download_failed";
}

export function ingestBlockerCode(code: OpsIngestCode): OpsBlockerCode {
  if (code === "fetch_held") return "fetch_held";
  if (code === "signed_out") return "signed_out";
  if (code === "layout_changed") return "layout_changed";
  return "days_missing";
}

export const INGEST_NOTE: Record<OpsIngestCode, string> = {
  signed_out: "login expired, we're reconnecting",
  download_failed: "the download failed",
  layout_changed: "the report layout changed",
  fetch_held: "the fetch is held",
  needs_owner: "the account needs the owner",
};

/**
 * Zomato business-report sales and Swiggy net sales are different keys, and
 * neither is flagged cross-platform. The daily brief adds them because they
 * are the same kind of money. Every other cross-app total has to be a
 * dictionary key with `crossPlatform: true`.
 */
export const COMBINED_NET_SALES = {
  zomato: "ops_sales_paise",
  swiggy: "swiggy_net_sales_paise",
} as const;

export function canSumAcrossApps(key: string): boolean {
  return metricDefinition(key)?.crossPlatform === true;
}

export function combinedNetSales(zomatoPaise: number, swiggyPaise: number): number {
  return zomatoPaise + swiggyPaise;
}

/** Sum a key across apps only when the dictionary says it combines. */
export function combinedDailyValue(key: string, values: readonly number[]): number | null {
  if (!canSumAcrossApps(key)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export const DAILY_FIXES = {
  d_sales_drop: "Confirm the outlet was open and visible on {App} through dinner.",
  d_zero_orders: "Confirm the outlet was open and visible on {App} that day.",
  d_delayed: "Start prep on accept and mark food ready only when it is.",
  d_bad_orders: "Read the day's bad orders in the partner app and fix the repeating cause.",
  d_cancel_reject:
    "Check stock and staffing at peak; mark items out of stock instead of rejecting.",
  d_complaints:
    "Read the day's complaints in the partner app; fix the repeating item or packing issue.",
  d_food_ready: "Mark food ready only when the order is packed.",
  d_online: "Check the outlet stayed online through promised hours; look at the offline log.",
  d_prep: "Start prep on accept so kitchen time stays under {Minutes} minutes.",
  d_rating: "Reply to recent low ratings and fix the dish or packing issue they name.",
} as const;

export type DailyRuleCode = keyof typeof DAILY_FIXES;

export function ruleFamily(code: string): string {
  if (code === "d_sales_drop") return "sales";
  if (code === "d_prep") return "prep";
  return code;
}

export function dailyDedupeKey(code: string, outletId: string, platform: string): string {
  return `daily:${code}:${outletId}:${platform}`;
}

export function appLabel(platform: OpsScopePlatform): string {
  if (platform === "zomato") return "Zomato";
  if (platform === "swiggy") return "Swiggy";
  return "Both apps";
}

export function dailyFix(
  code: string,
  platform: OpsScopePlatform,
  config?: { prep: { actNowAboveMinutes: { value: number } } },
): string {
  if (code === "d_sales_drop" && platform === "combined") {
    return "Confirm the outlets were open and visible on both apps through dinner.";
  }
  const template =
    DAILY_FIXES[code as DailyRuleCode] ?? "Review the day's figures in the partner app.";
  const minutes = config?.prep.actNowAboveMinutes.value ?? 22;
  return template.replaceAll("{App}", appLabel(platform)).replaceAll("{Minutes}", String(minutes));
}

export interface OpsMetricPoint {
  value: number | null;
  state: "ok" | "updating" | "not_available";
}

export interface OpsAppDay {
  outletId: string;
  platform: OpsPlatform;
  date: string;
  stored: boolean;
  lagBanner: boolean;
  /** The server stored a fetch and listed this date as a gap. The file left the day out. */
  gap?: boolean;
  ingest: { code: OpsIngestCode; retryable: boolean } | null;
  metrics: Partial<Record<string, OpsMetricPoint>>;
}

export interface DailyOutlet {
  id: string;
  name: string;
  platforms: OpsPlatform[];
}

export interface DailyEvaluationInput {
  date: string;
  outlets: DailyOutlet[];
  days: OpsAppDay[];
  /** Defaults when omitted. A restaurant override is already merged. */
  config?: OpsRulesConfig;
  /**
   * The morning the brief is built, as a civil date. A stored zero day is
   * still "not in yet" until it is `blank.waitDays` old against this date.
   * Defaults to the day after `date`.
   */
  asOf?: string;
}

export interface OpsCell {
  key: string;
  label: string;
  unit: "paise" | "count" | "pct" | "minutes" | "decimal";
  value: number | null;
  pctOfDelivered: number | null;
  status: "ok" | "updating" | "not_available" | "partial";
  reason?: string;
  coverageDays: number;
  expectedDays: number;
  missingDates: string[];
  updatingDates: string[];
  baseline: { weekStart: string; value: number | null } | null;
  changePct: number | null;
  changePoints: number | null;
  source: "daily" | "zomato_week" | "payout" | "mixed";
  accuracy: "exact" | "approx";
  warned: boolean;
  window: { from: string; to: string };
}

export interface DailyFinding {
  code: DailyRuleCode;
  family: string;
  dedupeKey: string;
  outletId: string;
  outletName: string;
  platform: OpsScopePlatform;
  severity: OpsAlertSeverity;
  provisional: boolean;
  value: number | null;
  threshold: number | null;
  baselineValue: number | null;
  baselineDate: string | null;
  fixKey: string;
  fix: string;
  text: string;
  evidence: OpsCell[];
}

export interface DailyClear {
  code: DailyRuleCode;
  dedupeKey: string;
  outletId: string;
  platform: OpsScopePlatform;
  /** Set when this clear withdraws a same-day alert. */
  correction?: string;
}

export interface DailyHold {
  code: DailyRuleCode;
  dedupeKey: string;
  outletId: string;
  platform: OpsScopePlatform;
  reason: "missing" | "updating" | "guard" | "ingest" | "lag_missing";
}

export interface DailyBlocker {
  outletId: string;
  platform: OpsPlatform;
  code: OpsBlockerCode;
  dates: string[];
  retryable: boolean;
}

export interface DailyAppSnapshot {
  platform: OpsPlatform;
  mode: "ready" | "lag_missing" | "failed" | "absent";
  ingest: OpsIngestCode | null;
  retryable: boolean;
  /** A stored fetch listed this day as a gap. It is waiting, not a failed download. */
  gap: boolean;
  /** The day is still inside the wait window, or a gap that aged out with no data. */
  waitedOut: boolean;
  lagBanner: boolean;
  salesPaise: number | null;
  baselineSalesPaise: number | null;
  baselineDate: string | null;
  delivered: number | null;
  onlinePct: number | null;
  prepMinutes: number | null;
  prepBaseline: number | null;
}

export interface DailySnapshot {
  outletId: string;
  name: string;
  apps: DailyAppSnapshot[];
}

export interface DailyEvaluation {
  date: string;
  findings: DailyFinding[];
  clears: DailyClear[];
  holds: DailyHold[];
  /** Apps (and combined) whose open alerts stay frozen for this date. */
  frozenScopes: Array<{ outletId: string; platform: OpsScopePlatform }>;
  blockers: DailyBlocker[];
  snapshots: DailySnapshot[];
  ready: boolean;
  notes: string[];
}

export interface OpsBlock {
  status: OpsStatus;
  flagCount: number;
  metrics: { zomato: OpsCell[] | null; swiggy: OpsCell[] | null; combined: OpsCell[] };
  warnings: Array<{
    code: string;
    scope: OpsScopePlatform;
    value: number;
    threshold: number;
    baseline: number | null;
    baselineWeek: string | null;
    text: string;
  }>;
  fixes: string[];
  notes: Array<{ code: string; text: string }>;
}

export interface AlertBook {
  evaluatedOn?: string;
  frozenOn?: string;
  ruleSeverity?: OpsAlertSeverity | null;
  watchLevelDays?: number;
  lastEvaluableDate?: string | null;
  provisional?: boolean;
  /** Escalated because a Watch was held, and kept at Act now until it clears. */
  heldEscalation?: boolean;
  /** Reopened too soon to notify. The brief lists it as ongoing, not a call-out. */
  quiet?: boolean;
  configVersion?: string;
}

export interface AlertState {
  id: string;
  dedupeKey: string;
  cadence: "daily" | "weekly" | "payout" | "owner_rule";
  ruleCode: string;
  family: string | null;
  outletId: string | null;
  platform: OpsScopePlatform;
  severity: OpsAlertSeverity;
  status: "open" | "snoozed" | "resolved";
  firstSeenDate: string;
  lastSeenDate: string;
  occurrences: number;
  consecutiveDays: number;
  clearDays: number;
  reopenCount: number;
  escalatedAt: string | null;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  resolvedReason: "cleared" | "stale" | "owner_dismissed" | "revised" | "scope_removed" | null;
  lastValue: number | null;
  threshold: number | null;
  baselineValue: number | null;
  fixKey: string;
  fix: string;
  text: string;
  lastNotifiedAt: string | null;
  notifiedSeverity: OpsAlertSeverity | null;
  evidence: OpsCell[];
  book: AlertBook;
}

export interface AlertEventDraft {
  kind:
    | "opened"
    | "seen"
    | "escalated"
    | "deescalated"
    | "resolved"
    | "reopened"
    | "snoozed"
    | "notified";
  severity: OpsAlertSeverity | null;
  value: number | null;
  businessDate: string;
}

export type AlertOutcome =
  | {
      kind: "fire";
      severity: OpsAlertSeverity;
      value: number | null;
      threshold: number | null;
      baselineValue: number | null;
      text: string;
      fixKey: string;
      fix: string;
      evidence: OpsCell[];
      provisional: boolean;
    }
  | { kind: "clear" }
  | { kind: "frozen" };

export interface AlertTransition {
  action: "create" | "update" | "ignore";
  alert: AlertState | null;
  events: AlertEventDraft[];
  notify: boolean;
  notifyReason: "opened" | "escalated" | "back_again" | null;
}

export interface DailyBriefView {
  restaurantName: string;
  date: string;
  baselineDate: string | null;
  form: "brief" | "lag_missing" | "no_data";
  onlyApp: "Zomato" | "Swiggy" | null;
  sales: {
    combinedPaise: number | null;
    zomatoPaise: number | null;
    swiggyPaise: number | null;
    zomatoBaselinePaise: number | null;
    swiggyBaselinePaise: number | null;
  } | null;
  delivered: number | null;
  aovPaise: number | null;
  week: {
    startLabel: string;
    endLabel: string;
    currentPaise: number;
    changePct: number;
    pendingLabel?: string | null;
  } | null;
  callouts: Array<{ severity: OpsAlertSeverity; text: string; fix: string }>;
  ongoing: string | null;
  resolved: string | null;
  notes: string[];
  dataAsOf: string | null;
  catchUp: string[];
  healthyOutlets: number;
  outletCount: number;
  /** Civil date of the capture, in IST. The stamp is omitted when this is missing. */
  capturedOn?: string | null;
  /** Full header fragment, including pending apps. */
  statusText?: string;
  closingText?: string;
  overflow?: number;
  corrections?: string[];
  outletSummary?: string | null;
  exclusion?: string | null;
  /** No app is connected. The brief asks the owner to connect one. */
  connect?: boolean;
}

export interface OpsRunResult {
  reportId: string;
  version: number;
  kind: "daily_brief" | "weekly_review" | "payout_check";
  businessDate: string;
  status: OpsStatus;
  dataAsOf: string | null;
  readiness: { ready: boolean; blockers: DailyBlocker[] };
  message: { text: string; chars: number };
  workbook: { available: boolean; fileName: string | null };
  deliver: { shouldNotify: boolean; reason: "first" | "update" | "unchanged" };
  /** Read from ops config. The runner does not push while this is true. */
  shadowMode: boolean;
  alerts: { opened: string[]; escalated: string[]; resolved: string[]; ongoing: string[] };
}

export interface OpsReport {
  id: string;
  kind: OpsRunResult["kind"];
  businessDate: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  status: OpsStatus;
  dataAsOf: string | null;
  text: string;
  restaurant: OpsBlock | null;
  outlets: Array<OpsBlock & { outletId: string; name: string }>;
  deliveries: Array<{ channel: string; status: string; sentAt: string; reportVersion: number }>;
}

export interface OpsAlertView {
  id: string;
  dedupeKey: string;
  cadence: string;
  ruleCode: string;
  family: string | null;
  outletId: string | null;
  platform: OpsScopePlatform;
  severity: OpsAlertSeverity;
  status: "open" | "snoozed" | "resolved";
  firstSeenDate: string;
  lastSeenDate: string;
  consecutiveDays: number;
  occurrences: number;
  lastValue: number | null;
  threshold: number | null;
  baselineValue: number | null;
  text: string;
  fix: string;
  evidence: OpsCell[];
  snoozedUntil: string | null;
}

export const OpsRunRequestSchema = z.object({
  kind: z.enum(["daily", "weekly", "payout_check"]),
  date: z.string().optional(),
  weekStart: z.string().optional(),
  runId: z.string().min(1).max(200),
});
export type OpsRunRequest = z.infer<typeof OpsRunRequestSchema>;

export const OpsDeliveryRequestSchema = z.object({
  reportVersion: z.number().int().positive(),
  channel: z.enum(["in_app", "whatsapp"]),
  status: z.enum(["sent", "failed", "skipped"]),
  runId: z.string().min(1).max(200),
  externalId: z.string().max(200).optional(),
  error: z.string().max(2_000).optional(),
  sentAt: z.string().datetime(),
});
export type OpsDeliveryRequest = z.infer<typeof OpsDeliveryRequestSchema>;

export const OpsSnoozeSchema = z.object({
  days: z.union([z.literal(1), z.literal(3), z.literal(7)]),
});

export const OpsDismissSchema = z.object({
  reason: z.string().max(500).optional(),
});

/** PR B evaluates these. This release only declares the shape. */
export interface WeeklyOpsInput {
  weekStart: string;
}

export interface WeeklyOpsResult {
  kind: "weekly_review";
  weekStart: string;
}

export interface PayoutCheckInput {
  weekStart: string;
}

export interface PayoutCheckResult {
  kind: "payout_check";
  weekStart: string;
}

export interface WeeklyRuleSet {
  readonly version: string;
  evaluate(input: WeeklyOpsInput): WeeklyOpsResult | null;
}

export interface PayoutRuleSet {
  readonly version: string;
  evaluate(input: PayoutCheckInput): PayoutCheckResult | null;
}

export const weeklyRuleSet: WeeklyRuleSet = {
  version: "ops-weekly/2026-11-15.1",
  evaluate: () => null,
};

export const payoutRuleSet: PayoutRuleSet = {
  version: "ops-payout/2026-11-15.1",
  evaluate: () => null,
};
