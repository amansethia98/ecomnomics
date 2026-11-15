import type {
  AlertBook,
  AlertState,
  DailyBlocker,
  DailyEvaluation,
  DailyFinding,
  OpsAlertView,
  OpsAppDay,
  OpsBlock,
  OpsCell,
  OpsDeliveryRequest,
  OpsIngestCode,
  OpsPlatform,
  OpsReport,
  OpsRulesOverride,
  OpsRunResult,
  OpsStatus,
} from "@rakazo/contracts";
import {
  addIsoDays,
  appLabel,
  applyDailyAlerts,
  CALLOUT_LIMIT,
  carryForward,
  civilRangeBounds,
  combinedDaySales,
  composeDailyBrief,
  DEFAULT_OPS_RULES_CONFIG,
  dailyFix,
  dismissAlert,
  displayFindings,
  evaluateDaily,
  indiaCivilDate,
  ingestRetryable,
  nextReportDelivery,
  resolvedLine,
  resolveOpsRulesConfig,
  rollupDailyApps,
  snoozeAlert,
  utcMidnight,
  viewFromDaily,
  weekSales,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import { parseMissingPeriods } from "./owner-metrics-assemble.js";
import type { RestaurantScope } from "./restaurant-agent.js";
import { RestaurantAgentError } from "./restaurant-agent.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const DAILY_KEYS = [
  "ops_sales_paise",
  "swiggy_net_sales_paise",
  "delivered_orders",
  "delayed_orders_kpt10",
  "delayed_orders_gt10",
  "bad_orders",
  "bad_orders_pct",
  "rejected_orders",
  "restaurant_cancelled_orders",
  "complaints",
  "food_ready_accuracy_pct",
  "online_pct",
  "kpt_minutes",
  "rating",
  "lag_banner",
] as const;

const FAILURES = new Set(["signed_out", "download_failed", "layout_changed", "needs_owner"]);

const RESOLVED_NAME: Record<string, string> = {
  d_delayed: "delays",
  d_sales_drop: "sales",
  d_zero_orders: "orders",
  d_bad_orders: "bad orders",
  d_cancel_reject: "cancellations",
  d_complaints: "complaints",
  d_food_ready: "food ready",
  d_online: "online time",
  d_prep: "prep time",
  d_rating: "rating",
};

interface StoredPayload {
  ready: boolean;
  blockers: DailyBlocker[];
  restaurant: OpsBlock | null;
  outlets: Array<OpsBlock & { outletId: string; name: string }>;
  configVersion?: string;
}

