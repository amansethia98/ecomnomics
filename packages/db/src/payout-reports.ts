import { createHash } from "node:crypto";
import type { IngestPayoutReportInput, PayoutRollupInput } from "@rakazo/contracts";
import {
  checkObservedIdentity,
  FILE_IDENTITY_ATTEMPT_LIMIT,
  indiaCivilDate,
  missingPlatformIdReason,
  utcMidnight,
} from "@rakazo/contracts";
import type {
  ParsedPayoutFile,
  ParsedPayoutOrder,
  PayoutCheck,
  PayoutFileRetention,
} from "@rakazo/contracts/payout";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import type { RestaurantScope } from "./restaurant-agent.js";
import { lockMetricWindow, RestaurantAgentError } from "./restaurant-agent.js";

const MAX_PAYOUT_BYTES = 8 * 1024 * 1024;

export interface IngestPayoutFileInput extends Omit<IngestPayoutReportInput, "fileBase64"> {
  file: Uint8Array;
}

export interface IngestPayoutOptions {
  /** Defaults to CUSTOMER_HASH_SALT. Null leaves Zomato customer hashes unset. */
  salt?: string | null;
  retention?: PayoutFileRetention;
}

export interface IngestPayoutReportResult {
  fetchId: string;
  status: "stored" | "skipped" | "rejected_mismatch" | "needs_owner";
  reason: string | null;
  orders: number;
  adjustments: number;
  superseded: number;
  checks: PayoutCheck[];
  warnings: string[];
}

