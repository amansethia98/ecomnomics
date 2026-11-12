import { OwnerMetricsQuerySchema, ownerMetricsErrorMessage } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { RestaurantAgentError, readOwnerMetricsForMember } from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";

export interface RestaurantOwnerRouteOptions {
  prisma: PrismaClient;
  getSession: (headers: Headers) => Promise<{ userId: string } | null>;
}

/** Session route for the owner dashboard. No agent token. */
export function restaurantOwnerRoutes(options: RestaurantOwnerRouteOptions) {
  const app = new Hono();
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

function ownerError(c: Context, status: 400 | 401 | 403 | 404 | 422, code: string, error: string) {
  return c.json({ error, code }, status);
}