/** Compute yesterday's brief, upsert alerts, and store the report. Idempotent per date. */
export async function runDailyOps(
  db: PrismaClient,
  scope: RestaurantScope,
  input: { date: string; runId: string; rules?: OpsRulesOverride | null },
): Promise<OpsRunResult> {
  const config = resolveOpsRulesConfig(input.rules);
  const loaded = await loadDaily(db, scope, input.date);
  const previousDate = addIsoDays(input.date, -1);
  const earlier = evaluateDaily({
    date: previousDate,
    outlets: loaded.outlets,
    days: loaded.days,
    config,
  });
  const current = evaluateDaily({
    date: input.date,
    outlets: loaded.outlets,
    days: loaded.days,
    config,
  });
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ops-daily:${scope.restaurantId}`}, 0))::text AS "lock"`;
    const existing = await tx.opsAlert.findMany({
      where: { restaurantId: scope.restaurantId, spaceId: scope.spaceId, cadence: "daily" },
    });
    let alerts = existing.map(toAlertState);
    const earlierStep = applyDailyAlerts({
      date: previousDate,
      findings: earlier.findings,
      clears: earlier.clears,
      holds: earlier.holds,
      frozenScopes: earlier.frozenScopes,
      existing: alerts,
      config,
    });
    alerts = earlierStep.alerts;
    const step = applyDailyAlerts({
      date: input.date,
      findings: current.findings,
      clears: current.clears,
      holds: current.holds,
      frozenScopes: current.frozenScopes,
      existing: alerts,
      config,
    });
    const carried = carryForward({
      alerts: step.alerts,
      ongoingKeys: step.ongoing,
      calloutKeys: calloutDedupeKeys(current.findings),
      previousDate,
    });
    const catchUp = carried.catchUp;
    const ongoing = carried.ongoing;
    const resolved = resolvedLine(
      step.alerts
        .filter((alert) => alert.resolvedReason === "cleared" && alert.resolvedAt === input.date)
        .map((alert) => `${appLabel(alert.platform)} ${RESOLVED_NAME[alert.ruleCode] ?? "alert"}`),
    );
    const week = weekSales(input.date, weekDays(loaded.days));
    const view = viewFromDaily({
      restaurantName: loaded.name,
      evaluation: current,
      catchUp,
      ongoing,
      resolved,
      dataAsOf: loaded.dataAsOf ? istClock(loaded.dataAsOf) : null,
      week,
    });
    const brief = composeDailyBrief(view);
    const payload = { ...payloadOf(current), configVersion: config.configVersion };
    const nonce = `daily_brief-${input.date}`;
    const prior = await tx.report.findUnique({
      where: { reportNonce: { restaurantId: scope.restaurantId, clientNonce: nonce } },
    });
    const previousReady = Boolean((prior?.payload as unknown as StoredPayload | null)?.ready);
    const delivery = nextReportDelivery(
      prior
        ? {
            version: prior.version,
            status: (prior.status ?? "green") as OpsStatus,
            ready: previousReady,
          }
        : null,
      { status: brief.status, ready: current.ready },
    );
    const report = prior
      ? await tx.report.update({
          where: { id: prior.id },
          data: {
            status: brief.status,
            summaryMarkdown: brief.text,
            payload: payload as unknown as Prisma.InputJsonValue,
            version: delivery.version,
            dataAsOf: loaded.dataAsOf,
            kind: "daily_brief",
            businessDate: utcMidnight(input.date),
          },
        })
      : await tx.report.create({
          data: {
            restaurantId: scope.restaurantId,
            spaceId: scope.spaceId,
            type: "daily_brief",
            periodStart: utcMidnight(input.date),
            periodEnd: utcMidnight(addIsoDays(input.date, 1)),
            status: brief.status,
            summaryMarkdown: brief.text,
            clientNonce: nonce,
            kind: "daily_brief",
            businessDate: utcMidnight(input.date),
            payload: payload as unknown as Prisma.InputJsonValue,
            version: delivery.version,
            dataAsOf: loaded.dataAsOf,
          },
        });
    await writeAlerts(
      tx,
      scope,
      step.alerts,
      [...earlierStep.events, ...step.events],
      report.id,
      input.date,
      config.configVersion,
    );
    return {
      reportId: report.id,
      version: report.version,
      kind: "daily_brief",
      businessDate: input.date,
      status: brief.status,
      dataAsOf: loaded.dataAsOf?.toISOString() ?? null,
      readiness: { ready: current.ready, blockers: current.blockers },
      message: { text: brief.text, chars: brief.chars },
      workbook: { available: false, fileName: null },
      deliver: { shouldNotify: delivery.shouldNotify, reason: delivery.reason },
      alerts: {
        opened: [...new Set([...earlierStep.opened, ...step.opened])],
        escalated: [...new Set([...earlierStep.escalated, ...step.escalated])],
        resolved: [...new Set([...earlierStep.resolved, ...step.resolved])],
        ongoing: step.ongoing,
      },
    };
  });
}

