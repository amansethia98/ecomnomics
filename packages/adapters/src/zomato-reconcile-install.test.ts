import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { installZomatoComputerCommands } from "./zomato-reconcile-install.js";

const computer = path.resolve(import.meta.dirname, "../../../infra/sandboxes/computer");
const scripts = [
  "rakazo-zomato-reconcile",
  "rakazo-zomato-monthly-analysis",
  "rakazo-zomato-report",
  "payout-owner-reconcile",
  "payout-swiggy-reconcile",
  "payout-combined",
  "agent-v1-post",
].map((name) => path.join(computer, name));
const libraries = [
  "payout/reconcile_base.py",
  "payout/owner_reconcile.py",
  "payout/swiggy_reconcile.py",
  "payout/swiggy_math.py",
  "payout/combined_owner.py",
  "payout/outlet_map.py",
  "payout/reconciliation_policy.py",
  "payout/owner-confirmed-outlet-map.csv",
  "payout/examples/outlet-settings.example.json",
  "payout/examples/swiggy-settings.example.json",
].map((name) => path.join(computer, name));
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it("writes this release's Zomato scripts once, and again when they differ", () => {
  root = mkdtempSync(path.join(tmpdir(), "zomato-reconcile-install-"));
  execFileSync("mkdir", ["-p", `${root}/usr/local/bin`]);
  const command = installZomatoComputerCommands()
    .replaceAll("/usr/local", `${root}/usr/local`)
    .replaceAll('"sudo -n"', '""');

  execFileSync("bash", ["-c", command], { encoding: "utf8" });
  for (const script of scripts) {
    const installed = `${root}/usr/local/bin/${path.basename(script)}`;
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(script, "utf8"));
    expect(statSync(installed).mode & 0o777).toBe(0o755);
  }
  for (const library of libraries) {
    const installed = `${root}/usr/local/lib/rakazo/${path.relative(computer, library)}`;
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(library, "utf8"));
    expect(statSync(installed).mode & 0o777).toBe(0o644);
  }
  expect(
    readFileSync(
      `${root}/usr/local/lib/rakazo/payout/owner-confirmed-outlet-map.csv`,
      "utf8",
    ).trim(),
  ).toBe("outlet,locality,zomato_id,swiggy_rid");
  expect(
    readFileSync(
      `${root}/usr/local/share/payout-reconciliation/owner-confirmed-outlet-map.csv`,
      "utf8",
    ).trim(),
  ).toBe("outlet,locality,zomato_id,swiggy_rid");
  expect(
    readFileSync(
      `${root}/usr/local/share/payout-reconciliation/outlet-settings.example.json`,
      "utf8",
    ),
  ).toContain("<ZOMATO_RES_ID>");

  const reconciler = `${root}/usr/local/bin/rakazo-zomato-reconcile`;
  writeFileSync(reconciler, "edited");
  execFileSync("bash", ["-c", command], { encoding: "utf8" });
  expect(readFileSync(reconciler, "utf8")).toBe("edited");

  writeFileSync(`${root}/usr/local/lib/rakazo/zomato-scripts.version`, "older");
  execFileSync("bash", ["-c", command], { encoding: "utf8" });
  expect(readFileSync(reconciler, "utf8")).toBe(readFileSync(scripts[0] ?? "", "utf8"));
});