export async function ingestPayoutReport(
  db: PrismaClient,
  scope: RestaurantScope,
  input: IngestPayoutFileInput,
  options: IngestPayoutOptions = {},
): Promise<IngestPayoutReportResult> {
  if (input.file.byteLength > MAX_PAYOUT_BYTES) {
    throw new RestaurantAgentError("invalid_body", 400, "The payout file is larger than 8MB.");
  }
  const outlet = await db.outlet.findFirst({
    where: { id: input.outletId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { name: true, city: true, zomatoResId: true, swiggyRid: true },
  });
  if (!outlet) {
    throw new RestaurantAgentError("unknown_outlet", 422, "Outlet is not part of this restaurant.");
  }
  const payoutFile = await import("@rakazo/contracts/payout");
  const digest = createHash("sha256").update(input.file).digest("hex");
  const requestedStart = utcMidnight(input.periodStart);
  const requestedEnd = utcMidnight(input.periodEnd);
  const capturedAt = new Date(input.capturedAt);
  const restaurantId = input.platform === "zomato" ? outlet.zomatoResId : outlet.swiggyRid;
  const base = {
    requestedRestaurantId: restaurantId,
    requestedName: outlet.name,
    requestedCity: outlet.city,
    requestedStart,
    requestedEnd,
    capturedAt,
    parserVersion: payoutFile.PAYOUT_PARSER_VERSION,
  };
  if (!restaurantId) {
    const reason = missingPlatformIdReason(input.platform);
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        ...base,
        status: "rejected_mismatch",
        digest,
        attempt: input.attempt ?? 1,
        reason,
        observed: null,
      }),
    });
    return emptyResult(fetch.id, "rejected_mismatch", reason);
  }

  const salt = options.salt === undefined ? customerHashSalt() : options.salt;
  const parsed = await payoutFile.parsePayoutWorkbook(input.file, input.platform, salt);
  if (!parsed.ok) {
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        ...base,
        status: "rejected_mismatch",
        digest,
        attempt: input.attempt ?? 1,
        reason: parsed.reason,
        observed: parsed.observed,
      }),
    });
    return emptyResult(fetch.id, "rejected_mismatch", parsed.reason);
  }

  const identity = checkObservedIdentity(parsed.payout.observed, {
    platform: input.platform,
    report: "payout",
    restaurantId,
    name: outlet.name,
    city: outlet.city,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
  const warnings = [...parsed.payout.warnings, ...identity.warnings];
  if (identity.reject) {
    const prior = await db.metricFetch.count({
      where: {
        outletId: input.outletId,
        platform: input.platform,
        reportKind: "payout",
        requestedPeriodStart: requestedStart,
        requestedPeriodEnd: requestedEnd,
        status: { in: ["rejected_mismatch", "needs_owner"] },
      },
    });
    const attempt = input.attempt ?? prior + 1;
    const status = attempt >= FILE_IDENTITY_ATTEMPT_LIMIT ? "needs_owner" : "rejected_mismatch";
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        ...base,
        status,
        digest,
        attempt,
        reason: identity.reject,
        observed: parsed.payout.observed,
      }),
    });
    return emptyResult(fetch.id, status, identity.reject);
  }

  const payout = parsed.payout;
  await retain(options.retention, digest, input.file, base.parserVersion);
  const stored = await db.$transaction(async (tx) => {
    await lockMetricWindow(tx, `payout\t${input.outletId}\t${input.platform}`);
    const duplicate = await tx.metricFetch.findFirst({
      where: {
        outletId: input.outletId,
        platform: input.platform,
        reportKind: "payout",
        sha256: digest,
        parserVersion: base.parserVersion,
        requestedPeriodStart: requestedStart,
        requestedPeriodEnd: requestedEnd,
        status: "stored",
      },
      select: { id: true },
    });
    if (duplicate) {
      const fetch = await tx.metricFetch.create({
        data: fetchData(scope, input, {
          ...base,
          status: "skipped",
          digest,
          attempt: input.attempt ?? 1,
          reason: "This file was already stored.",
          observed: payout.observed,
        }),
      });
      return { fetchId: fetch.id, skipped: true as const };
    }
    const fetch = await tx.metricFetch.create({
      data: fetchData(scope, input, {
        ...base,
        status: "stored",
        digest,
        attempt: input.attempt ?? 1,
        reason: warnings.length > 0 ? warnings.join(" ") : null,
        observed: payout.observed,
      }),
    });
    const written = await replaceCycle(tx, scope, input, payout, fetch.id);
    await tx.metricCheck.createMany({
      data: payout.checks.map((check) => ({
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: input.outletId,
        platform: input.platform,
        key: check.key,
        periodStart: utcMidnight(payout.cycleStart),
        periodEnd: utcMidnight(payout.cycleEnd),
        rebuiltValue: check.rebuiltValue,
        platformValue: check.platformValue,
        gap: check.gap,
        tolerance: check.tolerance,
        pass: check.pass,
        fetchId: fetch.id,
        checkedAt: capturedAt,
      })),
    });
    return { fetchId: fetch.id, skipped: false as const, ...written };
  });

  if (stored.skipped) {
    return {
      fetchId: stored.fetchId,
      status: "skipped",
      reason: null,
      orders: 0,
      adjustments: 0,
      superseded: 0,
      checks: [],
      warnings,
    };
  }
  return {
    fetchId: stored.fetchId,
    status: "stored",
    reason: warnings.length > 0 ? warnings.join(" ") : null,
    orders: stored.orders,
    adjustments: stored.adjustments,
    superseded: stored.superseded,
    checks: payout.checks,
    warnings,
  };
}

