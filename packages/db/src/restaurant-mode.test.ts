import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { ensureComputerRecord } from "./computers.js";
import { createRepos } from "./repos.js";
import {
  DedicatedComputerDisabledError,
  restaurantComputerEnabled,
  restaurantComputerMode,
  restaurantSignupEnabled,
  restaurantStarterBotsEnabled,
  SharedMachineSandboxError,
  sandboxSharesOneMachine,
} from "./restaurant-mode.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restaurant settings", () => {
  it("stays off unless the setting is exactly true", () => {
    expect(restaurantComputerEnabled({})).toBe(false);
    expect(restaurantComputerEnabled({ RESTAURANT_COMPUTER_ENABLED: "false" })).toBe(false);
    expect(restaurantComputerEnabled({ RESTAURANT_COMPUTER_ENABLED: "1" })).toBe(false);
    expect(restaurantComputerEnabled({ RESTAURANT_COMPUTER_ENABLED: "true" })).toBe(true);
    expect(restaurantStarterBotsEnabled({ RESTAURANT_STARTER_BOTS_ENABLED: "true" })).toBe(true);
    expect(restaurantStarterBotsEnabled({})).toBe(false);
    expect(restaurantSignupEnabled({})).toBe(false);
    expect(restaurantSignupEnabled({ RESTAURANT_SIGNUP_ENABLED: "false" })).toBe(false);
    expect(restaurantSignupEnabled({ RESTAURANT_SIGNUP_ENABLED: "true" })).toBe(true);
  });

  it("keeps one shared computer when restaurant computers are on", () => {
    const on = { RESTAURANT_COMPUTER_ENABLED: "true" };
    expect(restaurantComputerMode("dedicated", on)).toBe("team");
    expect(restaurantComputerMode("team", on)).toBe("team");
    expect(restaurantComputerMode(undefined, {})).toBe("team");
    expect(restaurantComputerMode("dedicated", {})).toBe("dedicated");
  });

  it("allows a machine per workspace and refuses a shared machine", () => {
    for (const kind of [
      "docker",
      "e2b",
      "daytona",
      "novita",
      "createos",
      "boat",
      "boxd",
      "railway",
      "kubernetes",
      "fake",
    ]) {
      expect(sandboxSharesOneMachine(kind)).toBe(false);
    }
    for (const kind of ["wuying", "desktop", "none"]) {
      expect(sandboxSharesOneMachine(kind)).toBe(true);
    }
  });

  it("does not record a computer on a shared machine when restaurant computers are on", async () => {
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "true");
    const prisma = { computer: { upsert: vi.fn() } } as unknown as PrismaClient;
    await expect(
      ensureComputerRecord(prisma, {
        mode: "team",
        spaceId: "space-a",
        userId: "owner-a",
        kind: "wuying",
      }),
    ).rejects.toBeInstanceOf(SharedMachineSandboxError);
    expect(prisma.computer.upsert).not.toHaveBeenCalled();
  });

  it("still records a computer on a shared machine when the setting is off", async () => {
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "false");
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "");
    const prisma = {
      computer: { upsert: vi.fn(async (args: { create: { kind: string } }) => args.create) },
    } as unknown as PrismaClient;
    await ensureComputerRecord(prisma, {
      mode: "team",
      spaceId: "space-a",
      userId: "owner-a",
      kind: "wuying",
    });
    expect(prisma.computer.upsert).toHaveBeenCalledOnce();
  });

  it("refuses a private computer when restaurant computers are on", async () => {
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "true");
    const repos = createRepos({} as PrismaClient);
    await expect(
      repos.setBotComputer(
        {
          userId: "owner-a",
          spaceId: "space-a",
          email: "owner-a@restaurant.test",
          isDeploymentOwner: false,
        },
        "bot-1",
        "dedicated",
      ),
    ).rejects.toBeInstanceOf(DedicatedComputerDisabledError);
  });
});
