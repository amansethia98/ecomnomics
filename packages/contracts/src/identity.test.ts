import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkObservedIdentity, parsePeriodLabel } from "./identity.js";

describe("identity entry", () => {
  it("parses a column label into an exclusive end without loading a workbook parser", () => {
    const source = readFileSync(new URL("./identity.ts", import.meta.url), "utf8");
    expect(source).not.toContain("exceljs");
    expect(source).not.toContain("payout-parse");
    const expected = {
      platform: "zomato" as const,
      report: "daily" as const,
      restaurantId: "900002",
      name: "Test Kitchen",
      city: "Testcity",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-02",
    };
    expect(parsePeriodLabel("01 Oct, 2026", expected)).toEqual({
      start: "2026-10-01",
      end: "2026-10-02",
      label: "01 Oct, 2026",
    });
    expect(
      parsePeriodLabel("2nd Nov 2026", { ...expected, platform: "swiggy", report: "daily" }),
    ).toEqual({ start: "2026-11-02", end: "2026-11-03", label: "2nd Nov 2026" });
    expect(
      checkObservedIdentity(
        {
          restaurantId: "900002",
          name: "Test Kitchen",
          city: "Testcity",
          periods: [{ start: "2026-10-01", end: "2026-10-02", label: "01 Oct, 2026" }],
        },
        expected,
      ).reject,
    ).toBeNull();
  });
});
