/**
 * One shared way to compare a printed metric or column name.
 * Parsers and the label registry both use it.
 */
export function normaliseLabel(input: string): string {
  let text = input.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  text = text.replace(/₹/g, " inr ");
  text = text.replace(/\(\s*rs\.?\s*\)/g, " inr ");
  text = text.replace(/\brs\.?(?!\w)/g, " inr ");
  text = text.replace(/\binr\b/g, " inr ");
  text = text.replace(/\(\s*%\s*\)/g, " pct ");
  text = text.replace(/%/g, " pct ");
  text = text.replace(/\bpercentage\b/g, " pct ");
  text = text.replace(/\bpercent\b/g, " pct ");
  text = text.replace(/\bpct\b/g, " pct ");
  text = text.replace(/&/g, " and ");
  text = text.replace(/</g, " lt ");
  text = text.replace(/>/g, " gt ");
  text = text.replace(/\bminutes\b/g, " min ");
  text = text.replace(/\bmins\b/g, " min ");
  text = text.replace(/\bmin\b/g, " min ");
  text = text.replace(/[()[\]{}"'“”‘’.,\-/]/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

/** The payout parser's own header fold: lower case, one space. Not the label normaliser. */
export function looseNorm(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export type LabelPlatform = "swiggy" | "zomato";
export type LabelReportKind = "business" | "payout" | "payout_annexure";
export type LabelMatchMode = "exact" | "tokens" | "prefix";
export type LabelRole = "read" | "item_pattern" | "ignore";
export type LabelSource = "seed" | "admin";

export interface LabelSlot {
  id: string;
  platform: LabelPlatform;
  reportKind: LabelReportKind;
  slotKey: string;
  section: string;
  valueType: string;
  summable: boolean;
  allowAutoApply: boolean;
  /** "all" keeps every matching column. "first" keeps the first match. */
  collect: "first" | "all";
  /** Set when an admin retires the metric. */
  retiredFrom?: string | null;
}

export interface LabelAlias {
  id: string;
  slotId: string;
  platform: LabelPlatform;
  reportKind: LabelReportKind;
  label: string;
  normLabel: string;
  matchMode: LabelMatchMode;
  includeTokens: string[];
  excludeTokens: string[];
  group: number;
  role: LabelRole;
  source: LabelSource;
  createdBy: string | null;
}

export interface LabelBook {
  slots: readonly LabelSlot[];
  aliases: readonly LabelAlias[];
}

export function slotById(book: LabelBook, slotId: string): LabelSlot {
  const slot = book.slots.find((item) => item.id === slotId);
  if (!slot) throw new Error(`Unknown metric label slot ${slotId}`);
  return slot;
}

/** Suffix after `{item}` for a dynamic row, such as ` Revenue %`. */
export function itemSuffix(book: LabelBook, slotId: string): string {
  const alias = book.aliases.find((item) => item.slotId === slotId && item.role === "item_pattern");
  if (!alias) throw new Error(`Metric label slot ${slotId} has no item pattern`);
  const marker = "{item}";
  const at = alias.label.indexOf(marker);
  if (at < 0) throw new Error(`Item pattern ${slotId} has no {item} marker`);
  return alias.label.slice(at + marker.length);
}

function ruleMatches(label: string, alias: LabelAlias): boolean {
  if (alias.excludeTokens.some((token) => label.includes(token))) return false;
  if (alias.matchMode === "exact") {
    const needle = alias.includeTokens[0] ?? looseNorm(alias.label);
    return label === needle;
  }
  if (alias.matchMode === "prefix") {
    const needle = alias.includeTokens[0] ?? looseNorm(alias.label);
    return label === needle || label.startsWith(`${needle} `) || label.startsWith(needle);
  }
  return alias.includeTokens.every((token) => label.includes(token));
}

/**
 * Column indexes whose header matches the slot's aliases.
 * Token and exact checks use the payout header fold, so a seed copied from
 * today's predicates picks the same column.
 */
export function resolveColumns(header: string[], book: LabelBook, slotId: string): number[] {
  const slot = slotById(book, slotId);
  const aliases = book.aliases
    .filter((item) => item.slotId === slotId && item.role === "read")
    .slice()
    .sort((left, right) => left.group - right.group || left.id.localeCompare(right.id));
  if (aliases.length === 0) throw new Error(`Metric label slot ${slotId} has no read alias`);
  const groups = [...new Set(aliases.map((item) => item.group))].sort(
    (left, right) => left - right,
  );
  const found: number[] = [];
  for (const group of groups) {
    const rules = aliases.filter((item) => item.group === group);
    for (let index = 0; index < header.length; index += 1) {
      const label = looseNorm(header[index] ?? "");
      if (!label) continue;
      if (!rules.some((rule) => ruleMatches(label, rule))) continue;
      found.push(index);
      if (slot.collect === "first") return found;
    }
    if (slot.collect === "first" && found.length > 0) return found;
  }
  return found;
}

export function resolveColumn(header: string[], book: LabelBook, slotId: string): number | null {
  return resolveColumns(header, book, slotId)[0] ?? null;
}

export interface LabelCollision {
  platform: LabelPlatform;
  reportKind: LabelReportKind;
  normLabel: string;
  slotIds: string[];
}

/** Two live labels in one platform and report that fold together but mean different slots. */
export function labelCollisions(aliases: readonly LabelAlias[]): LabelCollision[] {
  const groups = new Map<string, Set<string>>();
  for (const alias of aliases) {
    if (alias.role !== "read" && alias.role !== "item_pattern") continue;
    const key = `${alias.platform}\t${alias.reportKind}\t${alias.normLabel}`;
    const slots = groups.get(key) ?? new Set<string>();
    slots.add(alias.slotId);
    groups.set(key, slots);
  }
  const found: LabelCollision[] = [];
  for (const [key, slots] of groups) {
    if (slots.size < 2) continue;
    const [platform, reportKind, normLabel] = key.split("\t");
    found.push({
      platform: platform as LabelPlatform,
      reportKind: reportKind as LabelReportKind,
      normLabel: normLabel ?? "",
      slotIds: [...slots].sort(),
    });
  }
  return found;
}
