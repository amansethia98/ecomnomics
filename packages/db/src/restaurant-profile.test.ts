import type { Actor, RestaurantOnboardingInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  beginRestaurantProfile,
  RESTAURANT_MENU_PATH,
  RESTAURANT_OUTLETS_PATH,
  RESTAURANT_PROFILE_PATH,
  RestaurantProfileError,
  restaurantCounts,
  restaurantKnowledgeDocuments,
  saveRestaurantProfile,
} from "./restaurant-profile.js";
import { SpaceDeletionInProgressError } from "./spaces.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "ana@harbor.test",
  isDeploymentOwner: false,
};

const input: RestaurantOnboardingInput = {
  name: "Harbor Grill",
  cuisine: "Seafood",
  city: "Lisbon",
  contactName: "Ana Costa",
  contactEmail: "ana@harbor.test",
  contactPhone: "",
  outlets: [
    { name: "Riverside", address: "1 Dock Street", openingHours: "Tue–Sun 12:00–23:00" },
    { name: "Airport", address: "Terminal 2", openingHours: "Daily 08:00–22:00" },
  ],
  menuText: "Grilled fish",
  menuFileName: "../../menu.txt",
};

type Outlet = { id: string; name: string; address: string; openingHours: string; position: number };
type Doc = { id: string; path: string; content: string; revision: number };

function memoryPrisma(options: { role?: string | null; deleting?: boolean } = {}) {
  const state = {
    role: options.role === undefined ? "owner" : options.role,
    deletingAt: options.deleting ? new Date() : null,
    profile: null as Record<string, unknown> | null,
    outlets: [] as Outlet[],
    docs: [] as Doc[],
    spaceName: "Personal",
    orgName: "Personal",
    orgId: null as string | null,
  };
  let docs = 0;
  const botCount = vi.fn(async () => 4);
  const tx = {
    $queryRaw: async () => [],
    spaceMember: {
      findUnique: async () =>
        state.role
          ? {
              role: state.role,
              organizationId: "org-1",
              space: { deletingAt: state.deletingAt },
            }
          : null,
    },
    restaurantProfile: {
      findUnique: async () => (state.profile ? { ...state.profile, outlets: state.outlets } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.profile = { ...data };
        return state.profile;
      },
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        state.profile = { ...(state.profile ?? create), ...update };
        return state.profile;
      },
    },
    restaurantOutlet: {
      deleteMany: async () => {
        const count = state.outlets.length;
        state.outlets = [];
        return { count };
      },
      createMany: async ({ data }: { data: Outlet[] }) => {
        state.outlets = data;
        return { count: data.length };
      },
      count: async () => state.outlets.length,
    },
    space: {
      update: async ({ data }: { data: { name: string } }) => {
        state.spaceName = data.name;
      },
    },
    organization: {
      update: async ({ where, data }: { where: { id: string }; data: { name: string } }) => {
        state.orgId = where.id;
        state.orgName = data.name;
      },
    },
    memoryDocument: {
      deleteMany: async ({ where }: { where: { path: string } }) => {
        const before = state.docs.length;
        state.docs = state.docs.filter((doc) => doc.path !== where.path);
        return { count: before - state.docs.length };
      },
      findFirst: async ({ where }: { where: { path: string } }) =>
        state.docs.find((doc) => doc.path === where.path) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { content: string; revision: number };
      }) => {
        const doc = state.docs.find((item) => item.id === where.id);
        if (!doc) return null;
        doc.content = data.content;
        doc.revision = data.revision;
        return doc;
      },
      create: async ({ data }: { data: { path: string; content: string } }) => {
        const doc = { id: `doc-${docs++}`, path: data.path, content: data.content, revision: 1 };
        state.docs.push(doc);
        return doc;
      },
    },
    bot: { count: botCount },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    restaurantProfile: tx.restaurantProfile,
    restaurantOutlet: tx.restaurantOutlet,
    bot: tx.bot,
    memoryDocument: tx.memoryDocument,
  };
  return { prisma: prisma as unknown as PrismaClient, state, botCount };
}

