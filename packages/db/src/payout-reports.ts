import { createHash } from "node:crypto";
import type { IngestPayoutReportInput } from "@rakazo/contracts";
import {
  checkObservedIdentity,
  indiaCivilDate,
  layoutChangeFinding,
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
import { assertFetchOpen, noteIdentityMismatch } from "./fetch-holds.js";
import type { Prisma } from "./generated/prisma/client.js";
import {
  fetchCoversCurrentLabels,
  labelRegistryVersion,
  noteRelabelFailures,
} from "./metric-label-aging.js";
import type { RecordedLabelFinding } from "./metric-label-findings.js";
import { recordLabelFindings } from "./metric-label-findings.js";
import { loadLabelBook } from "./metric-labels.js";
import { isUniqueViolation } from "./prisma-errors.js";
import type { RestaurantScope } from "./restaurant-agent.js";
import { lockMetricWindow, RestaurantAgentError } from "./restaurant-agent.js";

const SHARED_ADJUSTMENT_KEY =
  "This payout could not be stored because two adjustment rows share a key.";

/** A unique-index failure from adjustment rows, as a client-facing parse failure. */
export function payoutAdjustmentKeyFailure(error: unknown): string | null {
  return isUniqueViolation(error) ? SHARED_ADJUSTMENT_KEY : null;
}

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
  status: "stored" | "skipped" | "rejected_mismatch" | "parse_failed" | "missing_platform_id";
  reason: string | null;
  orders: number;
  adjustments: number;
  superseded: number;
  checks: PayoutCheck[];
  warnings: string[];
  layoutChanged?: boolean;
  reingested?: boolean;
  labels?: {
    pendingSlots: number;
    findings: Array<{ findingId: string; slotId: string; kind: string; status: string }>;
  };
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
  await assertFetchOpen(db, scope, input.outletId, input.platform);
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
        status: "missing_platform_id",
        digest,
        attempt: input.attempt ?? 1,
        reason,
        observed: null,
      }),
    });
    return emptyResult(fetch.id, "missing_platform_id", reason);
  }

  const salt = options.salt === undefined ? customerHashSalt() : options.salt;
  let parsed: Awaited<ReturnType<typeof payoutFile.parsePayoutWorkbook>>;
  try {
    parsed = await payoutFile.parsePayoutWorkbook(
      input.file,
      input.platform,
      salt,
      await loadLabelBook(db),
    );
  } catch {
    parsed = { ok: false, reason: "The file is not a payout workbook.", observed: null };
  }
  if (!parsed.ok) {
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        ...base,
        status: "parse_failed",
        digest,
        attempt: input.attempt ?? 1,
        reason: parsed.layout ? "layout_changed" : parsed.reason,
        observed: parsed.observed,
        identityMismatch: parsed.layout ? false : undefined,
      }),
    });
    const recorded = parsed.layout
      ? await db.$transaction((tx) =>
          recordLabelFindings(tx, {
            findings:
              parsed.labelFindings && parsed.labelFindings.length > 0
                ? parsed.labelFindings
                : [layoutChangeFinding(input.platform, "payout", "payout")],
            restaurantId: scope.restaurantId,
            spaceId: scope.spaceId,
            outletId: input.outletId,
            fetchId: fetch.id,
            periods: parsed.observed?.periods.map((period) => period.start) ?? [],
          }),
        )
      : [];
    return {
      ...emptyResult(fetch.id, "parse_failed", parsed.layout ? "layout_changed" : parsed.reason),
      ...(parsed.layout ? { layoutChanged: true as const, labels: labelSummary(0, recorded) } : {}),
    };
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
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        ...base,
        status: "rejected_mismatch",
        digest,
        attempt: input.attempt ?? 1,
        reason: identity.reject,
        observed: parsed.payout.observed,
        identityMismatch: true,
      }),
    });
    await noteIdentityMismatch(db, scope, input.outletId, input.platform);
    return emptyResult(fetch.id, "rejected_mismatch", identity.reject);
  }

  const payout = parsed.payout;
  await retain(options.retention, digest, input.file, base.parserVersion);
  let stored: {
    fetchId: string;
    skipped: boolean;
    orders?: number;
    adjustments?: number;
    superseded?: number;
    labelFindings?: RecordedLabelFinding[];
    reingested?: boolean;
  };
  try {
    stored = await db.$transaction(async (tx) => {
      await lockMetricWindow(tx, `payout\t${input.outletId}\t${input.platform}`);
      const registryVersion = await labelRegistryVersion(tx);
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
        orderBy: [{ capturedAt: "desc" }, { createdAt: "desc" }],
        select: { id: true, pendingLabels: true, labelSetVersion: true },
      });
      const reingested = duplicate != null && !fetchCoversCurrentLabels(duplicate, registryVersion);
      if (duplicate && !reingested) {
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
        return { fetchId: fetch.id, skipped: true as const, reingested: false };
      }
      const fetch = await tx.metricFetch.create({
        data: fetchData(scope, input, {
          ...base,
          status: "stored",
          digest,
          attempt: input.attempt ?? 1,
          reason: warnings.length > 0 ? warnings.join(" ") : null,
          observed: payout.observed,
          labelSetVersion: registryVersion,
          pendingLabels: payout.totals.pendingFields.length,
        }),
      });
      const written = await replaceCycle(tx, scope, input, payout, fetch.id);
      if (payout.checks.length > 0) {
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
      }
      const labelFindings = payout.labelFindings?.length
        ? await recordLabelFindings(tx, {
            findings: payout.labelFindings,
            restaurantId: scope.restaurantId,
            spaceId: scope.spaceId,
            outletId: input.outletId,
            fetchId: fetch.id,
            periods: [payout.cycleStart],
          })
        : [];
      if (reingested && payout.totals.pendingFields.length > 0 && labelFindings.length > 0) {
        await noteRelabelFailures(
          tx,
          scope,
          indiaCivilDate(capturedAt),
          labelFindings.map((finding) => ({
            outletId: input.outletId,
            platform: input.platform,
            findingId: finding.findingId,
            periodStart: payout.cycleStart,
          })),
        );
      }
      return {
        fetchId: fetch.id,
        skipped: false as const,
        ...written,
        labelFindings,
        reingested,
      };
    });
  } catch (error) {
    const reason = payoutAdjustmentKeyFailure(error);
    if (!reason) throw error;
    const fetch = await db.metricFetch.create({
      data: fetchData(scope, input, {
        ...base,
        status: "parse_failed",
        digest,
        attempt: input.attempt ?? 1,
        reason,
        observed: payout.observed,
      }),
    });
    return emptyResult(fetch.id, "parse_failed", reason);
  }

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
    orders: stored.orders ?? 0,
    adjustments: stored.adjustments ?? 0,
    superseded: stored.superseded ?? 0,
    checks: payout.checks,
    warnings,
    labels: labelSummary(payout.skippedChecks?.length ?? 0, stored.labelFindings ?? []),
    ...(stored.reingested ? { reingested: true } : {}),
  };
}

