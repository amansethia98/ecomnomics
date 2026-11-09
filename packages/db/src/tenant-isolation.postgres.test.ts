import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { drainUnscopedDatabaseAccess, runAsSystem, runAsTenant } from "./row-security.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the
// owner, as `pnpm test:integration` provides after `pnpm db:migrate`.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

/**
 * One restaurant: its own organization, user, and space. Row-level security
 * limits a session to the space and user the application sets. It does not
 * look up membership itself — the sign-in path does that before opening the
 * session (see requestSession in apps/api).
 */
type Restaurant = {
  key: "a" | "b";
  organizationId: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  documentId: string;
  skillId: string;
  taughtSkillId: string;
  spaceSecretId: string;
  botSecretId: string;
  agentSecretId: string;
  modelSecretId: string;
  credentialId: string;
  outletId: string;
  menu: string;
  skillBody: string;
  secretBody: string;
};

function restaurant(key: "a" | "b", suffix: string): Restaurant {
  const id = (part: string) => `iso-${key}-${part}-${suffix}`;
  return {
    key,
    organizationId: id("org"),
    userId: id("user"),
    spaceId: id("space"),
    botId: id("bot"),
    threadId: id("thread"),
    documentId: id("knowledge"),
    skillId: id("skill"),
    taughtSkillId: id("taught"),
    spaceSecretId: id("space-secret"),
    botSecretId: id("bot-secret"),
    agentSecretId: id("agent-secret"),
    modelSecretId: id("model-secret"),
    credentialId: id("credential"),
    outletId: id("outlet"),
    menu: `menu-${key}`,
    skillBody: `skill-${key}`,
    secretBody: `secret-${key}`,
  };
}

