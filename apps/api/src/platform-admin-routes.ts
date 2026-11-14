import { AGENT_TOKEN_PREFIX, isPlatformAdminEmail } from "@rakazo/contracts";
import type { PlatformAdminStore } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context } from "hono";
import { Hono } from "hono";

interface AdminSession {
  user: { id: string; email: string; emailVerified: boolean };
}

type AdminEnv = { Variables: { adminUserId: string } };

export interface PlatformAdminRouteOptions {
  allowlist: readonly string[];
  store: PlatformAdminStore | null;
  getSession: (headers: Headers) => Promise<AdminSession | null>;
  clientIp?: (c: Context) => string | null;
}

export function platformAdminRoutes(options: PlatformAdminRouteOptions) {
  const app = new Hono<AdminEnv>();

  app.use("/admin/v1/*", async (c, next) => {
    const bearer = /^Bearer\s+(\S+)/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (bearer.startsWith(AGENT_TOKEN_PREFIX)) {
      return c.json({ error: "Forbidden", code: "forbidden" }, 403);
    }
    let session: AdminSession | null;
    try {
      session = await options.getSession(c.req.raw.headers);
    } catch (error) {
      getLogger().error("platform admin session lookup failed", error);
      return c.json({ error: "Admin access is not available", code: "admin_unavailable" }, 503);
    }
    if (!session?.user?.id || !session.user.email) {
      return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
    }
    if (!isPlatformAdminEmail(session.user.email, options.allowlist, session.user.emailVerified)) {
      return c.json({ error: "Forbidden", code: "forbidden" }, 403);
    }
    if (!options.store) {
      return c.json({ error: "Admin access is not configured", code: "admin_unavailable" }, 503);
    }
    c.set("adminUserId", session.user.id);
    return next();
  });

  app.get("/admin/v1/restaurants", (c) =>
    readAdmin(c, options, null, "list_restaurants", "/admin/v1/restaurants", (store, audit) =>
      store.listRestaurants(audit).then((restaurants) => ({ restaurants })),
    ),
  );

  app.get("/admin/v1/restaurants/:restaurantId", (c) => {
    const restaurantId = c.req.param("restaurantId");
    return readAdmin(
      c,
      options,
      restaurantId,
      "read_restaurant",
      `/admin/v1/restaurants/${restaurantId}`,
      async (store, audit) => {
        const restaurant = await store.readRestaurant(restaurantId, audit);
        if (!restaurant) return null;
        return { restaurant };
      },
    );
  });

  app.post("/admin/v1/restaurants/:restaurantId/fetch-holds", async (c) => {
    const restaurantId = c.req.param("restaurantId");
    const parsed = await clearBody(c);
    if (!parsed)
      return c.json({ error: "Send an outlet and a platform.", code: "invalid_body" }, 400);
    const target = `/admin/v1/restaurants/${restaurantId}/fetch-holds`;
    return readAdmin(
      c,
      options,
      restaurantId,
      "clear_fetch_hold",
      target,
      async (store, audit) => {
        const cleared = await store.clearFetchHold(
          restaurantId,
          parsed.outletId,
          parsed.platform,
          audit,
        );
        return cleared;
      },
      "No hold is open for this outlet.",
    );
  });

  return app;
}

async function clearBody(
  c: Context,
): Promise<{ outletId: string; platform: "zomato" | "swiggy" } | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as { outletId?: unknown; platform?: unknown };
  const outletId = typeof record.outletId === "string" ? record.outletId.trim() : "";
  if (!outletId || outletId.length > 200) return null;
  if (record.platform !== "zomato" && record.platform !== "swiggy") return null;
  return { outletId, platform: record.platform };
}

async function readAdmin(
  c: Context<AdminEnv>,
  options: PlatformAdminRouteOptions,
  restaurantId: string | null,
  action: string,
  target: string,
  read: (
    store: PlatformAdminStore,
    audit: {
      adminUserId: string;
      action: string;
      restaurantId: string | null;
      target: string;
      ip: string | null;
    },
  ) => Promise<unknown>,
  missing = "Restaurant not found",
) {
  const store = options.store;
  if (!store)
    return c.json({ error: "Admin access is not configured", code: "admin_unavailable" }, 503);
  try {
    const body = await read(store, {
      adminUserId: c.get("adminUserId"),
      action,
      restaurantId,
      target,
      ip: options.clientIp?.(c) ?? null,
    });
    if (body == null || typeof body !== "object") {
      return c.json({ error: missing, code: "not_found" }, 404);
    }
    return c.json(body);
  } catch (error) {
    getLogger().error("platform admin read failed", error);
    return c.json({ error: "Admin access is not available", code: "admin_unavailable" }, 503);
  }
}
