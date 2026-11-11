import { createHash, randomBytes } from "node:crypto";
import type {
  ActionStatus,
  CreateActionInput,
  CreateJobRunInput,
  CreateReportInput,
  PatchActionInput,
  PutMetricsInput,
} from "@rakazo/contracts";
import { AGENT_TOKEN_PREFIX, actionTransition, isValidTimeZone } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";

export class RestaurantAgentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "RestaurantAgentError";
    this.code = code;
    this.status = status;
  }
}

export interface RestaurantScope {
  restaurantId: string;
  spaceId: string;
  userId: string;
}

export function newAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function asNumber(value: { toString(): string } | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
}

function platformBlock(
  id: string | null,
  commission: { toString(): string } | null,
  idKey: "resId" | "rid",
):
  | { resId: string; commissionPct: number | null }
  | { rid: string; commissionPct: number | null }
  | null {
  if (!id) return null;
  return { [idKey]: id, commissionPct: asNumber(commission) } as
    | { resId: string; commissionPct: number | null }
    | { rid: string; commissionPct: number | null };
}

export interface RestaurantView {
  restaurantId: string;
  name: string;
  timezone: string;
  outlets: Array<{
    outletId: string;
    name: string;
    city: string;
    zomato: { resId: string; commissionPct: number | null } | null;
    swiggy: { rid: string; commissionPct: number | null } | null;
    active: boolean;
  }>;
}

export async function ensureRestaurant(
  db: PrismaClient,
  input: { spaceId: string; name?: string; timezone?: string },
) {
  return runAsSystem("ensure restaurant", async () => {
    const existing = await db.restaurant.findUnique({ where: { spaceId: input.spaceId } });
    if (existing) return existing;
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("This space has no restaurant yet. Pass --name to create one.");
    if (name.length > 80) throw new Error("Restaurant name must be 80 characters or less.");
    const timezone = input.timezone?.trim() || "Asia/Kolkata";
    if (!isValidTimeZone(timezone)) throw new Error("Unknown timezone.");
    const space = await db.space.findUnique({
      where: { id: input.spaceId },
      select: { id: true, organizationId: true },
    });
    if (!space) throw new Error("No space with that id.");
    return db.restaurant.create({
      data: {
        organizationId: space.organizationId,
        spaceId: space.id,
        name,
        timezone,
      },
    });
  });
}

function commissionOrNull(value: number | null | undefined, label: string): string | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RestaurantAgentError("invalid_body", 400, `${label} must be from 0 to 100`);
  }
  const text = value.toString();
  const places = (text.split(".")[1] ?? "").length;
  if (places > 3) {
    throw new RestaurantAgentError(
      "invalid_body",
      400,
      `${label} must have at most 3 decimal places`,
    );
  }
  return text;
}

export async function createOutlet(
  db: PrismaClient,
  restaurantId: string,
  input: {
    name: string;
    city: string;
    active?: boolean;
    zomatoResId?: string | null;
    zomatoCommissionPct?: number | null;
    swiggyRid?: string | null;
    swiggyCommissionPct?: number | null;
  },
) {
  const name = input.name.trim();
  const city = input.city.trim();
  if (!name || name.length > 80 || !city || city.length > 80) {
    throw new RestaurantAgentError(
      "invalid_body",
      400,
      "Add an outlet name and city, each at most 80 characters.",
    );
  }
  const zomatoResId = input.zomatoResId?.trim() || null;
  const swiggyRid = input.swiggyRid?.trim() || null;
  if ((zomatoResId && zomatoResId.length > 64) || (swiggyRid && swiggyRid.length > 64)) {
    throw new RestaurantAgentError(
      "invalid_body",
      400,
      "Platform ids must be 64 characters or less.",
    );
  }
  const zomatoCommissionPct = commissionOrNull(input.zomatoCommissionPct, "zomatoCommissionPct");
  const swiggyCommissionPct = commissionOrNull(input.swiggyCommissionPct, "swiggyCommissionPct");
  if (!zomatoResId && zomatoCommissionPct != null) {
    throw new RestaurantAgentError(
      "invalid_body",
      400,
      "A Zomato commission needs a Zomato restaurant id.",
    );
  }
  if (!swiggyRid && swiggyCommissionPct != null) {
    throw new RestaurantAgentError(
      "invalid_body",
      400,
      "A Swiggy commission needs a Swiggy restaurant id.",
    );
  }
  return runAsSystem("create restaurant outlet", async () => {
    const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new RestaurantAgentError("not_found", 404, "Restaurant not found");
    return db.outlet.create({
      data: {
        restaurantId,
        spaceId: restaurant.spaceId,
        name,
        city,
        active: input.active ?? true,
        zomatoResId,
        zomatoCommissionPct,
        swiggyRid,
        swiggyCommissionPct,
      },
    });
  });
}

