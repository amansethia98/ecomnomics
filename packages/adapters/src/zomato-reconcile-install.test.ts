import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { installZomatoReconcileCommand } from "./zomato-reconcile-install.js";

const script = path.resolve(
  import.meta.dirname,
  "../../../infra/sandboxes/computer/rakazo-zomato-reconcile",
);
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it("writes this release's reconciler once, and again when it differs", () => {
  root = mkdtempSync(path.join(tmpdir(), "zomato-reconcile-install-"));
  execFileSync("mkdir", ["-p", `${root}/usr/local/bin`]);
  const installed = `${root}/usr/local/bin/rakazo-zomato-reconcile`;
  const command = installZomatoReconcileCommand()
    .replaceAll("/usr/local", `${root}/usr/local`)
    .replaceAll('"sudo -n"', '""');

  execFileSync("bash", ["-c", command], { encoding: "utf8" });
  expect(readFileSync(installed, "utf8")).toBe(readFileSync(script, "utf8"));
  expect(statSync(installed).mode & 0o777).toBe(0o755);

  writeFileSync(installed, "edited");
  execFileSync("bash", ["-c", command], { encoding: "utf8" });
  expect(readFileSync(installed, "utf8")).toBe("edited");

  writeFileSync(`${root}/usr/local/lib/rakazo/zomato-reconcile.version`, "older");
  execFileSync("bash", ["-c", command], { encoding: "utf8" });
  expect(readFileSync(installed, "utf8")).toBe(readFileSync(script, "utf8"));
});
