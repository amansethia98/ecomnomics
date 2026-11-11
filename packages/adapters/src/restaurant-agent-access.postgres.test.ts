import { AGENT_TOKEN_PREFIX } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  authenticateAgentToken,
  createDb,
  ensureRestaurant,
  runAsSystem,
  runAsTenant,
  setRestaurantAgentAccessHandler,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shellCommandEnvironment } from "./bot-secrets.js";
import { ensureRestaurantAgentAccess } from "./restaurant-agent-access.js";
import { EncryptedSecretStore } from "./secrets.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("restaurant agent token vault", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const spaceId = `token-space-${suffix}`;
  const userId = `token-user-${suffix}`;
  const orgId = `token-org-${suffix}`;
  const apiBaseUrl = "https://api.example.test";
  let db: PrismaClient;
  let stop: () => Promise<void>;
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");

  beforeAll(async () => {
    setRestaurantAgentAccessHandler(undefined);
    const created = createDb(migrationUrl!);
    db = created.prisma;
    stop = async () => {
      await created.prisma.$disconnect();
      await created.pool.end();
    };
    await runAsSystem("restaurant token fixture", async () => {
      await db.organization.create({
        data: { id: orgId, name: "Token", slug: orgId, createdAt: new Date() },
      });
      await db.user.create({
        data: {
          id: userId,
          name: "Owner",
          email: `${userId}@ecomnomics.test`,
          emailVerified: true,
        },
      });
      await db.member.create({
        data: {
          id: `${userId}-member`,
          organizationId: orgId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await db.space.create({
        data: { id: spaceId, organizationId: orgId, name: "Kitchen", createdByUserId: userId },
      });
      await db.spaceMember.create({
        data: {
          id: `${userId}-space`,
          spaceId,
          userId,
          organizationId: orgId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await ensureRestaurant(db, { spaceId, name: "Kitchen" });
    });
  });

  afterAll(async () => {
    setRestaurantAgentAccessHandler(undefined);
    await runAsSystem("restaurant token cleanup", async () => {
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.user.deleteMany({ where: { id: userId } });
    });
    await stop();
  });

  const access = (mode: "ensure" | "mint" | "rotate" | "revoke") =>
    ensureRestaurantAgentAccess({ prisma: db, secretStore, spaceId, apiBaseUrl, mode });

  async function storedToken(): Promise<string | undefined> {
    const row = await runAsSystem("read test token", () =>
      db.vaultCredential.findFirst({
        where: { spaceId, userId, name: "restaurant_agent_token" },
      }),
    );
    if (!row) return undefined;
    return secretStore.load(row.ciphertext, row.id);
  }

  it("waits for a computer, then mints, rotates, and revokes", async () => {
    expect(await access("ensure")).toEqual({ status: "waiting" });
    expect(
      await runAsSystem("count tokens", () => db.agentToken.count({ where: { spaceId } })),
    ).toBe(0);

    await runAsSystem("restaurant computer", () =>
      db.computer.create({
        data: {
          spaceId,
          userId,
          scopeKey: `token-${suffix}`,
          homeKey: `token-${suffix}`,
          kind: "fake",
        },
      }),
    );

    const minted = await access("ensure");
    expect(minted).toEqual({ status: "minted" });
    const token = await storedToken();
    expect(token?.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    const rows = await runAsSystem("token rows", () =>
      db.agentToken.findMany({ where: { spaceId, revokedAt: null } }),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    const vault = await runAsSystem("vault rows", () =>
      db.vaultCredential.findMany({ where: { spaceId } }),
    );
    expect(vault.map((row) => row.name).sort()).toEqual([
      "restaurant_agent_api_base_url",
      "restaurant_agent_token",
    ]);
    expect(JSON.stringify(vault)).not.toContain(token);
    expect(
      await secretStore.load(
        vault.find((row) => row.name.endsWith("url"))!.ciphertext,
        vault.find((row) => row.name.endsWith("url"))!.id,
      ),
    ).toBe(apiBaseUrl);

    const redactions: string[] = [];
    const command = await runAsTenant({ userId, spaceId }, () =>
      shellCommandEnvironment({
        prisma: db,
        secretStore,
        scope: { userId, spaceId },
        registerRedactions: (values) => redactions.push(...values),
      }),
    );
    expect(command.env.RESTAURANT_AGENT_TOKEN).toBe(token);
    expect(command.env.RESTAURANT_AGENT_API_BASE_URL).toBe(apiBaseUrl);
    expect(redactions).toContain(token);
    expect(await authenticateAgentToken(db, `Bearer ${token}`)).toMatchObject({ spaceId });

    expect(await access("ensure")).toEqual({ status: "present" });
    expect(
      await runAsSystem("still one", () =>
        db.agentToken.count({ where: { spaceId, revokedAt: null } }),
      ),
    ).toBe(1);

    const rotated = await access("rotate");
    expect(rotated.status).toBe("rotated");
    expect(rotated.token).not.toBe(token);
    expect(await storedToken()).toBe(rotated.token);
    expect(await authenticateAgentToken(db, `Bearer ${token}`)).toBeNull();
    expect(await authenticateAgentToken(db, `Bearer ${rotated.token}`)).toMatchObject({ spaceId });
    expect(
      await runAsSystem("one active", () =>
        db.agentToken.count({ where: { spaceId, revokedAt: null } }),
      ),
    ).toBe(1);

    expect(await access("revoke")).toEqual({ status: "revoked" });
    expect(await authenticateAgentToken(db, `Bearer ${rotated.token}`)).toBeNull();
    expect(
      await runAsSystem("vault gone", () => db.vaultCredential.count({ where: { spaceId } })),
    ).toBe(0);
    const cleared = await runAsTenant({ userId, spaceId }, () =>
      shellCommandEnvironment({
        prisma: db,
        secretStore,
        scope: { userId, spaceId },
        registerRedactions: () => undefined,
      }),
    );
    expect(cleared.env.RESTAURANT_AGENT_TOKEN).toBeUndefined();
    expect(cleared.unsetEnv).toEqual(
      expect.arrayContaining(["RESTAURANT_AGENT_TOKEN", "RESTAURANT_AGENT_API_BASE_URL"]),
    );

    const cli = await access("mint");
    expect(cli.status).toBe("minted");
    expect(cli.token?.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(await storedToken()).toBe(cli.token);
    await expect(access("mint")).rejects.toThrow(/already has a token/);
  });
});
