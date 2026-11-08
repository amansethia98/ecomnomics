import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reconciles a synthetic Zomato settlement without extra packages", () => {
  const tests = fileURLToPath(new URL("../../computer/test_zomato_reconcile.py", import.meta.url));
  expect(() => execFileSync("python3", [tests], { timeout: 20_000, stdio: "pipe" })).not.toThrow();
});
