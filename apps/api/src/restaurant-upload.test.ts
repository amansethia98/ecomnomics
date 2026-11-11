import { describe, expect, it } from "vitest";
import { uploadSignature, uploadSignatureMatches } from "./restaurant-upload.js";

const input = {
  restaurantId: "rest_1",
  kind: "reports",
  parentId: "report_1",
  fileName: "payout.csv",
  contentType: "text/csv",
  exp: 1_700_000_000_000,
};

describe("restaurant upload signatures", () => {
  it("accepts the signature for the same file and rejects a swapped name", () => {
    const signature = uploadSignature("secret", input);
    expect(uploadSignatureMatches("secret", input, signature)).toBe(true);
    expect(uploadSignatureMatches("other", input, signature)).toBe(false);
    expect(uploadSignatureMatches("secret", { ...input, fileName: "other.csv" }, signature)).toBe(
      false,
    );
  });
});