export async function readOpsReport(
  db: PrismaClient,
  scope: Pick<RestaurantScope, "restaurantId" | "spaceId">,
  reportId: string,
): Promise<OpsReport> {
  const report = await db.report.findFirst({
    where: {
      id: reportId,
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      kind: { not: null },
    },
    include: { deliveries: { orderBy: { sentAt: "asc" } } },
  });
  if (!report?.kind || !report.businessDate) {
    throw new RestaurantAgentError("not_found", 404, "Report not found.");
  }
  const payload = (report.payload ?? {
    ready: true,
    blockers: [],
    restaurant: null,
    outlets: [],
  }) as unknown as StoredPayload;
  return {
    id: report.id,
    kind: report.kind as OpsReport["kind"],
    businessDate: civil(report.businessDate),
    periodStart: report.periodStart.toISOString(),
    periodEnd: report.periodEnd.toISOString(),
    version: report.version,
    status: (report.status ?? "green") as OpsStatus,
    dataAsOf: report.dataAsOf?.toISOString() ?? null,
    text: report.summaryMarkdown,
    restaurant: payload.restaurant,
    outlets: payload.outlets,
    deliveries: report.deliveries.map((delivery) => ({
      channel: delivery.channel,
      status: delivery.status,
      sentAt: delivery.sentAt.toISOString(),
      reportVersion: delivery.reportVersion,
    })),
  };
}

export async function recordOpsDelivery(
  db: PrismaClient,
  scope: RestaurantScope,
  reportId: string,
  input: OpsDeliveryRequest,
): Promise<void> {
  const report = await db.report.findFirst({
    where: { id: reportId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { id: true, version: true },
  });
  if (!report) throw new RestaurantAgentError("not_found", 404, "Report not found.");
  if (input.reportVersion > report.version) {
    throw new RestaurantAgentError("conflict", 409, "That report version does not exist.");
  }
  await db.opsReportDelivery.create({
    data: {
      reportId,
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      reportVersion: input.reportVersion,
      channel: input.channel,
      status: input.status,
      runId: input.runId,
      externalId: input.externalId ?? null,
      error: input.error ?? null,
      sentAt: new Date(input.sentAt),
    },
  });
}

export async function listOpsAlerts(
  db: PrismaClient,
  scope: Pick<RestaurantScope, "restaurantId" | "spaceId">,
  query: { status?: string; severity?: string; outletId?: string },
  today = indiaCivilDate(new Date()),
): Promise<{ alerts: OpsAlertView[] }> {
  if (query.outletId) {
    const outlet = await db.outlet.findFirst({
      where: { id: query.outletId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
      select: { id: true },
    });
    if (!outlet)
      throw new RestaurantAgentError(
        "unknown_outlet",
        422,
        "Outlet is not part of this restaurant.",
      );
  }
  const rows = await db.opsAlert.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.outletId ? { outletId: query.outletId } : {}),
      ...(query.status && query.status !== "open" ? { status: query.status } : {}),
      ...(query.status === "open" || !query.status ? { status: { in: ["open", "snoozed"] } } : {}),
    },
    orderBy: [{ lastSeenDate: "desc" }, { id: "asc" }],
  });
  const alerts = rows
    .map(toAlertState)
    .filter((alert) => (query.status && query.status !== "open" ? true : visible(alert, today)))
    .map(toView);
  return { alerts };
}

export async function listOpsFeedForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  query: { from?: string; to?: string; kind?: string },
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const rows = await db.report.findMany({
      where: {
        restaurantId,
        spaceId: restaurant.spaceId,
        kind: query.kind ?? { not: null },
        ...(query.from || query.to
          ? {
              businessDate: {
                ...(query.from ? { gte: utcMidnight(query.from) } : {}),
                ...(query.to ? { lte: utcMidnight(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
      take: 60,
    });
    return {
      reports: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        businessDate: row.businessDate ? civil(row.businessDate) : null,
        status: row.status,
        version: row.version,
        text: row.summaryMarkdown,
        dataAsOf: row.dataAsOf?.toISOString() ?? null,
      })),
    };
  });
}

export async function readOpsReportForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  reportId: string,
): Promise<OpsReport> {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, () =>
    readOpsReport(db, { restaurantId, spaceId: restaurant.spaceId }, reportId),
  );
}

export async function listOpsAlertsForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  query: { status?: string; severity?: string; outletId?: string },
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, () =>
    listOpsAlerts(db, { restaurantId, spaceId: restaurant.spaceId }, query),
  );
}

