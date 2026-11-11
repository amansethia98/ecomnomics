import type { SecretStore } from "@rakazo/adapter-kit";
import {
  AGENT_TOKEN_PREFIX,
  RESTAURANT_AGENT_API_BASE_URL_NAME,
  RESTAURANT_AGENT_TOKEN_NAME,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  beginAgentTokenRotation,
  claimAgentToken,
  deleteAgentToken,
  hashAgentToken,
  revokeAgentTokens,
  revokeAgentTokensExcept,
  runAsSystem,
  setRestaurantAgentAccessHandler,
} from "@rakazo/db";
import {
  deletePlatformCommandVariables,
  isPlatformManagedAuth,
  upsertPlatformCommandVariable,
} from "./bot-secrets.js";

const HEAL_AFTER_MS = 60_000;

function alreadyHasToken(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("This restaurant already has a token");
}

export type RestaurantAgentAccessMode = "ensure" | "mint" | "rotate" | "revoke";

export type RestaurantAgentAccessResult = {
  status: "waiting" | "present" | "minted" | "rotated" | "revoked";
  /** Set for an explicit mint or rotation. Automatic minting keeps the value in the vault. */
  token?: string;
};

type SavedVariable = { id: string; ciphertext: string };

/** The base URL stored for the computer. No userinfo, and no trailing slash on the origin. */
export function normalizeRestaurantApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The restaurant API base URL must be an http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The restaurant API base URL must be an http(s) URL.");
  }
  if (url.username || url.password) {
    throw new Error("The restaurant API base URL must not include a username or password.");
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}${path}${url.search}`;
}

/**
 * Mint the restaurant token when a restaurant and a computer both exist.
 * The CLI calls the same function with mint, rotate, or revoke.
 */
export function installRestaurantAgentAccess(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  apiBaseUrl: string;
}): void {
  setRestaurantAgentAccessHandler(async ({ spaceId }) => {
    await ensureRestaurantAgentAccess({
      prisma: input.prisma,
      secretStore: input.secretStore,
      spaceId,
      apiBaseUrl: input.apiBaseUrl,
      mode: "ensure",
    });
  });
}

export async function ensureRestaurantAgentAccess(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  spaceId: string;
  apiBaseUrl: string;
  mode: RestaurantAgentAccessMode;
  label?: string;
}): Promise<RestaurantAgentAccessResult> {
  const apiBaseUrl = normalizeRestaurantApiBaseUrl(input.apiBaseUrl);
  const ready = await runAsSystem("restaurant agent access", () =>
    restaurantReady(input.prisma, input.spaceId),
  );
  if (!ready) return { status: "waiting" };
  if (input.mode === "ensure" && !ready.computer) return { status: "waiting" };
  if (ready.userIds.length === 0) {
    if (input.mode === "ensure") return { status: "waiting" };
    throw new Error("This space has no owner.");
  }

  if (input.mode === "revoke") {
    await revokeAgentTokens(input.prisma, ready.restaurantId);
    await deletePlatformCommandVariables(input.prisma, input.secretStore, input.spaceId);
    return { status: "revoked" };
  }

  if (input.mode === "rotate") {
    const token = await rotateToken(input, ready.restaurantId, ready.userIds, apiBaseUrl);
    return { status: "rotated", token };
  }

  const active = await runAsSystem("restaurant agent token", () =>
    input.prisma.agentToken.findFirst({
      where: { restaurantId: ready.restaurantId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    }),
  );

  if (input.mode === "mint") {
    if (active)
      throw new Error("This restaurant already has a token. Pass --rotate to replace it.");
    const token = await mintToken(input, ready.restaurantId, ready.userIds, apiBaseUrl);
    return { status: "minted", token };
  }

  if (!active) {
    try {
      await mintToken(input, ready.restaurantId, ready.userIds, apiBaseUrl);
    } catch (error) {
      if (!alreadyHasToken(error)) throw error;
      return { status: "present" };
    }
    return { status: "minted" };
  }

  const stored = await loadStoredToken(input.prisma, input.secretStore, input.spaceId);
  if (stored) {
    const hash = hashAgentToken(stored);
    const match = await runAsSystem("restaurant agent token hash", () =>
      input.prisma.agentToken.findFirst({
        where: { restaurantId: ready.restaurantId, revokedAt: null, tokenHash: hash },
        select: { id: true },
      }),
    );
    if (match) {
      await revokeAgentTokensExcept(input.prisma, ready.restaurantId, match.id);
      await writeMissing(input, ready.userIds, stored, apiBaseUrl);
      return { status: "present" };
    }
  }

  // A mint that has not finished writing the vault yet must not be replaced.
  if (Date.now() - active.createdAt.getTime() < HEAL_AFTER_MS) return { status: "present" };
  await rotateToken(input, ready.restaurantId, ready.userIds, apiBaseUrl);
  return { status: "rotated" };
}

async function restaurantReady(db: PrismaClient, spaceId: string) {
  const restaurant = await db.restaurant.findUnique({
    where: { spaceId },
    select: { id: true },
  });
  if (!restaurant) return null;
  const [members, computers, space] = await Promise.all([
    db.spaceMember.findMany({ where: { spaceId }, select: { userId: true, role: true } }),
    db.computer.findMany({ where: { spaceId }, select: { userId: true } }),
    db.space.findUnique({ where: { id: spaceId }, select: { createdByUserId: true } }),
  ]);
  const memberIds = new Set(members.map((member) => member.userId));
  const userIds = new Set<string>();
  for (const member of members) {
    if (member.role.split(",").some((role) => role.trim() === "owner")) userIds.add(member.userId);
  }
  for (const computer of computers) {
    if (memberIds.has(computer.userId)) userIds.add(computer.userId);
  }
  if (userIds.size === 0 && space?.createdByUserId && memberIds.has(space.createdByUserId)) {
    userIds.add(space.createdByUserId);
  }
  return { restaurantId: restaurant.id, computer: computers.length > 0, userIds: [...userIds] };
}

async function loadStoredToken(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  spaceId: string,
): Promise<string | undefined> {
  const rows = await runAsSystem("read restaurant agent variable", () =>
    prisma.vaultCredential.findMany({
      where: { spaceId, name: RESTAURANT_AGENT_TOKEN_NAME },
      select: { id: true, ciphertext: true, auth: true },
    }),
  );
  for (const row of rows) {
    if (!isPlatformManagedAuth(row.auth)) continue;
    try {
      const value = await secretStore.load(row.ciphertext, row.id);
      if (value.startsWith(AGENT_TOKEN_PREFIX)) return value;
    } catch {
      // Try the next member's copy. A value that cannot be read is replaced by rotation.
    }
  }
  return undefined;
}

async function writeVariables(
  input: { prisma: PrismaClient; secretStore: SecretStore; spaceId: string },
  userIds: readonly string[],
  token: string,
  apiBaseUrl: string,
): Promise<void> {
  for (const userId of userIds) {
    await upsertPlatformCommandVariable({
      prisma: input.prisma,
      secretStore: input.secretStore,
      userId,
      spaceId: input.spaceId,
      name: RESTAURANT_AGENT_TOKEN_NAME,
      plaintext: token,
    });
    await upsertPlatformCommandVariable({
      prisma: input.prisma,
      secretStore: input.secretStore,
      userId,
      spaceId: input.spaceId,
      name: RESTAURANT_AGENT_API_BASE_URL_NAME,
      plaintext: apiBaseUrl,
    });
  }
}

async function writeMissing(
  input: { prisma: PrismaClient; secretStore: SecretStore; spaceId: string },
  userIds: readonly string[],
  token: string,
  apiBaseUrl: string,
): Promise<void> {
  const rows = await runAsSystem("restaurant agent variable owners", () =>
    input.prisma.vaultCredential.findMany({
      where: {
        spaceId: input.spaceId,
        userId: { in: [...userIds] },
        name: { in: [RESTAURANT_AGENT_TOKEN_NAME, RESTAURANT_AGENT_API_BASE_URL_NAME] },
      },
      select: { userId: true, name: true, auth: true },
    }),
  );
  const has = new Set(
    rows.filter((row) => isPlatformManagedAuth(row.auth)).map((row) => `${row.userId}:${row.name}`),
  );
  for (const userId of userIds) {
    if (!has.has(`${userId}:${RESTAURANT_AGENT_TOKEN_NAME}`)) {
      await upsertPlatformCommandVariable({
        prisma: input.prisma,
        secretStore: input.secretStore,
        userId,
        spaceId: input.spaceId,
        name: RESTAURANT_AGENT_TOKEN_NAME,
        plaintext: token,
      });
    }
    if (!has.has(`${userId}:${RESTAURANT_AGENT_API_BASE_URL_NAME}`)) {
      await upsertPlatformCommandVariable({
        prisma: input.prisma,
        secretStore: input.secretStore,
        userId,
        spaceId: input.spaceId,
        name: RESTAURANT_AGENT_API_BASE_URL_NAME,
        plaintext: apiBaseUrl,
      });
    }
  }
}

async function snapshotVariables(prisma: PrismaClient, spaceId: string): Promise<SavedVariable[]> {
  const rows = await prisma.vaultCredential.findMany({
    where: {
      spaceId,
      name: { in: [RESTAURANT_AGENT_TOKEN_NAME, RESTAURANT_AGENT_API_BASE_URL_NAME] },
    },
    select: { id: true, ciphertext: true, auth: true },
  });
  return rows
    .filter((row) => isPlatformManagedAuth(row.auth))
    .map((row) => ({ id: row.id, ciphertext: row.ciphertext }));
}

async function restoreVariables(
  prisma: PrismaClient,
  spaceId: string,
  saved: readonly SavedVariable[],
): Promise<void> {
  const previous = new Map(saved.map((row) => [row.id, row.ciphertext]));
  const rows = await prisma.vaultCredential.findMany({
    where: {
      spaceId,
      name: { in: [RESTAURANT_AGENT_TOKEN_NAME, RESTAURANT_AGENT_API_BASE_URL_NAME] },
    },
    select: { id: true, auth: true },
  });
  for (const row of rows) {
    if (!isPlatformManagedAuth(row.auth)) continue;
    const ciphertext = previous.get(row.id);
    if (ciphertext) {
      await prisma.vaultCredential.update({ where: { id: row.id }, data: { ciphertext } });
    } else {
      await prisma.vaultCredential.delete({ where: { id: row.id } });
    }
  }
}

async function mintToken(
  input: { prisma: PrismaClient; secretStore: SecretStore; spaceId: string; label?: string },
  restaurantId: string,
  userIds: readonly string[],
  apiBaseUrl: string,
): Promise<string> {
  const claimed = await claimAgentToken(input.prisma, restaurantId, input.label);
  if (!claimed)
    throw new Error("This restaurant already has a token. Pass --rotate to replace it.");
  try {
    await writeVariables(input, userIds, claimed.token, apiBaseUrl);
  } catch (error) {
    await deletePlatformCommandVariables(input.prisma, input.secretStore, input.spaceId).catch(
      () => undefined,
    );
    await deleteAgentToken(input.prisma, claimed.id).catch(() => undefined);
    throw error;
  }
  return claimed.token;
}

async function rotateToken(
  input: { prisma: PrismaClient; secretStore: SecretStore; spaceId: string; label?: string },
  restaurantId: string,
  userIds: readonly string[],
  apiBaseUrl: string,
): Promise<string> {
  const saved = await runAsSystem("snapshot restaurant agent variables", () =>
    snapshotVariables(input.prisma, input.spaceId),
  );
  const issued = await beginAgentTokenRotation(input.prisma, restaurantId, input.label);
  try {
    await writeVariables(input, userIds, issued.token, apiBaseUrl);
    await revokeAgentTokensExcept(input.prisma, restaurantId, issued.id);
  } catch (error) {
    await runAsSystem("restore restaurant agent variables", () =>
      restoreVariables(input.prisma, input.spaceId, saved),
    ).catch(() => undefined);
    await deleteAgentToken(input.prisma, issued.id).catch(() => undefined);
    throw error;
  }
  return issued.token;
}
