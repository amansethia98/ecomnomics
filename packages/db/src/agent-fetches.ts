import type {
  CheckStoredFetchesInput,
  CheckStoredFetchesResponse,
  FetchHoldState,
  FetchPlanQuery,
  FetchPlanResponse,
  FetchReport,
  FetchStatus,
  ListFetchesQuery,
  LogFetchInput,
  MetricFetchListItem,
  MetricFetchListResponse,
} from "@rakazo/contracts";
import {
  addIsoDays,
  FETCH_HORIZON_DAYS,
  FETCH_REPORTS,
  FETCH_STATUSES,
  indiaCivilDate,
  LOG_FETCH_STATUSES,
  utcMidnight,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { FetchPlanFacts } from "./fetch-calendar.js";
import { buildFetchPlan } from "./fetch-calendar.js";
import { noteIdentityMismatch } from "./fetch-holds.js";
import type { Prisma } from "./generated/prisma/client.js";
import {
  applyLabelAging,
  fetchCoversCurrentLabels,
  findingIdFromSource,
  labelRegistryVersion,
  noteRelabelFailures,
  RELABEL_NIGHT_DAYS,
} from "./metric-label-aging.js";
import { fetchCoverageSpans, parseMissingPeriods } from "./owner-metrics-assemble.js";
import type { RestaurantScope } from "./restaurant-agent.js";
import { RestaurantAgentError } from "./restaurant-agent.js";
import { runAsSystem } from "./row-security.js";

const PLATFORMS = ["zomato", "swiggy"] as const;

/**
 * Tonight's download windows for one outlet. Dates are Asia/Kolkata civil
 * days; periodEnd is exclusive. Callers already hold the tenant context.
 */
export async function readFetchPlan(
  db: PrismaClient,
  scope: RestaurantScope,
  input: FetchPlanQuery,
): Promise<FetchPlanResponse> {
  const outlet = await loadOutlet(db, scope, input.outletId);
  const date = input.date ?? indiaCivilDate(new Date());
  const horizonStart = utcMidnight(addIsoDays(date, -FETCH_HORIZON_DAYS));
  const horizonEnd = utcMidnight(date);
  await applyLabelAging(db, scope);
  const registryVersion = await labelRegistryVersion(db);
  const relabel = await relabelWork(
    db,
    scope,
    outlet.id,
    horizonStart,
    horizonEnd,
    registryVersion,
  );
  const [facts, fetches, orders, cycles, banners, holds] = await Promise.all([
    coveredDays(db, scope, outlet.id, horizonStart, horizonEnd),
    db.metricFetch.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: outlet.id,
        platform: { in: [...PLATFORMS] },
        // A weekly, monthly, or payout file does not fill the daily series.
        reportKind: "daily",
        status: "stored",
        requestedPeriodStart: { lt: horizonEnd },
        requestedPeriodEnd: { gt: horizonStart },
      },
      select: {
        platform: true,
        requestedPeriodStart: true,
        requestedPeriodEnd: true,
        missingPeriods: true,
      },
    }),
    db.payoutOrder.groupBy({
      by: ["platform", "orderDate"],
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: outlet.id,
        platform: { in: [...PLATFORMS] },
        supersededAt: null,
        orderDate: { gte: horizonStart, lt: horizonEnd },
      },
    }),
    db.payoutCycle.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: outlet.id,
        platform: { in: [...PLATFORMS] },
        supersededAt: null,
      },
      select: {
        platform: true,
        cycleStart: true,
        cycleEnd: true,
        settlementStatus: true,
      },
    }),
    db.metricValue.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: outlet.id,
        platform: "swiggy",
        key: "lag_banner",
        granularity: "day",
        supersededAt: null,
      },
      select: { periodStart: true, periodEnd: true, value: true, valueBoolean: true },
    }),
    db.fetchHold.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: outlet.id,
        clearedAt: null,
      },
      select: { platform: true },
    }),
  ]);
  const held = new Set(holds.flatMap((row) => (isPlatform(row.platform) ? [row.platform] : [])));
  return buildFetchPlan({
    outletId: outlet.id,
    zomatoResId: outlet.zomatoResId,
    swiggyRid: outlet.swiggyRid,
    date,
    facts: [
      ...facts.flatMap((row) => {
        if (!isPlatform(row.platform)) return [];
        const day = indiaCivilDate(row.periodStart);
        return [
          {
            outletId: outlet.id,
            platform: row.platform,
            key: "delivered_orders",
            date: day,
            value: 1,
            valueBoolean: null,
            granularity: "day",
            periodEnd: addIsoDays(day, 1),
          },
        ];
      }),
      ...banners.flatMap((row) => {
        const day = indiaCivilDate(row.periodStart);
        return [
          {
            outletId: outlet.id,
            platform: "swiggy" as const,
            key: "lag_banner",
            date: day,
            value: row.value == null ? null : Number(row.value.toString()),
            valueBoolean: row.valueBoolean,
            granularity: "day",
            periodEnd: indiaCivilDate(row.periodEnd),
          },
        ];
      }),
    ],
    fetches: fetches.flatMap((row) => {
      if (!isPlatform(row.platform)) return [];
      const platform = row.platform;
      const from = indiaCivilDate(row.requestedPeriodStart);
      const to = indiaCivilDate(row.requestedPeriodEnd);
      return fetchCoverageSpans(from, to, parseMissingPeriods(row.missingPeriods)).map((span) => ({
        outletId: outlet.id,
        platform,
        status: "stored" as const,
        from: span.from,
        to: span.to,
      }));
    }),
    orders: orders.flatMap((row) => {
      if (!isPlatform(row.platform)) return [];
      return [
        {
          outletId: outlet.id,
          platform: row.platform,
          orderDate: indiaCivilDate(row.orderDate),
          settlementDate: null,
        },
      ];
    }),
    held,
    relabel,
    cycles: cycles.flatMap((row) => {
      if (!isPlatform(row.platform)) return [];
      if (row.settlementStatus !== "pending" && row.settlementStatus !== "settled") return [];
      return [
        {
          platform: row.platform,
          periodStart: indiaCivilDate(row.cycleStart),
          periodEnd: indiaCivilDate(row.cycleEnd),
          settlementStatus: row.settlementStatus,
        },
      ];
    }),
  });
}

