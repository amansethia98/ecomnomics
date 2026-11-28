import type { OpsPlatform } from "./ops/types.js";

export type DashState = "ok" | "pending" | "missing" | "updating";

/** One stored day or week reading for a metric. */
export interface DashReading {
  from: string;
  grain: "day" | "week";
  platform: OpsPlatform;
  key: string;
  value: number | null;
  state: DashState;
}

/** Days where orders exceed carts, or carts are zero. Those days are not a rate. */
export function incomparableFunnelDays(readings: readonly DashReading[]): string[] {
  const dates = new Set<string>();
  for (const reading of readings) {
    if (reading.grain !== "day" || reading.key !== "cart_builds" || reading.state !== "ok")
      continue;
    const ordersKey = reading.platform === "swiggy" ? "swiggy_funnel_orders" : "placed_orders";
    const orders = readings.find(
      (row) =>
        row.grain === "day" &&
        row.platform === reading.platform &&
        row.key === ordersKey &&
        row.from === reading.from &&
        row.state === "ok",
    );
    const carts = reading.value;
    const placed = orders?.value ?? null;
    if (carts == null || carts === 0 || (placed != null && placed > carts)) dates.add(reading.from);
  }
  return [...dates].sort();
}
