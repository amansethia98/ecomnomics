import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "@playwright/test";

const execute = promisify(execFile);
const helper = path.resolve(
  import.meta.dirname,
  "../../../infra/sandboxes/computer/rakazo-page-browser",
);
const fixtures = path.resolve(
  import.meta.dirname,
  "../../../packages/testkit/src/page-browser-bench/fixtures",
);

test.skip(
  !process.env.CI && !process.env.RAKAZO_AGENT_BROWSER,
  "set RAKAZO_AGENT_BROWSER (infra/sandboxes/computer/install-agent-browser.sh)",
);

const BROWSER: { channel: "chromium"; headless: true } = { channel: "chromium", headless: true };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

test("covered clicks recover and downloads land without a dialog", async () => {
  test.setTimeout(120_000);
  const home = await mkdtemp(path.join(os.tmpdir(), "page-browser-reliability-"));
  const profile = path.join(home, "profile");
  const httpPort = await freePort();
  const server: ChildProcess = spawn(
    "python3",
    [path.join(fixtures, "server.py"), "--http", String(httpPort)],
    { stdio: "ignore" },
  );
  const base = `http://127.0.0.1:${httpPort}`;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 10_000 });
    const page = context.pages()[0]!;

    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: {
          ...process.env,
          HOME: home,
          RAKAZO_CDP_PORT: port,
          RAKAZO_DOWNLOAD_HOLD: "0",
        },
        timeout: 40_000,
      });
      return JSON.parse(stdout) as {
        ok?: boolean;
        note?: string;
        error?: string;
        elements?: { name: string; ref: string }[];
        downloads?: { name?: string; path?: string; state?: string; error?: string }[];
      };
    }
    const ref = (snapshot: { elements?: { name: string; ref: string }[] }, name: string) => {
      const found = snapshot.elements?.find((element) => element.name === name);
      expect(found, name).toBeTruthy();
      return found!.ref;
    };
    async function submitted(run: string) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const response = await fetch(`${base}/__submissions?run=${run}`);
        const found = (await response.json()) as { fields: Record<string, string> }[];
        if (found.length) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return [];
    }

    await page.goto(`${base}/covered.html?run=covered`);
    const covered = await command("snapshot");
    const coveredAct = await command("act", {
      actions: [{ kind: "click", ref: ref(covered, "Save payout") }],
    });
    expect(coveredAct.ok).toBe(true);
    expect(coveredAct.note).toMatch(/Covered by/);
    expect(coveredAct.note).toMatch(/Scrolled|directly|clear point/);
    expect(await submitted("covered")).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ saved: "1" }) }),
    ]);

    await page.goto(`${base}/toast.html?run=toast`);
    const toast = await command("snapshot");
    const toastAct = await command("act", {
      actions: [{ kind: "click", ref: ref(toast, "Get report") }],
    });
    expect(toastAct.ok).toBe(true);
    expect(toastAct.note).toContain("Dismissed Close");
    expect(await submitted("toast")).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ report: "1" }) }),
    ]);

    await page.goto(`${base}/mask.html?run=mask`);
    const mask = await command("snapshot");
    const maskAct = await command("act", {
      actions: [{ kind: "click", ref: ref(mask, "Get report") }],
    });
    expect(maskAct.ok).toBe(true);
    expect(maskAct.note).toMatch(/directly/);
    expect(await submitted("mask")).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ report: "1" }) }),
    ]);

    await page.goto(`${base}/otp-frame.html?run=otp`);
    const otp = await command("snapshot");
    expect(otp.elements?.some((element) => element.name === "Code 1")).toBe(true);
    expect(otp.elements?.some((element) => element.name === "Code 6")).toBe(true);
    expect(
      await command("act", { actions: [{ kind: "type", ref: ref(otp, "Code 1"), text: "482913" }] }),
    ).toMatchObject({ ok: true });
    const frame = page.frameLocator("iframe");
    for (const [index, digit] of Array.from("482913").entries()) {
      await expect(frame.getByLabel(`Code ${index + 1}`)).toHaveValue(digit);
    }
    expect(await submitted("otp")).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ code: "482913" }) }),
    ]);

    await page.goto(`${base}/download-blob.html?run=blob`);
    const blob = await command("snapshot");
    const blobAct = await command("act", {
      actions: [{ kind: "click", ref: ref(blob, "Download report") }],
      downloads: "Downloads",
    });
    expect(blobAct.downloads).toEqual([
      expect.objectContaining({ name: "payout.csv", path: "Downloads/payout.csv" }),
    ]);
    expect(blobAct.downloads?.[0]?.state).toBeUndefined();
    expect(await readFile(path.join(home, "Downloads", "payout.csv"), "utf8")).toContain("outlet,amount");

    await page.goto(`${base}/download-tab.html?run=tab`);
    const tab = await command("snapshot", { downloads: "Downloads" });
    const tabAct = await command("act", {
      actions: [{ kind: "click", ref: ref(tab, "Download report") }],
      downloads: "Downloads",
    });
    const listed = [...(tab.downloads ?? []), ...(tabAct.downloads ?? [])];
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "report.csv", path: "Downloads/report.csv" }),
      ]),
    );
    expect(await readFile(path.join(home, "Downloads", "report.csv"), "utf8")).toContain("outlet,amount");
  } finally {
    await context?.close();
    if (server.exitCode === null) server.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
});
