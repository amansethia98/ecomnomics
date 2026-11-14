import { writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createDb } from "@rakazo/db";
import { restaurantAgentRoutes } from "./restaurant-agent-routes.js";

// Built with the production server bundler. Booting this file is how the payout
// suite checks that a workbook dependency resolves from the built output.
const databaseUrl = process.env.DATABASE_URL;
const portFile = process.argv[2];
if (!databaseUrl || !portFile) throw new Error("Missing DATABASE_URL or the port file path");

const db = createDb(databaseUrl, { applicationName: "payout-bundle" });
const app = restaurantAgentRoutes({
  prisma: db.prisma,
  uploadSecret: "payout-bundle-upload-secret",
  publicBaseUrl: "http://127.0.0.1",
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
  void writeFile(portFile, String(info.port));
});

process.once("SIGTERM", () => {
  server.close();
  void db.pool.end().finally(() => process.exit(0));
});