export async function authenticateAgentToken(
  db: PrismaClient,
  authorization: string | undefined,
  now = new Date(),
): Promise<RestaurantScope | null> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  const token = match?.[1];
  if (!token) return null;
  const tokenHash = hashAgentToken(token);
  return runAsSystem("restaurant agent token", async () => {
    const row = await db.agentToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        revokedAt: true,
        restaurantId: true,
        spaceId: true,
        restaurant: { select: { space: { select: { createdByUserId: true } } } },
      },
    });
    if (!row || row.revokedAt) return null;
    await db.agentToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
    const member = await db.spaceMember.findFirst({
      where: { spaceId: row.spaceId, role: "owner" },
      select: { userId: true },
    });
    return {
      restaurantId: row.restaurantId,
      spaceId: row.spaceId,
      userId: member?.userId ?? row.restaurant.space.createdByUserId ?? row.spaceId,
    };
  });
}

export async function mintAgentToken(
  db: PrismaClient,
  restaurantId: string,
  label?: string,
): Promise<string> {
  return runAsSystem("mint restaurant agent token", async () => {
    const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new Error("No restaurant with that id.");
    const active = await db.agentToken.findFirst({
      where: { restaurantId, revokedAt: null },
      select: { id: true },
    });
    if (active) {
      throw new Error("This restaurant already has a token. Pass --rotate to replace it.");
    }
    return insertToken(db, restaurant.id, restaurant.spaceId, label);
  });
}

