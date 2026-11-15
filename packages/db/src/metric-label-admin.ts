import { randomUUID } from "node:crypto";
import { looseNorm, normaliseLabel } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";

export const LABEL_REJECT_MODES = ["ignore_label", "not_rename", "metric_removed"] as const;
export type LabelRejectMode = (typeof LABEL_REJECT_MODES)[number];

const OPEN = "open";

export interface LabelFindingListItem {
  findingId: string;
  kind: string;
  platform: string;
  family: string;
  reportKind: string;
  section: string;
  slotId: string | null;
  oldLabel: string;
  candidateLabel: string | null;
  evidence: Prisma.JsonValue;
  confidence: string;
  status: string;
  outletsAffected: number;
  daysAffected: number;
  occurrences: number;
  wouldApply: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface LabelFindingDetail extends LabelFindingListItem {
  observations: Array<{
    outletId: string;
    outletName: string;
    periods: string;
    createdAt: string;
  }>;
}

export type LabelAdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "not_found" | "not_open" | "collision" | "no_candidate" | "wrong_kind" };

export interface ApprovedLabel {
  findingId: string;
  aliasId: string;
  slotId: string;
  registryVersion: number;
}

export interface LabelSummary {
  open: number;
  layout: number;
  wouldApply: number;
  findings: Array<{
    findingId: string;
    kind: string;
    platform: string;
    slotId: string | null;
    status: string;
    outletsAffected: number;
    wouldApply: boolean;
  }>;
}

