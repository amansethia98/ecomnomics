#!/usr/bin/env node
// Run the web app and the API against a database the caller supplies.
//
//   DATABASE_URL=postgres://... pnpm preview:local
//
// The URL has to already be in the environment. This script does not read a
// connection string from the repo, and it does not seed, migrate, or start a
// database. The database is expected to already be migrated.

import { spawnPnpm } from "./pnpm.mjs";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  process.stderr.write(
    "preview:local needs DATABASE_URL in the environment. It does not seed, migrate, or start a database.\n",
  );
  process.exit(1);
}

const child = spawnPnpm(
  ["exec", "turbo", "dev", "--env-mode=loose", "--filter=@rakazo/api", "--filter=@rakazo/web"],
  {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
