import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { restaurantAgentRoutes } from "./restaurant-agent-routes.js";
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

describe("restaurant agent body limits", () => {
  const app = restaurantAgentRoutes({
    prisma: {} as PrismaClient,
    uploadSecret: "secret",
    publicBaseUrl: "http://127.0.0.1:3100",
  });

  it("rejects an oversized JSON body before reading the token", async () => {
    const response = await app.request("/agent/v1/runs", {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024) },
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Request body is too large.",
      code: "invalid_body",
    });
  });

  it("stops a streamed upload once it passes 20 MB", async () => {
    const response = await app.request(
      new Request("http://127.0.0.1:3100/agent/v1/reports/report/files/payout.csv", {
        method: "PUT",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
            controller.enqueue(new Uint8Array(20 * 1024 * 1024));
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "File is larger than 20 MB.",
      code: "invalid_body",
    });
  });
});
