import type { LabelBook, LabelSlot } from "./metric-label.js";
import { itemSuffix, looseNorm, normaliseLabel } from "./metric-label.js";

/** Off unless this is exactly `on`. Shadow mode records the decision and does not add an alias. */
export const LABEL_AUTO_APPLY_ENV = "ECOMNOMICS_LABEL_AUTO_APPLY";

export function labelAutoApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LABEL_AUTO_APPLY_ENV] === "on";
}

export interface DetectedCell {
  value: number | null;
  kind: string;
}

export interface DetectedRow {
  section: string;
  metric: string;
  rowIndex: number;
  cells: DetectedCell[];
}

export interface LabelChangeFinding {
  kind: "metric_label_change" | "layout_change";
  platform: "swiggy" | "zomato";
  family: "business" | "payout";
  reportKind: string;
  section: string;
  slotId: string;
  oldLabel: string;
  candidateLabel: string | null;
  candidateNorm: string | null;
  summable: boolean;
  allowAutoApply: boolean;
  rowIndex: number | null;
  /** Period indexes whose stored metric day is pending. */
  pendingPeriods: number[];
  evidence: LabelChangeEvidence;
  ruleInput: AutoApplyInput;
}

export interface LabelChangeEvidence {
  similarity: { jaccard: number; editRatio: number };
  position: {
    rowIndex: number | null;
    neighboursBefore: string | null;
    neighboursAfter: string | null;
    sameNeighbours: boolean;
  };
  unitMatch: boolean;
  kindMatch: boolean;
  valueEvidence: {
    method: "relation" | "continuity" | "none";
    count: number;
    min: number | null;
    max: number | null;
    median: number | null;
  };
  contradictions: string[];
}

export interface AutoApplyInput {
  absentInSection: number;
  unknownInSection: number;
  samePlace: boolean;
  unitMatch: boolean;
  kindMatch: boolean;
  nameSimilar: boolean;
  aliasCollision: boolean;
  otherFinding: boolean;
  relationPass: boolean;
  continuityPass: boolean;
  summable: boolean;
  outlets: number;
  files: number;
  nights: number;
  contradiction: boolean;
  allowAutoApply: boolean;
  switchOn: boolean;
}

export interface AutoApplyDecision {
  wouldApply: boolean;
  confidence: "high" | "low";
  ruleResults: Record<"A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9", boolean>;
  reasons: string[];
}

export interface BusinessLabelDetection {
  layoutReason: string | null;
  unknown: number;
  absent: number;
  sectionsAffected: number;
  findings: LabelChangeFinding[];
  /** Old label rows that should be stored as pending_label for these periods. */
  pending: Array<{
    section: string;
    label: string;
    periodIndex: number;
    slotId: string;
    key?: string;
  }>;
}

const emptyEvidence = (): LabelChangeEvidence => ({
  similarity: { jaccard: 0, editRatio: 0 },
  position: {
    rowIndex: null,
    neighboursBefore: null,
    neighboursAfter: null,
    sameNeighbours: false,
  },
  unitMatch: false,
  kindMatch: false,
  valueEvidence: { method: "none", count: 0, min: null, max: null, median: null },
  contradictions: [],
});

export function businessLayoutReason(input: {
  required: number;
  absent: number;
  sectionsAffected: number;
  unknown: number;
}): string | null {
  if (input.required > 0 && input.absent / input.required > 0.25) {
    return "More than a quarter of the required metrics are missing.";
  }
  if (input.sectionsAffected > 3) return "Missing metrics span more than three sections.";
  if (input.unknown > 10) return "The file has more than ten unrecognised labels.";
  return null;
}

export function payoutLayoutReason(input: {
  anchorMissing: boolean;
  required: number;
  absent: number;
}): string | null {
  if (input.anchorMissing) return "A payout key column is missing.";
  if (input.required > 0 && input.absent / input.required > 0.3) {
    return "More than 30% of the required payout columns are missing.";
  }
  return null;
}

