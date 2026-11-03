import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { computerHomeKey, SharedMachineSandboxError } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";
import { FakeWuyingDesktop } from "./wuying-sandbox.test-support.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "restaurant",
  userId: "owner",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restaurant computer providers", () => {
  it("keeps two restaurants on different machines and does not share their files", async () => {
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "true");
    const provider = new FakeSandboxProvider();
    const homeA = computerHomeKey({ mode: "team", spaceId: "restaurant-a", userId: "owner-a" });
    const homeB = computerHomeKey({ mode: "team", spaceId: "restaurant-b", userId: "owner-b" });
    const computerA = await provider.provision({ botId: homeA, homePath: "/a" }, ctx);
    const computerB = await provider.provision({ botId: homeB, homePath: "/b" }, ctx);
    expect(computerA.providerRef).not.toBe(computerB.providerRef);
    const menu = new TextEncoder().encode("tonight-special");
    await provider.writeFile(computerA, { path: "shared/menu.txt", content: menu }, ctx);
    await expect(provider.readFile(computerB, "shared/menu.txt", ctx)).rejects.toThrow(/not found/);
    expect(
      new TextDecoder().decode(await provider.readFile(computerA, "shared/menu.txt", ctx)),
    ).toBe("tonight-special");
  });

  it("does not start a shared desktop for two restaurants", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "false");
    const first = await provider.provision({ botId: "team-aaa", homePath: "/h" }, ctx);
    const second = await provider.provision({ botId: "team-bbb", homePath: "/h" }, ctx);
    expect(first.providerRef).toBe(second.providerRef);

    vi.stubEnv("RESTAURANT_COMPUTER_ENABLED", "true");
    const calls = desktop.calls.length;
    await expect(
      provider.provision({ botId: "team-ccc", homePath: "/h" }, ctx),
    ).rejects.toBeInstanceOf(SharedMachineSandboxError);
    expect(desktop.calls.length).toBe(calls);

    const root = mkdtempSync(path.join(tmpdir(), "restaurant-desktop-"));
    const host = new DesktopSandboxProvider({ root });
    await expect(
      host.provision({ botId: "team-ddd", homePath: path.join(root, "home") }, ctx),
    ).rejects.toBeInstanceOf(SharedMachineSandboxError);
    await expect(
      new NoneSandboxProvider().provision({ botId: "team-eee", homePath: "/h" }, ctx),
    ).rejects.toBeInstanceOf(SharedMachineSandboxError);
  });
});
