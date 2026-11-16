import type { PaymentAdjustment, PaymentCycle, PaymentOrder } from "@rakazo/contracts";
import {
  civilDateOrNull,
  composeOwnerDocuments,
  composeOwnerMenu,
  composeOwnerPayments,
  composeOwnerRatings,
  indiaCivilDate,
  utcMidnight,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { RestaurantAgentError } from "./restaurant-agent.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

interface LicencePatch {
  reference: string | null;
  expiresOn: string | null;
  gstin: string | null;
}

async function memberRestaurant(db: PrismaClient, userId: string, restaurantId: string) {
  const restaurant = await runAsSystem("owner desk membership", () =>
    db.restaurant.findFirst({
      where: { id: restaurantId, space: { deletingAt: null, memberships: { some: { userId } } } },
      select: { id: true, spaceId: true },
    }),
  );
  if (!restaurant) throw new RestaurantAgentError("not_found", 404, "Restaurant not found.");
  return { restaurantId: restaurant.id, spaceId: restaurant.spaceId };
}

export async function readPaymentsForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  outletId: string | undefined,
  selectedId: string | null | undefined,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const cycles = await db.payoutCycle.findMany({
      where: {
        restaurantId,
        spaceId: restaurant.spaceId,
        supersededAt: null,
        ...(outletId ? { outletId } : {}),
      },
      orderBy: { cycleEnd: "desc" },
      take: 24,
    });
    const mapped = cycles.flatMap((cycle) => {
      const platform = namedPlatform(cycle.platform);
      if (!platform) return [];
      const row: PaymentCycle = {
        id: cycleKey(cycle.outletId, platform, cycle.cycleId),
        outletId: cycle.outletId,
        platform,
        from: indiaCivilDate(cycle.cycleStart),
        to: indiaCivilDate(cycle.cycleEnd),
        orderCount: cycle.orderCount,
        netPayoutPaise: cycle.netPayoutPaise,
        commissionPaise: cycle.commissionPaise,
        feesPaise: cycle.platformFeesPaise,
        taxesPaise: cycle.taxesPaise,
        tdsPaise: cycle.tdsPaise,
        tcsPaise: cycle.tcsPaise,
        adsPaise: cycle.adSpendPaise,
        discountsPaise: cycle.discountPaise,
        gstPaise: cycle.gstCollectedPaise,
        complaintsPaise: cycle.complaintsCancellationChargesPaise,
      };
      return [row];
    });
    const selected =
      mapped.find((cycle) => cycle.id === selectedId) ??
      [...mapped].sort((left, right) => right.to.localeCompare(left.to))[0];
    const source = selected
      ? cycles.find(
          (cycle) =>
            cycleKey(cycle.outletId, namedPlatform(cycle.platform) ?? "", cycle.cycleId) ===
            selected.id,
        )
      : undefined;
    const [orders, adjustments] = source
      ? await Promise.all([
          db.payoutOrder.findMany({
            where: {
              restaurantId,
              spaceId: restaurant.spaceId,
              outletId: source.outletId,
              platform: source.platform,
              cycleId: source.cycleId,
              supersededAt: null,
            },
            orderBy: { orderDate: "desc" },
            take: 200,
            select: { platformOrderId: true, orderDate: true, netPayoutPaise: true },
          }),
          db.payoutAdjustment.findMany({
            where: {
              restaurantId,
              spaceId: restaurant.spaceId,
              outletId: source.outletId,
              platform: source.platform,
              cycleId: source.cycleId,
              supersededAt: null,
            },
            select: { type: true, amountPaise: true },
          }),
        ])
      : [[], []];
    const orderRows: PaymentOrder[] = orders.map((order) => ({
      cycleId: selected?.id ?? "",
      orderId: order.platformOrderId,
      date: indiaCivilDate(order.orderDate),
      netPayoutPaise: order.netPayoutPaise,
    }));
    const adjustmentRows: PaymentAdjustment[] = adjustments.map((row) => ({
      cycleId: selected?.id ?? "",
      label: row.type,
      amountPaise: row.amountPaise,
    }));
    return composeOwnerPayments({
      cycles: mapped,
      orders: orderRows,
      adjustments: adjustmentRows,
      selectedId: selected?.id ?? null,
    });
  });
}

