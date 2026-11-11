import type { PlatformAdminAudit, PlatformAdminStore } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { platformAdminRoutes } from "./platform-admin-routes.js";

function admin(
  store: PlatformAdminStore | null,
  session: { id: string; email: string; emailVerified: boolean } | null,
  seen: { lookups: number },
) {
  return platformAdminRoutes({
    allowlist: ["owner@example.com"],
    store,
    getSession: async () => {
      seen.lookups += 1;
      return session ? { user: session } : null;
    },
  });
}

function recordingStore() {
  const audits: PlatformAdminAudit[] = [];
  const store: PlatformAdminStore = {
    async listRestaurants(audit) {
      audits.push(audit);
      return [];
    },
    async readRestaurant(_id, audit) {
      audits.push(audit);
      return null;
    },
  };
  return { store, audits };
}

describe("platform admin routes", () => {
  it("rejects a missing session and does not read", async () => {
    const seen = { lookups: 0 };
    const { store, audits } = recordingStore();
    const response = await admin(store, null, seen).request("/admin/v1/restaurants");
    expect(response.status).toBe(401);
    expect(audits).toHaveLength(0);
  });

  it("rejects an unverified or unlisted account", async () => {
    const seen = { lookups: 0 };
    const { store, audits } = recordingStore();
    const app = admin(store, { id: "u", email: "owner@example.com", emailVerified: false }, seen);
    expect((await app.request("/admin/v1/restaurants")).status).toBe(403);
    const other = admin(store, { id: "u", email: "other@example.com", emailVerified: true }, seen);
    const body = await (await other.request("/admin/v1/restaurants")).json();
    expect(body).toEqual({ error: "Forbidden", code: "forbidden" });
    expect(audits).toHaveLength(0);
  });

  it("rejects an agent token before looking at a session", async () => {
    const seen = { lookups: 0 };
    const { store, audits } = recordingStore();
    const response = await admin(
      store,
      { id: "u", email: "owner@example.com", emailVerified: true },
      seen,
    ).request("/admin/v1/restaurants", { headers: { authorization: "Bearer ecom_agent_example" } });
    expect(response.status).toBe(403);
    expect(seen.lookups).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it("writes an audit record for an allowlisted read", async () => {
    const seen = { lookups: 0 };
    const { store, audits } = recordingStore();
    const response = await admin(
      store,
      { id: "admin-1", email: "owner@example.com", emailVerified: true },
      seen,
    ).request("/admin/v1/restaurants");
    expect(response.status).toBe(200);
    expect(audits).toEqual([
      expect.objectContaining({
        adminUserId: "admin-1",
        action: "list_restaurants",
        restaurantId: null,
      }),
    ]);
  });

  it("does not return data when the audit write fails", async () => {
    const seen = { lookups: 0 };
    const store: PlatformAdminStore = {
      async listRestaurants() {
        throw new Error('relation "admin_audit_log" permission denied');
      },
      async readRestaurant() {
        return null;
      },
    };
    const response = await admin(
      store,
      { id: "admin-1", email: "owner@example.com", emailVerified: true },
      seen,
    ).request("/admin/v1/restaurants");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: "Admin access is not available", code: "admin_unavailable" });
    expect(JSON.stringify(body)).not.toContain("permission denied");
  });

  it("stays unavailable when no admin database is configured", async () => {
    const seen = { lookups: 0 };
    const response = await admin(
      null,
      { id: "admin-1", email: "owner@example.com", emailVerified: true },
      seen,
    ).request("/admin/v1/restaurants/r1");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Admin access is not configured",
      code: "admin_unavailable",
    });
  });
});
