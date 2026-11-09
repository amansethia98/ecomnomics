import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["test_zomato_reconcile.py", "test_zomato_monthly_analysis.py", "test_zomato_report.py"])(
  "runs %s without extra packages",
  (name) => {
    const tests = fileURLToPath(new URL(`../../computer/${name}`, import.meta.url));
    expect(() =>
      execFileSync("python3", [tests], { timeout: 20_000, stdio: "pipe" }),
    ).not.toThrow();
  },
);
