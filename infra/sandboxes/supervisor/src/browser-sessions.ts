import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const browserSessionRequestSchema = z.object({
  command: z.enum(["save", "restore"]),
  platform: z.enum(["zomato", "swiggy"]),
  // The caller must first verify the signed-in outlet using the ordinary live browser.
  verifiedSignedIn: z.literal(true).optional(),
});
export type SessionPlatform = "zomato" | "swiggy";
export const SESSION_MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const context = (tenant: string, platform: SessionPlatform) =>
  Buffer.from(JSON.stringify({ version: 1, tenant, platform }));

export function sessionMasterKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.RAKAZO_BROWSER_SESSIONS_KEY ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error("Session key unavailable");
  return key;
}

/** Supervisor-only storage. Never mounted into a bot's computer or returned by an API. */
export class EncryptedBrowserSessionStore {
  constructor(
    private root: string,
    private masterKey: Buffer,
    private now = Date.now,
  ) {
    if (masterKey.length !== 32) throw new Error("Session key unavailable");
  }

  private location(tenant: string, platform: SessionPlatform) {
    const directory = path.join(this.root, createHash("sha256").update(tenant).digest("hex"));
    return { directory, file: path.join(directory, `${platform}.session.enc`) };
  }

  private key(tenant: string, platform: SessionPlatform) {
    return Buffer.from(
      hkdfSync("sha256", this.masterKey, context(tenant, platform), "browser-session-v1", 32),
    );
  }

  private async privateDirectory(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid session directory");
    await chmod(directory, 0o700);
  }

  async save(tenant: string, platform: SessionPlatform, bundle: unknown) {
    const payload = Buffer.from(JSON.stringify({ savedAt: this.now(), bundle }));
    if (payload.length > SESSION_MAX_BYTES) throw new Error("Session too large");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(tenant, platform), nonce);
    cipher.setAAD(context(tenant, platform));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const { directory, file } = this.location(tenant, platform);
    await this.privateDirectory(this.root);
    await this.privateDirectory(directory);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(envelope);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async load(tenant: string, platform: SessionPlatform): Promise<unknown | null> {
    const { directory, file } = this.location(tenant, platform);
    try {
      for (const entry of [this.root, directory]) {
        const stat = await lstat(entry);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) return null;
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let envelope: { version: number; nonce: string; tag: string; ciphertext: string };
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > SESSION_MAX_BYTES * 2) return null;
        envelope = JSON.parse(await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
      if (envelope.version !== 1) return null;
      const nonce = Buffer.from(envelope.nonce, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      if (nonce.length !== 12 || tag.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key(tenant, platform), nonce);
      decipher.setAAD(context(tenant, platform));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      if (plaintext.length > SESSION_MAX_BYTES) return null;
      const value = JSON.parse(plaintext.toString("utf8"));
      const age = this.now() - value.savedAt;
      if (!Number.isFinite(age) || age < 0 || age >= MAX_AGE_MS) return null;
      return value.bundle;
    } catch {
      // Missing, expired, tampered, cross-tenant or wrong-key artifacts all fall back safely.
      return null;
    }
  }
}

type NativeSession = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type SessionStore = Pick<EncryptedBrowserSessionStore, "save" | "load">;

/** Only status is returned. Cookie/storage payloads stay inside the trusted supervisor. */
export async function runBrowserSession(input: {
  enabled: boolean;
  tenant: string;
  command: "save" | "restore";
  platform: SessionPlatform;
  verifiedSignedIn?: boolean;
  store: () => SessionStore;
  native: NativeSession;
}) {
  if (!input.enabled) return { status: "disabled" };
  try {
    const store = input.store();
    if (input.command === "save") {
      if (!input.verifiedSignedIn) return { status: "live_verification_required" };
      const captured = await input.native({ command: "capture", platform: input.platform });
      if (captured.status !== "captured" || !captured.bundle)
        return { status: "proven_login_required" };
      await store.save(input.tenant, input.platform, captured.bundle);
      return { status: "saved" };
    }
    const bundle = await store.load(input.tenant, input.platform);
    if (!bundle) return { status: "use_current_profile", fallback: "inspect_then_proven_login" };
    const restored = await input.native({ command: "restore", platform: input.platform, bundle });
    if (restored.status === "proven_login_required") return { status: "proven_login_required" };
    if (restored.status === "use_current_profile") return { status: "use_current_profile" };
    return { status: "verify_live_page", fallback: "proven_login_if_expired" };
  } catch {
    // Never propagate CDP/helper/storage errors: they may contain authentication material.
    return { status: "use_current_profile", fallback: "inspect_then_proven_login" };
  }
}