/** Whether each file is already stored. A raw hash wins; the content hash is the fallback. */
export async function checkStoredFetches(
  db: PrismaClient,
  scope: RestaurantScope,
  input: CheckStoredFetchesInput,
): Promise<CheckStoredFetchesResponse> {
  await loadOutlet(db, scope, input.outletId);
  const or = input.files.flatMap((file) => {
    const window = {
      reportKind: file.report,
      parserVersion: file.parserVersion,
      requestedPeriodStart: utcMidnight(file.periodStart),
      requestedPeriodEnd: utcMidnight(file.periodEnd),
    };
    const clauses: Prisma.MetricFetchWhereInput[] = [{ ...window, sha256: file.sha256 }];
    if (file.rawSha256) clauses.push({ ...window, rawSha256: file.rawSha256 });
    return clauses;
  });
  const rows = await db.metricFetch.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: input.outletId,
      platform: input.platform,
      status: "stored",
      OR: or,
    },
    select: {
      id: true,
      sha256: true,
      rawSha256: true,
      reportKind: true,
      parserVersion: true,
      requestedPeriodStart: true,
      requestedPeriodEnd: true,
      capturedAt: true,
      createdAt: true,
      pendingLabels: true,
      labelSetVersion: true,
    },
  });
  const registryVersion = await labelRegistryVersion(db);
  return {
    files: input.files.map((file) => {
      const start = utcMidnight(file.periodStart).getTime();
      const end = utcMidnight(file.periodEnd).getTime();
      const candidates = rows.filter(
        (row) =>
          row.reportKind === file.report &&
          row.parserVersion === file.parserVersion &&
          row.requestedPeriodStart.getTime() === start &&
          row.requestedPeriodEnd.getTime() === end,
      );
      const rawHit = file.rawSha256
        ? newest(candidates.filter((row) => row.rawSha256 === file.rawSha256))
        : undefined;
      const contentHit = newest(candidates.filter((row) => row.sha256 === file.sha256));
      const hit = rawHit ?? contentHit;
      const current = hit != null && fetchCoversCurrentLabels(hit, registryVersion);
      return {
        sha256: file.sha256,
        rawSha256: file.rawSha256 ?? null,
        report: file.report,
        periodStart: file.periodStart,
        periodEnd: file.periodEnd,
        stored: current,
        reingest: hit != null && !current,
        fetchId: hit?.id ?? null,
      };
    }),
  };
}

