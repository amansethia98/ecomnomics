import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

function appFor(userId: string | null) {
  return restaurantOwnerRoutes({
    prisma: {} as PrismaClient,
    getSession: async () => (userId ? { userId } : null),
  });
}

describe("owner profile routes", () => {
  it("requires a session", async () => {
    const app = appFor(null);
    for (const path of ["/api/v1/restaurants", "/api/v1/restaurants/r1/profile"]) {
      const response = await app.request(path);
      expect(response.status).toBe(401);
    }
  });

  it("refuses a profile save that carries a credential or a platform id", async () => {
    const app = appFor("user-1");
    for (const body of [{ password: "secret" }, { zomatoResId: "100" }, { phone: "9000000000" }]) {
      const response = await app.request("/api/v1/restaurants/r1/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_body" });
    }
  });
});