export async function snoozeOpsAlertForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  alertId: string,
  days: 1 | 3 | 7,
) {
  return changeAlert(db, userId, restaurantId, alertId, (alert) => {
    const today = indiaCivilDate(new Date());
    const next = snoozeAlert(alert, days, today);
    return { alert: next, kind: "snoozed" as const };
  });
}

export async function dismissOpsAlertForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  alertId: string,
) {
  return changeAlert(db, userId, restaurantId, alertId, (alert) => {
    const today = indiaCivilDate(new Date());
    return { alert: dismissAlert(alert, today), kind: "resolved" as const };
  });
}

export async function proposeOpsActionForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  alertId: string,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const row = await db.opsAlert.findFirst({
      where: { id: alertId, restaurantId, spaceId: restaurant.spaceId },
    });
    if (!row) throw new RestaurantAgentError("not_found", 404, "Alert not found.");
    const alert = toAlertState(row);
    const nonce = `ops-propose-${alert.id}`;
    const existing = await db.action.findUnique({
      where: { actionNonce: { restaurantId, clientNonce: nonce } },
    });
    if (existing) return { actionId: existing.id, status: existing.status };
    const created = await db.action.create({
      data: {
        restaurantId,
        spaceId: restaurant.spaceId,
        outletId: alert.outletId,
        platform: alert.platform,
        type: "other",
        title: alert.text.slice(0, 200),
        details: {
          source: "ops_alert",
          alertId: alert.id,
          fixKey: alert.fixKey,
          suggestion: alert.fix,
        } as Prisma.InputJsonValue,
        status: "proposed",
        clientNonce: nonce,
      },
    });
    return { actionId: created.id, status: created.status };
  });
}

async function changeAlert(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  alertId: string,
  change: (alert: AlertState) => { alert: AlertState; kind: "snoozed" | "resolved" },
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const row = await db.opsAlert.findFirst({
      where: { id: alertId, restaurantId, spaceId: restaurant.spaceId },
    });
    if (!row) throw new RestaurantAgentError("not_found", 404, "Alert not found.");
    const next = change(toAlertState(row));
    const configVersion =
      (row.evidence as { configVersion?: string } | null)?.configVersion ??
      DEFAULT_OPS_RULES_CONFIG.configVersion;
    await db.opsAlert.update({
      where: { id: row.id },
      data: alertWrite(next.alert, configVersion),
    });
    await db.opsAlertEvent.create({
      data: {
        alertId: row.id,
        restaurantId,
        spaceId: restaurant.spaceId,
        businessDate: utcMidnight(indiaCivilDate(new Date())),
        kind: next.kind,
        severity: next.alert.severity,
        value: next.alert.lastValue,
        actor: `owner:${userId}`,
      },
    });
    return toView(next.alert);
  });
}

async function memberRestaurant(db: PrismaClient, userId: string, restaurantId: string) {
  const restaurant = await runAsSystem("ops membership", () =>
    db.restaurant.findFirst({
      where: {
        id: restaurantId,
        space: { deletingAt: null, memberships: { some: { userId } } },
      },
      select: { id: true, spaceId: true, name: true },
    }),
  );
  if (!restaurant) throw new RestaurantAgentError("not_found", 404, "Restaurant not found.");
  return restaurant;
}

