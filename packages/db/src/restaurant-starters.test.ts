import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { computerHomeKey } from "./computers.js";
import { createRepos } from "./repos.js";
import { SharedMachineSandboxError } from "./restaurant-mode.js";
import { seedRestaurantStarterBots } from "./restaurant-starters.js";

type BotRow = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  color: string;
  avatarSet: string;
  position: number;
  computerId: string | null;
  spawnKey: string | null;
  archivedAt: Date | null;
  parentBotId: string | null;
  sectionId: string | null;
  pinned: boolean;
  memoryScope: string | null;
  instructionHistory: unknown[];
  createdAt: Date;
  updatedAt: Date;
  disabledBuiltinTools: string[];
  [key: string]: unknown;
};

type ComputerRow = {
  id: string;
  scopeKey: string;
  homeKey: string;
  scope: string;
  spaceId: string;
  userId: string;
  kind: string;
};

type ThreadRow = { id: string; botId: string; unread: boolean };

function memoryDb(computerHost: string | null = null) {
  const bots: BotRow[] = [];
  const computers: ComputerRow[] = [];
  const threads: ThreadRow[] = [];
  let computerSeq = 0;
  let threadSeq = 0;

  function hydrate(row: BotRow) {
    const thread = threads.find((item) => item.botId === row.id);
    return {
      ...row,
      thread: thread
        ? { id: thread.id, reads: [{ unread: thread.unread, snoozedUntil: null }] }
        : null,
      computer: computers.find((computer) => computer.id === row.computerId) ?? null,
    };
  }

  function matches(
    row: BotRow,
    where: {
      id?: string;
      spaceId?: string;
      userId?: string;
      archivedAt?: null;
      spawnKey?: string | { startsWith: string };
    },
  ) {
    if (where.id && row.id !== where.id) return false;
    if (where.spaceId && row.spaceId !== where.spaceId) return false;
    if (where.userId && row.userId !== where.userId) return false;
    if (where.archivedAt === null && row.archivedAt) return false;
    if (typeof where.spawnKey === "string" && row.spawnKey !== where.spawnKey) return false;
    if (
      where.spawnKey &&
      typeof where.spawnKey === "object" &&
      !(row.spawnKey ?? "").startsWith(where.spawnKey.startsWith)
    ) {
      return false;
    }
    return true;
  }

  const bot = {
    aggregate: async ({ where }: { where: { spaceId: string; userId: string } }) => {
      const rows = bots.filter(
        (row) => row.spaceId === where.spaceId && row.userId === where.userId,
      );
      return {
        _max: { position: rows.length ? Math.max(...rows.map((row) => row.position)) : null },
      };
    },
    findMany: async ({ where }: { where: { spaceId: string; userId: string } }) =>
      bots
        .filter(
          (row) => row.spaceId === where.spaceId && row.userId === where.userId && !row.archivedAt,
        )
        .map((row) => ({ id: row.id, color: row.color })),
    create: async ({ data }: { data: BotRow }) => {
      if (
        data.spawnKey &&
        bots.some((row) => row.spaceId === data.spaceId && row.spawnKey === data.spawnKey)
      ) {
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
          meta: { target: ["spawnKey"] },
        });
      }
      const row: BotRow = Object.assign(
        {
          pinned: false,
          sectionId: null,
          archivedAt: null,
          memoryScope: null,
          instructionHistory: [],
          parentBotId: null,
          disabledBuiltinTools: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        data,
      );
      bots.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<BotRow> }) => {
      const row = bots.find((item) => item.id === where.id);
      if (!row) throw new Error("missing bot");
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: Parameters<typeof matches>[1];
      orderBy?: { position: "asc" };
    }) => {
      let rows = bots.filter((row) => matches(row, where));
      if (orderBy?.position === "asc") {
        rows = [...rows].sort((a, b) => a.position - b.position);
      }
      const row = rows[0];
      return row ? hydrate(row) : null;
    },
    findFirstOrThrow: async (args: {
      where: Parameters<typeof matches>[1];
      orderBy?: { position: "asc" };
    }) => {
      const row = await bot.findFirst(args);
      if (!row) throw new Error("not found");
      return row;
    },
    findUnique: async ({
      where,
    }: {
      where: { spaceId_spawnKey: { spaceId: string; spawnKey: string } };
    }) => {
      const key = where.spaceId_spawnKey;
      const row = bots.find(
        (item) => item.spaceId === key.spaceId && item.spawnKey === key.spawnKey,
      );
      return row ? hydrate(row) : null;
    },
  };

  const computer = {
    findUnique: async ({ where }: { where: { homeKey?: string; scopeKey?: string } }) => {
      if (where.homeKey) return computers.find((row) => row.homeKey === where.homeKey) ?? null;
      if (where.scopeKey) return computers.find((row) => row.scopeKey === where.scopeKey) ?? null;
      return null;
    },
    upsert: async ({ where, create }: { where: { scopeKey: string }; create: ComputerRow }) => {
      const existing = computers.find((row) => row.scopeKey === where.scopeKey);
      if (existing) return existing;
      const row = { ...create, id: `computer-${++computerSeq}` };
      computers.push(row);
      return row;
    },
  };

  const tx = {
    $queryRaw: async () => [],
    spaceMember: {
      findUnique: async () => ({ organizationId: "org", space: { deletingAt: null } }),
      // No membership row: the computer stays with the person who created the bot.
      findFirst: async () => null,
    },
    bot,
    computer,
    thread: {
      create: async ({ data }: { data: { botId: string } }) => {
        const row = { id: `thread-${++threadSeq}`, unread: false, ...data };
        threads.push(row);
        return row;
      },
    },
    browserProfile: { create: async () => ({}) },
    memoryDocument: { create: async () => ({}) },
  };

  const prisma = {
    deploymentSettings: { findUnique: async () => ({ computerHost }) },
    $transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
    bot,
    computer,
  };

  return { prisma: prisma as unknown as PrismaClient, bots, computers };
}

