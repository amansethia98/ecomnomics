import type { OwnerProfile, OwnerProfilePatch } from "@rakazo/contracts";
import { connectionStatus, displayOutletName } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { RestaurantAgentError } from "./restaurant-agent.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const PLATFORMS = ["zomato", "swiggy"] as const;

async function restaurantForMember(db: PrismaClient, userId: string, restaurantId: string) {
  return runAsSystem("owner profile membership", () =>
    db.restaurant.findFirst({
      where: {
        id: restaurantId,
        space: { deletingAt: null, memberships: { some: { userId } } },
      },
      select: { id: true, spaceId: true },
    }),
  );
}

function missingRestaurant(): never {
  throw new RestaurantAgentError("not_found", 404, "Restaurant not found.");
}

/** Restaurants the signed-in person can open. Other tenants are not listed. */
export async function listOwnerRestaurants(
  db: PrismaClient,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  const spaces = await runAsSystem("owner restaurant list", () =>
    db.spaceMember.findMany({
      where: { userId, space: { deletingAt: null } },
      select: { spaceId: true },
    }),
  );
  const restaurants: { id: string; name: string }[] = [];
  for (const space of spaces) {
    const rows = await runAsTenant({ spaceId: space.spaceId, userId }, () =>
      db.restaurant.findMany({
        where: { spaceId: space.spaceId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    );
    restaurants.push(...rows);
  }
  return restaurants;
}

async function readProfile(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  spaceId: string,
): Promise<OwnerProfile> {
  const [user, restaurant, outlets, fetches] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, locale: true },
    }),
    db.restaurant.findFirst({
      where: { id: restaurantId, spaceId },
      select: { id: true, name: true, timezone: true },
    }),
    db.outlet.findMany({
      where: { restaurantId, spaceId },
      select: { id: true, name: true, city: true, zomatoResId: true, swiggyRid: true },
      orderBy: { name: "asc" },
    }),
    db.metricFetch.findMany({
      where: { restaurantId, spaceId },
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
      take: 500,
      select: { outletId: true, platform: true, status: true, observedName: true },
    }),
  ]);
  if (!user || !restaurant) missingRestaurant();
  const latest = new Map<string, string>();
  for (const fetch of fetches) {
    const key = `${fetch.outletId}:${fetch.platform}`;
    if (!latest.has(key)) latest.set(key, fetch.status);
  }
  return {
    restaurant: { id: restaurant.id, name: restaurant.name, timezone: restaurant.timezone },
    owner: { name: user.name, email: user.email, locale: user.locale ?? "en" },
    outlets: outlets.map((outlet) => ({
      id: outlet.id,
      name: displayOutletName(
        outlet.name,
        fetches.find((row) => row.outletId === outlet.id)?.observedName,
      ),
      city: outlet.city,
      connections: PLATFORMS.map((platform) => ({
        platform,
        status: connectionStatus({
          linked: platform === "zomato" ? Boolean(outlet.zomatoResId) : Boolean(outlet.swiggyRid),
          latest: latest.get(`${outlet.id}:${platform}`) ?? null,
        }),
      })),
    })),
  };
}

export async function readOwnerProfileForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
): Promise<OwnerProfile> {
  const restaurant = await restaurantForMember(db, userId, restaurantId);
  if (!restaurant) missingRestaurant();
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, () =>
    readProfile(db, userId, restaurant.id, restaurant.spaceId),
  );
}

export async function updateOwnerProfileForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  patch: OwnerProfilePatch,
): Promise<OwnerProfile> {
  const restaurant = await restaurantForMember(db, userId, restaurantId);
  if (!restaurant) missingRestaurant();
  await runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    if (patch.ownerName !== undefined || patch.locale !== undefined) {
      await db.user.update({
        where: { id: userId },
        data: {
          ...(patch.ownerName !== undefined ? { name: patch.ownerName } : {}),
          ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
        },
      });
    }
    if (patch.restaurantName !== undefined) {
      await db.restaurant.update({
        where: { id: restaurant.id },
        data: { name: patch.restaurantName },
      });
    }
    if (patch.outlets && patch.outlets.length > 0) {
      const known = await db.outlet.findMany({
        where: { restaurantId: restaurant.id, spaceId: restaurant.spaceId },
        select: { id: true },
      });
      const ids = new Set(known.map((outlet) => outlet.id));
      for (const outlet of patch.outlets) {
        if (!ids.has(outlet.id)) {
          throw new RestaurantAgentError(
            "unknown_outlet",
            422,
            "Outlet is not part of this restaurant.",
          );
        }
        await db.outlet.update({
          where: { id: outlet.id },
          data: { name: outlet.name, city: outlet.city },
        });
      }
    }
  });
  return readOwnerProfileForMember(db, userId, restaurantId);
}