async function loadDaily(db: PrismaClient, scope: RestaurantScope, date: string) {
  const restaurant = await db.restaurant.findFirst({
    where: { id: scope.restaurantId, spaceId: scope.spaceId },
    select: { name: true },
  });
  if (!restaurant) throw new RestaurantAgentError("not_found", 404, "Restaurant not found.");
  const outlets = await db.outlet.findMany({
    where: { restaurantId: scope.restaurantId, spaceId: scope.spaceId, active: true },
    select: { id: true, name: true, zomatoResId: true, swiggyRid: true },
    orderBy: { name: "asc" },
  });
  const from = addIsoDays(date, -14);
  const range = civilRangeBounds(from, addIsoDays(date, 1));
  const [metrics, fetches, holds] = await Promise.all([
    db.metricValue.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        granularity: "day",
        supersededAt: null,
        rowRole: { in: ["fact", "platform_check"] },
        key: { in: [...DAILY_KEYS] },
        periodStart: { gte: range.start, lt: range.end },
      },
      select: {
        outletId: true,
        platform: true,
        key: true,
        rowRole: true,
        periodStart: true,
        value: true,
        valueBoolean: true,
        state: true,
      },
    }),
    db.metricFetch.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        requestedPeriodEnd: { gt: range.start },
        requestedPeriodStart: { lt: range.end },
      },
      select: {
        outletId: true,
        platform: true,
        status: true,
        requestedPeriodStart: true,
        requestedPeriodEnd: true,
        missingPeriods: true,
        capturedAt: true,
      },
    }),
    db.fetchHold.findMany({
      where: { restaurantId: scope.restaurantId, spaceId: scope.spaceId, clearedAt: null },
      select: { outletId: true, platform: true },
    }),
  ]);
  const days = new Map<string, OpsAppDay>();
  const slot = (outletId: string, platform: string, iso: string) => {
    const key = `${outletId}|${platform}|${iso}`;
    let found = days.get(key);
    if (!found && (platform === "zomato" || platform === "swiggy")) {
      found = {
        outletId,
        platform,
        date: iso,
        stored: false,
        lagBanner: false,
        gap: false,
        ingest: null,
        metrics: {},
      };
      days.set(key, found);
    }
    return found;
  };
  const ordered = [...metrics].sort(
    (left, right) => Number(left.rowRole === "fact") - Number(right.rowRole === "fact"),
  );
  for (const row of ordered) {
    const iso = indiaCivilDate(row.periodStart);
    const current = slot(row.outletId, row.platform, iso);
    if (!current) continue;
    if (row.key === "lag_banner") {
      current.lagBanner = row.valueBoolean === true;
      if (row.valueBoolean != null) current.stored = true;
      continue;
    }
    // platform_check is applied first. A fact row for the same key replaces it.
    current.metrics[row.key] = {
      value: row.value == null ? null : row.value.toNumber(),
      state:
        row.state === "pending_label"
          ? "updating"
          : row.state === "label_unrecoverable"
            ? "not_available"
            : "ok",
    };
    if (row.state === "ok" && row.value != null) current.stored = true;
  }
  const live = new Set([date, addIsoDays(date, -1)]);
  let dataAsOf: Date | null = null;
  for (const fetch of fetches) {
    const touchesLive = [...live].some((iso) => inRequestedWindow(fetch, iso));
    if (!touchesLive && !covers(fetch, date)) continue;
    for (const iso of live) {
      if (!inRequestedWindow(fetch, iso)) continue;
      const current = slot(fetch.outletId, fetch.platform, iso);
      if (!current) continue;
      if (fetch.status === "stored" && listedGap(fetch.missingPeriods, iso)) {
        if (!current.stored) current.gap = true;
        continue;
      }
      if (!covers(fetch, iso)) continue;
      if (fetch.status === "stored") {
        current.stored = true;
        current.gap = false;
        current.ingest = null;
        if (iso === date && (!dataAsOf || fetch.capturedAt > dataAsOf)) dataAsOf = fetch.capturedAt;
      } else if (!current.stored && FAILURES.has(fetch.status)) {
        const code = fetch.status as OpsIngestCode;
        current.ingest = { code, retryable: ingestRetryable(code) };
      }
    }
  }
  for (const hold of holds) {
    for (const iso of live) {
      const current = slot(hold.outletId, hold.platform, iso);
      // A stored file that left the day out is waiting on the next file, not a held login.
      if (!current || current.stored || current.gap) continue;
      current.ingest = { code: "fetch_held", retryable: false };
    }
  }
  return {
    name: restaurant.name,
    dataAsOf,
    outlets: outlets.map((outlet) => ({
      id: outlet.id,
      name: outlet.name,
      platforms: [
        ...(outlet.zomatoResId ? (["zomato"] as const) : []),
        ...(outlet.swiggyRid ? (["swiggy"] as const) : []),
      ],
    })),
    days: [...days.values()],
  };
}

