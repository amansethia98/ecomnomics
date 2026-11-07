/**
 * Run scripted page-browser tasks on this machine and record time and success.
 *
 * `pnpm bench:browser-tasks --fixtures` runs the built-in reliability pages
 * (covered clicks, a framed code, and downloads) in headless Chrome.
 * `pnpm bench:browser-tasks --tasks <file.json>` runs a list of tasks in the
 * same shape as the page-browser benchmark's tasks. Needs python3, Chrome,
 * and the pinned agent-browser binary (RAKAZO_AGENT_BROWSER or
 * /usr/local/bin/agent-browser).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserDownload, PageBrowserCommand, PageBrowserResult } from "@rakazo/adapter-kit";
import {
  RELIABILITY_TASK_IDS,
  TASKS,
  runTask,
  type BenchTask,
  type Submission,
} from "../page-browser-bench/tasks.js";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const helper = path.join(root, "infra/sandboxes/computer/rakazo-page-browser");
const fixtures = path.join(root, "packages/testkit/src/page-browser-bench/fixtures");
const USAGE = `Usage: pnpm bench:browser-tasks (--fixtures | --tasks=<file.json>) [--out=<file.json>]
  --fixtures          Run the built-in reliability tasks
  --tasks=<file.json> Run a JSON list of tasks (id, covers, steps, expect)
  --out=<file.json>   Results file (default: browser-task-bench.json)`;

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

async function chromeBin(): Promise<string> {
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const { stdout } = await execute("sh", ["-c", `command -v ${name}`]);
      const found = stdout.trim();
      if (found) return found;
    } catch {
      // try the next name
    }
  }
  throw new Error("no Chrome or Chromium found");
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const option = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const fixturesOnly = args.includes("--fixtures");
  const tasksFile = option("tasks");
  if (fixturesOnly === Boolean(tasksFile)) throw new Error(USAGE);
  const tasks: BenchTask[] = fixturesOnly
    ? TASKS.filter((task) =>
        (RELIABILITY_TASK_IDS as readonly string[]).includes(task.id),
      )
    : (JSON.parse(await readFile(tasksFile!, "utf8")) as BenchTask[]);
  const out = option("out") ?? "browser-task-bench.json";

  const home = await mkdtemp(path.join(tmpdir(), "browser-tasks-"));
  const profile = path.join(home, "profile");
  const httpPort = await freePort();
  const server = spawn("python3", [path.join(fixtures, "server.py"), "--http", String(httpPort)], {
    stdio: "ignore",
  });
  let chrome: ChildProcess | undefined;
  try {
    const bin = await chromeBin();
    chrome = spawn(
      bin,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let port = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
        if (/^\d+$/.test(port)) break;
      } catch {
        // Chrome is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!/^\d+$/.test(port)) throw new Error("Chrome did not open a debugging port");

    const base = `http://127.0.0.1:${httpPort}`;
    const rows: Array<{
      id: string;
      ok: boolean;
      ms: number;
      error?: string;
      downloads: BrowserDownload[];
    }> = [];
    for (const task of tasks) {
      const seen: BrowserDownload[] = [];
      const driver = async (command: PageBrowserCommand) => {
        let stdout: string;
        try {
          ({ stdout } = await execute("python3", [helper, command.command, JSON.stringify(command)], {
            env: {
              ...process.env,
              HOME: home,
              RAKAZO_CDP_PORT: port,
              RAKAZO_DOWNLOAD_HOLD: "0",
            },
            timeout: 45_000,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            error: message.slice(0, 500),
            fallback: "computer_act" as const,
          };
        }
        const result = JSON.parse(stdout) as PageBrowserResult;
        if (Array.isArray(result.downloads)) seen.push(...result.downloads);
        return result;
      };
      const submissions = async (runId: string) => {
        const response = await fetch(`${base}/__submissions?run=${runId}`);
        return (await response.json()) as Submission[];
      };
      const started = Date.now();
      const record = await runTask(task, randomUUID().slice(0, 8), driver, submissions, base);
      const detail = record.steps.find((step) => step.error)?.error;
      const row = {
        id: task.id,
        ok: record.success,
        ms: Date.now() - started,
        ...(record.failure ? { error: detail ? `${record.failure}: ${detail}` : record.failure } : {}),
        downloads: seen,
      };
      rows.push(row);
      console.error(`${task.id}: ${row.ok ? "ok" : `FAIL (${row.error})`} ${row.ms}ms`);
    }
    await writeFile(out, `${JSON.stringify({ tasks: rows }, null, 2)}\n`);
    console.log(out);
    if (rows.some((row) => !row.ok)) process.exitCode = 1;
  } finally {
    await stop(chrome);
    await stop(server);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
