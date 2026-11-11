import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";

/** A restaurant whose computer now exists, so its agent token can be minted. */
export type RestaurantAgentReady = { spaceId: string };

type Handler = (event: RestaurantAgentReady) => Promise<void>;

let handler: Handler | undefined;

/** Register the process that can encrypt the token. Unset clears it. */
export function setRestaurantAgentAccessHandler(next: Handler | undefined): void {
  handler = next;
}

/**
 * Called after a restaurant or its computer is saved. No-ops until a handler
 * is registered, and never fails the save that noticed the pair.
 */
export async function notifyRestaurantAgentReady(db: PrismaClient, spaceId: string): Promise<void> {
  if (!handler) return;
  try {
    const restaurant = await db.restaurant.findUnique({
      where: { spaceId },
      select: { id: true },
    });
    if (!restaurant) return;
    const computer = await db.computer.findFirst({
      where: { spaceId },
      select: { id: true },
    });
    if (!computer) return;
    await handler({ spaceId });
  } catch (error) {
    getLogger().warn("restaurant.agent_token.provision_failed", {
      spaceId,
      error: error instanceof Error ? error.name : "error",
    });
  }
}