function inRequestedWindow(
  fetch: { requestedPeriodStart: Date; requestedPeriodEnd: Date },
  iso: string,
): boolean {
  const start = indiaCivilDate(fetch.requestedPeriodStart);
  const end = indiaCivilDate(fetch.requestedPeriodEnd);
  return iso >= start && iso < end;
}

/** A stored report left this civil date out. The period end is exclusive. */
function listedGap(encoded: string | null, iso: string): boolean {
  return parseMissingPeriods(encoded).some((period) => iso >= period.start && iso < period.end);
}

function covers(
  fetch: {
    requestedPeriodStart: Date;
    requestedPeriodEnd: Date;
    missingPeriods: string | null;
  },
  iso: string,
): boolean {
  if (!inRequestedWindow(fetch, iso)) return false;
  return !listedGap(fetch.missingPeriods, iso);
}

function calloutDedupeKeys(findings: DailyFinding[]): Set<string> {
  const shown = displayFindings(findings).slice(0, CALLOUT_LIMIT);
  const groupOf = (finding: DailyFinding) =>
    finding.platform === "combined"
      ? `${finding.outletId}:combined:${finding.family}`
      : `${finding.outletId}:${finding.family}`;
  const groups = new Set(shown.map(groupOf));
  return new Set(
    findings.filter((finding) => groups.has(groupOf(finding))).map((finding) => finding.dedupeKey),
  );
}

function weekDays(days: OpsAppDay[]): Array<{ date: string; salesPaise: number | null }> {
  const dates = [...new Set(days.map((day) => day.date))];
  return dates.map((date) => ({
    date,
    salesPaise: combinedDaySales(
      days
        .filter((day) => day.date === date && day.stored && !day.ingest)
        .map((day) => ({ salesPaise: salesPaise(day) })),
    ),
  }));
}

function salesPaise(day: OpsAppDay): number | null {
  const metric =
    day.platform === "zomato" ? day.metrics.ops_sales_paise : day.metrics.swiggy_net_sales_paise;
  if (metric?.state !== "ok") return null;
  return metric.value;
}

function payloadOf(evaluation: DailyEvaluation): StoredPayload {
  const shown = displayFindings(evaluation.findings);
  const outlets = evaluation.snapshots.map((snapshot) => {
    const findings = shown.filter((finding) => finding.outletId === snapshot.outletId);
    return { outletId: snapshot.outletId, name: snapshot.name, ...block(findings, snapshot) };
  });
  const restaurant =
    outlets.length > 1
      ? {
          ...block(shown, { apps: rollupDailyApps(evaluation.snapshots) }),
          status: worst(outlets.map((outlet) => outlet.status)),
          flagCount: outlets.reduce((sum, outlet) => sum + outlet.flagCount, 0),
        }
      : null;
  return { ready: evaluation.ready, blockers: evaluation.blockers, restaurant, outlets };
}

function block(
  findings: DailyFinding[],
  snapshot: { apps: DailyEvaluation["snapshots"][number]["apps"] },
): OpsBlock {
  const status: OpsStatus = findings.some((finding) => finding.severity === "act_now")
    ? "red"
    : findings.length > 0
      ? "amber"
      : "green";
  return {
    status,
    flagCount: findings.length,
    metrics: {
      zomato: cells(snapshot, "zomato"),
      swiggy: cells(snapshot, "swiggy"),
      combined: [],
    },
    warnings: findings.map((finding) => ({
      code: finding.code,
      scope: finding.platform,
      value: finding.value ?? 0,
      threshold: finding.threshold ?? 0,
      baseline: finding.baselineValue,
      baselineWeek: finding.baselineDate,
      text: finding.text,
    })),
    fixes: findings.map((finding) => finding.fix),
    notes: [],
  };
}

