import { createHash } from "node:crypto";
import type { IngestMetricReportInput, ReadMetricsQuery, StoredWindowRow } from "@rakazo/contracts";
import {
  civilDayBounds,
  civilRangeBounds,
  comparePlatformValue,
  evaluateBusinessReport,
  FILE_IDENTITY_ATTEMPT_LIMIT,
  indiaCivilDate,
  METRIC_PARSER_VERSION,
  missingPlatformIdReason,
  planReplaceWindow,
  reportGranularity,
  rollupMetrics,
  utcMidnight,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import type { RestaurantScope } from "./restaurant-agent.js";
import { lockMetricWindow, metricWindowLockKey, RestaurantAgentError } from "./restaurant-agent.js";

export interface IngestMetricReportResult {
  fetchId: string;
  status: "stored" | "skipped" | "rejected_mismatch" | "needs_owner";
  reason: string | null;
  written: number;
  superseded: number;
  checks: number;
}

function indiaToday(now = new Date()): string {
  return indiaCivilDate(now);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function ingestBusinessReport(
  db: PrismaClient,
  scope: RestaurantScope,
  input: IngestMetricReportInput,
): Promise<IngestMetricReportResult> {
  const outlet = await db.outlet.findFirst({
    where: { id: input.outletId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { name: true, city: true, zomatoResId: true, swiggyRid: true },
  });
  if (!outlet) {
    throw new RestaurantAgentError("unknown_outlet", 422, "Outlet is not part of this restaurant.");
  }
  const restaurantId = input.platform === "zomato" ? outlet.zomatoResId : outlet.swiggyRid;
  const digest = sha256(input.csv);
  const requestedStart = utcMidnight(input.periodStart);
  const requestedEnd = utcMidnight(input.periodEnd);
  const capturedAt = new Date(input.capturedAt);
  if (!restaurantId) {
    const reason = missingPlatformIdReason(input.platform);
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        status: "rejected_mismatch",
        digest,
        attempt: input.attempt ?? 1,
        reason,
        requestedRestaurantId: null,
        requestedName: outlet.name,
        requestedCity: outlet.city,
        requestedStart,
        requestedEnd,
        observed: null,
        capturedAt,
      }),
    });
    return {
      fetchId: fetch.id,
      status: "rejected_mismatch",
      reason,
      written: 0,
      superseded: 0,
      checks: 0,
    };
  }
  const evaluation = evaluateBusinessReport(input.csv, {
    platform: input.platform,
    report: input.report,
    restaurantId,
    name: outlet.name,
    city: outlet.city,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
  const observed = evaluation.observed;
  const warning =
    evaluation.ok && evaluation.warnings.length > 0 ? evaluation.warnings.join(" ") : null;

  if (!evaluation.ok) {
    const prior = await db.metricFetch.count({
      where: {
        outletId: input.outletId,
        platform: input.platform,
        reportKind: input.report,
        requestedPeriodStart: requestedStart,
        requestedPeriodEnd: requestedEnd,
        status: { in: ["rejected_mismatch", "needs_owner"] },
      },
    });
    const attempt = input.attempt ?? prior + 1;
    const status = attempt >= FILE_IDENTITY_ATTEMPT_LIMIT ? "needs_owner" : "rejected_mismatch";
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        status,
        digest,
        attempt,
        reason: evaluation.reason,
        requestedRestaurantId: restaurantId,
        requestedName: outlet.name,
        requestedCity: outlet.city,
        requestedStart,
        requestedEnd,
        observed,
        capturedAt,
      }),
    });
    return {
      fetchId: fetch.id,
      status,
      reason: evaluation.reason,
      written: 0,
      superseded: 0,
      checks: 0,
    };
  }

  const duplicate = await db.metricFetch.findFirst({
    where: {
      outletId: input.outletId,
      platform: input.platform,
      reportKind: input.report,
      sha256: digest,
      parserVersion: METRIC_PARSER_VERSION,
      requestedPeriodStart: requestedStart,
      requestedPeriodEnd: requestedEnd,
      status: "stored",
    },
    select: { id: true },
  });
  if (duplicate) {
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        status: "skipped",
        digest,
        attempt: input.attempt ?? 1,
        reason: "This file was already stored.",
        requestedRestaurantId: restaurantId,
        requestedName: outlet.name,
        requestedCity: outlet.city,
        requestedStart,
        requestedEnd,
        observed,
        capturedAt,
      }),
    });
    return {
      fetchId: fetch.id,
      status: "skipped",
      reason: null,
      written: 0,
      superseded: 0,
      checks: 0,
    };
  }

  const granularity = evaluation.granularity;
  const periods = evaluation.observed.periods;
  const ownedKeys = [...new Set(evaluation.rows.map((row) => row.key))];
  const result = await db.$transaction(async (tx) => {
    const locks = [
      ...new Set(
        periods.map((period) =>
          metricWindowLockKey({
            outletId: input.outletId,
            platform: input.platform,
            granularity,
            periodStart: period.start,
            periodEnd: period.end,
          }),
        ),
      ),
    ].sort();
    for (const key of locks) await lockMetricWindow(tx, key);
    const fetch = await tx.metricFetch.create({
      data: fetchData(scope, input, {
        status: "stored",
        digest,
        attempt: input.attempt ?? 1,
        reason: warning,
        requestedRestaurantId: restaurantId,
        requestedName: outlet.name,
        requestedCity: outlet.city,
        requestedStart,
        requestedEnd,
        observed,
        capturedAt,
      }),
    });
    const existing = await tx.metricValue.findMany({
      where: {
        outletId: input.outletId,
        platform: input.platform,
        granularity,
        supersededAt: null,
        key: { in: ownedKeys },
        OR: periods.map((period) => {
          const start = civilDayBounds(period.start);
          const end = civilDayBounds(period.end);
          return {
            periodStart: { gte: start.start, lt: start.end },
            periodEnd: { gte: end.start, lt: end.end },
          };
        }),
      },
    });
    const mapped: StoredWindowRow[] = [];
    const duplicateIds: string[] = [];
    const seen = new Set<string>();
    for (const row of existing) {
      const item = {
        id: row.id,
        key: row.key,
        periodStart: indiaCivilDate(row.periodStart),
        periodEnd: indiaCivilDate(row.periodEnd),
        rowRole: row.rowRole === "platform_check" ? ("platform_check" as const) : ("fact" as const),
        value: row.value == null ? null : Number(row.value.toString()),
        source: row.source,
      };
      const slot = `${item.periodStart}\t${item.periodEnd}\t${item.key}\t${item.rowRole}`;
      if (seen.has(slot)) {
        duplicateIds.push(row.id);
        continue;
      }
      seen.add(slot);
      mapped.push(item);
    }
    const plan = planReplaceWindow(
      mapped,
      evaluation.rows.map((row) => ({
        key: row.key,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        rowRole: row.rowRole,
        value: row.value,
        source: row.source,
      })),
    );
    const supersedeIds = [...plan.supersedeIds, ...duplicateIds];
    if (supersedeIds.length > 0) {
      await tx.metricValue.updateMany({
        where: { id: { in: supersedeIds } },
        data: { supersededAt: capturedAt },
      });
    }
    if (plan.inserts.length > 0) {
      await tx.metricValue.createMany({
        data: plan.inserts.map((row) => ({
          restaurantId: scope.restaurantId,
          spaceId: scope.spaceId,
          outletId: input.outletId,
          platform: input.platform,
          granularity,
          periodStart: utcMidnight(row.periodStart),
          periodEnd: utcMidnight(row.periodEnd),
          key: row.key,
          rowRole: row.rowRole,
          value: row.value,
          runId: input.runId,
          source: row.source,
          capturedAt,
          fetchId: fetch.id,
        })),
      });
    }
    if (evaluation.items.length > 0) {
      await tx.platformWindowItem.createMany({
        data: evaluation.items.map((item) => ({
          restaurantId: scope.restaurantId,
          spaceId: scope.spaceId,
          outletId: input.outletId,
          platform: input.platform,
          periodStart: utcMidnight(item.periodStart),
          periodEnd: utcMidnight(item.periodEnd),
          rank: item.rank,
          itemName: item.itemName,
          revenuePaise: item.revenuePaise,
          fetchId: fetch.id,
        })),
      });
    }
    const checks = await writeChecks(tx, scope, input, fetch.id, capturedAt, evaluation);
    return {
      fetchId: fetch.id,
      written: plan.inserts.length,
      superseded: supersedeIds.length,
      checks,
    };
  });
  return { ...result, status: "stored", reason: warning };
}

