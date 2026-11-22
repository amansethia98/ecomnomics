/** Read-only platform admin. Nothing here is a login, a token, or a secret. */

import { addIsoDays, indiaCivilDate } from "./metric-dates.js";
import type { DashReading } from "./owner-dashboard.js";
import { incomparableFunnelDays } from "./owner-dashboard.js";

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
  /** Stored downloads. The newest createdAt is the last-download date. */
  fetches?: readonly AdminFetch[];
}

export interface AdminFetch {
  createdAt: string;
  platform?: string | null;
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
  /** Days a rate cannot be computed, plus payout rows a parser could not read. */
  quality: string[];
  /** Earliest start and latest end of the newest night that has a stored run. */
  night: { startedAt: string; endedAt: string | null } | null;
  /** Seven civil days ending on the newest stored download. Empty when nothing was stored. */
  freshness: Array<{ day: string; downloads: number }>;
  /** Nights that have a stored run, at most fourteen. */
  nights: Array<{ day: string; runs: number; costPaise: number }>;
  /** Days that have a stored cost. Empty when no run recorded one. */
  dailyCosts: Array<{ day: string; costPaise: number }>;
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
    fetches?: ReadonlyArray<AdminFetch>;
  }>,
  openFindings: number,
): AdminPanel {
  return composeAdminPanel({
    openFindings,
    restaurants: rows.map((row) => ({
      restaurantId: row.restaurantId,
      fetches: row.fetches,
      name: row.name,
      outlets: ownerViewFromRestaurant(row).outlets,
      runs: row.jobRuns,
    })),
  });
}

export function composeAdminPanel(input: {
  restaurants: readonly AdminRestaurantInput[];
  openFindings: number;
  quality?: readonly string[];
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
      quality: [],
      night: null,
      freshness: [],
      nights: [],
      dailyCosts: [],
    };
  }
  const runs = restaurants.flatMap((restaurant) => restaurant.runs);
  const fetches = restaurants.flatMap((restaurant) => restaurant.fetches ?? []);
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
        : active.length === 1
          ? "1 restaurant updated"
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
      lastDownload: lastDownload(row.restaurant.runs, row.restaurant.fetches ?? []),
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
    quality: [...(input.quality ?? [])],
    night: adminNight(runs),
    freshness: adminFreshness(fetches),
    nights: adminNights(runs),
    dailyCosts: adminDailyCosts(runs),
  };
}

/** The newest night's first start and last finish. An open run has no end. */
export function adminNight(
  runs: readonly AdminRun[],
): { startedAt: string; endedAt: string | null } | null {
  const newest = latestRun(runs);
  if (!newest) return null;
  const day = indiaCivilDate(new Date(newest.startedAt));
  const same = runs.filter((run) => indiaCivilDate(new Date(run.startedAt)) === day);
  const startedAt = same.map((run) => run.startedAt).sort()[0] ?? newest.startedAt;
  if (same.some((run) => run.endedAt == null)) return { startedAt, endedAt: null };
  const endedAt =
    same
      .map((run) => run.endedAt ?? "")
      .sort()
      .at(-1) ?? null;
  return { startedAt, endedAt };
}

/** Seven days ending on the newest stored download, including days with none. */
export function adminFreshness(
  fetches: readonly AdminFetch[],
): Array<{ day: string; downloads: number }> {
  const counts = new Map<string, number>();
  for (const row of fetches) {
    const day = indiaCivilDate(new Date(row.createdAt));
    if (day.length !== 10) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const end = [...counts.keys()].sort().at(-1);
  if (!end) return [];
  const days: Array<{ day: string; downloads: number }> = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = addIsoDays(end, -offset);
    days.push({ day, downloads: counts.get(day) ?? 0 });
  }
  return days;
}

/** Stored nights, oldest first, capped at fourteen. A night with no run is left out. */
export function adminNights(
  runs: readonly AdminRun[],
): Array<{ day: string; runs: number; costPaise: number }> {
  const byDay = new Map<string, { runs: number; costPaise: number }>();
  for (const run of runs) {
    const day = indiaCivilDate(new Date(run.startedAt));
    const current = byDay.get(day) ?? { runs: 0, costPaise: 0 };
    current.runs += 1;
    current.costPaise += run.costPaise ?? 0;
    byDay.set(day, current);
  }
  return [...byDay.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(-14)
    .map(([day, row]) => ({ day, runs: row.runs, costPaise: row.costPaise }));
}

/** Days a run recorded a cost. Days with no cost are absent. */
export function adminDailyCosts(
  runs: readonly AdminRun[],
): Array<{ day: string; costPaise: number }> {
  const byDay = new Map<string, number>();
  for (const run of runs) {
    if (run.costPaise == null) continue;
    const day = indiaCivilDate(new Date(run.startedAt));
    byDay.set(day, (byDay.get(day) ?? 0) + run.costPaise);
  }
  return [...byDay.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(-14)
    .map(([day, costPaise]) => ({ day, costPaise }));
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

function lastDownload(runs: readonly AdminRun[], fetches: readonly AdminFetch[]): string | null {
  const fetched = fetches
    .map((row) => indiaCivilDate(new Date(row.createdAt)))
    .filter((day) => day.length === 10)
    .sort();
  const newestFetch = fetched[fetched.length - 1];
  if (newestFetch) return newestFetch;
  const finished = [...runs]
    .filter((run) => run.endedAt != null)
    .sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""));
  const ended = finished[0]?.endedAt;
  return ended ? indiaCivilDate(new Date(ended)) : null;
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

/** Funnel days that are not a rate, plus payout rows whose mark could not be read. */
export function adminQualityNotes(input: {
  readings: readonly DashReading[];
  badPayouts: readonly { platform: string; mark: string }[];
}): string[] {
  const notes = incomparableFunnelDays(input.readings).map(
    (day) => `Carts and orders do not match on ${day}`,
  );
  for (const payout of input.badPayouts) {
    notes.push(`${payout.platform} payout mark ${payout.mark} could not be read`);
  }
  return notes;
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