function cells(
  snapshot: { apps: DailyEvaluation["snapshots"][number]["apps"] },
  platform: OpsPlatform,
): OpsCell[] | null {
  const app = snapshot.apps.find((item) => item.platform === platform);
  if (!app || app.mode === "absent") return null;
  if (app.salesPaise == null && app.delivered == null) return [];
  const cellsFor: OpsCell[] = [];
  if (app.salesPaise != null) {
    cellsFor.push(
      simpleCell(
        platform === "zomato" ? "ops_sales_paise" : "swiggy_net_sales_paise",
        "Net sales",
        "paise",
        app.salesPaise,
      ),
    );
  }
  if (app.delivered != null) {
    cellsFor.push(simpleCell("delivered_orders", "Delivered orders", "count", app.delivered));
  }
  return cellsFor;
}

function simpleCell(key: string, label: string, unit: OpsCell["unit"], value: number): OpsCell {
  return {
    key,
    label,
    unit,
    value,
    pctOfDelivered: null,
    status: "ok",
    coverageDays: 1,
    expectedDays: 1,
    missingDates: [],
    updatingDates: [],
    baseline: null,
    changePct: null,
    changePoints: null,
    source: "daily",
    accuracy: "exact",
    warned: false,
    window: { from: "", to: "" },
  };
}

function worst(statuses: OpsStatus[]): OpsStatus {
  if (statuses.includes("red")) return "red";
  if (statuses.includes("amber")) return "amber";
  return "green";
}

type AlertRow = {
  id: string;
  dedupeKey: string;
  cadence: string;
  ruleCode: string;
  family: string | null;
  outletId: string | null;
  platform: string;
  severity: string;
  status: string;
  firstSeenDate: Date;
  lastSeenDate: Date;
  occurrences: number;
  consecutiveDays: number;
  clearDays: number;
  reopenCount: number;
  escalatedAt: Date | null;
  snoozedUntil: Date | null;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  lastValue: { toNumber(): number } | null;
  threshold: { toNumber(): number } | null;
  baselineValue: { toNumber(): number } | null;
  evidence: unknown;
  fixKey: string;
  text: string;
  lastNotifiedAt: Date | null;
  notifiedSeverity: string | null;
};

function toAlertState(row: AlertRow): AlertState {
  const evidence = (row.evidence ?? {}) as { cells?: OpsCell[]; book?: AlertBook };
  const platform =
    row.platform === "swiggy" || row.platform === "combined" ? row.platform : "zomato";
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    cadence:
      row.cadence === "weekly" || row.cadence === "payout" || row.cadence === "owner_rule"
        ? row.cadence
        : "daily",
    ruleCode: row.ruleCode,
    family: row.family,
    outletId: row.outletId,
    platform,
    severity: row.severity === "act_now" ? "act_now" : "watch",
    status: row.status === "snoozed" || row.status === "resolved" ? row.status : "open",
    firstSeenDate: civil(row.firstSeenDate),
    lastSeenDate: civil(row.lastSeenDate),
    occurrences: row.occurrences,
    consecutiveDays: row.consecutiveDays,
    clearDays: row.clearDays,
    reopenCount: row.reopenCount,
    escalatedAt: row.escalatedAt ? civil(row.escalatedAt) : null,
    snoozedUntil: row.snoozedUntil ? civil(row.snoozedUntil) : null,
    resolvedAt: row.resolvedAt ? civil(row.resolvedAt) : null,
    resolvedReason:
      row.resolvedReason === "cleared" ||
      row.resolvedReason === "stale" ||
      row.resolvedReason === "owner_dismissed"
        ? row.resolvedReason
        : null,
    lastValue: row.lastValue?.toNumber() ?? null,
    threshold: row.threshold?.toNumber() ?? null,
    baselineValue: row.baselineValue?.toNumber() ?? null,
    fixKey: row.fixKey,
    fix: dailyFix(row.fixKey, platform),
    text: row.text,
    lastNotifiedAt: row.lastNotifiedAt ? civil(row.lastNotifiedAt) : null,
    notifiedSeverity:
      row.notifiedSeverity === "act_now" || row.notifiedSeverity === "watch"
        ? row.notifiedSeverity
        : null,
    evidence: evidence.cells ?? [],
    book: evidence.book ?? {},
  };
}