export function decideWouldApply(input: AutoApplyInput): AutoApplyDecision {
  const oneToOne = input.absentInSection === 1 && input.unknownInSection === 1;
  const kindOk = input.unitMatch && input.kindMatch;
  const clear = !input.aliasCollision && !input.otherFinding;
  const valuesOk = input.summable ? input.relationPass : input.relationPass || input.continuityPass;
  const seenEnough = input.outlets >= 2 || (input.files >= 3 && input.nights >= 2);
  const noContradiction = !input.contradiction;
  const switchOn = input.allowAutoApply && input.switchOn;
  const ruleResults = {
    A1: oneToOne,
    A2: input.samePlace,
    A3: kindOk,
    A4: input.nameSimilar,
    A5: clear,
    A6: valuesOk,
    A7: seenEnough,
    A8: noContradiction,
    A9: switchOn,
  };
  const wouldApply =
    oneToOne &&
    input.samePlace &&
    kindOk &&
    input.nameSimilar &&
    clear &&
    valuesOk &&
    seenEnough &&
    noContradiction &&
    input.allowAutoApply;
  const reasons: string[] = [];
  if (!oneToOne)
    reasons.push("The section does not have exactly one missing metric and one new label.");
  if (!input.samePlace) reasons.push("The new label is not in the missing metric's place.");
  if (!kindOk) reasons.push("The unit or the value type does not match.");
  if (!input.nameSimilar) reasons.push("The new name is not similar to the missing one.");
  if (input.aliasCollision) reasons.push("That label is already an alias of another metric.");
  if (input.otherFinding) reasons.push("Another open finding already proposes that label.");
  if (!valuesOk) {
    reasons.push(
      input.summable
        ? "The values do not satisfy a relation for this metric."
        : "The values do not satisfy a relation or the recent band.",
    );
  }
  if (!seenEnough)
    reasons.push("It has not been seen in two outlets, or in three files on two nights.");
  if (input.contradiction)
    reasons.push("The old label and the new label both have values for one period.");
  if (!input.allowAutoApply)
    reasons.push("This metric is not allowed to take an alias on its own.");
  if (!input.switchOn) reasons.push("ECOMNOMICS_LABEL_AUTO_APPLY is off.");
  return {
    wouldApply,
    confidence: wouldApply ? "high" : "low",
    ruleResults,
    reasons,
  };
}

