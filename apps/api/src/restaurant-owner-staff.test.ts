import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { restaurantOwnerRoutes } from "./restaurant-owner-routes.js";

function appFor(userId: string | null) {
  return restaurantOwnerRoutes({
    prisma: {} as PrismaClient,
    getSession: async () => (userId ? { userId } : null),
  });
}

describe("owner staff routes", () => {
  it("requires a session", async () => {
    const app = appFor(null);
    const response = await app.request("/api/v1/restaurants/r1/staff");
    expect(response.status).toBe(401);
  });

  it("rejects a blank question and an unknown choice", async () => {
    const app = appFor("user-1");
    const question = await app.request("/api/v1/restaurants/r1/staff/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(question.status).toBe(400);
    expect(await question.json()).toMatchObject({ code: "invalid_body" });

    const choice = await app.request("/api/v1/restaurants/r1/staff/choices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: "offer-1", choice: "later" }),
    });
    expect(choice.status).toBe(400);
  });
});
