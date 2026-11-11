import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EncryptedBrowserSessionStore,
  runBrowserSession,
  sessionMasterKey,
} from "./browser-sessions.js";

// Entirely synthetic: no restaurant identity, real cookie, key, phone or date.
const key = Buffer.alloc(32, 7);
const bundle = {
  cookies: [{ name: "SYNTHETIC_COOKIE", value: "SYNTHETIC_TOKEN" }],
  localStorage: [["SYNTHETIC_KEY", "SYNTHETIC_VALUE"]],
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake-browser-session-"));
  directories.push(root);
  return root;
}
const location = (root: string, tenant: string, platform = "swiggy") =>
  path.join(root, createHash("sha256").update(tenant).digest("hex"), `${platform}.session.enc`);

describe("encrypted browser session store", () => {
  it("writes only ciphertext, mode 0600 files and mode 0700 directories", async () => {
    const root = await fixture();
    const store = new EncryptedBrowserSessionStore(root, key);
    await store.save("SYNTHETIC_TENANT_A", "swiggy", bundle);
    const file = location(root, "SYNTHETIC_TENANT_A");
    expect(await store.load("SYNTHETIC_TENANT_A", "swiggy")).toEqual(bundle);
    expect(await readFile(file, "utf8")).not.toContain("SYNTHETIC_TOKEN");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readdir(path.dirname(file))).toEqual(["swiggy.session.enc"]);
  });
  it("rejects copied cross-tenant and cross-platform envelopes and wrong keys", async () => {
    const root = await fixture();
    const store = new EncryptedBrowserSessionStore(root, key);
    await store.save("SYNTHETIC_TENANT_A", "swiggy", bundle);
    const source = location(root, "SYNTHETIC_TENANT_A");
    const other = location(root, "SYNTHETIC_TENANT_B");
    await mkdir(path.dirname(other), { mode: 0o700 });
    await copyFile(source, other);
    expect(await store.load("SYNTHETIC_TENANT_B", "swiggy")).toBeNull();
    await copyFile(source, location(root, "SYNTHETIC_TENANT_A", "zomato"));
    expect(await store.load("SYNTHETIC_TENANT_A", "zomato")).toBeNull();
    expect(
      await new EncryptedBrowserSessionStore(root, Buffer.alloc(32, 8)).load(
        "SYNTHETIC_TENANT_A",
        "swiggy",
      ),
    ).toBeNull();
  });
  it("expires after a day and rejects tampering without exposing payloads", async () => {
    const root = await fixture();
    let clock = 1000;
    const store = new EncryptedBrowserSessionStore(root, key, () => clock);
    await store.save("SYNTHETIC_TENANT_A", "zomato", bundle);
    clock += 24 * 60 * 60 * 1000;
    expect(await store.load("SYNTHETIC_TENANT_A", "zomato")).toBeNull();
    await writeFile(location(root, "SYNTHETIC_TENANT_A", "zomato"), "SYNTHETIC_CORRUPT_FILE", {
      mode: 0o600,
    });
    expect(await store.load("SYNTHETIC_TENANT_A", "zomato")).toBeNull();
  });
  it("will not follow a symlinked session file", async () => {
    const root = await fixture();
    const store = new EncryptedBrowserSessionStore(root, key);
    const file = location(root, "SYNTHETIC_TENANT_A");
    await mkdir(path.dirname(file), { mode: 0o700 });
    await symlink(path.join(root, "nonexistent-fake-target"), file);
    expect(await store.load("SYNTHETIC_TENANT_A", "swiggy")).toBeNull();
  });
  it("requires an explicit supervisor-only 32-byte key", () => {
    expect(() => sessionMasterKey({})).toThrow("Session key unavailable");
    expect(sessionMasterKey({ RAKAZO_BROWSER_SESSIONS_KEY: key.toString("base64") })).toEqual(key);
  });
});

describe("opt-in session broker", () => {
  it("does absolutely nothing when disabled, including key/store/transport access", async () => {
    const store = vi.fn();
    const native = vi.fn();
    expect(
      await runBrowserSession({
        enabled: false,
        tenant: "SYNTHETIC_TENANT_A",
        platform: "swiggy",
        command: "restore",
        store,
        native,
      }),
    ).toEqual({ status: "disabled" });
    expect(store).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
  it("requires live sign-in verification to save and returns no private material", async () => {
    const store = { save: vi.fn(), load: vi.fn() };
    const native = vi.fn().mockResolvedValue({ status: "captured", bundle });
    const input = {
      enabled: true,
      tenant: "SYNTHETIC_TENANT_A",
      platform: "zomato" as const,
      command: "save" as const,
      store: () => store,
      native,
    };
    expect(await runBrowserSession(input)).toEqual({ status: "live_verification_required" });
    expect(native).not.toHaveBeenCalled();
    expect(await runBrowserSession({ ...input, verifiedSignedIn: true })).toEqual({
      status: "saved",
    });
    expect(store.save).toHaveBeenCalledWith("SYNTHETIC_TENANT_A", "zomato", bundle);
  });
  it("treats restore as requiring a real page check, not proof of authentication", async () => {
    const store = { save: vi.fn(), load: vi.fn().mockResolvedValue(bundle) };
    const native = vi
      .fn()
      .mockResolvedValue({ status: "verify_live_page", unexpectedSecret: "SYNTHETIC_TOKEN" });
    const input = {
      enabled: true,
      tenant: "SYNTHETIC_TENANT_A",
      platform: "swiggy" as const,
      command: "restore" as const,
      store: () => store,
      native,
    };
    expect(await runBrowserSession(input)).toEqual({
      status: "verify_live_page",
      fallback: "proven_login_if_expired",
    });
    native.mockResolvedValue({ status: "proven_login_required" });
    expect(await runBrowserSession(input)).toEqual({ status: "proven_login_required" });
    native.mockRejectedValue(new Error("SYNTHETIC_TOKEN"));
    expect(JSON.stringify(await runBrowserSession(input))).not.toContain("SYNTHETIC_TOKEN");
    store.load.mockResolvedValue(null);
    native.mockClear();
    expect((await runBrowserSession(input)).status).toBe("use_current_profile");
    expect(native).not.toHaveBeenCalled();
  });
});