async function replaceCycle(
  tx: Prisma.TransactionClient,
  scope: RestaurantScope,
  input: IngestPayoutFileInput,
  payout: ParsedPayoutFile,
  fetchId: string,
): Promise<{ orders: number; adjustments: number; superseded: number }> {
  const now = new Date();
  const ids = payout.orders.map((order) => order.platformOrderId);
  const currentOrders = await tx.payoutOrder.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: input.outletId,
      platform: input.platform,
      supersededAt: null,
      OR: [{ cycleId: payout.cycleId }, { platformOrderId: { in: ids } }],
    },
  });
  const byOrder = new Map(currentOrders.map((row) => [row.platformOrderId, row]));
  const supersede: string[] = [];
  const inserts: Prisma.PayoutOrderCreateManyInput[] = [];
  for (const order of payout.orders) {
    const current = byOrder.get(order.platformOrderId);
    if (current && sameOrder(current, order, payout)) continue;
    if (current) supersede.push(current.id);
    inserts.push(orderInput(scope, input, payout, order, fetchId));
  }
  for (const current of currentOrders) {
    if (current.cycleId === payout.cycleId && !ids.includes(current.platformOrderId)) {
      supersede.push(current.id);
    }
  }
  if (supersede.length > 0) {
    await tx.payoutOrder.updateMany({
      where: { id: { in: supersede } },
      data: { supersededAt: now },
    });
  }
  if (inserts.length > 0) await tx.payoutOrder.createMany({ data: inserts });

  const currentAdjustments = await tx.payoutAdjustment.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: input.outletId,
      platform: input.platform,
      cycleId: payout.cycleId,
      supersededAt: null,
    },
    select: { id: true },
  });
  if (currentAdjustments.length > 0) {
    await tx.payoutAdjustment.updateMany({
      where: { id: { in: currentAdjustments.map((row) => row.id) } },
      data: { supersededAt: now },
    });
  }
  if (payout.adjustments.length > 0) {
    await tx.payoutAdjustment.createMany({
      data: payout.adjustments.map((row) => ({
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: input.outletId,
        platform: input.platform,
        cycleId: payout.cycleId,
        type: row.type,
        invoiceId: row.invoiceId,
        periodFrom: utcMidnight(row.periodFrom),
        periodTo: utcMidnight(row.periodTo),
        amountPaise: row.amountPaise,
        bookedCycle: row.bookedCycle,
        fetchId,
      })),
    });
  }

  const currentCycle = await tx.payoutCycle.findFirst({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: input.outletId,
      platform: input.platform,
      cycleId: payout.cycleId,
      supersededAt: null,
    },
    select: { id: true },
  });
  if (currentCycle) {
    await tx.payoutCycle.update({ where: { id: currentCycle.id }, data: { supersededAt: now } });
  }
  await tx.payoutCycle.create({
    data: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: input.outletId,
      platform: input.platform,
      cycleId: payout.cycleId,
      cycleStart: utcMidnight(payout.cycleStart),
      cycleEnd: utcMidnight(payout.cycleEnd),
      settlementStatus: payout.settlementStatus,
      settlementDate: payout.settlementDate ? utcMidnight(payout.settlementDate) : null,
      utrLast4: payout.utrLast4,
      orderCount: payout.totals.orderCount,
      grossSalesPaise: payout.totals.grossSalesPaise,
      discountPaise: payout.totals.discountPaise,
      cvPaise: payout.totals.cvPaise,
      commissionPaise: payout.totals.commissionPaise,
      platformFeesPaise: payout.totals.platformFeesPaise,
      taxesPaise: payout.totals.taxesPaise,
      tdsPaise: payout.totals.tdsPaise,
      tcsPaise: payout.totals.tcsPaise,
      gstCollectedPaise: payout.totals.gstCollectedPaise,
      complaintsCancellationChargesPaise: payout.totals.complaintsCancellationChargesPaise,
      adSpendPaise: payout.totals.adSpendPaise,
      netPayoutPaise: payout.orders.reduce((total, order) => total + order.netPayoutPaise, 0),
      platformNetPayoutPaise: payout.totals.platformNetPayoutPaise,
      paidAmountPaise: payout.totals.paidAmountPaise,
      fetchId,
    },
  });
  return {
    orders: inserts.length,
    adjustments: payout.adjustments.length,
    superseded: supersede.length + currentAdjustments.length + (currentCycle ? 1 : 0),
  };
}

