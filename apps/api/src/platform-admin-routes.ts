import { AGENT_TOKEN_PREFIX, isPlatformAdminEmail } from "@rakazo/contracts";
import type { PlatformAdminStore } from "@rakazo/db";
import { LABEL_REJECT_MODES } from "@rakazo/db";
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

  app.post("/admin/v1/restaurants/:restaurantId/view", (c) => {
    const restaurantId = c.req.param("restaurantId");
    return readAdmin(
      c,
      options,
      restaurantId,
      "view_as_owner",
      `/admin/v1/restaurants/${restaurantId}/view`,
      async (store, audit) => {
        const view = await store.viewAsOwner(restaurantId, audit);
        if (!view) return null;
        return { view };
      },
    );
  });

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

  app.get("/admin/v1/label-findings", (c) =>
    audited(c, options, null, "list_label_findings", "/admin/v1/label-findings", (store, audit) =>
      store.listLabelFindings(
        {
          status: c.req.query("status") || undefined,
          platform: c.req.query("platform") || undefined,
          kind: c.req.query("kind") || undefined,
        },
        audit,
      ),
    ),
  );

  app.get("/admin/v1/label-findings/:findingId", (c) => {
    const findingId = c.req.param("findingId");
    return audited(
      c,
      options,
      null,
      "read_label_finding",
      `/admin/v1/label-findings/${findingId}`,
      async (store, audit) => store.readLabelFinding(findingId, audit),
    );
  });

  app.post("/admin/v1/label-findings/:findingId/approve", (c) => {
    const findingId = c.req.param("findingId");
    return audited(
      c,
      options,
      null,
      "approve_label_finding",
      `/admin/v1/label-findings/${findingId}/approve`,
      (store, audit) => store.approveLabelFinding(findingId, audit),
    );
  });

  app.post("/admin/v1/label-findings/:findingId/reject", async (c) => {
    const mode = await rejectMode(c);
    if (!mode) return c.json({ error: "Name a reject mode.", code: "invalid_body" }, 400);
    const findingId = c.req.param("findingId");
    return audited(
      c,
      options,
      null,
      "reject_label_finding",
      `/admin/v1/label-findings/${findingId}/reject`,
      (store, audit) => store.rejectLabelFinding(findingId, mode, audit),
    );
  });

  app.post("/admin/v1/label-findings/:findingId/resolve", (c) => {
    const findingId = c.req.param("findingId");
    return audited(
      c,
      options,
      null,
      "resolve_layout_finding",
      `/admin/v1/label-findings/${findingId}/resolve`,
      (store, audit) => store.resolveLayoutFinding(findingId, audit),
    );
  });

  app.get("/admin/v1/metric-labels", (c) =>
    audited(c, options, null, "list_metric_labels", "/admin/v1/metric-labels", (store, audit) =>
      store.listMetricLabels(
        {
          platform: c.req.query("platform") || undefined,
          family: c.req.query("family") || undefined,
        },
        audit,
      ),
    ),
  );

  app.post("/admin/v1/metric-labels/slots/:slotId/aliases", async (c) => {
    const label = await aliasLabel(c);
    if (!label) return c.json({ error: "Name the label.", code: "invalid_body" }, 400);
    const slotId = c.req.param("slotId");
    return audited(
      c,
      options,
      null,
      "add_label_alias",
      `/admin/v1/metric-labels/slots/${slotId}/aliases`,
      (store, audit) => store.addLabelAlias(slotId, label, audit),
    );
  });

  app.post("/admin/v1/metric-labels/aliases/:aliasId/retire", (c) => {
    const aliasId = c.req.param("aliasId");
    return audited(
      c,
      options,
      null,
      "retire_label_alias",
      `/admin/v1/metric-labels/aliases/${aliasId}/retire`,
      (store, audit) => store.retireLabelAlias(aliasId, audit),
    );
  });

  app.get("/admin/v1/metric-labels/unknown", (c) =>
    audited(
      c,
      options,
      null,
      "list_unknown_labels",
      "/admin/v1/metric-labels/unknown",
      (store, audit) => store.listUnknownLabels(audit),
    ),
  );

  return app;
}

function isRejectMode(value: string): value is (typeof LABEL_REJECT_MODES)[number] {
  return (LABEL_REJECT_MODES as readonly string[]).includes(value);
}

async function rejectMode(c: Context): Promise<(typeof LABEL_REJECT_MODES)[number] | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const mode = (body as { mode?: unknown }).mode;
  return typeof mode === "string" && isRejectMode(mode) ? mode : null;
}

async function aliasLabel(c: Context): Promise<string | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const label = (body as { label?: unknown }).label;
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
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

async function audited(
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
    if (body == null) return c.json({ error: "Not found", code: "not_found" }, 404);
    if (isLabelResult(body) && !body.ok) return labelError(c, body.error);
    if (isLabelResult(body)) return c.json(body.value);
    return c.json(body);
  } catch (error) {
    getLogger().error("platform admin read failed", error);
    return c.json({ error: "Admin access is not available", code: "admin_unavailable" }, 503);
  }
}

function isLabelResult(body: unknown): body is { ok: boolean; error?: string; value?: unknown } {
  return body != null && typeof body === "object" && "ok" in body;
}

function labelError(c: Context, error: string | undefined) {
  if (error === "collision") {
    return c.json(
      { error: "That label already belongs to another metric.", code: "alias_collision" },
      409,
    );
  }
  if (error === "not_open" || error === "wrong_kind") {
    return c.json({ error: "That finding cannot be changed.", code: "not_open" }, 409);
  }
  if (error === "no_candidate") {
    return c.json({ error: "That finding has no label to add.", code: "no_candidate" }, 400);
  }
  return c.json({ error: "Not found", code: "not_found" }, 404);
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
