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
    const matched = checkObservedIdentity(
      {
        restaurantId: "900002",
        name: "Test Kitchen",
        city: "Testcity",
        periods: [{ start: "2026-10-01", end: "2026-10-02", label: "01 Oct, 2026" }],
      },
      expected,
    );
    expect(matched.ok).toBe(true);
    if (matched.ok) expect(matched.missingPeriods).toEqual([]);
  });

  it("accepts a requested period that is absent and rejects a period that is not", () => {
    const expected = {
      platform: "swiggy" as const,
      report: "daily" as const,
      restaurantId: "900001",
      name: "Test Kitchen",
      city: "Testcity",
      periodStart: "2026-11-02",
      periodEnd: "2026-11-05",
    };
    const period = (start: string) => {
      const date = new Date(`${start}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + 1);
      return { start, end: date.toISOString().slice(0, 10), label: start };
    };
    const observed = (starts: string[]) => ({
      restaurantId: "900001",
      name: "Test Kitchen",
      city: "Testcity",
      periods: starts.map(period),
    });

    const middle = checkObservedIdentity(observed(["2026-11-02", "2026-11-04"]), expected);
    expect(middle).toMatchObject({
      ok: true,
      missingPeriods: [{ start: "2026-11-03", end: "2026-11-04", label: "2026-11-03" }],
    });
    if (middle.ok) expect(middle.warnings.join(" ")).toBe("The file is missing 2026-11-03.");

    const ends = checkObservedIdentity(observed(["2026-11-03"]), expected);
    expect(ends.ok).toBe(true);
    if (ends.ok) {
      expect(ends.missingPeriods.map((item) => item.start)).toEqual(["2026-11-02", "2026-11-04"]);
      expect(ends.warnings.join(" ")).toBe("The file is missing 2026-11-02 and 2026-11-04.");
    }

    const extra = checkObservedIdentity(observed(["2026-11-02", "2026-11-03", "2026-11-06"]), {
      ...expected,
      periodEnd: "2026-11-04",
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reject).toContain("was not requested");

    const unordered = checkObservedIdentity(observed(["2026-11-04", "2026-11-02"]), expected);
    expect(unordered.ok).toBe(false);
    if (!unordered.ok) expect(unordered.reject).toContain("out of order");

    const repeated = checkObservedIdentity(observed(["2026-11-02", "2026-11-02"]), expected);
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.reject).toContain("repeated");

    const wrongOutlet = checkObservedIdentity(
      { ...observed(["2026-11-02", "2026-11-03", "2026-11-04"]), restaurantId: "900009" },
      expected,
    );
    expect(wrongOutlet.ok).toBe(false);
    if (!wrongOutlet.ok) expect(wrongOutlet.reject).toContain("900009");

    const none = checkObservedIdentity(observed(["2026-10-01"]), expected);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reject).toBe("The file has no requested period.");

    const week = checkObservedIdentity(
      {
        restaurantId: "900001",
        name: "Test Kitchen",
        city: "Testcity",
        periods: [{ start: "2026-10-11", end: "2026-10-18", label: "11th Oct - 17th Oct 2026" }],
      },
      {
        platform: "swiggy",
        report: "weekly",
        restaurantId: "900001",
        name: "Test Kitchen",
        city: "Testcity",
        periodStart: "2026-10-11",
        periodEnd: "2026-10-25",
      },
    );
    expect(week.ok).toBe(true);
    if (week.ok) expect(week.missingPeriods.map((item) => item.start)).toEqual(["2026-10-18"]);

    const payout = checkObservedIdentity(
      {
        restaurantId: "900002",
        name: "Test Kitchen",
        city: "Testcity",
        periods: [{ start: "2026-10-05", end: "2026-10-12", label: "payout" }],
      },
      {
        platform: "zomato",
        report: "payout",
        restaurantId: "900002",
        name: "Test Kitchen",
        city: "Testcity",
        periodStart: "2026-10-05",
        periodEnd: "2026-10-12",
      },
    );
    expect(payout).toMatchObject({ ok: true, missingPeriods: [] });
    const otherPayout = checkObservedIdentity(
      {
        restaurantId: "900002",
        name: "Test Kitchen",
        city: "Testcity",
        periods: [{ start: "2026-10-06", end: "2026-10-13", label: "payout" }],
      },
      {
        platform: "zomato",
        report: "payout",
        restaurantId: "900002",
        name: "Test Kitchen",
        city: "Testcity",
        periodStart: "2026-10-05",
        periodEnd: "2026-10-12",
      },
    );
    expect(otherPayout.ok).toBe(false);
  });
});