function sameOrder(
  current: {
    orderDate: Date;
    cycleId: string;
    cycleStart: Date;
    cycleEnd: Date;
    settlementStatus: string;
    settlementDate: Date | null;
    utrLast4: string | null;
    orderStatus: string;
    category: string | null;
    cancelledBy: string | null;
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
    mfrMarked: boolean | null;
    mfrAccurate: boolean | null;
    customerHash: string | null;
  },
  order: ParsedPayoutOrder,
  payout: ParsedPayoutFile,
): boolean {
  const sameDate = (stored: Date | null, iso: string | null) =>
    (stored == null && iso == null) ||
    (stored != null && iso != null && stored.getTime() === utcMidnight(iso).getTime());
  return (
    sameDate(current.orderDate, order.orderDate) &&
    current.cycleId === payout.cycleId &&
    sameDate(current.cycleStart, payout.cycleStart) &&
    sameDate(current.cycleEnd, payout.cycleEnd) &&
    current.settlementStatus === order.settlementStatus &&
    sameDate(current.settlementDate, order.settlementDate) &&
    current.utrLast4 === order.utrLast4 &&
    current.orderStatus === order.orderStatus &&
    current.category === order.category &&
    current.cancelledBy === order.cancelledBy &&
    current.grossSalesPaise === order.grossSalesPaise &&
    current.discountPaise === order.discountPaise &&
    current.commissionPaise === order.commissionPaise &&
    current.platformFeesPaise === order.platformFeesPaise &&
    current.taxesPaise === order.taxesPaise &&
    current.tdsPaise === order.tdsPaise &&
    current.tcsPaise === order.tcsPaise &&
    current.cvPaise === order.cvPaise &&
    current.gstCollectedPaise === order.gstCollectedPaise &&
    current.complaintsCancellationChargesPaise === order.complaintsCancellationChargesPaise &&
    current.netPayoutPaise === order.netPayoutPaise &&
    current.paidAmountPaise === order.paidAmountPaise &&
    current.mfrMarked === order.mfrMarked &&
    current.mfrAccurate === order.mfrAccurate &&
    current.customerHash === order.customerHash
  );
}

function orderInput(
  scope: RestaurantScope,
  input: IngestPayoutFileInput,
  payout: ParsedPayoutFile,
  order: ParsedPayoutOrder,
  fetchId: string,
): Prisma.PayoutOrderCreateManyInput {
  return {
    restaurantId: scope.restaurantId,
    spaceId: scope.spaceId,
    outletId: input.outletId,
    platform: input.platform,
    platformOrderId: order.platformOrderId,
    orderDate: utcMidnight(order.orderDate),
    cycleId: payout.cycleId,
    cycleStart: utcMidnight(payout.cycleStart),
    cycleEnd: utcMidnight(payout.cycleEnd),
    settlementStatus: order.settlementStatus,
    settlementDate: order.settlementDate ? utcMidnight(order.settlementDate) : null,
    utrLast4: order.utrLast4,
    orderStatus: order.orderStatus,
    category: order.category,
    cancelledBy: order.cancelledBy,
    grossSalesPaise: order.grossSalesPaise,
    discountPaise: order.discountPaise,
    commissionPaise: order.commissionPaise,
    platformFeesPaise: order.platformFeesPaise,
    taxesPaise: order.taxesPaise,
    tdsPaise: order.tdsPaise,
    tcsPaise: order.tcsPaise,
    cvPaise: order.cvPaise,
    gstCollectedPaise: order.gstCollectedPaise,
    complaintsCancellationChargesPaise: order.complaintsCancellationChargesPaise,
    netPayoutPaise: order.netPayoutPaise,
    paidAmountPaise: order.paidAmountPaise,
    mfrMarked: order.mfrMarked,
    mfrAccurate: order.mfrAccurate,
    customerHash: order.customerHash,
    fetchId,
  };
}

