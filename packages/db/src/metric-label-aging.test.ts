import { describe, expect, it } from "vitest";
import { fetchCoversCurrentLabels, longAbsentDates } from "./metric-label-aging.js";

describe("label re-read rules", () => {
  it("treats a stored file as current when nothing is pending or the label version matches", () => {
    expect(fetchCoversCurrentLabels({ pendingLabels: 0, labelSetVersion: 1 }, 4)).toBe(true);
    expect(fetchCoversCurrentLabels({ pendingLabels: 3, labelSetVersion: 4 }, 4)).toBe(true);
    expect(fetchCoversCurrentLabels({ pendingLabels: 3, labelSetVersion: 2 }, 4)).toBe(false);
  });

  it("marks a metric missing for fourteen days in two outlets", () => {
    const first = Array.from(
      { length: 14 },
      (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}`,
    );
    const second = [...first];
    const marked = longAbsentDates(
      new Map([
        ["a", first],
        ["b", second],
      ]),
    );
    expect(marked).toHaveLength(14);
    expect(longAbsentDates(new Map([["a", first]]))).toEqual([]);
    expect(
      longAbsentDates(
        new Map([
          ["a", first.slice(0, 13)],
          ["b", second.slice(0, 13)],
        ]),
      ),
    ).toEqual([]);
  });
});