function toView(alert: AlertState): OpsAlertView {
  return {
    id: alert.id,
    dedupeKey: alert.dedupeKey,
    cadence: alert.cadence,
    ruleCode: alert.ruleCode,
    family: alert.family,
    outletId: alert.outletId,
    platform: alert.platform,
    severity: alert.severity,
    status: alert.status,
    firstSeenDate: alert.firstSeenDate,
    lastSeenDate: alert.lastSeenDate,
    consecutiveDays: alert.consecutiveDays,
    occurrences: alert.occurrences,
    lastValue: alert.lastValue,
    threshold: alert.threshold,
    baselineValue: alert.baselineValue,
    text: alert.text,
    fix: alert.fix,
    evidence: alert.evidence,
    snoozedUntil: alert.snoozedUntil,
  };
}

function visible(alert: AlertState, today: string): boolean {
  if (alert.status === "open") return true;
  if (alert.status !== "snoozed") return false;
  if (alert.snoozedUntil && alert.snoozedUntil < today) return true;
  return alert.severity === "act_now";
}

function alertWrite(alert: AlertState, configVersion: string): Prisma.OpsAlertUpdateInput {
  return {
    severity: alert.severity,
    status: alert.status,
    lastSeenDate: utcMidnight(alert.lastSeenDate),
    occurrences: alert.occurrences,
    consecutiveDays: alert.consecutiveDays,
    clearDays: alert.clearDays,
    reopenCount: alert.reopenCount,
    escalatedAt: alert.escalatedAt ? utcMidnight(alert.escalatedAt) : null,
    snoozedUntil: alert.snoozedUntil ? utcMidnight(alert.snoozedUntil) : null,
    resolvedAt: alert.resolvedAt ? utcMidnight(alert.resolvedAt) : null,
    resolvedReason: alert.resolvedReason,
    lastValue: alert.lastValue,
    threshold: alert.threshold,
    baselineValue: alert.baselineValue,
    evidence: {
      cells: alert.evidence,
      book: alert.book,
      configVersion,
    } as unknown as Prisma.InputJsonValue,
    fixKey: alert.fixKey,
    text: alert.text,
    lastNotifiedAt: alert.lastNotifiedAt ? utcMidnight(alert.lastNotifiedAt) : null,
    notifiedSeverity: alert.notifiedSeverity,
  };
}

async function writeAlerts(
  tx: Prisma.TransactionClient,
  scope: RestaurantScope,
  alerts: AlertState[],
  events: Array<{
    dedupeKey: string;
    event: { kind: string; severity: string | null; value: number | null; businessDate: string };
  }>,
  reportId: string,
  date: string,
  configVersion: string,
) {
  const ids = new Map<string, string>();
  for (const alert of alerts) {
    if (!alert.id) {
      const created = await tx.opsAlert.create({
        data: {
          restaurantId: scope.restaurantId,
          spaceId: scope.spaceId,
          outletId: alert.outletId,
          platform: alert.platform,
          cadence: alert.cadence,
          ruleCode: alert.ruleCode,
          family: alert.family,
          dedupeKey: alert.dedupeKey,
          ...alertWrite(alert, configVersion),
          firstSeenDate: utcMidnight(alert.firstSeenDate || date),
        } as Prisma.OpsAlertUncheckedCreateInput,
      });
      ids.set(alert.dedupeKey, created.id);
    } else {
      await tx.opsAlert.update({
        where: { id: alert.id },
        data: alertWrite(alert, configVersion),
      });
      ids.set(alert.dedupeKey, alert.id);
    }
  }
  if (events.length === 0) return;
  await tx.opsAlertEvent.createMany({
    data: events.flatMap((item) => {
      const alertId = ids.get(item.dedupeKey);
      if (!alertId) return [];
      return [
        {
          alertId,
          restaurantId: scope.restaurantId,
          spaceId: scope.spaceId,
          businessDate: utcMidnight(item.event.businessDate),
          kind: item.event.kind,
          severity: item.event.severity,
          value: item.event.value,
          reportId,
          actor: "system",
        },
      ];
    }),
  });
}

function civil(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function istClock(value: Date): string {
  const shifted = new Date(value.getTime() + 5.5 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}
