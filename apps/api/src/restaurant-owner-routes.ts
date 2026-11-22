import {
  AGENT_TOKEN_PREFIX,
  isIsoDate,
  LicencePatchSchema,
  MarketingConfirmSchema,
  OpsDismissSchema,
  OpsSnoozeSchema,
  OutletDayRequestSchema,
  OwnerMetricsQuerySchema,
  OwnerProfilePatchSchema,
  ownerMetricsErrorMessage,
  StaffChoiceSchema,
  StaffQuestionSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  askStaffForMember,
  chooseStaffForMember,
  confirmMarketingForMember,
  dismissOpsAlertForMember,
  listOpsAlertsForMember,
  listOpsFeedForMember,
  listOwnerRestaurants,
  proposeOpsActionForMember,
  RestaurantAgentError,
  readDocumentsForMember,
  readMarketingForMember,
  readMenuForMember,
  readOpsReportForMember,
  readOwnerHomeForMember,
  readOwnerMetricsForMember,
  readOwnerProfileForMember,
  readPaymentsForMember,
  readRatingsForMember,
  readStaffForMember,
  recordOutletDayForMember,
  saveLicenceForMember,
  snoozeOpsAlertForMember,
  updateOwnerProfileForMember,
} from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";

export interface RestaurantOwnerRouteOptions {
  prisma: PrismaClient;
  getSession: (headers: Headers) => Promise<{ userId: string } | null>;
}

