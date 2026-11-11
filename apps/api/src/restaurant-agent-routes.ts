import type { ObjectStorage } from "@rakazo/adapter-kit";
import {
  CreateActionSchema,
  CreateJobRunSchema,
  CreateReportSchema,
  PatchActionSchema,
  PutMetricsSchema,
  unknownMetricKeyMessage,
  unknownMetricKeys,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  actionFileForUpload,
  authenticateAgentToken,
  createAction,
  createReport,
  markActionFileUploaded,
  markReportFileUploaded,
  RestaurantAgentError,
  readRestaurant,
  reportFileForUpload,
  runAsTenant,
  transitionAction,
  upsertJobRun,
  upsertMetrics,
} from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { requestBodyLimit } from "./request-body-limit.js";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_TTL_MS,
  uploadSignature,
  uploadSignatureMatches,
} from "./restaurant-upload.js";

const MAX_AGENT_JSON_BYTES = 1024 * 1024;

type AgentEnv = { Variables: { restaurantId: string; spaceId: string; userId: string } };

export interface RestaurantAgentRouteOptions {
  prisma: PrismaClient;
  /** Signs upload URLs. Use the API auth secret. */
  uploadSecret: string;
  /** Origin the agent calls back, such as the API's public URL. */
  publicBaseUrl: string;
  objectStorage?: ObjectStorage;
}

