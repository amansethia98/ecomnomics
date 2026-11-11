# Platform admin

`/admin/v1` is for a person who operates the platform, not for a restaurant and not for its computer.

Set `ECOMNOMICS_PLATFORM_ADMINS` to a comma-separated list of verified account emails. An empty list means nobody. This is separate from `RAKAZO_ADMIN_EMAILS`.

Set `PLATFORM_ADMIN_DATABASE_URL` to a Postgres login that is not the app login. `pnpm db:migrate` grants that login the `ecomnomics_admin` role. The role can read restaurants, outlets, and job-run fields other than the error text. It can insert the audit log. It cannot read token hashes, secrets, or passwords, and it cannot turn on `app.rls_bypass`.

`GET /admin/v1/restaurants` and `GET /admin/v1/restaurants/:id` require a signed-in session for an allowlisted, verified email. Each successful read writes an `admin_audit_log` row first (`adminUserId`, `action`, `restaurantId`, `target`, `ip`, time). If that write fails, the response is `503` and includes no rows.

An agent token is `403` on these routes, including when a session is also present. A normal signed-in user who is not on the list is `403`. Neither of those writes an audit row. With no admin database URL, the routes answer `503`.
