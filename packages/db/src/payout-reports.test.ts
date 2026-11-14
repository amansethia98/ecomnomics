import { describe, expect, it } from "vitest";
import { payoutAdjustmentKeyFailure } from "./payout-reports.js";

describe("payout adjustment key failures", () => {
  it("turns a unique violation into a parse failure and leaves other errors alone", () => {
    expect(payoutAdjustmentKeyFailure({ code: "P2002" })).toBe(
      "This payout could not be stored because two adjustment rows share a key.",
    );
    expect(payoutAdjustmentKeyFailure({ code: "P2003" })).toBeNull();
    expect(payoutAdjustmentKeyFailure(new Error("The file is not a payout workbook."))).toBeNull();
  });
});
