import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";
import { restaurantStarterBotsEnabled } from "./restaurant-mode.js";
import { loadRestaurantTemplates } from "./restaurant-templates.js";

/**
 * Copy every template bot into a new workspace.
 *
 * Skills are not copied. They stay in `restaurant-templates/` and are served
 * read-only, so editing a SKILL.md and restarting updates every restaurant.
 * Safe to call twice: each template's spawn key returns the bot already created.
 */
export async function seedRestaurantStarterBots(
  prisma: PrismaClient,
  input: { userId: string; spaceId: string; email?: string | null },
): Promise<void> {
  if (!restaurantStarterBotsEnabled()) return;
  const templates = loadRestaurantTemplates();
  const actor: Actor = {
    userId: input.userId,
    spaceId: input.spaceId,
    email: input.email?.includes("@") ? input.email : "restaurant@localhost",
    isDeploymentOwner: false,
  };
  const repos = createRepos(prisma);
  for (const template of templates) {
    await repos.createBot(actor, {
      name: template.name,
      description: template.description,
      instructions: template.instructions,
      notifyOnFinish: true,
      spawnKey: template.spawnKey,
      computerMode: "team",
    });
  }
}
