import { addIsoDays, indiaCivilDate, utcMidnight } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";

/** Re-read at most this many pending days for one outlet and platform in a night. */
export const RELABEL_NIGHT_DAYS = 30;
/** A pending day is given up after this many failed nights. */
export const RELABEL_ATTEMPT_LIMIT = 3;
/** A metric missing this many days in two outlets is not available. */
export const LABEL_ABSENT_DAYS = 14;
export const LABEL_ABSENT_OUTLETS = 2;

export interface RelabelFailure {
  outletId: string;
  platform: string;
  findingId: string;
  periodStart: string;
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Dates that are pending in at least two outlets for fourteen consecutive days.
 * The input dates are civil dates already sorted per outlet.
 */
export function longAbsentDates(
  byOutlet: ReadonlyMap<string, readonly string[]>,
  days = LABEL_ABSENT_DAYS,
  outlets = LABEL_ABSENT_OUTLETS,
): string[] {
  const sets = [...byOutlet.entries()].map(
    ([outletId, dates]) => [outletId, new Set(dates)] as const,
  );
  const marked = new Set<string>();
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      const first = sets[left]?.[1];
      const second = sets[right]?.[1];
      if (!first || !second) continue;
      const shared = [...first].filter((date) => second.has(date)).sort();
      let run: string[] = [];
      for (const date of shared) {
        const previous = run.at(-1);
        run = previous && addIsoDays(previous, 1) === date ? [...run, date] : [date];
        if (run.length >= days) {
          for (const item of run) marked.add(item);
        }
      }
    }
  }
  if (outlets > sets.length) return [];
  return [...marked].sort();
}

/** Records a failed night. The same night for the same day is stored once. */
export async function noteRelabelFailures(
  db: Db,
  scope: { restaurantId: string; spaceId: string },
  night: string,
  failures: readonly RelabelFailure[],
): Promise<void> {
  if (failures.length === 0) return;
  await db.metricRelabelAttempt.createMany({
    data: failures.map((failure) => ({
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      outletId: failure.outletId,
      platform: failure.platform,
      findingId: failure.findingId,
      periodStart: utcMidnight(failure.periodStart),
      night,
      outcome: "failed",
    })),
    skipDuplicates: true,
  });
}

/**
 * Gives up on a day after three failed nights, and marks a metric not available
 * after it has been missing for fourteen days in two outlets. Safe to run again.
 */
export async function applyLabelAging(
  db: PrismaClient,
  scope: { restaurantId: string; spaceId: string },
): Promise<void> {
  await exhaustRelabelAttempts(db, scope);
  await markLongAbsences(db, scope);
}

async function exhaustRelabelAttempts(
  db: PrismaClient,
  scope: { restaurantId: string; spaceId: string },
): Promise<void> {
  const attempts = await db.metricRelabelAttempt.findMany({
    where: { restaurantId: scope.restaurantId, spaceId: scope.spaceId, outcome: "failed" },
    select: { outletId: true, findingId: true, periodStart: true, night: true },
  });
  const nights = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    const key = `${attempt.outletId}\t${attempt.findingId}\t${attempt.periodStart.toISOString()}`;
    const seen = nights.get(key) ?? new Set<string>();
    seen.add(attempt.night);
    nights.set(key, seen);
  }
  const exhausted = [...nights.entries()].filter(([, seen]) => seen.size >= RELABEL_ATTEMPT_LIMIT);
  if (exhausted.length === 0) return;
  const pending = await db.metricValue.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      state: "pending_label",
      supersededAt: null,
    },
    select: { id: true, outletId: true, source: true, periodStart: true },
  });
  const ids = pending.flatMap((row) => {
    const findingId = findingIdFromSource(row.source);
    if (!findingId) return [];
    const key = `${row.outletId}\t${findingId}\t${row.periodStart.toISOString()}`;
    return (nights.get(key)?.size ?? 0) >= RELABEL_ATTEMPT_LIMIT ? [row.id] : [];
  });
  if (ids.length === 0) return;
  await db.metricValue.updateMany({
    where: { id: { in: ids } },
    data: { state: "label_unrecoverable" },
  });
}

async function markLongAbsences(
  db: PrismaClient,
  scope: { restaurantId: string; spaceId: string },
): Promise<void> {
  const pending = await db.metricValue.findMany({
    where: {
      restaurantId: scope.restaurantId,
      spaceId: scope.spaceId,
      state: "pending_label",
      granularity: "day",
      supersededAt: null,
    },
    select: { id: true, outletId: true, source: true, periodStart: true },
  });
  const findingIds = [...new Set(pending.flatMap((row) => findingIdFromSource(row.source) ?? []))];
  if (findingIds.length === 0) return;
  const absent = await runAsSystem("absent label findings", () =>
    db.metricLabelFinding.findMany({
      where: { id: { in: findingIds }, kind: "metric_absent" },
      select: { id: true },
    }),
  );
  const absentIds = new Set(absent.map((row) => row.id));
  if (absentIds.size === 0) return;
  const byFinding = new Map<string, Map<string, { id: string; date: string }[]>>();
  for (const row of pending) {
    const findingId = findingIdFromSource(row.source);
    if (!findingId || !absentIds.has(findingId)) continue;
    const outlets = byFinding.get(findingId) ?? new Map<string, { id: string; date: string }[]>();
    const dates = outlets.get(row.outletId) ?? [];
    dates.push({ id: row.id, date: indiaCivilDate(row.periodStart) });
    outlets.set(row.outletId, dates);
    byFinding.set(findingId, outlets);
  }
  const ids: string[] = [];
  for (const outlets of byFinding.values()) {
    const dates = new Map(
      [...outlets.entries()].map(([outletId, rows]) => [outletId, rows.map((row) => row.date)]),
    );
    const marked = new Set(longAbsentDates(dates));
    if (marked.size === 0) continue;
    for (const rows of outlets.values()) {
      for (const row of rows) {
        if (marked.has(row.date)) ids.push(row.id);
      }
    }
  }
  if (ids.length === 0) return;
  await db.metricValue.updateMany({
    where: { id: { in: ids } },
    data: { state: "label_unrecoverable" },
  });
}

export function findingIdFromSource(source: string): string | null {
  const prefix = "pending_label:";
  if (!source.startsWith(prefix)) return null;
  const id = source.slice(prefix.length);
  return id.length > 0 && id !== "absent" ? id : null;
}

/** A stored fetch needs another parse when it still has pending labels from an older registry. */
export function fetchCoversCurrentLabels(
  row: { pendingLabels: number; labelSetVersion: number | null },
  version: number,
): boolean {
  return row.pendingLabels === 0 || row.labelSetVersion === version;
}

export async function labelRegistryVersion(db: Db): Promise<number> {
  const row = await db.metricLabelRegistry.findUnique({ where: { id: "global" } });
  return row?.version ?? 1;
}