async function writeChecks(
  tx: Prisma.TransactionClient,
  scope: RestaurantScope,
  input: IngestMetricReportInput,
  fetchId: string,
  checkedAt: Date,
  evaluation: Extract<ReturnType<typeof evaluateBusinessReport>, { ok: true }>,
): Promise<number> {
  if (input.report === "daily") return 0;
  const granularity = reportGranularity(input.platform, input.report);
  let written = 0;
  for (const period of evaluation.observed.periods) {
    const range = civilRangeBounds(period.start, period.end);
    const facts = await tx.metricValue.findMany({
      where: {
        outletId: input.outletId,
        platform: input.platform,
        granularity: "day",
        rowRole: "fact",
        supersededAt: null,
        periodStart: { gte: range.start, lt: range.end },
      },
    });
    const rollup = rollupMetrics(
      facts.map((row) => ({
        key: row.key,
        platform: input.platform,
        granularity: row.granularity,
        periodStart: indiaCivilDate(row.periodStart),
        periodEnd: indiaCivilDate(row.periodEnd),
        value: row.value == null ? null : Number(row.value.toString()),
        rowRole: "fact" as const,
      })),
      {
        platform: input.platform,
        from: period.start,
        to: period.end,
        today: period.end,
        basis: "order_date",
      },
    );
    const rebuilt = new Map(rollup.values.map((value) => [value.key, value.value]));
    const checks = evaluation.rows.filter(
      (row) =>
        row.rowRole === "platform_check" &&
        row.periodStart === period.start &&
        row.periodEnd === period.end,
    );
    const data = [];
    for (const row of checks) {
      const comparison = comparePlatformValue(
        row.key,
        input.platform,
        granularity,
        rebuilt.get(row.key) ?? null,
        row.value,
      );
      if (comparison.action !== "check") continue;
      data.push({
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: input.outletId,
        platform: input.platform,
        key: row.key,
        periodStart: utcMidnight(period.start),
        periodEnd: utcMidnight(period.end),
        rebuiltValue: rebuilt.get(row.key) ?? null,
        platformValue: row.value,
        gap: comparison.gap,
        tolerance: comparison.tolerance,
        pass: comparison.pass,
        fetchId,
        checkedAt,
      });
    }
    if (data.length > 0) {
      await tx.metricCheck.createMany({ data });
      written += data.length;
    }
  }
  return written;
}

