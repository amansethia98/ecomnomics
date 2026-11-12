import type { OwnerMetricsQuery, OwnerMetricsResponse } from "@rakazo/contracts";
import { civilRangeBounds, indiaCivilDate } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import type { OwnerCycleFact, OwnerOrderFact } from "./owner-metrics-assemble.js";
import { assembleOwnerMetrics, ownerMetricLoadKeys } from "./owner-metrics-assemble.js";
import type { RestaurantScope } from "./restaurant-agent.js";
import { RestaurantAgentError } from "./restaurant-agent.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const PLATFORMS = ["zomato", "swiggy"] as const;

/**
 * Confirms the user is a member of the restaurant's space, then reads inside
 * that tenant so row security applies. A non-member gets the same not-found
 * answer as a missing restaurant.
 */
export async function readOwnerMetricsForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  query: OwnerMetricsQuery,
): Promise<OwnerMetricsResponse> {
  const restaurant = await runAsSystem("restaurant metrics membership", () =>
    db.restaurant.findFirst({
      where: {
        id: restaurantId,
        space: { deletingAt: null, memberships: { some: { userId } } },
      },
      select: { id: true, spaceId: true },
    }),
  );
  if (!restaurant) {
    throw new RestaurantAgentError("not_found", 404, "Restaurant not found.");
  }
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, () =>
    readOwnerMetrics(db, { restaurantId: restaurant.id, spaceId: restaurant.spaceId }, query),
  );
}

/**
 * One read for a restaurant's outlets. A fixed set of queries loads the window,
 * then the rollup runs in memory. Callers already hold the tenant context.
 */
export async function readOwnerMetrics(
  db: PrismaClient,
  scope: Pick<RestaurantScope, "restaurantId" | "spaceId">,
  query: OwnerMetricsQuery,
  today = indiaCivilDate(new Date()),
): Promise<OwnerMetricsResponse> {
  const started = performance.now();
  const outlets = await db.outlet.findMany({
    where: { restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const known = new Set(outlets.map((outlet) => outlet.id));
  if (query.outletIds?.some((id) => !known.has(id))) {
    throw new RestaurantAgentError("unknown_outlet", 422, "Outlet is not part of this restaurant.");
  }
  const outletIds = query.outletIds ?? outlets.map((outlet) => outlet.id);
  const platforms = query.platform === "all" ? [...PLATFORMS] : [query.platform];
  const range = civilRangeBounds(query.from, query.to);
  const keys = ownerMetricLoadKeys(query.keys);
  const where = {
    restaurantId: scope.restaurantId,
    spaceId: scope.spaceId,
    outletId: { in: outletIds },
    platform: { in: platforms },
    supersededAt: null,
  };
  const [facts, history, fetches, orders, adjustments, cycles] = await Promise.all([
    db.metricValue.findMany({
      where: {
        ...where,
        key: { in: keys },
        periodStart: { gte: range.start, lt: range.end },
      },
      select: {
        outletId: true,
        platform: true,
        key: true,
        granularity: true,
        periodStart: true,
        periodEnd: true,
        value: true,
        valueBoolean: true,
      },
    }),
    db.metricValue.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: { in: outletIds },
        platform: { in: platforms },
        key: { in: ownerMetricLoadKeys(query.keys) },
        supersededAt: { not: null },
        periodStart: { lt: range.end },
        periodEnd: { gt: range.start },
      },
      select: {
        outletId: true,
        platform: true,
        key: true,
        granularity: true,
        periodStart: true,
        periodEnd: true,
      },
    }),
    db.metricFetch.findMany({
      where: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: { in: outletIds },
        platform: { in: platforms },
        status: "stored",
        requestedPeriodStart: { lt: range.end },
        requestedPeriodEnd: { gt: range.start },
      },
      select: {
        outletId: true,
        platform: true,
        status: true,
        requestedPeriodStart: true,
        requestedPeriodEnd: true,
      },
    }),
    db.payoutOrder.findMany({
      where: {
        ...where,
        OR: [
          { orderDate: { gte: range.start, lt: range.end } },
          { settlementDate: { gte: range.start, lt: range.end } },
        ],
      },
      select: {
        outletId: true,
        platform: true,
        orderDate: true,
        settlementStatus: true,
        settlementDate: true,
        utrLast4: true,
        category: true,
        customerHash: true,
        grossSalesPaise: true,
        discountPaise: true,
        commissionPaise: true,
        platformFeesPaise: true,
        taxesPaise: true,
        tdsPaise: true,
        tcsPaise: true,
        cvPaise: true,
        gstCollectedPaise: true,
        complaintsCancellationChargesPaise: true,
        netPayoutPaise: true,
        paidAmountPaise: true,
      },
    }),
    db.payoutAdjustment.findMany({
      where,
      select: {
        outletId: true,
        platform: true,
        type: true,
        periodFrom: true,
        periodTo: true,
        amountPaise: true,
        bookedCycle: true,
      },
    }),
    db.payoutCycle.findMany({
      where,
      select: {
        outletId: true,
        platform: true,
        cycleId: true,
        settlementStatus: true,
        settlementDate: true,
        utrLast4: true,
        platformNetPayoutPaise: true,
        paidAmountPaise: true,
      },
    }),
  ]);
  const cycleById = new Map(cycles.map((cycle) => [cycle.cycleId, cycle]));
  const response = assembleOwnerMetrics({
    query,
    today,
    outlets,
    facts: facts.flatMap((row) => {
      if (!isPlatform(row.platform)) return [];
      return [
        {
          outletId: row.outletId,
          platform: row.platform,
          key: row.key,
          date: indiaCivilDate(row.periodStart),
          value: row.value == null ? null : Number(row.value.toString()),
          valueBoolean: row.valueBoolean,
          granularity: row.granularity,
          periodEnd: indiaCivilDate(row.periodEnd),
        },
      ];
    }),
    fetches: fetches.flatMap((row) => {
      if (!isPlatform(row.platform)) return [];
      return [
        {
          outletId: row.outletId,
          platform: row.platform,
          status: row.status,
          from: indiaCivilDate(row.requestedPeriodStart),
          to: indiaCivilDate(row.requestedPeriodEnd),
        },
      ];
    }),
    history: history.flatMap((row) => {
      if (!isPlatform(row.platform)) return [];
      return [
        {
          outletId: row.outletId,
          platform: row.platform,
          key: row.key,
          from: indiaCivilDate(row.periodStart),
          to: indiaCivilDate(row.periodEnd),
        },
      ];
    }),
    orders: orders.flatMap((row) => {
      const platform = row.platform;
      if (!isPlatform(platform)) return [];
      if (row.settlementStatus !== "settled" && row.settlementStatus !== "pending") return [];
      return [orderFact({ ...row, platform })];
    }),
    adjustments: adjustments.flatMap((row) => {
      if (!isPlatform(row.platform)) return [];
      const cycle = cycleById.get(row.bookedCycle);
      const status = cycle?.settlementStatus === "settled" ? "settled" : "pending";
      return [
        {
          outletId: row.outletId,
          platform: row.platform,
          type: row.type,
          periodFrom: indiaCivilDate(row.periodFrom),
          periodTo: indiaCivilDate(row.periodTo),
          amountPaise: row.amountPaise,
          settlementDate: cycle?.settlementDate ? indiaCivilDate(cycle.settlementDate) : null,
          settlementStatus: status,
        },
      ];
    }),
    cycles: cycles.flatMap((row) => {
      const platform = row.platform;
      if (!isPlatform(platform)) return [];
      if (row.settlementStatus !== "settled" && row.settlementStatus !== "pending") return [];
      return [cycleFact({ ...row, platform })];
    }),
  });
  getLogger().info("owner.metrics.read", {
    durationMs: Math.round(performance.now() - started),
    outlets: outletIds.length,
    days: daysBetweenSafe(query.from, query.to),
    keys: query.keys.length,
  });
  return response;
}