/** Recent fetch rows, newest first, including log rows that stored no file. */
export async function listMetricFetches(
  db: PrismaClient,
  scope: RestaurantScope,
  input: ListFetchesQuery,
): Promise<MetricFetchListResponse> {
  await loadOutlet(db, scope, input.outletId);
  const [rows, openHolds] = await Promise.all([
    db.metricFetch.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: input.outletId,
        platform: { in: [...PLATFORMS] },
        ...(input.since ? { createdAt: { gte: new Date(input.since) } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        status: true,
        platform: true,
        reportKind: true,
        requestedPeriodStart: true,
        requestedPeriodEnd: true,
        sha256: true,
        reason: true,
        createdAt: true,
      },
    }),
    db.fetchHold.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: input.outletId,
        clearedAt: null,
      },
      select: { platform: true, reason: true, createdAt: true },
    }),
  ]);
  return {
    holds: holdStates(openHolds),
    fetches: rows.flatMap((row) => {
      if (!isPlatform(row.platform) || !isReport(row.reportKind) || !isStatus(row.status)) {
        return [];
      }
      const logged = isLogStatus(row.status);
      const item: MetricFetchListItem = {
        fetchId: row.id,
        status: row.status,
        rejectedMismatch: row.status === "rejected_mismatch",
        needsOwner: row.status === "needs_owner",
        warnings: row.status === "stored" && row.reason ? [row.reason] : [],
        reason: logged ? row.reason : null,
        platform: row.platform,
        report: row.reportKind,
        window: {
          periodStart: indiaCivilDate(row.requestedPeriodStart),
          periodEnd: indiaCivilDate(row.requestedPeriodEnd),
        },
        sha256: row.sha256,
        createdAt: row.createdAt.toISOString(),
      };
      return [item];
    }),
  };
}

/** Records a download that produced no file. The reason is a short code, not prose. */
export async function logMetricFetch(
  db: PrismaClient,
  scope: RestaurantScope,
  input: LogFetchInput,
): Promise<{ fetchId: string; status: LogFetchInput["status"] }> {
  const outlet = await loadOutlet(db, scope, input.outletId);
  const platformId = input.platform === "zomato" ? outlet.zomatoResId : outlet.swiggyRid;
  const fetch = await db.metricFetch.create({
    data: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: outlet.id,
      platform: input.platform,
      reportKind: input.report,
      status: input.status,
      requestedRestaurantId: platformId,
      requestedName: outlet.name,
      requestedCity: outlet.city,
      requestedPeriodStart: utcMidnight(input.periodStart),
      requestedPeriodEnd: utcMidnight(input.periodEnd),
      sha256: null,
      rawSha256: null,
      attemptCount: 1,
      source: "log",
      parserVersion: "none",
      reason: input.reason,
      runId: input.runId,
      capturedAt: new Date(),
    },
    select: { id: true, status: true },
  });
  if (!isLogStatus(fetch.status)) {
    throw new RestaurantAgentError("invalid_body", 400, "The fetch was not logged.");
  }
  if (fetch.status === "local_mismatch") {
    await noteIdentityMismatch(db, scope, outlet.id, input.platform);
  }
  if (fetch.status === "download_failed") {
    await noteFailedDownload(db, scope, outlet.id, input);
  }
  return { fetchId: fetch.id, status: fetch.status };
}