export async function readDocumentsForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, () =>
    readDocumentsInside(db, restaurant, indiaCivilDate(new Date())),
  );
}

export async function saveLicenceForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  patch: LicencePatch,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  const expiresOn = civilDateOrNull(patch.expiresOn);
  if (patch.expiresOn != null && expiresOn == null) {
    throw new RestaurantAgentError("invalid_body", 400, "That licence date is not valid.");
  }
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    await db.ownerLicence.upsert({
      where: { restaurantId },
      create: {
        restaurantId,
        spaceId: restaurant.spaceId,
        reference: blank(patch.reference),
        expiresOn: expiresOn ? utcMidnight(expiresOn) : null,
        gstin: blank(patch.gstin),
      },
      update: {
        reference: blank(patch.reference),
        expiresOn: expiresOn ? utcMidnight(expiresOn) : null,
        gstin: blank(patch.gstin),
      },
    });
    return readDocumentsInside(db, restaurant, indiaCivilDate(new Date()));
  });
}

async function readDocumentsInside(
  db: PrismaClient,
  restaurant: { restaurantId: string; spaceId: string },
  today: string,
) {
  const [licence, reports] = await Promise.all([
    db.ownerLicence.findUnique({ where: { restaurantId: restaurant.restaurantId } }),
    db.report.findMany({
      where: { restaurantId: restaurant.restaurantId, spaceId: restaurant.spaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, kind: true, periodStart: true, periodEnd: true, createdAt: true },
    }),
  ]);
  return composeOwnerDocuments({
    today,
    reference: licence?.reference ?? null,
    expiresOn: licence?.expiresOn ? indiaCivilDate(licence.expiresOn) : null,
    gstin: licence?.gstin ?? null,
    reports: reports.map((report) => ({
      id: report.id,
      kind: report.kind,
      from: indiaCivilDate(report.periodStart),
      to: indiaCivilDate(report.periodEnd),
      createdOn: indiaCivilDate(report.createdAt),
    })),
  });
}

export async function readMenuForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  outletId: string | undefined,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const latest = await db.platformWindowItem.findFirst({
      where: {
        restaurantId,
        spaceId: restaurant.spaceId,
        ...(outletId ? { outletId } : {}),
      },
      orderBy: { periodEnd: "desc" },
      select: { periodEnd: true },
    });
    if (!latest) return composeOwnerMenu([]);
    const items = await db.platformWindowItem.findMany({
      where: {
        restaurantId,
        spaceId: restaurant.spaceId,
        periodEnd: latest.periodEnd,
        ...(outletId ? { outletId } : {}),
      },
      select: { itemName: true, platform: true, revenuePaise: true },
    });
    return composeOwnerMenu(
      items.flatMap((item) => {
        const platform = namedPlatform(item.platform);
        if (!platform) return [];
        return [{ name: item.itemName, platform, revenuePaise: item.revenuePaise }];
      }),
    );
  });
}

export async function readRatingsForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  outletId: string | undefined,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const row = await db.metricValue.findFirst({
      where: {
        restaurantId,
        spaceId: restaurant.spaceId,
        key: "rating",
        state: "ok",
        supersededAt: null,
        rowRole: "fact",
        platform: "zomato",
        ...(outletId ? { outletId } : {}),
      },
      orderBy: { periodStart: "desc" },
      select: { value: true },
    });
    return composeOwnerRatings({
      rating: row?.value == null ? null : Number(row.value),
      reviews: [],
    });
  });
}

function cycleKey(outletId: string, platform: string, cycleId: string): string {
  return `${outletId}:${platform}:${cycleId}`;
}

function namedPlatform(value: string | null | undefined): "zomato" | "swiggy" | null {
  return value === "zomato" || value === "swiggy" ? value : null;
}

function blank(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
