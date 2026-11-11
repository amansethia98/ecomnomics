import {
  contentKeyProviderFromEnv,
  createSecretStore,
  ensureRestaurantAgentAccess,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { RESTAURANT_AGENT_TOKEN_ENV } from "@rakazo/contracts";
import { resolveEncryptionKey } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, ensureRestaurant } from "@rakazo/db";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

loadRootEnv();
await unwrapEnvFromKeyManager();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { prisma, pool } = createDb(databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
const secrets = createSecretStore(resolveEncryptionKey(process.env), process.env);
await secrets.start();

try {
  const spaceId = argument("space");
  if (!spaceId) throw new Error("Pass --space <space id>.");
  const rotate = process.argv.includes("--rotate");
  const revoke = process.argv.includes("--revoke");
  if (rotate && revoke) throw new Error("Pass either --rotate or --revoke, not both.");
  const restaurant = await ensureRestaurant(prisma, {
    spaceId,
    name: argument("name"),
    timezone: argument("timezone"),
  });
  const result = await ensureRestaurantAgentAccess({
    prisma,
    secretStore: secrets,
    spaceId,
    apiBaseUrl: process.env.API_URL?.trim() || "http://127.0.0.1:3100",
    mode: revoke ? "revoke" : rotate ? "rotate" : "mint",
    label: argument("label") || undefined,
  });
  if (revoke) {
    process.stderr.write(`Revoked the token for restaurant ${restaurant.id}.\n`);
  } else if (result.token) {
    process.stdout.write(`${RESTAURANT_AGENT_TOKEN_ENV}=${result.token}\n`);
    process.stderr.write(
      [
        `Restaurant ${restaurant.id} (${restaurant.name}).`,
        "The token is stored encrypted for this restaurant's computer.",
        "Each command receives it fresh. It is not written into the container.",
        "Do not set it on the API process, and do not reuse it for another restaurant.",
        `The computer sends it as: Authorization: Bearer <${RESTAURANT_AGENT_TOKEN_ENV}>`,
        "",
      ].join("\n"),
    );
  }
} finally {
  await secrets.close();
  await prisma.$disconnect();
  await pool.end();
}
