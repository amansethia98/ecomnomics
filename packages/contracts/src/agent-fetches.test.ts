import { describe, expect, it } from "vitest";
import {
  CheckStoredFetchesSchema,
  ListFetchesQuerySchema,
  LogFetchSchema,
} from "./agent-fetches.js";

const sha = "a".repeat(64);

describe("fetch contracts", () => {
  it("rejects a free-text log reason and accepts a short code", () => {
    const body = {
      outletId: "outlet-1",
      platform: "zomato",
      report: "daily",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-08",
      runId: "run-1",
      status: "signed_out",
      reason: "session_expired",
    };
    expect(LogFetchSchema.parse(body).reason).toBe("session_expired");
    expect(LogFetchSchema.safeParse({ ...body, reason: "Signed out, OTP 123456" }).success).toBe(
      false,
    );
    expect(LogFetchSchema.safeParse({ ...body, status: "stored" }).success).toBe(false);
    expect(LogFetchSchema.safeParse({ ...body, csv: "orders,1" }).success).toBe(false);
  });

  it("requires a window and parser version on a hash check", () => {
    const file = {
      sha256: sha,
      report: "daily",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-08",
      parserVersion: "2026-11-12.1",
    };
    expect(
      CheckStoredFetchesSchema.parse({ outletId: "outlet-1", platform: "swiggy", files: [file] })
        .files,
    ).toHaveLength(1);
    expect(
      CheckStoredFetchesSchema.safeParse({
        outletId: "outlet-1",
        platform: "swiggy",
        files: [{ sha256: sha, report: "daily" }],
      }).success,
    ).toBe(false);
    expect(
      CheckStoredFetchesSchema.safeParse({
        outletId: "outlet-1",
        platform: "swiggy",
        files: [{ ...file, rawSha256: "ZZ" }],
      }).success,
    ).toBe(false);
  });

  it("defaults the fetch list to 50 and refuses more than 200", () => {
    expect(ListFetchesQuerySchema.parse({ outletId: "outlet-1" }).limit).toBe(50);
    expect(ListFetchesQuerySchema.parse({ outletId: "outlet-1", limit: "200" }).limit).toBe(200);
    expect(ListFetchesQuerySchema.safeParse({ outletId: "outlet-1", limit: "201" }).success).toBe(
      false,
    );
    expect(ListFetchesQuerySchema.safeParse({ outletId: "" }).success).toBe(false);
  });
});
