import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

it("runs the payout calculators on synthetic files", () => {
  const root = fileURLToPath(new URL("../../computer/payout", import.meta.url));
  expect(() =>
    execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests"], {
      cwd: root,
      timeout: 60_000,
      stdio: "pipe",
    }),
  ).not.toThrow();
});

it("ships the owner outlet map as a header with no confirmed rows", () => {
  const map = fileURLToPath(
    new URL("../../computer/payout/owner-confirmed-outlet-map.csv", import.meta.url),
  );
  expect(readFileSync(map, "utf8").trim()).toBe("outlet,locality,zomato_id,swiggy_rid");
  const zomato = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../computer/payout/examples/outlet-settings.example.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { outlet_id: string; outlets: Record<string, { onboarding_rate_percent: number | null }> };
  expect(zomato.outlet_id).toBe("<ZOMATO_RES_ID>");
  expect(zomato.outlets["<ZOMATO_RES_ID>"]?.onboarding_rate_percent).toBeNull();
});