function orderFact(row: {
  outletId: string;
  platform: "zomato" | "swiggy";
  orderDate: Date;
  settlementStatus: string;
  settlementDate: Date | null;
  utrLast4: string | null;
  category: string | null;
  customerHash: string | null;
  grossSalesPaise: number;
  discountPaise: number;
  commissionPaise: number;
  platformFeesPaise: number;
  taxesPaise: number;
  tdsPaise: number;
  tcsPaise: number;
  cvPaise: number;
  gstCollectedPaise: number;
  complaintsCancellationChargesPaise: number;
  netPayoutPaise: number;
  paidAmountPaise: number | null;
}): OwnerOrderFact {
  return {
    outletId: row.outletId,
    platform: row.platform,
    orderDate: indiaCivilDate(row.orderDate),
    settlementStatus: row.settlementStatus === "settled" ? "settled" : "pending",
    settlementDate: row.settlementDate ? indiaCivilDate(row.settlementDate) : null,
    utrLast4: row.utrLast4,
    category: row.category,
    customerHash: row.customerHash,
    grossSalesPaise: row.grossSalesPaise,
    discountPaise: row.discountPaise,
    commissionPaise: row.commissionPaise,
    platformFeesPaise: row.platformFeesPaise,
    taxesPaise: row.taxesPaise,
    tdsPaise: row.tdsPaise,
    tcsPaise: row.tcsPaise,
    cvPaise: row.cvPaise,
    gstCollectedPaise: row.gstCollectedPaise,
    complaintsCancellationChargesPaise: row.complaintsCancellationChargesPaise,
    netPayoutPaise: row.netPayoutPaise,
    paidAmountPaise: row.paidAmountPaise,
  };
}

function cycleFact(row: {
  outletId: string;
  platform: "zomato" | "swiggy";
  settlementStatus: string;
  settlementDate: Date | null;
  utrLast4: string | null;
  platformNetPayoutPaise: number | null;
  paidAmountPaise: number | null;
}): OwnerCycleFact {
  return {
    outletId: row.outletId,
    platform: row.platform,
    settlementStatus: row.settlementStatus === "settled" ? "settled" : "pending",
    settlementDate: row.settlementDate ? indiaCivilDate(row.settlementDate) : null,
    utrLast4: row.utrLast4,
    platformNetPayoutPaise: row.platformNetPayoutPaise,
    paidAmountPaise: row.paidAmountPaise,
  };
}

function isPlatform(value: string): value is "zomato" | "swiggy" {
  return value === "zomato" || value === "swiggy";
}

function daysBetweenSafe(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 86_400_000);
}