function labelSummary(pendingSlots: number, findings: RecordedLabelFinding[]) {
  return {
    pendingSlots,
    findings: findings.map((finding) => ({
      findingId: finding.findingId,
      slotId: finding.slotId,
      kind: finding.kind,
      status: finding.status,
    })),
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
      netPayoutPaise: payout.totals.pendingFields.includes("netPayoutPaise")
        ? null
        : payout.orders.reduce((total, order) => total + (order.netPayoutPaise ?? 0), 0),
      platformNetPayoutPaise: payout.totals.platformNetPayoutPaise,
      paidAmountPaise: payout.totals.paidAmountPaise,
      pendingFields: payout.totals.pendingFields,
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
    grossSalesPaise: number | null;
    discountPaise: number | null;
    commissionPaise: number | null;
    platformFeesPaise: number | null;
    taxesPaise: number | null;
    tdsPaise: number | null;
    tcsPaise: number | null;
    cvPaise: number | null;
    gstCollectedPaise: number | null;
    gstDeductionPaise: number | null;
    complaintsCancellationChargesPaise: number | null;
    netPayoutPaise: number | null;
    pendingFields: string[];
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
    current.gstDeductionPaise === order.gstDeductionPaise &&
    current.complaintsCancellationChargesPaise === order.complaintsCancellationChargesPaise &&
    current.netPayoutPaise === order.netPayoutPaise &&
    current.pendingFields.join("\t") === order.pendingFields.join("\t") &&
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
    gstDeductionPaise: order.gstDeductionPaise,
    complaintsCancellationChargesPaise: order.complaintsCancellationChargesPaise,
    netPayoutPaise: order.netPayoutPaise,
    pendingFields: order.pendingFields,
    paidAmountPaise: order.paidAmountPaise,
    mfrMarked: order.mfrMarked,
    mfrAccurate: order.mfrAccurate,
    customerHash: order.customerHash,
    fetchId,
  };
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
    identityMismatch?: boolean;
    labelSetVersion?: number;
    pendingLabels?: number;
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
    rawSha256: input.rawSha256 ?? null,
    attemptCount: details.attempt,
    identityMismatch: details.identityMismatch ?? null,
    source: input.source,
    parserVersion: details.parserVersion,
    labelSetVersion: details.labelSetVersion ?? null,
    pendingLabels: details.pendingLabels ?? 0,
    reason: details.reason,
    runId: input.runId,
    capturedAt: details.capturedAt,
  };
}