export function detectBusinessLabels(input: {
  platform: "swiggy" | "zomato";
  reportKind: string;
  book: LabelBook;
  rows: DetectedRow[];
  periods: number;
  /** Section and printed label the parser stores. Other seed slots are not required. */
  expectedLabels: ReadonlySet<string>;
  switchOn?: boolean;
}): BusinessLabelDetection {
  const slots = input.book.slots.filter(
    (slot) =>
      slot.platform === input.platform &&
      slot.reportKind === "business" &&
      !slot.retiredFrom &&
      input.expectedLabels.has(`${slot.section}\t${primaryAlias(input.book, slot)}`),
  );
  const aliasOf = new Map<string, LabelSlot>();
  const ignored = new Set<string>();
  for (const slot of input.book.slots) {
    if (slot.platform !== input.platform || slot.reportKind !== "business") continue;
    for (const alias of input.book.aliases) {
      if (alias.slotId !== slot.id) continue;
      const key = `${slot.section}\t${alias.normLabel}`;
      if (alias.role === "ignore") {
        ignored.add(key);
        continue;
      }
      if (alias.role === "read" || alias.role === "item_pattern") aliasOf.set(key, slot);
    }
  }
  const suffix = itemSuffixOrNull(input.book, input.platform);
  const resolved = new Map<string, DetectedRow>();
  const unknownBySection = new Map<string, DetectedRow[]>();
  let unknown = 0;
  for (const row of input.rows) {
    if (!row.metric.trim()) continue;
    if (suffix && row.metric.endsWith(suffix)) continue;
    const key = `${row.section}\t${normaliseLabel(row.metric)}`;
    if (ignored.has(key)) continue;
    const slot = aliasOf.get(key);
    if (slot) {
      resolved.set(slot.id, row);
      continue;
    }
    unknown += 1;
    const list = unknownBySection.get(row.section) ?? [];
    list.push(row);
    unknownBySection.set(row.section, list);
  }

  const absentSlots = slots.filter((slot) => !resolved.has(slot.id));
  const sectionsAffected = new Set(absentSlots.map((slot) => slot.section)).size;
  // A short file of known labels is a partial extract, not a report that lost its layout.
  // A full report that is missing more than a quarter still has most of its labels.
  const present = slots.length - absentSlots.length;
  const partialExtract = unknown === 0 && slots.length > 0 && present / slots.length <= 0.25;
  const layoutReason = partialExtract
    ? null
    : businessLayoutReason({
        required: slots.length,
        absent: absentSlots.length,
        sectionsAffected,
        unknown,
      });
  const findings: LabelChangeFinding[] = [];
  const pending: BusinessLabelDetection["pending"] = [];
  const bySection = new Map<string, LabelSlot[]>();
  for (const slot of slots) {
    const list = bySection.get(slot.section) ?? [];
    list.push(slot);
    bySection.set(slot.section, list);
  }

  for (const slot of slots) {
    const old = primaryAlias(input.book, slot);
    const row = resolved.get(slot.id);
    const unknowns = unknownBySection.get(slot.section) ?? [];
    const blankPeriods = row
      ? row.cells.flatMap((cell, index) => (cell.value == null ? [index] : []))
      : [...Array(input.periods).keys()];
    if (!row && !partialExtract) {
      for (const periodIndex of blankPeriods) {
        pending.push({ section: slot.section, label: old, periodIndex, slotId: slot.id });
      }
    }
    if (unknowns.length === 0 || (row && blankPeriods.length === 0)) continue;
    const sectionSlots = bySection.get(slot.section) ?? [];
    const absentInSection = sectionSlots.filter((item) => !resolved.has(item.id)).length;
    for (const candidate of unknowns) {
      const valued = candidate.cells.flatMap((cell, index) =>
        cell.value == null ? [] : [{ index, value: cell.value, kind: cell.kind }],
      );
      const pendingPeriods = row
        ? valued
            .filter((item) => blankPeriods.includes(item.index))
            .filter((item) => !samePeriodValued(row, item.index))
            .map((item) => item.index)
        : blankPeriods;
      if (row && pendingPeriods.length === 0) continue;
      for (const periodIndex of pendingPeriods) {
        if (!pending.some((item) => item.slotId === slot.id && item.periodIndex === periodIndex)) {
          pending.push({ section: slot.section, label: old, periodIndex, slotId: slot.id });
        }
      }
      const numbers = valued.map((item) => item.value);
      const summary = summarise(numbers);
      const similarity = compareNames(old, candidate.metric);
      const neighbours = neighbourLabels(input.rows, candidate.rowIndex);
      const samePlace = neighboursMatch(sectionSlots, slot, input.rows, candidate.rowIndex);
      const kindMatch = kindMatches(
        slot,
        valued.map((item) => item.kind),
        numbers,
      );
      const unitMatch = kindMatch;
      const relation = relationPasses(slot, slots, resolved, candidate, input.periods);
      const contradiction = row
        ? valued.some((item) => row.cells[item.index]?.value != null)
        : false;
      const aliasCollision = isLiveAlias(input.book, input.platform, "business", candidate.metric);
      findings.push({
        kind: "metric_label_change",
        platform: input.platform,
        family: "business",
        reportKind: input.reportKind,
        section: slot.section,
        slotId: slot.id,
        oldLabel: old,
        candidateLabel: candidate.metric,
        candidateNorm: normaliseLabel(candidate.metric),
        summable: slot.summable,
        allowAutoApply: slot.allowAutoApply,
        rowIndex: candidate.rowIndex,
        pendingPeriods,
        evidence: {
          similarity,
          position: {
            rowIndex: candidate.rowIndex,
            neighboursBefore: neighbours.before,
            neighboursAfter: neighbours.after,
            sameNeighbours: samePlace,
          },
          unitMatch,
          kindMatch,
          valueEvidence: {
            method: relation.method,
            count: summary.count,
            min: summary.min,
            max: summary.max,
            median: summary.median,
          },
          contradictions: contradiction ? ["same-period"] : [],
        },
        ruleInput: {
          absentInSection: Math.max(absentInSection, row ? 1 : absentInSection),
          unknownInSection: unknowns.length,
          samePlace,
          unitMatch,
          kindMatch,
          nameSimilar: similarity.similar,
          aliasCollision,
          otherFinding: false,
          relationPass: relation.pass,
          continuityPass: false,
          summable: slot.summable,
          outlets: 1,
          files: 1,
          nights: 1,
          contradiction,
          allowAutoApply: slot.allowAutoApply,
          switchOn: input.switchOn ?? false,
        },
      });
    }
  }

  if (layoutReason) {
    findings.length = 0;
    pending.length = 0;
    findings.push({
      kind: "layout_change",
      platform: input.platform,
      family: "business",
      reportKind: input.reportKind,
      section: "",
      slotId: "",
      oldLabel: "",
      candidateLabel: null,
      candidateNorm: null,
      summable: false,
      allowAutoApply: false,
      rowIndex: null,
      pendingPeriods: [],
      evidence: emptyEvidence(),
      ruleInput: blockedInput(),
    });
  }

  return {
    layoutReason,
    unknown,
    absent: absentSlots.length,
    sectionsAffected,
    findings: dedupeDrafts(findings),
    pending,
  };
}

