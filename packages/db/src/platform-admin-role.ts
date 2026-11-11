import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { RUNTIME_ROLE, scramSha256Verifier } from "./database-access.js";

/** NOLOGIN group. A login granted this role is the only platform-admin connection. */
export const PLATFORM_ADMIN_ROLE = "ecomnomics_admin";

/**
 * Create or update the login in `adminUrl` and grant it {@link PLATFORM_ADMIN_ROLE}.
 * The login is not a superuser, does not bypass row-level security, and is not a
 * member of the application role.
 */
export async function provisionPlatformAdminLogin(
  migrationUrl: string,
  adminUrl: string,
): Promise<void> {
  const parsed = new URL(adminUrl);
  const login = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!login || !password)
    throw new Error("PLATFORM_ADMIN_DATABASE_URL needs a user and a password");
  if (login === "rakazo_app" || login === PLATFORM_ADMIN_ROLE) {
    throw new Error("PLATFORM_ADMIN_DATABASE_URL must be its own login");
  }
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login]);
    if ((exists.rowCount ?? 0) > 0) {
      const runtime = await owner.query<{ member: boolean }>(
        "SELECT pg_has_role($1, 'rakazo_app', 'member') AS member",
        [login],
      );
      if (runtime.rows[0]?.member) {
        throw new Error("The platform admin login cannot also be the application login");
      }
    }
    const existing = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [login],
    );
    const role = existing.rows[0];
    if (role?.rolsuper || role?.rolbypassrls) {
      throw new Error(
        "The platform admin login cannot be a superuser or bypass row-level security",
      );
    }
    const [admin] = (
      await owner.query<{ superuser: boolean }>(
        "SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      )
    ).rows;
    const database = (await owner.query<{ name: string }>("SELECT current_database() AS name"))
      .rows[0]?.name;
    const name = escapeIdentifier(login);
    const secret = `PASSWORD ${escapeLiteral(scramSha256Verifier(password))}`;
    const limits = admin?.superuser
      ? "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION"
      : "";
    if (!role) await owner.query(`CREATE ROLE ${name} LOGIN ${secret} ${limits}`);
    else await owner.query(`ALTER ROLE ${name} LOGIN ${secret} ${limits}`);
    await owner.query(`GRANT ${PLATFORM_ADMIN_ROLE} TO ${name}`);
    if (database) {
      await owner.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${name}`);
    }
  } finally {
    await owner.end();
  }
}

/**
 * `provisionRuntimeRole` grants the app login every table. The audit log is not one of them:
 * only the platform-admin login can read or insert it.
 */
export async function revokeRuntimeAdminAuditAccess(migrationUrl: string): Promise<void> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    await owner.query(`REVOKE ALL ON TABLE "admin_audit_log" FROM ${RUNTIME_ROLE}`);
    await owner.query(`REVOKE ALL ON TABLE "admin_audit_log" FROM PUBLIC`);
  } finally {
    await owner.end();
  }
}
