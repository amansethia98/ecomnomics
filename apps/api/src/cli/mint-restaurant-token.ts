import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { RESTAURANT_AGENT_TOKEN_ENV } from "@rakazo/contracts";
import {
  createDb,
  ensureRestaurant,
  mintAgentToken,
  revokeAgentTokens,
  rotateAgentToken,
} from "@rakazo/db";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

await unwrapEnvFromKeyManager();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { prisma, pool } = createDb(databaseUrl, { keyProvider: contentKeyProviderFromEnv() });

try {
  const spaceId = argument("space");
  if (!spaceId) throw new Error("Pass --space <space id>.");
  const rotate = process.argv.includes("--rotate");
  const revoke = process.argv.includes("--revoke");
  if (rotate && revoke) throw new Error("Pass either --rotate or --revoke, not both.");
  const label = argument("label") || undefined;
  const restaurant = await ensureRestaurant(prisma, {
    spaceId,
    name: argument("name"),
    timezone: argument("timezone"),
  });
  if (revoke) {
    const count = await revokeAgentTokens(prisma, restaurant.id);
    process.stderr.write(`Revoked ${count} token(s) for restaurant ${restaurant.id}.\n`);
  } else {
    const token = rotate
      ? await rotateAgentToken(prisma, restaurant.id, label)
      : await mintAgentToken(prisma, restaurant.id, label);
    process.stdout.write(`${RESTAURANT_AGENT_TOKEN_ENV}=${token}\n`);
    process.stderr.write(
      [
        `Restaurant ${restaurant.id} (${restaurant.name}).`,
        `Put ${RESTAURANT_AGENT_TOKEN_ENV} in that restaurant's computer environment only.`,
        "Do not set it on the API process, and do not reuse it for another restaurant.",
        `The computer sends it as: Authorization: Bearer <${RESTAURANT_AGENT_TOKEN_ENV}>`,
        "",
      ].join("\n"),
    );
  }
} finally {
  await prisma.$disconnect();
  await pool.end();
}
