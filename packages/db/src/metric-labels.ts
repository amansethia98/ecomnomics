import type { LabelAlias, LabelBook, LabelSlot } from "@rakazo/contracts";
import { METRIC_LABEL_ALIASES, METRIC_LABEL_SLOTS, seedLabelBook } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

let cached: { version: number; book: LabelBook } | null = null;

/**
 * Insert the built-in labels. Safe to run again: existing rows, including an
 * alias an admin added, are left as they are.
 */
export async function seedMetricLabels(db: PrismaClient): Promise<void> {
  await runAsSystem("seed metric labels", async () => {
    await db.metricLabelSlot.createMany({
      data: METRIC_LABEL_SLOTS.map(slotRow),
      skipDuplicates: true,
    });
    await db.metricLabelAlias.createMany({
      data: METRIC_LABEL_ALIASES.map(aliasRow),
      skipDuplicates: true,
    });
    const registry = await db.metricLabelRegistry.findUnique({ where: { id: "global" } });
    if (!registry) {
      await db.metricLabelRegistry.create({ data: { id: "global", version: 1 } });
    }
  });
}

/**
 * The alias list the parsers use. A failed or empty read returns the built-in
 * list and is not cached, so the next read can pick up a seed that landed later.
 */
export async function loadLabelBook(db: PrismaClient): Promise<LabelBook> {
  try {
    const registry = await db.metricLabelRegistry.findUnique({ where: { id: "global" } });
    if (!registry) return seedLabelBook();
    if (cached?.version === registry.version) return cached.book;
    const [slots, aliases] = await Promise.all([
      db.metricLabelSlot.findMany(),
      db.metricLabelAlias.findMany(),
    ]);
    if (slots.length === 0 || aliases.length === 0) return seedLabelBook();
    const book: LabelBook = {
      slots: slots.map(asSlot),
      aliases: aliases.map(asAlias),
    };
    cached = { version: registry.version, book };
    return book;
  } catch {
    return seedLabelBook();
  }
}

function slotRow(slot: LabelSlot) {
  return {
    id: slot.id,
    platform: slot.platform,
    reportKind: slot.reportKind,
    slotKey: slot.slotKey,
    section: slot.section,
    valueType: slot.valueType,
    summable: slot.summable,
    allowAutoApply: slot.allowAutoApply,
    collect: slot.collect,
  };
}

function aliasRow(alias: LabelAlias) {
  return {
    id: alias.id,
    slotId: alias.slotId,
    platform: alias.platform,
    reportKind: alias.reportKind,
    label: alias.label,
    normLabel: alias.normLabel,
    matchMode: alias.matchMode,
    includeTokens: [...alias.includeTokens],
    excludeTokens: [...alias.excludeTokens],
    group: alias.group,
    role: alias.role,
    source: alias.source,
    createdBy: alias.createdBy,
  };
}

function asSlot(slot: {
  id: string;
  platform: string;
  reportKind: string;
  slotKey: string;
  section: string;
  valueType: string;
  summable: boolean;
  allowAutoApply: boolean;
  collect: string;
}): LabelSlot {
  return {
    id: slot.id,
    platform: slot.platform as LabelSlot["platform"],
    reportKind: slot.reportKind as LabelSlot["reportKind"],
    slotKey: slot.slotKey,
    section: slot.section,
    valueType: slot.valueType,
    summable: slot.summable,
    allowAutoApply: slot.allowAutoApply,
    collect: slot.collect === "all" ? "all" : "first",
  };
}

function asAlias(alias: {
  id: string;
  slotId: string;
  platform: string;
  reportKind: string;
  label: string;
  normLabel: string;
  matchMode: string;
  includeTokens: string[];
  excludeTokens: string[];
  group: number;
  role: string;
  source: string;
  createdBy: string | null;
}): LabelAlias {
  return {
    id: alias.id,
    slotId: alias.slotId,
    platform: alias.platform as LabelAlias["platform"],
    reportKind: alias.reportKind as LabelAlias["reportKind"],
    label: alias.label,
    normLabel: alias.normLabel,
    matchMode: alias.matchMode as LabelAlias["matchMode"],
    includeTokens: alias.includeTokens,
    excludeTokens: alias.excludeTokens,
    group: alias.group,
    role: alias.role as LabelAlias["role"],
    source: alias.source as LabelAlias["source"],
    createdBy: alias.createdBy,
  };
}