export async function rotateAgentToken(
  db: PrismaClient,
  restaurantId: string,
  label?: string,
): Promise<string> {
  return runAsSystem("rotate restaurant agent token", async () => {
    const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new Error("No restaurant with that id.");
    const token = newAgentToken();
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.agentToken.updateMany({
        where: { restaurantId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.agentToken.create({
        data: {
          restaurantId,
          spaceId: restaurant.spaceId,
          tokenHash: hashAgentToken(token),
          label: label?.trim() || null,
        },
      });
    });
    return token;
  });
}

export async function revokeAgentTokens(db: PrismaClient, restaurantId: string): Promise<number> {
  return runAsSystem("revoke restaurant agent token", async () => {
    const result = await db.agentToken.updateMany({
      where: { restaurantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  });
}

async function insertToken(
  db: PrismaClient,
  restaurantId: string,
  spaceId: string,
  label?: string,
): Promise<string> {
  const token = newAgentToken();
  await db.agentToken.create({
    data: {
      restaurantId,
      spaceId,
      tokenHash: hashAgentToken(token),
      label: label?.trim() || null,
    },
  });
  return token;
}

export async function readRestaurant(
  db: PrismaClient,
  scope: RestaurantScope,
): Promise<RestaurantView> {
  const restaurant = await db.restaurant.findFirst({
    where: { id: scope.restaurantId, spaceId: scope.spaceId },
    include: { outlets: { orderBy: { name: "asc" } } },
  });
  if (!restaurant) throw new RestaurantAgentError("not_found", 404, "Restaurant not found");
  return {
    restaurantId: restaurant.id,
    name: restaurant.name,
    timezone: restaurant.timezone,
    outlets: restaurant.outlets.map((outlet) => ({
      outletId: outlet.id,
      name: outlet.name,
      city: outlet.city,
      zomato: platformBlock(outlet.zomatoResId, outlet.zomatoCommissionPct, "resId") as {
        resId: string;
        commissionPct: number | null;
      } | null,
      swiggy: platformBlock(outlet.swiggyRid, outlet.swiggyCommissionPct, "rid") as {
        rid: string;
        commissionPct: number | null;
      } | null,
      active: outlet.active,
    })),
  };
}

async function assertOutlet(db: PrismaClient, scope: RestaurantScope, outletId: string | null) {
  if (!outletId) return;
  const outlet = await db.outlet.findFirst({
    where: { id: outletId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { id: true },
  });
  if (!outlet) {
    throw new RestaurantAgentError("unknown_outlet", 422, "Outlet is not part of this restaurant.");
  }
}

export async function upsertMetrics(
  db: PrismaClient,
  scope: RestaurantScope,
  input: PutMetricsInput,
) {
  const outletIds = [...new Set(input.rows.map((row) => row.outletId))];
  const outlets = await db.outlet.findMany({
    where: { id: { in: outletIds }, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
    select: { id: true },
  });
  const known = new Set(outlets.map((outlet) => outlet.id));
  const missing = outletIds.find((id) => !known.has(id));
  if (missing) {
    throw new RestaurantAgentError("unknown_outlet", 422, "Outlet is not part of this restaurant.");
  }
  const capturedAt = new Date(input.capturedAt);
  await db.$transaction(async (tx) => {
    for (const row of input.rows) {
      const periodStart = new Date(row.periodStart);
      const periodEnd = new Date(row.periodEnd);
      await tx.metricValue.upsert({
        where: {
          metricUpsert: {
            outletId: row.outletId,
            platform: row.platform,
            granularity: row.granularity,
            periodStart,
            key: row.key,
          },
        },
        create: {
          restaurantId: scope.restaurantId,
          spaceId: scope.spaceId,
          outletId: row.outletId,
          platform: row.platform,
          granularity: row.granularity,
          periodStart,
          periodEnd,
          key: row.key,
          value: row.value,
          runId: input.runId,
          source: input.source,
          capturedAt,
        },
        update: {
          periodEnd,
          value: row.value,
          runId: input.runId,
          source: input.source,
          capturedAt,
        },
      });
    }
  });
  return { upserted: input.rows.length };
}

function uniqueFileNames(files: ReadonlyArray<{ name: string }>) {
  const names = files.map((file) => file.name);
  if (new Set(names).size !== names.length) {
    throw new RestaurantAgentError("invalid_body", 400, "File names must be unique.");
  }
}

export interface StoredUpload {
  name: string;
  contentType: string;
  storageKey: string;
}

async function assertChatMessage(db: PrismaClient, messageId: string | null) {
  if (!messageId) return;
  const message = await db.message.findFirst({ where: { id: messageId }, select: { id: true } });
  if (!message) {
    throw new RestaurantAgentError(
      "unknown_message",
      422,
      "That chat message is not in this restaurant.",
    );
  }
}

export async function createReport(
  db: PrismaClient,
  scope: RestaurantScope,
  input: CreateReportInput,
) {
  uniqueFileNames(input.files);
  await assertOutlet(db, scope, input.outletId);
  if (input.clientNonce) {
    const existing = await db.report.findUnique({
      where: { reportNonce: { restaurantId: scope.restaurantId, clientNonce: input.clientNonce } },
      include: { files: { orderBy: { name: "asc" } } },
    });
    if (existing) {
      const names = existing.files.map((file) => file.name).sort();
      const requested = input.files.map((file) => file.name).sort();
      if (names.join("\n") !== requested.join("\n")) {
        throw new RestaurantAgentError(
          "idempotency_conflict",
          409,
          "This clientNonce was already used for a different report.",
        );
      }
      return { reportId: existing.id, files: existing.files.map(storedFile) };
    }
  }
  const report = await db.$transaction(async (tx) => {
    const created = await tx.report.create({
      data: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        type: input.type,
        outletId: input.outletId,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        status: input.status,
        summaryMarkdown: input.summaryMarkdown,
        clientNonce: input.clientNonce ?? null,
      },
    });
    const files: StoredUpload[] = [];
    for (const file of input.files) {
      const storageKey = `restaurants/${scope.restaurantId}/reports/${created.id}/${file.name}`;
      await tx.reportFile.create({
        data: {
          reportId: created.id,
          spaceId: scope.spaceId,
          name: file.name,
          contentType: file.contentType,
          storageKey,
        },
      });
      files.push({ name: file.name, contentType: file.contentType, storageKey });
    }
    return { reportId: created.id, files };
  });
  return report;
}

function storedFile(file: { name: string; contentType: string; storageKey: string }): StoredUpload {
  return { name: file.name, contentType: file.contentType, storageKey: file.storageKey };
}

export async function createAction(
  db: PrismaClient,
  scope: RestaurantScope,
  input: CreateActionInput,
) {
  uniqueFileNames(input.evidenceFiles ?? []);
  await assertOutlet(db, scope, input.outletId);
  await assertChatMessage(db, input.chatMessageId);
  if (input.clientNonce) {
    const existing = await db.action.findUnique({
      where: { actionNonce: { restaurantId: scope.restaurantId, clientNonce: input.clientNonce } },
      include: { evidence: { orderBy: { name: "asc" } } },
    });
    if (existing) {
      const names = existing.evidence.map((file) => file.name).sort();
      const requested = (input.evidenceFiles ?? []).map((file) => file.name).sort();
      if (names.join("\n") !== requested.join("\n")) {
        throw new RestaurantAgentError(
          "idempotency_conflict",
          409,
          "This clientNonce was already used for a different action.",
        );
      }
      return { action: actionJson(existing), files: existing.evidence.map(storedFile) };
    }
  }
  return db.$transaction(async (tx) => {
    const created = await tx.action.create({
      data: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        outletId: input.outletId,
        platform: input.platform,
        type: input.type,
        title: input.title,
        details: input.details as Prisma.InputJsonValue,
        estCostPaise: input.estCostPaise,
        chatMessageId: input.chatMessageId,
        status: "proposed",
        clientNonce: input.clientNonce ?? null,
      },
    });
    const files: StoredUpload[] = [];
    for (const file of input.evidenceFiles ?? []) {
      const storageKey = `restaurants/${scope.restaurantId}/actions/${created.id}/${file.name}`;
      await tx.actionFile.create({
        data: {
          actionId: created.id,
          spaceId: scope.spaceId,
          name: file.name,
          contentType: file.contentType,
          storageKey,
        },
      });
      files.push({ name: file.name, contentType: file.contentType, storageKey });
    }
    return { action: actionJson(created), files };
  });
}

function actionStamp(status: ActionStatus) {
  switch (status) {
    case "approved":
      return "approvedAt" as const;
    case "rejected":
      return "rejectedAt" as const;
    case "executing":
      return "executingAt" as const;
    case "executed":
      return "executedAt" as const;
    case "failed":
      return "failedAt" as const;
    case "reverted":
      return "revertedAt" as const;
    default:
      return undefined;
  }
}

export async function messageApprovesAction(
  db: PrismaClient,
  spaceId: string,
  messageId: string,
): Promise<boolean> {
  const message = await db.message.findFirst({
    where: { id: messageId },
    select: {
      role: true,
      botId: true,
      thread: { select: { spaceId: true, userId: true } },
    },
  });
  // User messages are written by the person who owns the thread. Bot messages use role "bot".
  if (message?.role !== "user" || message?.botId) return false;
  if (message.thread.spaceId !== spaceId) return false;
  const member = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: message.thread.userId } },
    select: { id: true },
  });
  return member !== null;
}

