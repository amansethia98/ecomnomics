import { ownerViewFromRestaurant } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { LabelRejectMode } from "./metric-label-admin.js";
import {
  addLabelAlias,
  approveLabelFinding,
  listLabelFindings,
  listMetricLabels,
  listUnknownLabels,
  readLabelFinding,
  rejectLabelFinding,
  resolveLayoutFinding,
  retireLabelAlias,
} from "./metric-label-admin.js";
import { runAsPlatformAdmin } from "./row-security.js";

export interface PlatformAdminAudit {
  adminUserId: string;
  action: string;
  restaurantId: string | null;
  target: string;
  ip: string | null;
}

export interface PlatformAdminRestaurant {
  restaurantId: string;
  spaceId: string;
  name: string;
  timezone: string;
  outlets: Array<{
    outletId: string;
    name: string;
    city: string;
    active: boolean;
    zomato: { resId: string; commissionPct: number | null } | null;
    swiggy: { rid: string; commissionPct: number | null } | null;
  }>;
  jobRuns: Array<{
    runId: string;
    skill: string;
    outletId: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
    costPaise: number | null;
    costUsdMicros: number | null;
    fxRate: number | null;
    model: string | null;
  }>;
}

function asNumber(value: { toString(): string } | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
}

type OutletRow = {
  id: string;
  name: string;
  city: string;
  active: boolean;
  zomatoResId: string | null;
  zomatoCommissionPct: { toString(): string } | null;
  swiggyRid: string | null;
  swiggyCommissionPct: { toString(): string } | null;
};

type JobRow = {
  runId: string;
  skill: string;
  outletId: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  costPaise: number | null;
  costUsdMicros: bigint | null;
  fxRate: { toString(): string } | null;
  model: string | null;
};

function present(row: {
  id: string;
  spaceId: string;
  name: string;
  timezone: string;
  outlets: OutletRow[];
  jobRuns: JobRow[];
}): PlatformAdminRestaurant {
  return {
    restaurantId: row.id,
    spaceId: row.spaceId,
    name: row.name,
    timezone: row.timezone,
    outlets: row.outlets.map((outlet) => ({
      outletId: outlet.id,
      name: outlet.name,
      city: outlet.city,
      active: outlet.active,
      zomato: outlet.zomatoResId
        ? { resId: outlet.zomatoResId, commissionPct: asNumber(outlet.zomatoCommissionPct) }
        : null,
      swiggy: outlet.swiggyRid
        ? { rid: outlet.swiggyRid, commissionPct: asNumber(outlet.swiggyCommissionPct) }
        : null,
    })),
    jobRuns: row.jobRuns.map((job) => ({
      runId: job.runId,
      skill: job.skill,
      outletId: job.outletId,
      status: job.status,
      startedAt: job.startedAt.toISOString(),
      endedAt: job.endedAt?.toISOString() ?? null,
      costPaise: job.costPaise,
      costUsdMicros: job.costUsdMicros == null ? null : Number(job.costUsdMicros),
      fxRate: asNumber(job.fxRate),
      model: job.model,
    })),
  };
}

const restaurantSelect = {
  id: true,
  spaceId: true,
  name: true,
  timezone: true,
  outlets: {
    orderBy: { name: "asc" as const },
    select: {
      id: true,
      name: true,
      city: true,
      active: true,
      zomatoResId: true,
      zomatoCommissionPct: true,
      swiggyRid: true,
      swiggyCommissionPct: true,
    },
  },
  jobRuns: {
    orderBy: { startedAt: "desc" as const },
    take: 20,
    select: {
      runId: true,
      skill: true,
      outletId: true,
      status: true,
      startedAt: true,
      endedAt: true,
      costPaise: true,
      costUsdMicros: true,
      fxRate: true,
      model: true,
    },
  },
};

/**
 * Reads through the platform-admin connection. The select list has no token
 * hashes, secrets, passwords, report files, or job error text.
 */
export function createPlatformAdminStore(db: PrismaClient) {
  return {
    async listRestaurants(audit: PlatformAdminAudit): Promise<PlatformAdminRestaurant[]> {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: { ...audit, ip: audit.ip?.slice(0, 64) ?? null } });
        const rows = await db.restaurant.findMany({
          orderBy: { name: "asc" },
          select: restaurantSelect,
        });
        return rows.map(present);
      });
    },
    async viewAsOwner(restaurantId: string, audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: { ...audit, ip: audit.ip?.slice(0, 64) ?? null } });
        const row = await db.restaurant.findUnique({
          where: { id: restaurantId },
          select: restaurantSelect,
        });
        return row ? ownerViewFromRestaurant(present(row)) : null;
      });
    },
    async readRestaurant(
      restaurantId: string,
      audit: PlatformAdminAudit,
    ): Promise<PlatformAdminRestaurant | null> {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: { ...audit, ip: audit.ip?.slice(0, 64) ?? null } });
        const row = await db.restaurant.findUnique({
          where: { id: restaurantId },
          select: restaurantSelect,
        });
        return row ? present(row) : null;
      });
    },
    async clearFetchHold(
      restaurantId: string,
      outletId: string,
      platform: "zomato" | "swiggy",
      audit: PlatformAdminAudit,
    ): Promise<{ outletId: string; platform: "zomato" | "swiggy"; clearedAt: string } | null> {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: { ...audit, ip: audit.ip?.slice(0, 64) ?? null } });
        const hold = await db.fetchHold.findFirst({
          where: { restaurantId, outletId, platform, clearedAt: null },
          select: { id: true },
        });
        if (!hold) return null;
        const cleared = await db.fetchHold.update({
          where: { id: hold.id },
          data: { clearedAt: new Date(), clearedBy: audit.adminUserId },
          select: { clearedAt: true },
        });
        if (!cleared.clearedAt) return null;
        return { outletId, platform, clearedAt: cleared.clearedAt.toISOString() };
      });
    },
    async listLabelFindings(
      query: { status?: string; platform?: string; kind?: string },
      audit: PlatformAdminAudit,
    ) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return listLabelFindings(db, query);
      });
    },
    async readLabelFinding(findingId: string, audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return readLabelFinding(db, findingId);
      });
    },
    async approveLabelFinding(findingId: string, audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return approveLabelFinding(db, findingId, audit.adminUserId);
      });
    },
    async rejectLabelFinding(findingId: string, mode: LabelRejectMode, audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return rejectLabelFinding(db, findingId, audit.adminUserId, mode);
      });
    },
    async resolveLayoutFinding(findingId: string, audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return resolveLayoutFinding(db, findingId, audit.adminUserId);
      });
    },
    async listMetricLabels(
      query: { platform?: string; family?: string },
      audit: PlatformAdminAudit,
    ) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return listMetricLabels(db, query);
      });
    },
    async addLabelAlias(slotId: string, label: string, audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return addLabelAlias(db, slotId, label, audit.adminUserId);
      });
    },
    async retireLabelAlias(aliasId: string, audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return retireLabelAlias(db, aliasId, audit.adminUserId);
      });
    },
    async listUnknownLabels(audit: PlatformAdminAudit) {
      return runAsPlatformAdmin(audit.adminUserId, async () => {
        await db.adminAuditLog.create({ data: auditRow(audit) });
        return listUnknownLabels(db);
      });
    },
  };
}

function auditRow(audit: PlatformAdminAudit) {
  return { ...audit, ip: audit.ip?.slice(0, 64) ?? null };
}

export type PlatformAdminStore = ReturnType<typeof createPlatformAdminStore>;