function fetchData(
  scope: RestaurantScope,
  input: IngestMetricReportInput,
  details: {
    status: IngestMetricReportResult["status"];
    digest: string;
    attempt: number;
    reason: string | null;
    requestedRestaurantId: string | null;
    requestedName: string;
    requestedCity: string;
    requestedStart: Date;
    requestedEnd: Date;
    observed: {
      restaurantId: string;
      name: string;
      city: string;
      periods: Array<{ start: string; end: string; label: string }>;
    } | null;
    capturedAt: Date;
  },
) {
  const first = details.observed?.periods[0];
  const last = details.observed?.periods.at(-1);
  return {
    restaurantId: scope.restaurantId,
    spaceId: scope.spaceId,
    outletId: input.outletId,
    platform: input.platform,
    reportKind: input.report,
    status: details.status,
    requestedRestaurantId: details.requestedRestaurantId,
    requestedName: details.requestedName,
    requestedCity: details.requestedCity,
    requestedPeriodStart: details.requestedStart,
    requestedPeriodEnd: details.requestedEnd,
    observedRestaurantId: details.observed?.restaurantId ?? null,
    observedName: details.observed?.name ?? null,
    observedCity: details.observed?.city ?? null,
    observedPeriodStart: first ? utcMidnight(first.start) : null,
    observedPeriodEnd: last ? utcMidnight(last.end) : null,
    observedLabels: details.observed?.periods.map((period) => period.label).join(", ") ?? null,
    sha256: details.digest,
    attemptCount: details.attempt,
    source: input.source,
    parserVersion: METRIC_PARSER_VERSION,
    reason: details.reason,
    runId: input.runId,
    capturedAt: details.capturedAt,
  };
}

export async function readMetrics(
  db: PrismaClient,
  scope: RestaurantScope,
  query: ReadMetricsQuery,
) {
  const outlet = await db.outlet.findFirst({
    where: { id: query.outletId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { id: true },
  });
  if (!outlet) {
    throw new RestaurantAgentError("unknown_outlet", 422, "Outlet is not part of this restaurant.");
  }
  const platforms = query.platform === "combined" ? ["zomato", "swiggy"] : [query.platform];
  const range = civilRangeBounds(query.from, query.to);
  const stored = await db.metricValue.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: query.outletId,
      platform: { in: platforms },
      supersededAt: null,
      periodStart: { gte: range.start, lt: range.end },
    },
  });
  return rollupMetrics(
    stored.flatMap((row) => {
      if (row.platform !== "zomato" && row.platform !== "swiggy") return [];
      if (row.rowRole !== "fact" && row.rowRole !== "platform_check") return [];
      return [
        {
          key: row.key,
          platform: row.platform,
          granularity: row.granularity,
          periodStart: indiaCivilDate(row.periodStart),
          periodEnd: indiaCivilDate(row.periodEnd),
          value: row.value == null ? null : Number(row.value.toString()),
          rowRole: row.rowRole,
        },
      ];
    }),
    {
      platform: query.platform,
      from: query.from,
      to: query.to,
      today: indiaToday(),
      basis: query.basis,
    },
  );
}
