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
    const stamps = await db.platformWindowItem.findMany({
      where: {
        restaurantId,
        spaceId: restaurant.spaceId,
        ...(outletId ? { outletId } : {}),
      },
      distinct: ["outletId", "platform", "periodEnd"],
      select: { outletId: true, platform: true, periodEnd: true },
    });
    const windows = latestMenuWindows(stamps);
    const swiggy = await swiggyMenuFacts(db, restaurant, outletId);
    if (windows.length === 0) return composeOwnerMenu([], swiggy);
    const items = await db.platformWindowItem.findMany({
      where: {
        restaurantId,
        spaceId: restaurant.spaceId,
        OR: windows.map((window) => ({
          outletId: window.outletId,
          platform: window.platform,
          periodEnd: window.periodEnd,
        })),
      },
      select: { itemName: true, platform: true, revenuePaise: true },
    });
    return composeOwnerMenu(
      items.flatMap((item) => {
        const platform = namedPlatform(item.platform);
        if (!platform) return [];
        return [{ name: item.itemName, platform, revenuePaise: item.revenuePaise }];
      }),
      swiggy,
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
    const keys = ["rating", "poor_rated_orders", ...COMPLAINT_KEYS];
    const facts = await latestFacts(db, restaurant, keys, outletId);
    const app = (platform: "zomato" | "swiggy") => ({
      platform,
      rating: facts.get(`${platform}|rating`) ?? null,
      poorRatedOrders: facts.get(`${platform}|poor_rated_orders`) ?? null,
      complaints: Object.fromEntries(
        COMPLAINT_KEYS.map((key) => [key, facts.get(`${platform}|${key}`) ?? null]),
      ),
    });
    return composeOwnerRatings({
      rating: facts.get("zomato|rating") ?? null,
      reviews: [],
      apps: [app("zomato"), app("swiggy")],
    });
  });
}

const MENU_FACT_KEYS = [
  "menu_score",
  "menu_photo_pct",
  "menu_desc_pct",
  "top5_items_revenue_paise",
] as const;

const COMPLAINT_KEYS = [
  "complaints_missing",
  "complaints_quality",
  "complaints_packaging",
  "complaints_wrong",
] as const;

async function swiggyMenuFacts(
  db: PrismaClient,
  restaurant: { restaurantId: string; spaceId: string },
  outletId: string | undefined,
) {
  const facts = await latestFacts(db, restaurant, MENU_FACT_KEYS, outletId);
  const present = MENU_FACT_KEYS.some((key) => facts.has(`swiggy|${key}`));
  if (!present) return null;
  return {
    score: facts.get("swiggy|menu_score") ?? null,
    photoPct: facts.get("swiggy|menu_photo_pct") ?? null,
    descriptionPct: facts.get("swiggy|menu_desc_pct") ?? null,
    top5RevenuePaise: facts.get("swiggy|top5_items_revenue_paise") ?? null,
  };
}

async function latestFacts(
  db: PrismaClient,
  restaurant: { restaurantId: string; spaceId: string },
  keys: readonly string[],
  outletId: string | undefined,
) {
  const rows = await db.metricValue.findMany({
    where: {
      restaurantId: restaurant.restaurantId,
      spaceId: restaurant.spaceId,
      key: { in: [...keys] },
      state: "ok",
      supersededAt: null,
      rowRole: "fact",
      ...(outletId ? { outletId } : {}),
    },
    orderBy: { periodStart: "desc" },
    select: { key: true, platform: true, value: true },
    take: 400,
  });
  const kept = new Map<string, number | null>();
  for (const row of rows) {
    const id = `${row.platform}|${row.key}`;
    if (kept.has(id)) continue;
    kept.set(id, row.value == null ? null : Number(row.value));
  }
  return kept;
}

/** The newest menu window for each outlet and app. A later window on one app does not drop the other. */
export function latestMenuWindows<
  T extends { outletId: string; platform: string; periodEnd: Date },
>(rows: readonly T[]): T[] {
  const kept = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.outletId}|${row.platform}`;
    const current = kept.get(key);
    if (!current || row.periodEnd.getTime() > current.periodEnd.getTime()) kept.set(key, row);
  }
  return [...kept.values()];
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
