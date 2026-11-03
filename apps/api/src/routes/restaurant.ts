import { ORPCError } from "@orpc/server";
import {
  beginRestaurantProfile,
  getRestaurantProfile,
  IsolationError,
  RestaurantProfileError,
  recordAuditEvent,
  restaurantCounts,
  SpaceDeletionInProgressError,
  saveRestaurantProfile,
} from "@rakazo/db";
import type { RouterContext } from "./context.js";

function restaurantError(error: unknown): never {
  if (error instanceof RestaurantProfileError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
  if (error instanceof SpaceDeletionInProgressError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  throw error;
}

export function restaurantRoutes(ctx: RouterContext) {
  const { deps, restaurantEnabled } = ctx;
  return {
    restaurant: {
      get: restaurantEnabled.restaurant.get.handler(async ({ context }) => {
        try {
          return await getRestaurantProfile(deps.prisma, context.actor);
        } catch (error) {
          restaurantError(error);
        }
      }),
      begin: restaurantEnabled.restaurant.begin.handler(async ({ context }) => {
        try {
          return await beginRestaurantProfile(deps.prisma, context.actor);
        } catch (error) {
          restaurantError(error);
        }
      }),
      save: restaurantEnabled.restaurant.save.handler(async ({ context, input }) => {
        try {
          const saved = await saveRestaurantProfile(deps.prisma, context.actor, input);
          await recordAuditEvent({
            action: "space.renamed",
            actor: { type: "user", id: context.actor.userId },
            spaceId: context.actor.spaceId,
            target: { type: "space", id: context.actor.spaceId, label: saved.name },
          });
          return saved;
        } catch (error) {
          restaurantError(error);
        }
      }),
      counts: restaurantEnabled.restaurant.counts.handler(async ({ context }) => {
        try {
          return await restaurantCounts(deps.prisma, context.actor.spaceId);
        } catch (error) {
          restaurantError(error);
        }
      }),
    },
  };
}
