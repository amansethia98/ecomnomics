/** Read-only platform admin. Nothing here is a login, a token, or a secret. */

import { addIsoDays, indiaCivilDate } from "./metric-dates.js";
import { formatCivilDay, formatWeekdayShort } from "./ops/format.js";
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
  reports?: ReadonlyArray<{ kind: string | null; on: string; createdAt?: string | null }>;
}

export interface AdminFetch {
  createdAt: string;
  platform?: string | null;
  status?: string | null;
  runId?: string | null;
  attemptCount?: number | null;
  periodStart?: string | null;
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
    tries?: number | null;
    rows?: number | null;
    minutes?: number | null;
    costPaise?: number | null;
  }>;
  restaurants: AdminRestaurantRow[];
  connections: Array<{
    restaurant: string;
    outlet: string;
    zomato: "connected" | "not_connected";
    swiggy: "connected" | "not_connected";
  }>;
  messages: string;
  /** One line per brief we could read. Empty when the log is not readable. */
  messageRows?: string[];
  /** Stored downloads, not restaurants. */
  downloads?: { ok: number; total: number };
  /** Days in the last week with no stored file for that app. */
  pendingSwiggy?: number;
  pendingZomato?: number;
  /** Set when yesterday has no stored file on either app. */
  pendingNote?: string | null;
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
    reports?: ReadonlyArray<{ kind: string | null; on: string; createdAt?: string | null }>;
    quality?: readonly string[];
  }>,
  openFindings: number,
): AdminPanel {
  return composeAdminPanel({
    openFindings,
    quality: rows.flatMap((row) => row.quality ?? []),
    restaurants: rows.map((row) => ({
      restaurantId: row.restaurantId,
      fetches: row.fetches,
      reports: row.reports,
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
  today?: string;
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
      messages: "Message log isn't readable from admin yet.",
      messageRows: [],
      downloads: { ok: 0, total: 0 },
      pendingSwiggy: 0,
      pendingZomato: 0,
      pendingNote: null,
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
      tries: attemptTotal(nightFetches(row.restaurant.fetches ?? [])),
      rows: storedTotal(nightFetches(row.restaurant.fetches ?? [])),
      minutes: runMinutes(row.latest),
      costPaise: runCost(row.restaurant.runs),
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
    messages:
      messageRows(restaurants).length > 0
        ? messageRows(restaurants).join("\n")
        : "Message log isn't readable from admin yet.",
    messageRows: messageRows(restaurants),
    downloads: downloadTally(fetches),
    pendingSwiggy: pendingApps(fetches, input.today ?? indiaCivilDate(new Date())).swiggy,
    pendingZomato: pendingApps(fetches, input.today ?? indiaCivilDate(new Date())).zomato,
    pendingNote: pendingSentence(fetches, input.today ?? indiaCivilDate(new Date())),
    costsPaise: costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0),
    rules: rulesLine(input.openFindings),
    quality: [...(input.quality ?? [])],
    night: nightlyWindow(fetches) ?? adminNight(runs),
    freshness: adminFreshness(fetches),
    nights: adminNights(runs),
    dailyCosts: adminDailyCosts(runs),
  };
}

/** The latest nightly download's first and last stored time. Job runs are not the night. */
export function nightlyWindow(
  fetches: readonly AdminFetch[],
): { startedAt: string; endedAt: string | null } | null {
  const nightly = fetches.filter((row) => row.runId?.startsWith("nightly-"));
  const latest = nightly
    .map((row) => row.runId)
    .sort()
    .at(-1);
  if (!latest) return null;
  const times = nightly
    .filter((row) => row.runId === latest)
    .map((row) => row.createdAt)
    .sort();
  const stamped = nightlyStart(latest);
  const startedAt = stamped ?? times[0];
  if (!startedAt) return null;
  return { startedAt, endedAt: times.at(-1) ?? startedAt };
}

/** `nightly-YYYYMMDD-HHMM` is an India civil clock. Other ids keep the stored time. */
function nightlyStart(runId: string): string | null {
  const match = /^nightly-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(runId);
  if (!match) return null;
  const utc =
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
    ) -
    5.5 * 60 * 60 * 1000;
  return new Date(utc).toISOString();
}

/** Stored files, one per app and report. A restaurant is not a download. */
export function downloadTally(fetches: readonly AdminFetch[]): { ok: number; total: number } {
  const nightly = fetches.filter((row) => row.runId?.startsWith("nightly-"));
  const latest = nightly
    .map((row) => row.runId)
    .sort()
    .at(-1);
  const scoped = latest ? fetches.filter((row) => row.runId === latest) : fetches;
  const counted = scoped.filter((row) => row.status);
  return {
    ok: counted.filter((row) => row.status === "stored").length,
    total: counted.length,
  };
}

/** Yesterday is missing on both apps, named as "Sat 21 is pending on both apps". */
export function pendingSentence(fetches: readonly AdminFetch[], today: string): string | null {
  const pending = pendingApps(fetches, today);
  if (pending.zomato === 0 || pending.swiggy === 0) return null;
  const day = addIsoDays(today, -1);
  return `${formatWeekdayShort(day)} ${Number(day.slice(8, 10))} is pending on both apps`;
}

/** Yesterday, when that civil day has no stored file for the app. */
export function pendingApps(
  fetches: readonly AdminFetch[],
  today: string,
): { zomato: number; swiggy: number } {
  const day = addIsoDays(today, -1);
  const missing = (platform: "zomato" | "swiggy") => {
    const stored = fetches.some((row) => {
      if (row.platform !== platform) return false;
      if (row.status != null && row.status !== "stored") return false;
      const covered = row.periodStart ?? indiaCivilDate(new Date(row.createdAt));
      return covered === day;
    });
    return stored ? 0 : 1;
  };
  return { zomato: missing("zomato"), swiggy: missing("swiggy") };
}

function messageRows(restaurants: readonly AdminRestaurantInput[]): string[] {
  const lines = restaurants.flatMap((restaurant) =>
    (restaurant.reports ?? []).map((report) => {
      const kind =
        report.kind === "daily_brief"
          ? "Daily brief"
          : report.kind === "weekly_review"
            ? "Weekly review"
            : "Payout check";
      const day = report.createdAt ? indiaCivilDate(new Date(report.createdAt)) : report.on;
      return `${kind} · ${formatCivilDay(day)} · Sent`;
    }),
  );
  return [...new Set(lines)];
}

function nightFetches(fetches: readonly AdminFetch[]): readonly AdminFetch[] {
  const nightly = fetches.filter((row) => row.runId?.startsWith("nightly-"));
  const latest = nightly
    .map((row) => row.runId)
    .sort()
    .at(-1);
  return latest ? fetches.filter((row) => row.runId === latest) : fetches;
}

function attemptTotal(fetches: readonly AdminFetch[]): number | null {
  const known = fetches.flatMap((row) => (row.attemptCount == null ? [] : [row.attemptCount]));
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

function storedTotal(fetches: readonly AdminFetch[]): number | null {
  const counted = fetches.filter((row) => row.status);
  if (counted.length === 0) return null;
  return counted.filter((row) => row.status === "stored").length;
}

function runMinutes(run: AdminRun | null): number | null {
  if (!run?.endedAt) return null;
  const minutes = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60_000);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
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

/** Seven days ending on the newest cost, including days that recorded nothing. */
export function adminDailyCosts(
  runs: readonly AdminRun[],
): Array<{ day: string; costPaise: number }> {
  const byDay = new Map<string, number>();
  for (const run of runs) {
    if (run.costPaise == null) continue;
    const day = indiaCivilDate(new Date(run.startedAt));
    byDay.set(day, (byDay.get(day) ?? 0) + run.costPaise);
  }
  const end = [...byDay.keys()].sort().at(-1);
  if (!end) return [];
  const days: Array<{ day: string; costPaise: number }> = [];
  for (let cursor = addIsoDays(end, -6); cursor <= end; cursor = addIsoDays(cursor, 1)) {
    days.push({ day: cursor, costPaise: byDay.get(cursor) ?? 0 });
  }
  return days;
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
/** A funnel day that cannot be a rate, with the stored cart and order counts. */
export function funnelGapLines(readings: readonly DashReading[]): string[] {
  return incomparableFunnelDays(readings).map((day) => {
    const carts = readings.find(
      (row) => row.from === day && row.key === "cart_builds" && row.state === "ok",
    );
    const orders = readings.find(
      (row) =>
        row.from === day &&
        row.platform === carts?.platform &&
        (row.key === "placed_orders" || row.key === "swiggy_funnel_orders") &&
        row.state === "ok",
    );
    const name = carts?.platform === "swiggy" ? "Swiggy" : "Zomato";
    if (carts?.value == null || orders?.value == null) {
      return `Carts and orders do not match on ${day}`;
    }
    return `${name} ${formatCivilDay(day)}: ${carts.value} carts → ${orders.value} orders`;
  });
}

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