type FindingRow = {
  id: string;
  kind: string;
  platform: string;
  family: string;
  reportKind: string;
  section: string;
  slotId: string | null;
  oldLabel: string;
  candidateLabel: string | null;
  candidateNorm: string | null;
  evidence: Prisma.JsonValue;
  confidence: string;
  status: string;
  outletsAffected: number;
  daysAffected: number;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

function present(row: FindingRow): LabelFindingListItem {
  return {
    findingId: row.id,
    kind: row.kind,
    platform: row.platform,
    family: row.family,
    reportKind: row.reportKind,
    section: row.section,
    slotId: row.slotId,
    oldLabel: row.oldLabel,
    candidateLabel: row.candidateLabel,
    evidence: row.evidence,
    confidence: row.confidence,
    status: row.status,
    outletsAffected: row.outletsAffected,
    daysAffected: row.daysAffected,
    occurrences: row.occurrences,
    wouldApply: wouldApplyOf(row.evidence),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function wouldApplyOf(evidence: Prisma.JsonValue): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  return evidence.wouldApply === true;
}

async function registryVersion(db: Prisma.TransactionClient | PrismaClient): Promise<number> {
  const row = await db.metricLabelRegistry.findUnique({ where: { id: "global" } });
  return row?.version ?? 1;
}

async function bumpRegistry(db: Prisma.TransactionClient | PrismaClient): Promise<number> {
  const next = (await registryVersion(db)) + 1;
  await db.metricLabelRegistry.upsert({
    where: { id: "global" },
    create: { id: "global", version: next },
    update: { version: next },
  });
  return next;
}

async function writeEvent(
  db: Prisma.TransactionClient | PrismaClient,
  event: {
    actor: string;
    action: string;
    findingId?: string | null;
    aliasId?: string | null;
    slotId?: string | null;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    registryVersion: number;
  },
): Promise<void> {
  await db.metricLabelEvent.create({
    data: {
      actor: event.actor,
      action: event.action,
      findingId: event.findingId ?? null,
      aliasId: event.aliasId ?? null,
      slotId: event.slotId ?? null,
      before: event.before,
      after: event.after,
      registryVersion: event.registryVersion,
    },
  });
}

/** A live read alias for this label on a different slot. */
async function collidingSlot(
  db: Prisma.TransactionClient | PrismaClient,
  slot: { id: string; platform: string; reportKind: string },
  norm: string,
): Promise<boolean> {
  const hit = await db.metricLabelAlias.findFirst({
    where: {
      platform: slot.platform,
      reportKind: slot.reportKind,
      normLabel: norm,
      role: "read",
      retiredAt: null,
      NOT: { slotId: slot.id },
    },
    select: { id: true },
  });
  return hit != null;
}

async function addReadAlias(
  db: Prisma.TransactionClient | PrismaClient,
  slot: { id: string; platform: string; reportKind: string },
  label: string,
  actor: string,
  role: "read" | "ignore",
): Promise<{ id: string; created: boolean }> {
  const norm = normaliseLabel(label);
  const existing = await db.metricLabelAlias.findFirst({
    where: { slotId: slot.id, normLabel: norm, role, retiredAt: null },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  const created = await db.metricLabelAlias.create({
    data: {
      id: randomUUID(),
      slotId: slot.id,
      platform: slot.platform,
      reportKind: slot.reportKind,
      label,
      normLabel: norm,
      matchMode: "exact",
      includeTokens: [looseNorm(label)],
      excludeTokens: [],
      group: 1,
      role,
      source: "admin",
      createdBy: actor,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

export async function listLabelFindings(
  db: PrismaClient,
  query: { status?: string; platform?: string; kind?: string },
): Promise<{ findings: LabelFindingListItem[] }> {
  const rows = await db.metricLabelFinding.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    },
    orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    take: 200,
  });
  return { findings: rows.map(present) };
}

export async function readLabelFinding(
  db: PrismaClient,
  findingId: string,
): Promise<LabelFindingDetail | null> {
  const row = await db.metricLabelFinding.findUnique({ where: { id: findingId } });
  if (!row) return null;
  const observations = await db.metricLabelObservation.findMany({
    where: { findingId },
    orderBy: { createdAt: "asc" },
    select: { outletId: true, periods: true, createdAt: true, spaceId: true },
  });
  const outlets = await db.outlet.findMany({
    where: { id: { in: observations.map((item) => item.outletId) } },
    select: { id: true, name: true },
  });
  const names = new Map(outlets.map((outlet) => [outlet.id, outlet.name]));
  return {
    ...present(row),
    observations: observations.map((item) => ({
      outletId: item.outletId,
      outletName: names.get(item.outletId) ?? item.outletId,
      periods: item.periods,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}

export async function approveLabelFinding(
  db: PrismaClient,
  findingId: string,
  actor: string,
): Promise<LabelAdminResult<ApprovedLabel>> {
  const finding = await db.metricLabelFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "not_found" };
  if (finding.status === "approved" && finding.aliasId && finding.slotId) {
    return {
      ok: true,
      value: {
        findingId,
        aliasId: finding.aliasId,
        slotId: finding.slotId,
        registryVersion: await registryVersion(db),
      },
    };
  }
  if (finding.status !== OPEN) return { ok: false, error: "not_open" };
  if (!finding.slotId || !finding.candidateLabel) return { ok: false, error: "no_candidate" };
  const slot = await db.metricLabelSlot.findUnique({ where: { id: finding.slotId } });
  if (!slot) return { ok: false, error: "not_found" };
  const norm = normaliseLabel(finding.candidateLabel);
  if (await collidingSlot(db, slot, norm)) return { ok: false, error: "collision" };
  const alias = await addReadAlias(db, slot, finding.candidateLabel, actor, "read");
  const version = await bumpRegistry(db);
  await db.metricLabelFinding.update({
    where: { id: findingId },
    data: {
      status: "approved",
      resolvedAt: new Date(),
      resolvedBy: actor,
      aliasId: alias.id,
    },
  });
  await writeEvent(db, {
    actor,
    action: "finding_approved",
    findingId,
    aliasId: alias.id,
    slotId: slot.id,
    before: { status: OPEN },
    after: { status: "approved", label: finding.candidateLabel },
    registryVersion: version,
  });
  if (alias.created) {
    await writeEvent(db, {
      actor,
      action: "alias_added",
      findingId,
      aliasId: alias.id,
      slotId: slot.id,
      after: { label: finding.candidateLabel, role: "read" },
      registryVersion: version,
    });
  }
  return {
    ok: true,
    value: { findingId, aliasId: alias.id, slotId: slot.id, registryVersion: version },
  };
}

export async function rejectLabelFinding(
  db: PrismaClient,
  findingId: string,
  actor: string,
  mode: LabelRejectMode,
): Promise<LabelAdminResult<{ findingId: string; status: string; registryVersion: number }>> {
  const finding = await db.metricLabelFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "not_found" };
  if (finding.status !== OPEN) return { ok: false, error: "not_open" };
  if (mode === "not_rename") {
    await db.metricLabelFinding.update({
      where: { id: findingId },
      data: { status: "rejected_not_rename", resolvedAt: new Date(), resolvedBy: actor },
    });
    const version = await registryVersion(db);
    await writeEvent(db, {
      actor,
      action: "finding_rejected",
      findingId,
      slotId: finding.slotId,
      before: { status: OPEN },
      after: { status: "rejected_not_rename", mode },
      registryVersion: version,
    });
    return {
      ok: true,
      value: { findingId, status: "rejected_not_rename", registryVersion: version },
    };
  }
  if (mode === "ignore_label") {
    if (!finding.slotId || !finding.candidateLabel) return { ok: false, error: "no_candidate" };
    const slot = await db.metricLabelSlot.findUnique({ where: { id: finding.slotId } });
    if (!slot) return { ok: false, error: "not_found" };
    const alias = await addReadAlias(db, slot, finding.candidateLabel, actor, "ignore");
    const version = await bumpRegistry(db);
    await db.metricLabelFinding.update({
      where: { id: findingId },
      data: { status: "rejected_ignored", resolvedAt: new Date(), resolvedBy: actor },
    });
    await openAbsentFinding(db, finding);
    await writeEvent(db, {
      actor,
      action: "finding_rejected",
      findingId,
      aliasId: alias.id,
      slotId: slot.id,
      before: { status: OPEN },
      after: { status: "rejected_ignored", mode },
      registryVersion: version,
    });
    return { ok: true, value: { findingId, status: "rejected_ignored", registryVersion: version } };
  }
  const version = await registryVersion(db);
  await db.metricLabelFinding.update({
    where: { id: findingId },
    data: { status: "metric_removed", resolvedAt: new Date(), resolvedBy: actor },
  });
  if (finding.slotId) {
    const first = await db.metricLabelObservation.findFirst({
      where: { findingId },
      orderBy: { createdAt: "asc" },
      select: { periods: true },
    });
    const start = first?.periods.split(",")[0];
    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
      await db.metricLabelSlot.update({
        where: { id: finding.slotId },
        data: { retiredFrom: new Date(`${start}T00:00:00.000Z`) },
      });
    }
    await db.metricValue.updateMany({
      where: { source: `pending_label:${findingId}`, state: "pending_label", supersededAt: null },
      data: { state: "label_unrecoverable" },
    });
  }
  await writeEvent(db, {
    actor,
    action: "slot_retired",
    findingId,
    slotId: finding.slotId,
    before: { status: OPEN },
    after: { status: "metric_removed", mode },
    registryVersion: version,
  });
  return { ok: true, value: { findingId, status: "metric_removed", registryVersion: version } };
}

async function openAbsentFinding(
  db: PrismaClient,
  finding: {
    platform: string;
    family: string;
    reportKind: string;
    section: string;
    slotId: string | null;
    oldLabel: string;
  },
): Promise<void> {
  const existing = await db.metricLabelFinding.findFirst({
    where: {
      status: OPEN,
      kind: "metric_absent",
      platform: finding.platform,
      family: finding.family,
      reportKind: finding.reportKind,
      section: finding.section,
      slotId: finding.slotId,
    },
    select: { id: true },
  });
  if (existing) return;
  await db.metricLabelFinding.create({
    data: {
      kind: "metric_absent",
      platform: finding.platform,
      family: finding.family,
      reportKind: finding.reportKind,
      section: finding.section,
      slotId: finding.slotId,
      oldLabel: finding.oldLabel,
      candidateLabel: null,
      candidateNorm: null,
      evidence: { wouldApply: false, reasons: ["ignore_label"] },
      confidence: "high",
      status: OPEN,
    },
  });
}

export async function resolveLayoutFinding(
  db: PrismaClient,
  findingId: string,
  actor: string,
): Promise<LabelAdminResult<{ findingId: string; status: string }>> {
  const finding = await db.metricLabelFinding.findUnique({ where: { id: findingId } });
  if (!finding) return { ok: false, error: "not_found" };
  if (finding.kind !== "layout_change") return { ok: false, error: "wrong_kind" };
  if (finding.status !== OPEN) return { ok: false, error: "not_open" };
  await db.metricLabelFinding.update({
    where: { id: findingId },
    data: { status: "resolved", resolvedAt: new Date(), resolvedBy: actor },
  });
  await writeEvent(db, {
    actor,
    action: "layout_alert_resolved",
    findingId,
    slotId: finding.slotId,
    before: { status: OPEN },
    after: { status: "resolved" },
    registryVersion: await registryVersion(db),
  });
  return { ok: true, value: { findingId, status: "resolved" } };
}

export async function listMetricLabels(
  db: PrismaClient,
  query: { platform?: string; family?: string },
): Promise<{
  version: number;
  slots: Array<{
    slotId: string;
    platform: string;
    reportKind: string;
    section: string;
    slotKey: string;
    retiredFrom: string | null;
    aliases: Array<{
      aliasId: string;
      label: string;
      role: string;
      source: string;
      retired: boolean;
    }>;
  }>;
}> {
  const [version, slots, aliases] = await Promise.all([
    registryVersion(db),
    db.metricLabelSlot.findMany({
      where: {
        ...(query.platform ? { platform: query.platform } : {}),
        ...(query.family ? { reportKind: query.family } : {}),
      },
      orderBy: { id: "asc" },
    }),
    db.metricLabelAlias.findMany({ orderBy: { label: "asc" } }),
  ]);
  return {
    version,
    slots: slots.map((slot) => ({
      slotId: slot.id,
      platform: slot.platform,
      reportKind: slot.reportKind,
      section: slot.section,
      slotKey: slot.slotKey,
      retiredFrom: slot.retiredFrom?.toISOString() ?? null,
      aliases: aliases
        .filter((alias) => alias.slotId === slot.id)
        .map((alias) => ({
          aliasId: alias.id,
          label: alias.label,
          role: alias.role,
          source: alias.source,
          retired: alias.retiredAt != null,
        })),
    })),
  };
}

export async function addLabelAlias(
  db: PrismaClient,
  slotId: string,
  label: string,
  actor: string,
): Promise<LabelAdminResult<{ aliasId: string; slotId: string; registryVersion: number }>> {
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "no_candidate" };
  const slot = await db.metricLabelSlot.findUnique({ where: { id: slotId } });
  if (!slot) return { ok: false, error: "not_found" };
  if (await collidingSlot(db, slot, normaliseLabel(trimmed)))
    return { ok: false, error: "collision" };
  const alias = await addReadAlias(db, slot, trimmed, actor, "read");
  const version = alias.created ? await bumpRegistry(db) : await registryVersion(db);
  if (alias.created) {
    await writeEvent(db, {
      actor,
      action: "alias_added",
      aliasId: alias.id,
      slotId,
      after: { label: trimmed, role: "read" },
      registryVersion: version,
    });
  }
  return { ok: true, value: { aliasId: alias.id, slotId, registryVersion: version } };
}

export async function retireLabelAlias(
  db: PrismaClient,
  aliasId: string,
  actor: string,
): Promise<LabelAdminResult<{ aliasId: string; registryVersion: number }>> {
  const alias = await db.metricLabelAlias.findUnique({ where: { id: aliasId } });
  if (!alias) return { ok: false, error: "not_found" };
  if (alias.retiredAt) {
    return { ok: true, value: { aliasId, registryVersion: await registryVersion(db) } };
  }
  await db.metricLabelAlias.update({ where: { id: aliasId }, data: { retiredAt: new Date() } });
  const version = await bumpRegistry(db);
  await writeEvent(db, {
    actor,
    action: "alias_retired",
    aliasId,
    slotId: alias.slotId,
    before: { retired: false },
    after: { retired: true },
    registryVersion: version,
  });
  return { ok: true, value: { aliasId, registryVersion: version } };
}

export async function listUnknownLabels(db: PrismaClient): Promise<{
  labels: Array<{ label: string; platform: string; occurrences: number; findingId: string }>;
}> {
  const rows = await db.metricLabelFinding.findMany({
    where: { status: OPEN, kind: "metric_label_change", candidateLabel: { not: null } },
    orderBy: { occurrences: "desc" },
    take: 200,
    select: { id: true, platform: true, candidateLabel: true, occurrences: true },
  });
  return {
    labels: rows.flatMap((row) => {
      if (!row.candidateLabel) return [];
      return [
        {
          label: row.candidateLabel,
          platform: row.platform,
          occurrences: row.occurrences,
          findingId: row.id,
        },
      ];
    }),
  };
}

/** Compact open findings for this restaurant. No evidence, cell values, or credentials. */
export async function readLabelSummary(
  db: PrismaClient,
  scope: { restaurantId: string; spaceId: string },
): Promise<LabelSummary> {
  const seen = await db.metricLabelObservation.findMany({
    where: { restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { findingId: true },
  });
  const ids = [...new Set(seen.map((row) => row.findingId))];
  if (ids.length === 0) return { open: 0, layout: 0, wouldApply: 0, findings: [] };
  const rows = await runAsSystem("label summary", () =>
    db.metricLabelFinding.findMany({
      where: { id: { in: ids }, status: OPEN },
      select: {
        id: true,
        kind: true,
        platform: true,
        slotId: true,
        status: true,
        outletsAffected: true,
        evidence: true,
      },
    }),
  );
  const findings = rows.map((row) => ({
    findingId: row.id,
    kind: row.kind,
    platform: row.platform,
    slotId: row.slotId,
    status: row.status,
    outletsAffected: row.outletsAffected,
    wouldApply: wouldApplyOf(row.evidence),
  }));
  return {
    open: findings.length,
    layout: findings.filter((row) => row.kind === "layout_change").length,
    wouldApply: findings.filter((row) => row.wouldApply).length,
    findings,
  };
}
