/** Read-only platform admin. Nothing here is a login, a token, or a secret. */

export interface AdminOutlet {
  name: string;
  city: string;
  active: boolean;
  zomato: "connected" | "not_connected";
  swiggy: "connected" | "not_connected";
}

export interface AdminRun {
  status: string;
  startedAt: string;
  endedAt: string | null;
  costPaise: number | null;
}

export interface AdminRestaurantInput {
  restaurantId: string;
  name: string;
  outlets: readonly AdminOutlet[];
  runs: readonly AdminRun[];
}

export interface AdminRestaurantRow {
  restaurantId: string;
  name: string;
  paused: boolean;
  outlets: number;
  zomato: "connected" | "not_connected";
  swiggy: "connected" | "not_connected";
  run: "in_progress" | "done" | "not_started" | "failed" | "paused";
  /** Civil date of the latest finished run. Null when none has finished. */
  lastDownload: string | null;
  costPaise: number | null;
}

export type AdminRestaurantFilter = "all" | "attention" | "paused";

export function restaurantNeedsAttention(row: AdminRestaurantRow): boolean {
  return (
    row.paused ||
    row.run === "failed" ||
    row.run === "not_started" ||
    row.zomato === "not_connected" ||
    row.swiggy === "not_connected"
  );
}

export function filterAdminRestaurants(
  rows: readonly AdminRestaurantRow[],
  query: string,
  filter: AdminRestaurantFilter,
): AdminRestaurantRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (needle && !row.name.toLowerCase().includes(needle)) return false;
    if (filter === "paused") return row.paused;
    if (filter === "attention") return restaurantNeedsAttention(row);
    return true;
  });
}

export interface AdminOwnerView {
  restaurantId: string;
  name: string;
  readOnly: true;
  outlets: AdminOutlet[];
}

export interface AdminPanel {
  health: string;
  needsYou: boolean;
  runs: Array<{
    restaurant: string;
    state: "in_progress" | "done" | "not_started" | "failed" | "paused";
  }>;
  restaurants: AdminRestaurantRow[];
  connections: Array<{
    restaurant: string;
    outlet: string;
    zomato: "connected" | "not_connected";
    swiggy: "connected" | "not_connected";
  }>;
  messages: string;
  costsPaise: number | null;
  rules: string;
}

export function ownerViewFromRestaurant(row: {
  restaurantId: string;
  name: string;
  outlets: ReadonlyArray<{
    name: string;
    city: string;
    active: boolean;
    zomato: { resId: string } | null;
    swiggy: { rid: string } | null;
  }>;
}): AdminOwnerView {
  return {
    restaurantId: row.restaurantId,
    name: row.name,
    readOnly: true,
    outlets: row.outlets.map((outlet) => ({
      name: outlet.name,
      city: outlet.city,
      active: outlet.active,
      zomato: outlet.zomato ? "connected" : "not_connected",
      swiggy: outlet.swiggy ? "connected" : "not_connected",
    })),
  };
}

export function panelFromAdminRows(
  rows: ReadonlyArray<{
    restaurantId: string;
    name: string;
    outlets: ReadonlyArray<{
      name: string;
      city: string;
      active: boolean;
      zomato: { resId: string } | null;
      swiggy: { rid: string } | null;
    }>;
    jobRuns: ReadonlyArray<AdminRun>;
  }>,
  openFindings: number,
): AdminPanel {
  return composeAdminPanel({
    openFindings,
    restaurants: rows.map((row) => ({
      restaurantId: row.restaurantId,
      name: row.name,
      outlets: ownerViewFromRestaurant(row).outlets,
      runs: row.jobRuns,
    })),
  });
}

export function composeAdminPanel(input: {
  restaurants: readonly AdminRestaurantInput[];
  openFindings: number;
}): AdminPanel {
  const restaurants = [...input.restaurants].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (restaurants.length === 0) {
    return {
      health: "Add your first restaurant",
      needsYou: false,
      runs: [],
      restaurants: [],
      connections: [],
      messages: "No messages are in this view.",
      costsPaise: null,
      rules: rulesLine(input.openFindings),
    };
  }
  const rows = restaurants.map((restaurant) => ({
    restaurant,
    latest: latestRun(restaurant.runs),
  }));
  const active = rows.filter((row) => !paused(row.restaurant));
  const inProgress = active.filter((row) => row.latest != null && row.latest.endedAt == null);
  const notStarted = active.filter((row) => row.latest == null);
  const failed = active.filter((row) => row.latest?.status === "failed");
  const done = active.length - inProgress.length;
  const health =
    inProgress.length > 0
      ? `Run in progress, ${done} of ${active.length} done`
      : notStarted.length > 0
        ? "Last night's run didn't start"
        : `All ${active.length} restaurants updated`;
  const costs = active.flatMap((row) =>
    row.restaurant.runs.flatMap((run) => (run.costPaise == null ? [] : [run.costPaise])),
  );
  return {
    health,
    needsYou:
      inProgress.length > 0 || notStarted.length > 0 || failed.length > 0 || input.openFindings > 0,
    runs: rows.map((row) => ({
      restaurant: row.restaurant.name,
      state: runState(row.latest, paused(row.restaurant)),
    })),
    restaurants: rows.map((row) => ({
      restaurantId: row.restaurant.restaurantId,
      name: row.restaurant.name,
      paused: paused(row.restaurant),
      outlets: row.restaurant.outlets.filter((outlet) => outlet.active).length,
      zomato: platformState(row.restaurant.outlets, "zomato"),
      swiggy: platformState(row.restaurant.outlets, "swiggy"),
      run: runState(row.latest, paused(row.restaurant)),
      lastDownload: lastDownload(row.restaurant.runs),
      costPaise: runCost(row.restaurant.runs),
    })),
    connections: rows.flatMap((row) =>
      row.restaurant.outlets
        .filter((outlet) => outlet.active)
        .map((outlet) => ({
          restaurant: row.restaurant.name,
          outlet: outlet.name,
          zomato: outlet.zomato,
          swiggy: outlet.swiggy,
        })),
    ),
    messages: "No messages are in this view.",
    costsPaise: costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0),
    rules: rulesLine(input.openFindings),
  };
}

function rulesLine(openFindings: number): string {
  return openFindings === 0 ? "No rule placeholders left." : `${openFindings} need a person`;
}

function platformState(
  outlets: readonly AdminOutlet[],
  platform: "zomato" | "swiggy",
): "connected" | "not_connected" {
  return outlets.some((outlet) => outlet.active && outlet[platform] === "connected")
    ? "connected"
    : "not_connected";
}

function lastDownload(runs: readonly AdminRun[]): string | null {
  const finished = [...runs]
    .filter((run) => run.endedAt != null)
    .sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""));
  return finished[0]?.endedAt?.slice(0, 10) ?? null;
}

function runCost(runs: readonly AdminRun[]): number | null {
  const known = runs.flatMap((run) => (run.costPaise == null ? [] : [run.costPaise]));
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

function paused(restaurant: AdminRestaurantInput): boolean {
  return restaurant.outlets.length > 0 && restaurant.outlets.every((outlet) => !outlet.active);
}

function latestRun(runs: readonly AdminRun[]): AdminRun | null {
  return [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
}

function runState(
  run: AdminRun | null,
  isPaused: boolean,
): "in_progress" | "done" | "not_started" | "failed" | "paused" {
  if (isPaused) return "paused";
  if (!run) return "not_started";
  if (run.endedAt == null) return "in_progress";
  if (run.status === "failed") return "failed";
  return "done";
}
