/** Which current rows a re-fetch replaces. An unchanged value is left alone. */

export interface WindowWrite {
  key: string;
  periodStart: string;
  periodEnd: string;
  rowRole: "fact" | "platform_check";
  value: number | null;
  source: string;
  state?: "ok" | "pending_label" | "label_unrecoverable";
}

export interface StoredWindowRow extends WindowWrite {
  id: string;
}

export interface ReplacePlan {
  supersedeIds: string[];
  inserts: WindowWrite[];
  unchanged: number;
}

function slot(row: WindowWrite): string {
  return `${row.periodStart}\t${row.periodEnd}\t${row.key}\t${row.rowRole}`;
}

function rowState(row: WindowWrite): string {
  return row.state ?? "ok";
}

function sameValue(left: WindowWrite, right: WindowWrite): boolean {
  if (rowState(left) !== rowState(right)) return false;
  if (left.value == null || right.value == null) return left.value == null && right.value == null;
  return Math.abs(left.value - right.value) < 0.00005;
}

/**
 * Incoming rows are the whole window for this file. A key that is missing, or
 * present as null, supersedes a stored value to null. The same value writes nothing.
 */
export function planReplaceWindow(
  existing: readonly StoredWindowRow[],
  incoming: readonly WindowWrite[],
): ReplacePlan {
  const existingBySlot = new Map<string, StoredWindowRow>();
  for (const row of existing) existingBySlot.set(slot(row), row);
  const seen = new Set<string>();
  const supersedeIds: string[] = [];
  const inserts: WindowWrite[] = [];
  let unchanged = 0;

  for (const row of incoming) {
    const key = slot(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const prior = existingBySlot.get(key);
    if (
      prior &&
      rowState(prior) === "ok" &&
      prior.value != null &&
      rowState(row) === "pending_label"
    ) {
      unchanged += 1;
      continue;
    }
    if (prior && sameValue(prior, row)) {
      unchanged += 1;
      continue;
    }
    if (prior) supersedeIds.push(prior.id);
    inserts.push(row);
  }

  for (const prior of existing) {
    if (seen.has(slot(prior))) continue;
    if (prior.value == null) {
      unchanged += 1;
      continue;
    }
    supersedeIds.push(prior.id);
    inserts.push({
      key: prior.key,
      periodStart: prior.periodStart,
      periodEnd: prior.periodEnd,
      rowRole: prior.rowRole,
      value: null,
      source: "missing",
    });
  }

  return { supersedeIds, inserts, unchanged };
}
