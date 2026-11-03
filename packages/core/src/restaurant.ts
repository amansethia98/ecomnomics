/** Spawn key prefix for bots copied from `restaurant-templates/`. */
export const RESTAURANT_TEMPLATE_SPAWN_PREFIX = "restaurant-template:";

export function isRestaurantTemplateSpawnKey(spawnKey: string | null | undefined): boolean {
  return Boolean(spawnKey?.startsWith(RESTAURANT_TEMPLATE_SPAWN_PREFIX));
}

export function restaurantTemplateSpawnKey(templateId: string): string {
  return `${RESTAURANT_TEMPLATE_SPAWN_PREFIX}${templateId}`;
}