/** One open finding per slot and candidate. Layout findings collapse to one. */
function dedupeDrafts(findings: LabelChangeFinding[]): LabelChangeFinding[] {
  const seen = new Set<string>();
  const kept: LabelChangeFinding[] = [];
  for (const finding of findings) {
    const key =
      finding.kind === "layout_change"
        ? "layout"
        : `${finding.slotId}\t${finding.candidateNorm ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(finding);
  }
  return kept;
}

export function layoutChangeFinding(
  platform: "swiggy" | "zomato",
  family: "business" | "payout",
  reportKind: string,
): LabelChangeFinding {
  return {
    kind: "layout_change",
    platform,
    family,
    reportKind,
    section: "",
    slotId: "",
    oldLabel: "",
    candidateLabel: null,
    candidateNorm: null,
    summable: false,
    allowAutoApply: false,
    rowIndex: null,
    pendingPeriods: [],
    evidence: family === "payout" ? payoutEvidence() : emptyEvidence(),
    ruleInput: blockedInput(),
  };
}

function blockedInput(): AutoApplyInput {
  return {
    absentInSection: 0,
    unknownInSection: 0,
    samePlace: false,
    unitMatch: false,
    kindMatch: false,
    nameSimilar: false,
    aliasCollision: false,
    otherFinding: false,
    relationPass: false,
    continuityPass: false,
    summable: false,
    outlets: 0,
    files: 0,
    nights: 0,
    contradiction: false,
    allowAutoApply: false,
    switchOn: false,
  };
}

function primaryAlias(book: LabelBook, slot: LabelSlot): string {
  return (
    book.aliases.find((alias) => alias.slotId === slot.id && alias.role === "read")?.label ??
    slot.slotKey
  );
}

function itemSuffixOrNull(book: LabelBook, platform: "swiggy" | "zomato"): string | null {
  if (platform !== "swiggy") return null;
  try {
    return itemSuffix(book, "swiggy.business.MENU.item_revenue_pct");
  } catch {
    return null;
  }
}

function samePeriodValued(row: DetectedRow, index: number): boolean {
  return row.cells[index]?.value != null;
}

function summarise(values: number[]): {
  count: number;
  min: number | null;
  max: number | null;
  median: number | null;
} {
  if (values.length === 0) return { count: 0, min: null, max: null, median: null };
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return {
    count: values.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median,
  };
}

function compareNames(
  oldLabel: string,
  candidate: string,
): {
  jaccard: number;
  editRatio: number;
  similar: boolean;
} {
  const left = normaliseLabel(oldLabel);
  const right = normaliseLabel(candidate);
  const leftTokens = left.split(" ").filter(Boolean);
  const rightTokens = right.split(" ").filter(Boolean);
  const jaccard = tokenJaccard(leftTokens, rightTokens);
  const editRatio = 1 - levenshtein(left, right) / Math.max(left.length, right.length, 1);
  const contained =
    containsTokens(leftTokens, rightTokens) || containsTokens(rightTokens, leftTokens);
  return { jaccard, editRatio, similar: jaccard >= 0.5 || editRatio >= 0.8 || contained };
}

function tokenJaccard(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of new Set(left)) if (rightSet.has(token)) shared += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

function containsTokens(outer: string[], inner: string[]): boolean {
  if (inner.length === 0 || inner.length > outer.length) return false;
  const bag = new Set(outer);
  return inner.every((token) => bag.has(token));
}

function levenshtein(left: string, right: string): number {
  const row = [...Array(right.length + 1).keys()];
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, previous + cost);
      previous = current;
    }
  }
  return row[right.length] ?? 0;
}

function neighbourLabels(
  rows: DetectedRow[],
  rowIndex: number,
): { before: string | null; after: string | null } {
  const index = rows.findIndex((row) => row.rowIndex === rowIndex);
  return {
    before: index > 0 ? (rows[index - 1]?.metric ?? null) : null,
    after: rows[index + 1]?.metric ?? null,
  };
}

function neighboursMatch(
  sectionSlots: LabelSlot[],
  slot: LabelSlot,
  rows: DetectedRow[],
  rowIndex: number,
): boolean {
  const expected = sectionSlots.findIndex((item) => item.id === slot.id);
  const sectionRows = rows.filter((row) => row.section === slot.section && row.metric.trim());
  const actual = sectionRows.findIndex((row) => row.rowIndex === rowIndex);
  return expected >= 0 && actual >= 0 && Math.abs(expected - actual) <= 1;
}

function kindMatches(slot: LabelSlot, kinds: string[], values: number[]): boolean {
  if (values.length === 0) return false;
  if (slot.valueType === "count") return values.every((value) => Number.isInteger(value));
  if (slot.valueType === "pct" || slot.valueType === "ratio") {
    return kinds.every((kind) => kind === "pct" || kind === "number");
  }
  if (slot.valueType === "money")
    return kinds.every((kind) => kind === "money" || kind === "number");
  if (slot.valueType === "minutes" || slot.valueType === "hours") {
    return kinds.every((kind) => kind === "minutes" || kind === "number");
  }
  return values.every((value) => Number.isFinite(value));
}

function relationPasses(
  slot: LabelSlot,
  slots: LabelSlot[],
  resolved: Map<string, DetectedRow>,
  candidate: DetectedRow,
  periods: number,
): { pass: boolean; method: "relation" | "continuity" | "none" } {
  const byKey = new Map(slots.map((item) => [`${item.section}\t${item.slotKey}`, item]));
  const readNumber = (slotKey: string, index: number): number | null => {
    const found = byKey.get(`${slot.section}\t${slotKey}`);
    if (!found) return null;
    return resolved.get(found.id)?.cells[index]?.value ?? null;
  };
  let checked = 0;
  let passed = 0;
  for (let index = 0; index < periods; index += 1) {
    const value = candidate.cells[index]?.value;
    if (value == null) continue;
    if (slot.slotKey === "cart_builds") {
      const opens = readNumber("menu_opens", index);
      const pct = readNumber("menu_to_cart", index);
      if (opens == null || pct == null) continue;
      checked += 1;
      if (Math.abs(value - (opens * pct) / 100) <= 1) passed += 1;
    } else if (slot.slotKey === "menu_to_cart") {
      const opens = readNumber("menu_opens", index);
      const carts = readNumber("cart_builds", index);
      if (opens == null || carts == null || opens === 0) continue;
      checked += 1;
      if (Math.abs(value - (carts / opens) * 100) <= 1) passed += 1;
    }
  }
  if (checked === 0) return { pass: false, method: "none" };
  return { pass: passed > 0, method: "relation" };
}

function isLiveAlias(
  book: LabelBook,
  platform: "swiggy" | "zomato",
  reportKind: string,
  label: string,
): boolean {
  const norm = normaliseLabel(label);
  return book.aliases.some(
    (alias) =>
      alias.platform === platform &&
      alias.reportKind === reportKind &&
      alias.role === "read" &&
      alias.normLabel === norm,
  );
}

/** Headers the payout parser already resolved, plus the ones it could not. */
export function assessPayoutColumns(input: {
  anchorMissing: boolean;
  required: number;
  absent: number;
  formulaMissing: boolean;
}): { layoutReason: string | null; skipOrderNet: boolean } {
  return {
    layoutReason: payoutLayoutReason(input),
    skipOrderNet: input.formulaMissing && payoutLayoutReason(input) == null,
  };
}

export function payoutEvidence(): LabelChangeEvidence {
  return {
    ...emptyEvidence(),
    valueEvidence: { method: "none", count: 0, min: null, max: null, median: null },
  };
}

/** An expected payout column is missing while the header has a label the book does not know. */
export function detectPayoutLabels(input: {
  platform: "swiggy" | "zomato";
  reportKind: string;
  section: string;
  book: LabelBook;
  headers: string[];
  columns: Array<{ slotId: string; index: number | null }>;
}): {
  layoutReason: string | null;
  findings: LabelChangeFinding[];
  unknown: number;
  absent: number;
} {
  const unknowns = input.headers.flatMap((header, index) => {
    const label = header.trim();
    if (
      !label ||
      headerIsKnown(label, input.book, input.platform, input.reportKind, input.section)
    ) {
      return [];
    }
    return [{ label, index }];
  });
  const absent = input.columns.filter((column) => column.index == null);
  const anchorMissing = absent.some((column) =>
    /(?:^|\.)(order_id|order_status|order_date)$/.test(column.slotId),
  );
  const wideHeader = input.headers.filter((header) => header.trim()).length >= input.columns.length;
  const layoutReason = payoutLayoutReason({
    anchorMissing,
    required: wideHeader ? input.columns.length : 0,
    absent: wideHeader ? absent.length : 0,
  });
  if (layoutReason || unknowns.length === 0 || absent.length === 0) {
    return {
      layoutReason,
      unknown: unknowns.length,
      absent: absent.length,
      findings: layoutReason
        ? [
            {
              kind: "layout_change",
              platform: input.platform,
              family: "payout",
              reportKind: input.reportKind,
              section: input.section,
              slotId: "",
              oldLabel: "",
              candidateLabel: null,
              candidateNorm: null,
              summable: false,
              allowAutoApply: false,
              rowIndex: null,
              pendingPeriods: [],
              evidence: payoutEvidence(),
              ruleInput: blockedInput(),
            },
          ]
        : [],
    };
  }
  const findings: LabelChangeFinding[] = [];
  for (const column of absent) {
    const slot = input.book.slots.find((item) => item.id === column.slotId);
    if (!slot) continue;
    const old = primaryAlias(input.book, slot);
    for (const candidate of unknowns) {
      const similarity = compareNames(old, candidate.label);
      const placed = [
        ...input.columns.flatMap((item) =>
          item.index == null ? [] : [{ slotId: item.slotId, index: item.index }],
        ),
        { slotId: column.slotId, index: candidate.index },
      ].sort((left, right) => left.index - right.index);
      const actual = placed.findIndex((item) => item.slotId === column.slotId);
      const expected = input.columns.findIndex((item) => item.slotId === column.slotId);
      const samePlace = expected >= 0 && actual >= 0 && Math.abs(expected - actual) <= 1;
      const oneToOne = absent.length === 1 && unknowns.length === 1;
      if (!similarity.similar && !(samePlace && oneToOne)) continue;
      const aliasCollision = isLiveAlias(
        input.book,
        input.platform,
        input.reportKind,
        candidate.label,
      );
      findings.push({
        kind: "metric_label_change",
        platform: input.platform,
        family: "payout",
        reportKind: input.reportKind,
        section: input.section,
        slotId: slot.id,
        oldLabel: old,
        candidateLabel: candidate.label,
        candidateNorm: normaliseLabel(candidate.label),
        summable: slot.summable,
        allowAutoApply: slot.allowAutoApply,
        rowIndex: candidate.index,
        pendingPeriods: [],
        evidence: {
          ...payoutEvidence(),
          similarity,
          position: {
            rowIndex: candidate.index,
            neighboursBefore: input.headers[candidate.index - 1]?.trim() || null,
            neighboursAfter: input.headers[candidate.index + 1]?.trim() || null,
            sameNeighbours: samePlace,
          },
        },
        ruleInput: {
          absentInSection: absent.length,
          unknownInSection: unknowns.length,
          samePlace,
          unitMatch: false,
          kindMatch: false,
          nameSimilar: similarity.similar,
          aliasCollision,
          otherFinding: false,
          relationPass: false,
          continuityPass: false,
          summable: slot.summable,
          outlets: 1,
          files: 1,
          nights: 1,
          contradiction: false,
          allowAutoApply: slot.allowAutoApply,
          switchOn: false,
        },
      });
    }
  }
  return {
    layoutReason: null,
    unknown: unknowns.length,
    absent: absent.length,
    findings: dedupeDrafts(findings),
  };
}

export function headerIsKnown(
  header: string,
  book: LabelBook,
  platform: string,
  reportKind: string,
  section?: string,
): boolean {
  const folded = looseNorm(header);
  if (!folded) return true;
  return book.aliases.some((alias) => {
    if (alias.platform !== platform || alias.reportKind !== reportKind) return false;
    if (alias.role !== "read" && alias.role !== "ignore") return false;
    if (section && book.slots.find((slot) => slot.id === alias.slotId)?.section !== section)
      return false;
    if (alias.excludeTokens.some((token) => folded.includes(token))) return false;
    if (alias.matchMode === "exact" || alias.matchMode === "prefix") {
      const needle = alias.includeTokens[0] ?? looseNorm(alias.label);
      return alias.matchMode === "exact"
        ? folded === needle
        : folded === needle || folded.startsWith(`${needle} `) || folded.startsWith(needle);
    }
    return alias.includeTokens.every((token) => folded.includes(token));
  });
}