function actor(userId: string, spaceId: string): Actor {
  return {
    userId,
    spaceId,
    email: `${userId}@restaurant.test`,
    isDeploymentOwner: false,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restaurant starter bots and computers", () => {
  it("gives each restaurant its own bots and one computer the other restaurant cannot use", async () => {
    vi.stubEnv("RESTAURANT_STARTER_BOTS_ENABLED", "true");
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "true");
    vi.stubEnv("SANDBOX_PROVIDER", "docker");
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "");
    const db = memoryDb();

    await seedRestaurantStarterBots(db.prisma, {
      userId: "owner-a",
      spaceId: "restaurant-a",
      email: "a@restaurant.test",
    });
    await seedRestaurantStarterBots(db.prisma, {
      userId: "owner-b",
      spaceId: "restaurant-b",
      email: "b@restaurant.test",
    });

    const names = (spaceId: string) =>
      db.bots.filter((bot) => bot.spaceId === spaceId).map((bot) => bot.name);
    expect(names("restaurant-a")).toEqual(["Menu Manager", "Payouts", "Reviews Replier"]);
    expect(names("restaurant-b")).toEqual(["Menu Manager", "Payouts", "Reviews Replier"]);
    for (const bot of db.bots) {
      if (bot.name === "Payouts") {
        expect(bot.instructions).toContain("Never send a report by email");
      } else {
        expect(bot.instructions.startsWith("EDIT THIS:")).toBe(true);
      }
    }

    const computersFor = (spaceId: string) =>
      db.computers.filter((computer) => computer.spaceId === spaceId);
    expect(computersFor("restaurant-a")).toHaveLength(1);
    expect(computersFor("restaurant-b")).toHaveLength(1);
    const [computerA] = computersFor("restaurant-a");
    const [computerB] = computersFor("restaurant-b");
    expect(computerA!.id).not.toBe(computerB!.id);
    expect(computerA!.homeKey).not.toBe(computerB!.homeKey);
    expect(computerA!.scope).toBe("team");
    expect(computerA!.homeKey).toBe(
      computerHomeKey({ mode: "team", spaceId: "restaurant-a", userId: "owner-a" }),
    );
    expect(
      db.bots
        .filter((bot) => bot.spaceId === "restaurant-a")
        .every((bot) => bot.computerId === computerA!.id),
    ).toBe(true);

    const before = db.bots.filter((bot) => bot.spaceId === "restaurant-a").map((bot) => bot.id);
    await seedRestaurantStarterBots(db.prisma, {
      userId: "owner-a",
      spaceId: "restaurant-a",
      email: "a@restaurant.test",
    });
    expect(db.bots.filter((bot) => bot.spaceId === "restaurant-a").map((bot) => bot.id)).toEqual(
      before,
    );
    expect(computersFor("restaurant-a")).toHaveLength(1);

    const repos = createRepos(db.prisma);
    const extra = await repos.createBot(actor("owner-a", "restaurant-a"), {
      name: "Host",
      description: "Floor",
      instructions: "Seat guests",
      notifyOnFinish: true,
      computerMode: "dedicated",
    });
    expect(extra.computerMode).toBe("team");
    expect(db.bots.find((bot) => bot.id === extra.id)?.computerId).toBe(computerA!.id);
    expect(computersFor("restaurant-a")).toHaveLength(1);

    const onboarding = await repos.createBot(actor("owner-a", "restaurant-a"), {
      name: "Chief",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: "onboarding:first",
    });
    expect(onboarding.name).toBe("Menu Manager");
    expect(names("restaurant-a")).toEqual(["Menu Manager", "Payouts", "Reviews Replier", "Host"]);
  });

  it("does not copy templates or force one computer when the settings are off", async () => {
    vi.stubEnv("RESTAURANT_STARTER_BOTS_ENABLED", "false");
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "false");
    vi.stubEnv("SANDBOX_PROVIDER", "docker");
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "");
    const db = memoryDb();
    await seedRestaurantStarterBots(db.prisma, {
      userId: "owner-a",
      spaceId: "restaurant-a",
    });
    expect(db.bots).toHaveLength(0);

    const repos = createRepos(db.prisma);
    const shared = await repos.createBot(actor("owner-a", "restaurant-a"), {
      name: "One",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const own = await repos.createBot(actor("owner-a", "restaurant-a"), {
      name: "Two",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "dedicated",
    });
    expect(shared.computerMode).toBe("team");
    expect(own.computerMode).toBe("dedicated");
    expect(db.computers).toHaveLength(2);
    expect(db.bots.find((bot) => bot.id === own.id)?.computerId).not.toBe(
      db.bots.find((bot) => bot.id === shared.id)?.computerId,
    );
  });

  it("refuses a provider that would put two restaurants on one machine", async () => {
    vi.stubEnv("RESTAURANT_STARTER_BOTS_ENABLED", "true");
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "true");
    vi.stubEnv("SANDBOX_PROVIDER", "wuying");
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "");
    const db = memoryDb();
    await expect(
      seedRestaurantStarterBots(db.prisma, { userId: "owner-a", spaceId: "restaurant-a" }),
    ).rejects.toBeInstanceOf(SharedMachineSandboxError);
    expect(db.bots).toHaveLength(0);
    expect(db.computers).toHaveLength(0);

    vi.stubEnv("SANDBOX_PROVIDER", "docker");
    const mac = memoryDb("this-mac");
    await expect(
      seedRestaurantStarterBots(mac.prisma, { userId: "owner-a", spaceId: "restaurant-a" }),
    ).rejects.toBeInstanceOf(SharedMachineSandboxError);
    expect(mac.computers).toHaveLength(0);
  });
});