async function noteFailedDownload(
  db: PrismaClient,
  scope: RestaurantScope,
  outletId: string,
  input: LogFetchInput,
): Promise<void> {
  const pending = await db.metricValue.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId,
      platform: input.platform,
      state: "pending_label",
      supersededAt: null,
      granularity: "day",
      periodStart: { gte: utcMidnight(input.periodStart), lt: utcMidnight(input.periodEnd) },
    },
    select: { source: true, periodStart: true },
    take: RELABEL_NIGHT_DAYS,
  });
  await noteRelabelFailures(
    db,
    scope,
    indiaCivilDate(new Date()),
    pending.flatMap((row) => {
      const findingId = findingIdFromSource(row.source);
      if (!findingId) return [];
      return [
        {
          outletId,
          platform: input.platform,
          findingId,
          periodStart: indiaCivilDate(row.periodStart),
        },
      ];
    }),
  );
}

async function relabelWork(
  db: PrismaClient,
  scope: RestaurantScope,
  outletId: string,
  horizonStart: Date,
  horizonEnd: Date,
  version: number,
): Promise<FetchPlanFactsRelabel> {
  const [pending, orders] = await Promise.all([
    db.metricValue.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId,
        state: "pending_label",
        supersededAt: null,
        granularity: "day",
        periodStart: { gte: horizonStart, lt: horizonEnd },
      },
      select: {
        platform: true,
        periodStart: true,
        source: true,
        fetch: { select: { labelSetVersion: true, capturedAt: true } },
      },
    }),
    db.payoutOrder.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId,
        supersededAt: null,
        NOT: { pendingFields: { isEmpty: true } },
      },
      select: {
        platform: true,
        cycleStart: true,
        cycleEnd: true,
        fetch: { select: { labelSetVersion: true, capturedAt: true } },
      },
    }),
  ]);
  const findingIds = [...new Set(pending.flatMap((row) => findingIdFromSource(row.source) ?? []))];
  const findings =
    findingIds.length === 0
      ? []
      : await runAsSystem("relabel findings", () =>
          db.metricLabelFinding.findMany({
            where: { id: { in: findingIds } },
            select: { id: true, slotId: true, status: true },
          }),
        );
  const byId = new Map(findings.map((row) => [row.id, row]));
  const slotIds = [...new Set(findings.flatMap((row) => (row.slotId ? [row.slotId] : [])))];
  const aliases =
    slotIds.length === 0
      ? []
      : await db.metricLabelAlias.findMany({
          where: { slotId: { in: slotIds }, role: "read", retiredAt: null },
          select: { slotId: true, createdAt: true },
        });
  const days: Array<{
    platform: "zomato" | "swiggy";
    days: Array<{ date: string; findingIds: string[] }>;
    payouts?: Array<{ periodStart: string; periodEnd: string; findingIds: string[] }>;
  }> = [];
  const grouped = new Map<
    string,
    { platform: "zomato" | "swiggy"; date: string; findingIds: Set<string> }
  >();
  for (const row of pending) {
    if (!isPlatform(row.platform)) continue;
    const parsed = row.fetch?.labelSetVersion ?? null;
    if (parsed != null && parsed >= version) continue;
    const findingId = findingIdFromSource(row.source);
    const finding = findingId ? byId.get(findingId) : undefined;
    if (!finding?.slotId) continue;
    const added = aliases.some(
      (alias) =>
        alias.slotId === finding.slotId &&
        (finding.status === "approved" ||
          (row.fetch?.capturedAt != null && alias.createdAt > row.fetch.capturedAt)),
    );
    if (!added) continue;
    const date = indiaCivilDate(row.periodStart);
    const key = `${row.platform}\t${date}`;
    const item = grouped.get(key) ?? {
      platform: row.platform,
      date,
      findingIds: new Set<string>(),
    };
    if (findingId) item.findingIds.add(findingId);
    grouped.set(key, item);
  }
  const byPlatform = new Map<"zomato" | "swiggy", Array<{ date: string; findingIds: string[] }>>();
  for (const item of grouped.values()) {
    const list = byPlatform.get(item.platform) ?? [];
    list.push({ date: item.date, findingIds: [...item.findingIds] });
    byPlatform.set(item.platform, list);
  }
  for (const [platform, list] of byPlatform) {
    const chosen = [...list]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, RELABEL_NIGHT_DAYS);
    days.push({ platform, days: chosen });
  }
  const payouts = new Map<
    string,
    { platform: "zomato" | "swiggy"; periodStart: string; periodEnd: string }
  >();
  for (const order of orders) {
    if (!isPlatform(order.platform)) continue;
    const parsed = order.fetch?.labelSetVersion ?? null;
    if (parsed != null && parsed >= version) continue;
    const periodStart = indiaCivilDate(order.cycleStart);
    const periodEnd = indiaCivilDate(order.cycleEnd);
    payouts.set(`${order.platform}\t${periodStart}\t${periodEnd}`, {
      platform: order.platform,
      periodStart,
      periodEnd,
    });
  }
  for (const payout of payouts.values()) {
    const host = days.find((item) => item.platform === payout.platform) ?? {
      platform: payout.platform,
      days: [],
    };
    host.payouts = [
      ...(host.payouts ?? []),
      { periodStart: payout.periodStart, periodEnd: payout.periodEnd, findingIds: [] },
    ];
    if (!days.includes(host)) days.push(host);
  }
  return days;
}