function jsonOrNull(
  value: Record<string, unknown> | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function actionJson(row: {
  id: string;
  outletId: string | null;
  platform: string;
  type: string;
  title: string;
  details: Prisma.JsonValue;
  estCostPaise: number | null;
  chatMessageId: string | null;
  status: string;
  approvedByMessageId: string | null;
  result: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  executingAt: Date | null;
  executedAt: Date | null;
  failedAt: Date | null;
  revertedAt: Date | null;
}) {
  return {
    actionId: row.id,
    outletId: row.outletId,
    platform: row.platform,
    type: row.type,
    title: row.title,
    details: row.details,
    estCostPaise: row.estCostPaise,
    chatMessageId: row.chatMessageId,
    status: row.status,
    approvedByMessageId: row.approvedByMessageId,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    executingAt: row.executingAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
  };
}

export async function transitionAction(
  db: PrismaClient,
  scope: RestaurantScope,
  actionId: string,
  input: PatchActionInput,
  now = new Date(),
) {
  const existing = await db.action.findFirst({
    where: { id: actionId, restaurantId: scope.restaurantId, spaceId: scope.spaceId },
  });
  if (!existing) throw new RestaurantAgentError("not_found", 404, "Action not found");
  const from = existing.status as ActionStatus;
  const to = input.status;
  const step = actionTransition(from, to);
  if (step === "illegal") {
    throw new RestaurantAgentError(
      "invalid_transition",
      409,
      `Cannot move an action from ${from} to ${to}.`,
    );
  }
  if (step === "same") {
    if (input.result === undefined) return actionJson(existing);
    const updated = await db.action.update({
      where: { id: existing.id },
      data: { result: jsonOrNull(input.result) },
    });
    return actionJson(updated);
  }
  if (to === "approved" || to === "executing" || to === "executed") {
    const messageId = to === "approved" ? input.approvedByMessageId : existing.approvedByMessageId;
    if (!messageId) {
      throw new RestaurantAgentError(
        "approval_required",
        409,
        "This action needs approvedByMessageId for a message a person in this restaurant sent.",
      );
    }
    if (!(await messageApprovesAction(db, scope.spaceId, messageId))) {
      throw new RestaurantAgentError(
        "approval_required",
        409,
        "That message is not an approval from a person in this restaurant.",
      );
    }
  }
  const stamp = actionStamp(to);
  const updated = await db.action.update({
    where: { id: existing.id },
    data: {
      status: to,
      ...(to === "approved" ? { approvedByMessageId: input.approvedByMessageId } : {}),
      ...(stamp && existing[stamp] == null ? { [stamp]: now } : {}),
      ...(input.result !== undefined ? { result: jsonOrNull(input.result) } : {}),
    },
  });
  return actionJson(updated);
}

export function jobRunJson(row: {
  id: string;
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
  error: string | null;
}) {
  return {
    jobId: row.id,
    runId: row.runId,
    skill: row.skill,
    outletId: row.outletId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    costPaise: row.costPaise,
    costUsdMicros: row.costUsdMicros == null ? null : Number(row.costUsdMicros),
    fxRate: asNumber(row.fxRate),
    model: row.model,
    error: row.error,
  };
}

export async function upsertJobRun(
  db: PrismaClient,
  scope: RestaurantScope,
  input: CreateJobRunInput,
) {
  if (input.outletId) await assertOutlet(db, scope, input.outletId);
  const existing = await db.jobRun.findUnique({
    where: { jobRunId: { restaurantId: scope.restaurantId, runId: input.runId } },
  });
  const costs = {
    ...(input.costPaise !== undefined ? { costPaise: input.costPaise } : {}),
    ...(input.costUsdMicros !== undefined
      ? { costUsdMicros: input.costUsdMicros == null ? null : BigInt(input.costUsdMicros) }
      : {}),
    ...(input.fxRate !== undefined
      ? { fxRate: input.fxRate == null ? null : input.fxRate.toString() }
      : {}),
  };
  if (!existing) {
    const created = await db.jobRun.create({
      data: {
        restaurantId: scope.restaurantId,
        spaceId: scope.spaceId,
        runId: input.runId,
        skill: input.skill,
        outletId: input.outletId ?? null,
        status: input.status,
        startedAt: new Date(input.startedAt),
        endedAt: input.endedAt ? new Date(input.endedAt) : null,
        model: input.model ?? null,
        error: input.error ?? null,
        ...costs,
      },
    });
    return jobRunJson(created);
  }
  const updated = await db.jobRun.update({
    where: { id: existing.id },
    data: {
      skill: input.skill,
      status: input.status,
      ...(input.outletId !== undefined ? { outletId: input.outletId } : {}),
      ...(input.endedAt !== undefined
        ? { endedAt: input.endedAt ? new Date(input.endedAt) : null }
        : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...costs,
    },
  });
  return jobRunJson(updated);
}

export async function markReportFileUploaded(
  db: PrismaClient,
  scope: RestaurantScope,
  reportId: string,
  name: string,
  sizeBytes: number,
) {
  const file = await db.reportFile.findFirst({
    where: { reportId, name, spaceId: scope.spaceId, report: { restaurantId: scope.restaurantId } },
  });
  if (!file) throw new RestaurantAgentError("not_found", 404, "File not found");
  await db.reportFile.update({
    where: { id: file.id },
    data: { sizeBytes, uploadedAt: new Date() },
  });
  return file.storageKey;
}

export async function markActionFileUploaded(
  db: PrismaClient,
  scope: RestaurantScope,
  actionId: string,
  name: string,
  sizeBytes: number,
) {
  const file = await db.actionFile.findFirst({
    where: { actionId, name, spaceId: scope.spaceId, action: { restaurantId: scope.restaurantId } },
  });
  if (!file) throw new RestaurantAgentError("not_found", 404, "File not found");
  await db.actionFile.update({
    where: { id: file.id },
    data: { sizeBytes, uploadedAt: new Date() },
  });
  return file.storageKey;
}

export async function reportFileForUpload(
  db: PrismaClient,
  scope: RestaurantScope,
  reportId: string,
  name: string,
) {
  return db.reportFile.findFirst({
    where: { reportId, name, spaceId: scope.spaceId, report: { restaurantId: scope.restaurantId } },
  });
}

export async function actionFileForUpload(
  db: PrismaClient,
  scope: RestaurantScope,
  actionId: string,
  name: string,
) {
  return db.actionFile.findFirst({
    where: { actionId, name, spaceId: scope.spaceId, action: { restaurantId: scope.restaurantId } },
  });
}