describePostgres("tenant isolation between two organizations (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const a = restaurant("a", suffix);
  const b = restaurant("b", suffix);
  const restaurants = [a, b];
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    const o = owner.prisma;
    for (const restaurant of restaurants) {
      await o.organization.create({
        data: {
          id: restaurant.organizationId,
          name: `Restaurant ${restaurant.key}`,
          slug: restaurant.organizationId,
          createdAt: new Date(),
        },
      });
      await o.user.create({
        data: {
          id: restaurant.userId,
          name: restaurant.key,
          email: `${restaurant.userId}@ecomnomics.test`,
          emailVerified: true,
        },
      });
      await o.space.create({
        data: {
          id: restaurant.spaceId,
          organizationId: restaurant.organizationId,
          name: restaurant.key,
          createdByUserId: restaurant.userId,
        },
      });
      await o.member.create({
        data: {
          id: `${restaurant.userId}-member`,
          organizationId: restaurant.organizationId,
          userId: restaurant.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await o.spaceMember.create({
        data: {
          id: `${restaurant.userId}-space`,
          spaceId: restaurant.spaceId,
          userId: restaurant.userId,
          organizationId: restaurant.organizationId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await o.bot.create({
        data: {
          id: restaurant.botId,
          spaceId: restaurant.spaceId,
          userId: restaurant.userId,
          name: `Bot ${restaurant.key}`,
          color: "#000",
        },
      });
      await o.thread.create({
        data: {
          id: restaurant.threadId,
          spaceId: restaurant.spaceId,
          userId: restaurant.userId,
          botId: restaurant.botId,
        },
      });
      await o.message.create({
        data: {
          threadId: restaurant.threadId,
          seq: 1,
          role: "user",
          blocks: [{ text: restaurant.menu }],
        },
      });
      // The knowledge screen stores notes as memory documents. The path is the file name.
      await o.memoryDocument.create({
        data: {
          id: restaurant.documentId,
          spaceId: restaurant.spaceId,
          userId: restaurant.userId,
          botId: restaurant.botId,
          scope: "bot",
          path: "knowledge/menu.md",
          content: restaurant.menu,
        },
      });
      await o.restaurantProfile.create({
        data: {
          spaceId: restaurant.spaceId,
          organizationId: restaurant.organizationId,
          name: `Restaurant ${restaurant.key}`,
          cuisine: `cuisine-${restaurant.key}`,
          city: `city-${restaurant.key}`,
          contactName: `contact-${restaurant.key}`,
          contactEmail: `${restaurant.userId}@ecomnomics.test`,
        },
      });
      await o.restaurantOutlet.create({
        data: {
          id: restaurant.outletId,
          spaceId: restaurant.spaceId,
          name: `Outlet ${restaurant.key}`,
          address: `address-${restaurant.key}`,
          openingHours: `hours-${restaurant.key}`,
          position: 0,
        },
      });
      await o.agentSkill.create({
        data: {
          id: restaurant.skillId,
          spaceId: restaurant.spaceId,
          userId: restaurant.userId,
          name: `skill-${restaurant.key}`,
          description: "how this restaurant works",
          content: restaurant.skillBody,
          // Available in every space of its owner. Another restaurant's user must still not see it.
          allSpaces: true,
        },
      });
      await o.taughtSkill.create({
        data: {
          id: restaurant.taughtSkillId,
          spaceId: restaurant.spaceId,
          botId: restaurant.botId,
          userId: restaurant.userId,
          goal: restaurant.skillBody,
          status: "ready",
        },
      });
      await o.secret.create({
        data: {
          id: restaurant.spaceSecretId,
          userId: restaurant.userId,
          spaceId: restaurant.spaceId,
          kind: "test",
          ciphertext: restaurant.secretBody,
        },
      });
      await o.secret.create({
        data: {
          id: restaurant.agentSecretId,
          userId: restaurant.userId,
          spaceId: restaurant.spaceId,
          kind: "test",
          ciphertext: `${restaurant.secretBody}-agent`,
        },
      });
      await o.agentSecret.create({
        data: {
          spaceId: restaurant.spaceId,
          createdByUserId: restaurant.userId,
          name: `KEY_${restaurant.key.toUpperCase()}`,
          secretId: restaurant.agentSecretId,
        },
      });
      await o.botSecret.create({
        data: {
          id: restaurant.botSecretId,
          userId: restaurant.userId,
          spaceId: restaurant.spaceId,
          botId: restaurant.botId,
          name: `bot-key-${restaurant.key}`,
          origin: "https://example.test",
          auth: {},
          ciphertext: `${restaurant.secretBody}-bot`,
        },
      });
      await o.secret.create({
        data: {
          id: restaurant.modelSecretId,
          userId: restaurant.userId,
          kind: "model",
          ciphertext: `${restaurant.secretBody}-model`,
        },
      });
      await o.userModelCredential.create({
        data: {
          id: restaurant.credentialId,
          userId: restaurant.userId,
          provider: "p",
          label: `key-${restaurant.key}`,
          secretId: restaurant.modelSecretId,
        },
      });
    }
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.prisma.organization.deleteMany({
      where: { id: { in: restaurants.map((restaurant) => restaurant.organizationId) } },
    });
    await owner.prisma.user.deleteMany({
      where: { id: { in: restaurants.map((restaurant) => restaurant.userId) } },
    });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  const ids = <K extends keyof Restaurant>(field: K) =>
    restaurants.map((restaurant) => restaurant[field]);

  async function visible(restaurant: Restaurant) {
    const [
      bots,
      messages,
      knowledge,
      skills,
      taught,
      spaceSecrets,
      botSecrets,
      agentSecrets,
      credentials,
      profiles,
      outlets,
    ] = await Promise.all([
      db.bot.findMany({
        where: { id: { in: ids("botId") as string[] } },
        select: { id: true, name: true },
      }),
      db.message.findMany({
        where: { threadId: { in: ids("threadId") as string[] } },
        select: { threadId: true },
      }),
      db.memoryDocument.findMany({
        where: { id: { in: ids("documentId") as string[] } },
        select: { id: true, path: true, content: true },
      }),
      db.agentSkill.findMany({
        where: { id: { in: ids("skillId") as string[] } },
        select: { id: true, content: true },
      }),
      db.taughtSkill.findMany({
        where: { id: { in: ids("taughtSkillId") as string[] } },
        select: { id: true },
      }),
      db.secret.findMany({
        where: {
          id: {
            in: [
              ...(ids("spaceSecretId") as string[]),
              ...(ids("agentSecretId") as string[]),
              ...(ids("modelSecretId") as string[]),
            ],
          },
        },
        select: { id: true, ciphertext: true },
      }),
      db.botSecret.findMany({
        where: { id: { in: ids("botSecretId") as string[] } },
        select: { id: true, ciphertext: true },
      }),
      db.agentSecret.findMany({
        where: { secretId: { in: ids("agentSecretId") as string[] } },
        select: { secretId: true },
      }),
      db.userModelCredential.findMany({
        where: { id: { in: ids("credentialId") as string[] } },
        select: { id: true, label: true },
      }),
      db.restaurantProfile.findMany({
        where: { spaceId: { in: ids("spaceId") as string[] } },
        select: { cuisine: true },
      }),
      db.restaurantOutlet.findMany({
        where: { id: { in: ids("outletId") as string[] } },
        select: { name: true, address: true },
      }),
    ]);
    return {
      actor: restaurant.key,
      bots: bots.map((row) => row.id).sort(),
      botNames: bots.map((row) => row.name).sort(),
      messages: messages.map((row) => row.threadId).sort(),
      knowledge: knowledge.map((row) => `${row.path}:${row.content}`).sort(),
      skills: skills.map((row) => row.content).sort(),
      taught: taught.map((row) => row.id).sort(),
      secrets: spaceSecrets.map((row) => row.ciphertext).sort(),
      botSecrets: botSecrets.map((row) => row.ciphertext).sort(),
      agentSecrets: agentSecrets.map((row) => row.secretId).sort(),
      credentials: credentials.map((row) => row.label).sort(),
      profiles: profiles.map((row) => row.cuisine).sort(),
      outlets: outlets.map((row) => `${row.name}:${row.address}`).sort(),
    };
  }

  const own = (restaurant: Restaurant) => ({
    actor: restaurant.key,
    bots: [restaurant.botId],
    botNames: [`Bot ${restaurant.key}`],
    messages: [restaurant.threadId],
    knowledge: [`knowledge/menu.md:${restaurant.menu}`],
    skills: [restaurant.skillBody],
    taught: [restaurant.taughtSkillId],
    secrets: [
      restaurant.secretBody,
      `${restaurant.secretBody}-agent`,
      `${restaurant.secretBody}-model`,
    ].sort(),
    botSecrets: [`${restaurant.secretBody}-bot`],
    agentSecrets: [restaurant.agentSecretId],
    credentials: [`key-${restaurant.key}`],
    profiles: [`cuisine-${restaurant.key}`],
    outlets: [`Outlet ${restaurant.key}:address-${restaurant.key}`],
  });

  it("lets each restaurant read only its own bots, messages, knowledge, skills, secrets, and model keys", async () => {
    expect(await runAsTenant(a, () => visible(a))).toEqual(own(a));
    expect(await runAsTenant(b, () => visible(b))).toEqual(own(b));
  });

  it("hides the other restaurant even when its ids are asked for directly", async () => {
    expect(await runAsTenant(a, () => db.bot.findUnique({ where: { id: b.botId } }))).toBeNull();
    expect(
      await runAsTenant(a, () => db.memoryDocument.findUnique({ where: { id: b.documentId } })),
    ).toBeNull();
    expect(
      await runAsTenant(a, () => db.agentSkill.findUnique({ where: { id: b.skillId } })),
    ).toBeNull();
    expect(
      await runAsTenant(a, () =>
        db.userModelCredential.findUnique({ where: { id: b.credentialId } }),
      ),
    ).toBeNull();
    expect(
      await runAsTenant(a, () => db.secret.findUnique({ where: { id: b.spaceSecretId } })),
    ).toBeNull();
    expect(
      await runAsTenant(a, () =>
        db.restaurantProfile.findUnique({ where: { spaceId: b.spaceId } }),
      ),
    ).toBeNull();
    expect(
      await runAsTenant(a, () => db.restaurantOutlet.findUnique({ where: { id: b.outletId } })),
    ).toBeNull();
  });

  it("refuses writes into the other restaurant and leaves its rows unchanged", async () => {
    expect(
      await runAsTenant(a, () =>
        db.bot.updateMany({ where: { id: b.botId }, data: { name: "stolen" } }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () =>
        db.memoryDocument.updateMany({ where: { id: b.documentId }, data: { content: "stolen" } }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () =>
        db.agentSkill.updateMany({ where: { id: b.skillId }, data: { content: "stolen" } }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () =>
        db.taughtSkill.updateMany({ where: { id: b.taughtSkillId }, data: { goal: "stolen" } }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () =>
        db.secret.updateMany({ where: { id: b.spaceSecretId }, data: { ciphertext: "stolen" } }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () =>
        db.botSecret.updateMany({ where: { id: b.botSecretId }, data: { ciphertext: "stolen" } }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () =>
        db.userModelCredential.updateMany({
          where: { id: b.credentialId },
          data: { label: "stolen" },
        }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () => db.message.deleteMany({ where: { threadId: b.threadId } })),
    ).toEqual({ count: 0 });
    await expect(
      runAsTenant(a, () =>
        db.message.create({
          data: { threadId: b.threadId, seq: 2, role: "user", blocks: [{ text: "stolen" }] },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      runAsTenant(a, () =>
        db.bot.create({
          data: { spaceId: b.spaceId, userId: b.userId, name: "stolen", color: "#000" },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      runAsTenant(a, () =>
        db.memoryDocument.create({
          data: {
            spaceId: b.spaceId,
            userId: b.userId,
            botId: b.botId,
            scope: "bot",
            path: "knowledge/stolen.md",
            content: "stolen",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      runAsTenant(a, () =>
        db.agentSkill.create({
          data: {
            spaceId: b.spaceId,
            userId: b.userId,
            name: "stolen-skill",
            description: "stolen",
            content: "stolen",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      await runAsTenant(a, () =>
        db.restaurantProfile.updateMany({
          where: { spaceId: b.spaceId },
          data: { cuisine: "stolen" },
        }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await runAsTenant(a, () =>
        db.restaurantOutlet.updateMany({ where: { id: b.outletId }, data: { name: "stolen" } }),
      ),
    ).toEqual({ count: 0 });
    await expect(
      runAsTenant(a, () =>
        db.restaurantOutlet.create({
          data: {
            id: `stolen-outlet-${suffix}`,
            spaceId: b.spaceId,
            name: "stolen",
            address: "stolen",
            openingHours: "stolen",
            position: 1,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);

    const still = await runAsSystem("tenant isolation check", () => visible(b));
    expect(still.botNames).toEqual(["Bot a", "Bot b"]);
    expect(still.knowledge).toEqual(["knowledge/menu.md:menu-a", "knowledge/menu.md:menu-b"]);
    expect(still.skills).toEqual(["skill-a", "skill-b"]);
    expect(still.credentials).toEqual(["key-a", "key-b"]);
    expect(still.secrets).toEqual(
      [
        "secret-a",
        "secret-a-agent",
        "secret-a-model",
        "secret-b",
        "secret-b-agent",
        "secret-b-model",
      ].sort(),
    );
    expect(still.messages).toEqual([a.threadId, b.threadId].sort());
    expect(still.profiles).toEqual(["cuisine-a", "cuisine-b"]);
    expect(still.outlets).toEqual(["Outlet a:address-a", "Outlet b:address-b"]);
  });

  it("returns nothing and rejects writes when no restaurant is selected", async () => {
    const hidden = await visible(a);
    expect(hidden.bots).toEqual([]);
    expect(hidden.messages).toEqual([]);
    expect(hidden.knowledge).toEqual([]);
    expect(hidden.skills).toEqual([]);
    expect(hidden.secrets).toEqual([]);
    expect(hidden.credentials).toEqual([]);
    expect(hidden.profiles).toEqual([]);
    expect(hidden.outlets).toEqual([]);
    await expect(
      db.message.create({
        data: { threadId: a.threadId, seq: 9, role: "user", blocks: [] },
      }),
    ).rejects.toThrow(/row-level security/);
    drainUnscopedDatabaseAccess();
  });

  it("still lets a restaurant write its own records", async () => {
    const count = await runAsTenant(b, () =>
      db.$transaction(async (tx) => {
        await tx.message.create({
          data: { threadId: b.threadId, seq: 2, role: "assistant", blocks: [{ text: "ok" }] },
        });
        return tx.message.count({ where: { threadId: { in: ids("threadId") as string[] } } });
      }),
    );
    expect(count).toBe(2);
    expect(await runAsTenant(a, () => db.message.count({ where: { threadId: b.threadId } }))).toBe(
      0,
    );
  });
});
