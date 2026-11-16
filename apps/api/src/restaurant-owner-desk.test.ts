import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

function appFor(userId: string | null) {
  return restaurantOwnerRoutes({
    prisma: {} as PrismaClient,
    getSession: async () => (userId ? { userId } : null),
  });
}

describe("owner desk routes", () => {
  it("requires a session", async () => {
    const app = appFor(null);
    const payments = await app.request("/api/v1/restaurants/r1/payments");
    const documents = await app.request("/api/v1/restaurants/r1/documents");
    expect(payments.status).toBe(401);
    expect(documents.status).toBe(401);
  });

  it("rejects a licence date that is not a day", async () => {
    const app = appFor("user-1");
    const response = await app.request("/api/v1/restaurants/r1/documents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: null, expiresOn: "2026-02-31", gstin: null }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_body" });
  });
});