describe("restaurant knowledge", () => {
  it("writes the restaurant, each outlet, and the menu for every bot in the workspace", () => {
    const documents = restaurantKnowledgeDocuments({
      ...input,
      menuFileName: "menu.txt",
    });
    expect(documents.map((document) => document.path)).toEqual([
      RESTAURANT_PROFILE_PATH,
      RESTAURANT_OUTLETS_PATH,
      RESTAURANT_MENU_PATH,
    ]);
    expect(documents[0]?.content).toContain("Name: Harbor Grill");
    expect(documents[0]?.content).toContain("Cuisine: Seafood");
    expect(documents[0]?.content).toContain("City: Lisbon");
    expect(documents[0]?.content).toContain("Email: ana@harbor.test");
    expect(documents[1]?.content).toContain("## 1. Riverside");
    expect(documents[1]?.content).toContain("Address: 1 Dock Street");
    expect(documents[1]?.content).toContain("Opening hours: Tue–Sun 12:00–23:00");
    expect(documents[1]?.content).toContain("## 2. Airport");
    expect(documents[2]?.content).toContain("File: menu.txt");
    expect(documents[2]?.content).toContain("Grilled fish");
  });

  it("leaves the menu document out when there is no menu", () => {
    const documents = restaurantKnowledgeDocuments({
      ...input,
      menuText: "  ",
      menuFileName: null,
    });
    expect(documents.map((document) => document.path)).toEqual([
      RESTAURANT_PROFILE_PATH,
      RESTAURANT_OUTLETS_PATH,
    ]);
  });
});

describe("restaurant onboarding save", () => {
  it("names the workspace, stores outlets, and gives the menu to the bots", async () => {
    const { prisma, state } = memoryPrisma();
    const saved = await saveRestaurantProfile(prisma, actor, input);
    expect(saved.completed).toBe(true);
    expect(saved.menuFileName).toBe("menu.txt");
    expect(saved.outlets.map((outlet) => outlet.name)).toEqual(["Riverside", "Airport"]);
    expect(state.spaceName).toBe("Harbor Grill");
    expect(state.orgName).toBe("Harbor Grill");
    expect(state.orgId).toBe("org-1");
    expect(state.outlets).toHaveLength(2);
    expect(state.docs.map((doc) => doc.path).sort()).toEqual(
      [RESTAURANT_MENU_PATH, RESTAURANT_OUTLETS_PATH, RESTAURANT_PROFILE_PATH].sort(),
    );
    expect(state.docs.find((doc) => doc.path === RESTAURANT_MENU_PATH)?.content).toContain(
      "File: menu.txt",
    );
  });

  it("drops a removed menu and still does not limit how many bots exist", async () => {
    const { prisma, state, botCount } = memoryPrisma();
    await saveRestaurantProfile(prisma, actor, input);
    await saveRestaurantProfile(prisma, actor, { ...input, menuText: "", menuFileName: null });
    expect(state.docs.map((doc) => doc.path)).not.toContain(RESTAURANT_MENU_PATH);
    await expect(restaurantCounts(prisma, actor.spaceId)).resolves.toEqual({ bots: 4, outlets: 2 });
    expect(botCount).toHaveBeenCalledWith({ where: { spaceId: "space-1", archivedAt: null } });
  });

  it("refuses a blank name before writing", async () => {
    const { prisma } = memoryPrisma();
    await expect(saveRestaurantProfile(prisma, actor, { ...input, name: "!!!" })).rejects.toThrow(
      RestaurantProfileError,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("lets only the owner start or save a restaurant", async () => {
    const member = memoryPrisma({ role: "member" });
    await expect(beginRestaurantProfile(member.prisma, actor)).rejects.toThrow(
      /Only the restaurant owner/,
    );
    const stranger = memoryPrisma({ role: null });
    await expect(saveRestaurantProfile(stranger.prisma, actor, input)).rejects.toThrow(
      /not found/i,
    );
    const deleting = memoryPrisma({ deleting: true });
    await expect(beginRestaurantProfile(deleting.prisma, actor)).rejects.toBeInstanceOf(
      SpaceDeletionInProgressError,
    );
  });

  it("starts an empty restaurant the welcome form can finish", async () => {
    const { prisma, state } = memoryPrisma();
    const started = await beginRestaurantProfile(prisma, actor);
    expect(started.completed).toBe(false);
    expect(started.name).toBe("");
    expect(state.profile).toMatchObject({ organizationId: "org-1", name: "" });
    const again = await beginRestaurantProfile(prisma, actor);
    expect(again.completed).toBe(false);
  });
});