type FetchPlanFactsRelabel = NonNullable<FetchPlanFacts["relabel"]>;

function holdStates(
  rows: Array<{ platform: string; reason: string; createdAt: Date }>,
): FetchHoldState[] {
  return PLATFORMS.map((platform) => {
    const hold = rows.find((row) => row.platform === platform);
    return {
      platform,
      held: Boolean(hold),
      reason: hold?.reason ?? null,
      createdAt: hold?.createdAt.toISOString() ?? null,
    };
  });
}

async function loadOutlet(db: PrismaClient, scope: RestaurantScope, outletId: string) {
  const outlet = await db.outlet.findFirst({
    where: { id: outletId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { id: true, name: true, city: true, zomatoResId: true, swiggyRid: true },
  });
  if (!outlet) {
    throw new RestaurantAgentError("unknown_outlet", 422, "Outlet is not part of this restaurant.");
  }
  return outlet;
}

function coveredDays(
  db: PrismaClient,
  scope: RestaurantScope,
  outletId: string,
  start: Date,
  end: Date,
) {
  return db.metricValue.groupBy({
    by: ["platform", "periodStart"],
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId,
      platform: { in: [...PLATFORMS] },
      supersededAt: null,
      granularity: "day",
      periodStart: { gte: start, lt: end },
      OR: [{ value: { not: null } }, { valueBoolean: { not: null } }],
    },
  });
}

function newest<T extends { capturedAt: Date; createdAt: Date; id: string }>(
  rows: readonly T[],
): T | undefined {
  return [...rows].sort((a, b) => {
    const captured = b.capturedAt.getTime() - a.capturedAt.getTime();
    if (captured !== 0) return captured;
    const created = b.createdAt.getTime() - a.createdAt.getTime();
    if (created !== 0) return created;
    return a.id < b.id ? 1 : -1;
  })[0];
}

function isPlatform(value: string): value is "zomato" | "swiggy" {
  return value === "zomato" || value === "swiggy";
}

function isReport(value: string): value is FetchReport {
  return (FETCH_REPORTS as readonly string[]).includes(value);
}

function isStatus(value: string): value is FetchStatus {
  return (FETCH_STATUSES as readonly string[]).includes(value);
}

function isLogStatus(value: string): value is LogFetchInput["status"] {
  return (LOG_FETCH_STATUSES as readonly string[]).includes(value);
}
