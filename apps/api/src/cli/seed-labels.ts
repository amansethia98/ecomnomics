// `pnpm db:seed-labels`: put the built-in metric and payout labels back.
// Rows already stored, including one an admin added, are left as they are.
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, databaseUrls, seedMetricLabels } from "@rakazo/db";

loadRootEnv();
const urls = databaseUrls(process.env);
const owner = createDb(urls.migrationUrl, { applicationName: "metric-label-seed" });
try {
  await seedMetricLabels(owner.prisma);
  process.stdout.write("Metric labels are seeded.\n");
} finally {
  await owner.prisma.$disconnect();
  await owner.pool.end();
}