export async function loadPayoutRollup(
  db: PrismaClient,
  scope: RestaurantScope,
  query: {
    outletId: string;
    platform: "zomato" | "swiggy" | "combined";
    from: string;
    to: string;
  },
): Promise<PayoutRollupInput | undefined> {
  const platforms = query.platform === "combined" ? ["zomato", "swiggy"] : [query.platform];
  const where = {
    restaurantId: scope.restaurantId,
    spaceId: scope.spaceId,
    outletId: query.outletId,
    platform: { in: platforms },
    supersededAt: null,
  };
  const [orders, adjustments, cycles] = await Promise.all([
    db.payoutOrder.findMany({
      where: {
        ...where,
        OR: [
          { orderDate: { gte: utcMidnight(query.from), lt: utcMidnight(query.to) } },
          { settlementDate: { gte: utcMidnight(query.from), lt: utcMidnight(query.to) } },
        ],
      },
    }),
    db.payoutAdjustment.findMany({ where }),
    db.payoutCycle.findMany({ where }),
  ]);
  if (orders.length === 0 && adjustments.length === 0 && cycles.length === 0) return undefined;
  const cycleById = new Map(cycles.map((row) => [row.cycleId, row]));
  const facts: PayoutRollupInput = {
    orders: orders.flatMap((row) => {
      if (row.platform !== "zomato" && row.platform !== "swiggy") return [];
      if (row.settlementStatus !== "settled" && row.settlementStatus !== "pending") return [];
      return [
        {
          platform: row.platform,
          orderDate: indiaCivilDate(row.orderDate),
          settlementStatus: row.settlementStatus,
          settlementDate: row.settlementDate ? indiaCivilDate(row.settlementDate) : null,
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
        },
      ];
    }),
    adjustments: adjustments.flatMap((row) => {
      if (row.platform !== "zomato" && row.platform !== "swiggy") return [];
      const cycle = cycleById.get(row.bookedCycle);
      const status = cycle?.settlementStatus === "settled" ? "settled" : "pending";
      return [
        {
          platform: row.platform,
          type: row.type,
          periodFrom: indiaCivilDate(row.periodFrom),
          periodTo: indiaCivilDate(row.periodTo),
          amountPaise: row.amountPaise,
          bookedCycle: row.bookedCycle,
          settlementDate: cycle?.settlementDate ? indiaCivilDate(cycle.settlementDate) : null,
          settlementStatus: status,
        },
      ];
    }),
    cycles: cycles.flatMap((row) => {
      if (row.platform !== "zomato" && row.platform !== "swiggy") return [];
      if (row.settlementStatus !== "settled" && row.settlementStatus !== "pending") return [];
      return [
        {
          platform: row.platform,
          settlementStatus: row.settlementStatus,
          settlementDate: row.settlementDate ? indiaCivilDate(row.settlementDate) : null,
          platformNetPayoutPaise: row.platformNetPayoutPaise,
          paidAmountPaise: row.paidAmountPaise,
        },
      ];
    }),
  };
  return facts;
}

async function retain(
  retention: PayoutFileRetention | undefined,
  sha256: string,
  file: Uint8Array,
  parserVersion: string,
): Promise<void> {
  const payoutFile = await import("@rakazo/contracts/payout");
  const stored = retention ?? payoutFile.noopPayoutFileRetention;
  const body = await payoutFile.redactPayoutWorkbook(file);
  await stored.put({ sha256, parserVersion, body });
}

function customerHashSalt(): string | null {
  const salt = process.env.CUSTOMER_HASH_SALT?.trim();
  return salt ? salt : null;
}

function emptyResult(
  fetchId: string,
  status: IngestPayoutReportResult["status"],
  reason: string,
): IngestPayoutReportResult {
  return {
    fetchId,
    status,
    reason,
    orders: 0,
    adjustments: 0,
    superseded: 0,
    checks: [],
    warnings: [],
  };
}

function fetchData(
  scope: RestaurantScope,
  input: IngestPayoutFileInput,
  details: {
    status: IngestPayoutReportResult["status"];
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
      periods: Array<{ start: string; end: string }>;
    } | null;
    capturedAt: Date;
    parserVersion: string;
  },
) {
  const first = details.observed?.periods[0];
  const last = details.observed?.periods.at(-1);
  return {
    restaurantId: scope.restaurantId,
    spaceId: scope.spaceId,
    outletId: input.outletId,
    platform: input.platform,
    reportKind: "payout",
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
    observedLabels: "payout",
    sha256: details.digest,
    attemptCount: details.attempt,
    source: input.source,
    parserVersion: details.parserVersion,
    reason: details.reason,
    runId: input.runId,
    capturedAt: details.capturedAt,
  };
}
