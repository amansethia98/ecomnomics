import { FILE_IDENTITY_ATTEMPT_LIMIT } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { isUniqueViolation } from "./prisma-errors.js";
import type { RestaurantScope } from "./restaurant-agent.js";
import { RestaurantAgentError } from "./restaurant-agent.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const FETCH_HOLD_REASON = "identity_mismatch";

/**
 * Refuses a report upload while this outlet and platform are held.
 * The caller has not stored the file yet.
 */
export async function assertFetchOpen(
  db: PrismaClient,
  scope: RestaurantScope,
  outletId: string,
  platform: string,
): Promise<void> {
  const hold = await db.fetchHold.findFirst({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId,
      platform,
      clearedAt: null,
    },
    select: { id: true },
  });
  if (!hold) return;
  throw new RestaurantAgentError(
    "fetch_held",
    423,
    "Fetching is paused for this outlet until a platform admin clears it.",
  );
}

/**
 * Counts identity mismatches for this outlet and platform over the last 24
 * hours, including the row just written. The client's attempt number is not
 * an input. A rejected_mismatch row counts only when this release marked it
 * as an identity mismatch, so a parse failure stored by the previous release
 * does not. A local_mismatch log counts. The third one opens a hold that
 * stays until it is cleared.
 */
export async function noteIdentityMismatch(
  db: PrismaClient,
  scope: RestaurantScope,
  outletId: string,
  platform: string,
): Promise<void> {
  const since = new Date(Date.now() - WINDOW_MS);
  const count = await db.metricFetch.count({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId,
      platform,
      createdAt: { gte: since },
      OR: [{ status: "rejected_mismatch", identityMismatch: true }, { status: "local_mismatch" }],
    },
  });
  if (count < FILE_IDENTITY_ATTEMPT_LIMIT) return;
  const open = await db.fetchHold.findFirst({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId,
      platform,
      clearedAt: null,
    },
    select: { id: true },
  });
  if (open) return;
  try {
    await db.fetchHold.create({
      data: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId,
        platform,
        reason: FETCH_HOLD_REASON,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return;
    throw error;
  }
}
