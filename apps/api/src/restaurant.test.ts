import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "ana@harbor.test",
  isDeploymentOwner: false,
};

const onboarding = {
  name: "Harbor Grill",
  cuisine: "Seafood",
  city: "Lisbon",
  contactName: "Ana Costa",
  contactEmail: "ana@harbor.test",
  contactPhone: "",
  outlets: [{ name: "Riverside", address: "1 Dock Street", openingHours: "Daily 12:00–23:00" }],
  menuText: "",
  menuFileName: null,
};

function client(
  env: {
    restaurantSignupEnabled?: boolean;
    defaultProvider?: string;
    defaultModel?: string;
    sandboxProvider?: string;
  },
  prisma: unknown = {},
) {
  return createRouterClient(createRouter({ prisma, env } as unknown as RouterDeps), {
    context: { actor },
  });
}

describe("restaurant routes", () => {
  it("stays closed until restaurant signup is turned on", async () => {
    const query = vi.fn(() => {
      throw new Error("Unexpected database access");
    });
    const prisma = new Proxy({}, { get: () => query });
    const api = client({ restaurantSignupEnabled: false }, prisma);
    await expect(api.restaurant.get()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.restaurant.begin()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.restaurant.counts()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.restaurant.save(onboarding)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns bot and outlet counts without refusing the read", async () => {
    const prisma = {
      bot: { count: vi.fn(async () => 2) },
      restaurantOutlet: { count: vi.fn(async () => 3) },
    };
    const api = client({ restaurantSignupEnabled: true }, prisma);
    await expect(api.restaurant.counts()).resolves.toEqual({ bots: 2, outlets: 3 });
    expect(prisma.bot.count).toHaveBeenCalledWith({
      where: { spaceId: "space-1", archivedAt: null },
    });
  });

  it("tells me when welcome is unfinished", async () => {
    const findUnique = vi.fn(async () => ({ completedAt: null }));
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn(async () => ({
          email: actor.email,
          name: "Ana",
          signupSurvey: null,
        })),
      },
      userModelPreference: { findFirst: vi.fn(async () => null) },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: vi.fn(async () => []) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      restaurantProfile: { findUnique },
    };
    const modelEnv = {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      sandboxProvider: "fake",
    };
    const enabled = client({ restaurantSignupEnabled: true, ...modelEnv }, prisma);
    await expect(enabled.me()).resolves.toMatchObject({ needsRestaurantWelcome: true });
    const disabled = client({ restaurantSignupEnabled: false, ...modelEnv }, prisma);
    await expect(disabled.me()).resolves.toMatchObject({ needsRestaurantWelcome: false });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