/** Session route for the owner dashboard. No agent token. */
export function restaurantOwnerRoutes(options: RestaurantOwnerRouteOptions) {
  const app = new Hono();
  app.use("/api/v1/restaurants/:restaurantId/*", async (c, next) => {
    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.header("x-owner-view") === "readonly"
    ) {
      return ownerError(c, 403, "read_only", "This view cannot change the restaurant.");
    }
    return next();
  });
  app.get("/api/v1/restaurants", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    return c.json({ restaurants: await listOwnerRestaurants(options.prisma, session.userId) });
  });
  app.get("/api/v1/restaurants/:restaurantId/profile", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      return c.json(
        await readOwnerProfileForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.patch("/api/v1/restaurants/:restaurantId/profile", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const body = await c.req.json().catch(() => null);
    const parsed = OwnerProfilePatchSchema.safeParse(body);
    if (!parsed.success)
      return ownerError(c, 400, "invalid_body", "That profile change is not valid.");
    try {
      return c.json(
        await updateOwnerProfileForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          parsed.data,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/home", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const outletId = c.req.query("outletId");
    try {
      return c.json(
        await readOwnerHomeForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          outletId && outletId !== "all" ? outletId : undefined,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.post("/api/v1/restaurants/:restaurantId/outlet-days", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const body = await c.req.json().catch(() => null);
    const parsed = OutletDayRequestSchema.omit({ source: true }).safeParse(body);
    if (!parsed.success) return ownerError(c, 400, "invalid_body", "That answer is not valid.");
    try {
      return c.json(
        await recordOutletDayForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          parsed.data,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.use("/api/v1/restaurants/:restaurantId/ops/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (token.startsWith(AGENT_TOKEN_PREFIX)) {
      return ownerError(c, 403, "forbidden", "An agent token cannot call this.");
    }
    return next();
  });
  app.get("/api/v1/restaurants/:restaurantId/ops/feed", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const from = c.req.query("from");
    const to = c.req.query("to");
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
      return ownerError(c, 400, "invalid_body", "from and to must be YYYY-MM-DD.");
    }
    try {
      return c.json(
        await listOpsFeedForMember(options.prisma, session.userId, c.req.param("restaurantId"), {
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(c.req.query("kind") ? { kind: c.req.query("kind") } : {}),
        }),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/ops/reports/:reportId", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      return c.json(
        await readOpsReportForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          c.req.param("reportId"),
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/ops/alerts", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      return c.json(
        await listOpsAlertsForMember(options.prisma, session.userId, c.req.param("restaurantId"), {
          ...(c.req.query("status") ? { status: c.req.query("status") } : {}),
          ...(c.req.query("severity") ? { severity: c.req.query("severity") } : {}),
          ...(c.req.query("outletId") ? { outletId: c.req.query("outletId") } : {}),
        }),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.post("/api/v1/restaurants/:restaurantId/ops/alerts/:alertId/snooze", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      const input = OpsSnoozeSchema.parse(await c.req.json());
      return c.json(
        await snoozeOpsAlertForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          c.req.param("alertId"),
          input.days,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.post("/api/v1/restaurants/:restaurantId/ops/alerts/:alertId/dismiss", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      OpsDismissSchema.parse(await c.req.json().catch(() => ({})));
      return c.json(
        await dismissOpsAlertForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          c.req.param("alertId"),
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.post("/api/v1/restaurants/:restaurantId/ops/alerts/:alertId/propose-action", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      return c.json(
        await proposeOpsActionForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          c.req.param("alertId"),
        ),
        201,
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/metrics", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const likeForLike = c.req.query("likeForLike");
    if (likeForLike !== undefined && likeForLike !== "true" && likeForLike !== "false") {
      return ownerError(c, 400, "invalid_body", "likeForLike must be true or false.");
    }
    try {
      const query = OwnerMetricsQuerySchema.parse(queryOf(c, likeForLike === "true"));
      const result = await readOwnerMetricsForMember(
        options.prisma,
        session.userId,
        c.req.param("restaurantId"),
        query,
      );
      return c.json(result);
    } catch (error) {
      const message = ownerMetricsErrorMessage(error);
      if (message) return ownerError(c, 400, "invalid_body", message);
      if (error instanceof RestaurantAgentError) {
        const status = error.status === 404 || error.status === 422 ? error.status : 400;
        return ownerError(c, status, error.code, error.message);
      }
      throw error;
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/staff", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      return c.json(
        await readStaffForMember(options.prisma, session.userId, c.req.param("restaurantId")),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.post("/api/v1/restaurants/:restaurantId/staff/questions", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const body = await c.req.json().catch(() => null);
    const parsed = StaffQuestionSchema.safeParse(body);
    if (!parsed.success) return ownerError(c, 400, "invalid_body", "That question is not valid.");
    try {
      return c.json(
        await askStaffForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          parsed.data.text,
          parsed.data.key,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.post("/api/v1/restaurants/:restaurantId/staff/choices", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const body = await c.req.json().catch(() => null);
    const parsed = StaffChoiceSchema.safeParse(body);
    if (!parsed.success) return ownerError(c, 400, "invalid_body", "That choice is not valid.");
    try {
      return c.json(
        await chooseStaffForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          parsed.data.actionId,
          parsed.data.choice,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/marketing", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      return c.json(
        await readMarketingForMember(options.prisma, session.userId, c.req.param("restaurantId")),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/payments", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const outletId = c.req.query("outletId");
    try {
      return c.json(
        await readPaymentsForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          outletId && outletId !== "all" ? outletId : undefined,
          c.req.query("cycle"),
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/documents", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    try {
      return c.json(
        await readDocumentsForMember(options.prisma, session.userId, c.req.param("restaurantId")),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.patch("/api/v1/restaurants/:restaurantId/documents", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const body = await c.req.json().catch(() => null);
    const parsed = LicencePatchSchema.safeParse(body);
    if (!parsed.success)
      return ownerError(c, 400, "invalid_body", "That licence date is not valid.");
    try {
      return c.json(
        await saveLicenceForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          parsed.data,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/menu", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const outletId = c.req.query("outletId");
    try {
      return c.json(
        await readMenuForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          outletId && outletId !== "all" ? outletId : undefined,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.get("/api/v1/restaurants/:restaurantId/ratings", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const outletId = c.req.query("outletId");
    try {
      return c.json(
        await readRatingsForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          outletId && outletId !== "all" ? outletId : undefined,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  app.post("/api/v1/restaurants/:restaurantId/marketing/:actionId/confirm", async (c) => {
    const session = await options.getSession(c.req.raw.headers);
    if (!session) return ownerError(c, 401, "unauthorized", "Unauthorized");
    const body = await c.req.json().catch(() => null);
    const parsed = MarketingConfirmSchema.safeParse(body);
    if (!parsed.success) return ownerError(c, 400, "invalid_body", "That answer is not valid.");
    try {
      return c.json(
        await confirmMarketingForMember(
          options.prisma,
          session.userId,
          c.req.param("restaurantId"),
          c.req.param("actionId"),
          parsed.data.done,
        ),
      );
    } catch (error) {
      return ownerFailure(c, error);
    }
  });
  return app;
}

function queryOf(c: Context, likeForLike: boolean): unknown {
  const grain = c.req.query("grain");
  const outletIds = listQuery(c, "outletIds");
  return {
    platform: c.req.query("platform"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    keys: listQuery(c, "keys") ?? [],
    basis: c.req.query("basis") ?? "order_date",
    likeForLike,
    ...(outletIds ? { outletIds } : {}),
    ...(grain ? { grain } : {}),
  };
}

function listQuery(c: Context, name: string): string[] | undefined {
  const values = c.req.queries(name);
  if (!values || values.length === 0) return undefined;
  const split = values.flatMap((value) => value.split(",")).map((value) => value.trim());
  const present = split.filter((value) => value.length > 0);
  return present.length > 0 ? present : undefined;
}

function ownerFailure(c: Context, error: unknown) {
  if (error instanceof RestaurantAgentError) {
    const status =
      error.status === 404 || error.status === 422 || error.status === 409 || error.status === 429
        ? error.status
        : 400;
    return ownerError(c, status === 409 ? 400 : status, error.code, error.message);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return ownerError(c, 400, "invalid_body", "Invalid request.");
  }
  throw error;
}

function ownerError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 422 | 429,
  code: string,
  error: string,
) {
  return c.json({ error, code }, status);
}