export function restaurantAgentRoutes(options: RestaurantAgentRouteOptions) {
  const app = new Hono<AgentEnv>();
  const jsonLimit = requestBodyLimit(
    MAX_AGENT_JSON_BYTES,
    "Request body is too large.",
    "invalid_body",
  );
  const fileLimit = requestBodyLimit(
    MAX_UPLOAD_BYTES,
    "File is larger than 20 MB.",
    "invalid_body",
  );
  app.use("/agent/v1/reports/:reportId/files/:name", fileLimit);
  app.use("/agent/v1/actions/:actionId/files/:name", fileLimit);
  app.use("/agent/v1/metrics", jsonLimit);
  app.use("/agent/v1/reports", jsonLimit);
  app.use("/agent/v1/actions", jsonLimit);
  app.use("/agent/v1/actions/:actionId", jsonLimit);
  app.use("/agent/v1/runs", jsonLimit);

  app.use("/agent/v1/*", async (c, next) => {
    try {
      const scope = await authenticateAgentToken(options.prisma, c.req.header("authorization"));
      if (!scope) return agentError(c, 401, "unauthorized", "Unauthorized");
      c.set("restaurantId", scope.restaurantId);
      c.set("spaceId", scope.spaceId);
      c.set("userId", scope.userId);
      return await runAsTenant({ spaceId: scope.spaceId, userId: scope.userId }, () => next());
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.get("/agent/v1/restaurant", async (c) => {
    try {
      return c.json(await readRestaurant(options.prisma, scopeOf(c)));
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.put("/agent/v1/metrics", async (c) => {
    try {
      const body = await readJson(c);
      const unknown = unknownMetricKeys(body);
      if (unknown.length > 0) {
        return agentError(c, 400, "unknown_metric_key", unknownMetricKeyMessage(unknown));
      }
      const input = PutMetricsSchema.parse(body);
      return c.json(await upsertMetrics(options.prisma, scopeOf(c), input));
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.post("/agent/v1/reports", async (c) => {
    try {
      const input = CreateReportSchema.parse(await readJson(c));
      if (input.files.length > 0 && !options.objectStorage) {
        return agentError(
          c,
          503,
          "object_storage_unconfigured",
          "File uploads are not configured on this server.",
        );
      }
      const created = await createReport(options.prisma, scopeOf(c), input);
      return c.json(
        {
          reportId: created.reportId,
          uploads: created.files.map((file) =>
            signedUpload(options, scopeOf(c).restaurantId, "reports", created.reportId, file),
          ),
        },
        201,
      );
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.put("/agent/v1/reports/:reportId/files/:name", async (c) => {
    try {
      return await receiveUpload(c, options, "reports");
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.post("/agent/v1/actions", async (c) => {
    try {
      const input = CreateActionSchema.parse(await readJson(c));
      if ((input.evidenceFiles?.length ?? 0) > 0 && !options.objectStorage) {
        return agentError(
          c,
          503,
          "object_storage_unconfigured",
          "File uploads are not configured on this server.",
        );
      }
      const created = await createAction(options.prisma, scopeOf(c), input);
      return c.json(
        {
          ...created.action,
          uploads: created.files.map((file) =>
            signedUpload(
              options,
              scopeOf(c).restaurantId,
              "actions",
              created.action.actionId,
              file,
            ),
          ),
        },
        201,
      );
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.patch("/agent/v1/actions/:actionId", async (c) => {
    try {
      const input = PatchActionSchema.parse(await readJson(c));
      const action = await transitionAction(
        options.prisma,
        scopeOf(c),
        c.req.param("actionId"),
        input,
      );
      return c.json(action);
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.post("/agent/v1/runs", async (c) => {
    try {
      const input = CreateJobRunSchema.parse(await readJson(c));
      const run = await upsertJobRun(options.prisma, scopeOf(c), input);
      return c.json(run);
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  app.put("/agent/v1/actions/:actionId/files/:name", async (c) => {
    try {
      return await receiveUpload(c, options, "actions");
    } catch (error) {
      return agentFailure(c, error);
    }
  });

  return app;
}

function scopeOf(c: Context<AgentEnv>) {
  return {
    restaurantId: c.get("restaurantId"),
    spaceId: c.get("spaceId"),
    userId: c.get("userId"),
  };
}

function signedUpload(
  options: RestaurantAgentRouteOptions,
  restaurantId: string,
  kind: "reports" | "actions",
  parentId: string,
  file: { name: string; contentType: string },
) {
  const exp = Date.now() + UPLOAD_TTL_MS;
  const sig = uploadSignature(options.uploadSecret, {
    restaurantId,
    kind,
    parentId,
    fileName: file.name,
    contentType: file.contentType,
    exp,
  });
  const url = new URL(
    `/agent/v1/${kind}/${parentId}/files/${encodeURIComponent(file.name)}`,
    options.publicBaseUrl,
  );
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return {
    name: file.name,
    contentType: file.contentType,
    method: "PUT" as const,
    uploadUrl: url.toString(),
    expiresAt: new Date(exp).toISOString(),
  };
}

async function receiveUpload(
  c: Context<AgentEnv>,
  options: RestaurantAgentRouteOptions,
  kind: "reports" | "actions",
) {
  if (!options.objectStorage) {
    return agentError(
      c,
      503,
      "object_storage_unconfigured",
      "File uploads are not configured on this server.",
    );
  }
  const parentId = c.req.param(kind === "reports" ? "reportId" : "actionId");
  const name = c.req.param("name");
  if (!parentId || !name) return agentError(c, 404, "not_found", "File not found");
  const scope = scopeOf(c);
  const file =
    kind === "reports"
      ? await reportFileForUpload(options.prisma, scope, parentId, name)
      : await actionFileForUpload(options.prisma, scope, parentId, name);
  if (!file) return agentError(c, 404, "not_found", "File not found");
  const exp = Number(c.req.query("exp"));
  const sig = c.req.query("sig") ?? "";
  if (!Number.isSafeInteger(exp) || exp < Date.now()) {
    return agentError(c, 403, "forbidden", "This upload link has expired.");
  }
  if (
    !uploadSignatureMatches(
      options.uploadSecret,
      {
        restaurantId: scope.restaurantId,
        kind,
        parentId,
        fileName: file.name,
        contentType: file.contentType,
        exp,
      },
      sig,
    )
  ) {
    return agentError(c, 403, "forbidden", "This upload link is not valid.");
  }
  const declared = c.req.header("content-length");
  if (declared && Number(declared) > MAX_UPLOAD_BYTES) {
    return agentError(c, 413, "invalid_body", "File is larger than 20 MB.");
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return agentError(c, 413, "invalid_body", "File is larger than 20 MB.");
  }
  await options.objectStorage.put(file.storageKey, yieldOnce(bytes));
  if (kind === "reports") {
    await markReportFileUploaded(options.prisma, scope, parentId, name, bytes.byteLength);
  } else {
    await markActionFileUploaded(options.prisma, scope, parentId, name, bytes.byteLength);
  }
  return c.json({ name, sizeBytes: bytes.byteLength });
}

async function* yieldOnce(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) {
    throw new RestaurantAgentError("invalid_body", 400, "Send a JSON body.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RestaurantAgentError("invalid_body", 400, "Send a JSON body.");
  }
}

function agentError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503,
  code: string,
  error: string,
) {
  return c.json({ error, code }, status);
}

function agentFailure(c: Context, error: unknown) {
  if (isSchemaError(error)) {
    const issue = error.issues[0];
    const path = issue?.path.map(String).join(".");
    const message = issue
      ? path
        ? `${path}: ${issue.message}`
        : issue.message
      : "Invalid request";
    return agentError(c, 400, "invalid_body", message);
  }
  const known = error instanceof RestaurantAgentError ? error : outletFailure(error);
  if (known) return agentError(c, known.status as 400, known.code, known.message);
  throw error;
}

function isSchemaError(
  error: unknown,
): error is { issues: Array<{ path: Array<PropertyKey>; message: string }> } {
  if (!(error instanceof Error) || error.name !== "ZodError") return false;
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues);
}

function outletFailure(error: unknown): RestaurantAgentError | null {
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("outlet is not in this restaurant") ||
    message.includes("restaurant space mismatch")
  ) {
    return new RestaurantAgentError(
      "unknown_outlet",
      422,
      "Outlet is not part of this restaurant.",
    );
  }
  return null;
}
