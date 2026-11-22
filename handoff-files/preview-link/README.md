# Private preview link (box-local)

Aman can open a public HTTPS URL that reaches this box's local Ecomnomics dashboard (the pilot restaurant's stored data, which is not in this folder). The current URL is in `/workspace/preview-link/ACCESS.txt` (mode 600). Aman set his own password; it is not stored in that file. `start.sh` and `test-public.sh` read `PREVIEW_LINK_PASSWORD` from the environment. Caddy uses the bcrypt hash in `private/basic.bcrypt`, not the plain value.

## What is running

- **Caddy** on `127.0.0.1:8787`: HTTP basic auth, blocks `/admin` and `/admin/*` and sign-up, then reverse-proxies to the configured upstream. It rewrites `Host` and `Origin` to the upstream origin so the app's trusted-origin check still passes when the public hostname changes. It matches any `Host` header (needed for `*.trycloudflare.com`).
- **cloudflared quick tunnel** in front of Caddy. Free, no Cloudflare account. The hostname is a random `*.trycloudflare.com` and **changes if cloudflared is restarted**.
- **edge-forward** on `127.0.0.1:7844` plus a local DNS helper and a marked `/etc/hosts` block (`region1.v2.argotunnel.com` and `region2.v2.argotunnel.com` → `127.0.0.1`). This box's default resolver returns a fake IP, and raw outbound TCP to Cloudflare's tunnel edge is intercepted. The forwarder uses the box HTTP CONNECT proxy at `127.0.0.1:8791` to reach a real edge address on port 7844. `start.sh` adds the hosts block if it is missing (it does not remove it).
- **Upstream (now):** the preview-s2 Vite dev server on `127.0.0.1:5173`, talking to the API on `127.0.0.1:3100`, using the existing Postgres on `127.0.0.1:55450` (not reset). That checkout is currently `fa489bd307987347acc474159367d42458f82a91` (PR #33 head as of this setup). This is a dev server, not a production build.

The docker app containers (`ecomnomics-agentv1-web/api/supervisor`) were stopped when this link was set up; only `ecomnomics-agentv1-postgres-1` was up. The rakazo-benchmark stack was not touched.

## Commands

```sh
/workspace/preview-link/start.sh          # start or refresh; keeps the tunnel hostname if cloudflared is already up
/workspace/preview-link/stop.sh           # stop Caddy, cloudflared, the edge forwarder, and the local DNS helper
/workspace/preview-link/repoint.sh 127.0.0.1:5523   # point at the docker web port after a rebuild
/workspace/preview-link/test-public.sh    # curl the public URL (no passwords printed)
```

## After a rebuild to new PR heads

1. Start the docker stack as usual, for example:
   `WITH_MODEL=1 SKIP_BUILD=1 /workspace/live-agentv1/rebuild.sh <sha>`
   Docker web is published at `127.0.0.1:5523` and the API at `127.0.0.1:3320`. Do not reset the database.
2. Repoint the gateway (keeps the same trycloudflare hostname if the tunnel process is still up):
   `/workspace/preview-link/repoint.sh 127.0.0.1:5523`
3. Run `/workspace/preview-link/test-public.sh`.

## Restarts and the nightly 5:30 stop

- **Caddy, cloudflared, the edge forwarder, and the local DNS helper** are ordinary box processes. They do not come back after a box reboot or if they are killed. Run `start.sh` again. A new `start.sh` after cloudflared was stopped will get a **new** hostname; update anyone who has the old link. The `/etc/hosts` override stays until someone removes the marked block.
- The **nightly 5:30 routine stops the docker stack** (web/api/supervisor) and leaves Postgres up. It has previously left the preview-s2 dev server on `:5173` running. If the gateway is still pointed at `:5173` and that process stays up, the link keeps working. If you have repointed to `:5523`, the link will fail after the nightly stop until the stack is started again with `rebuild.sh` (Caddy and the tunnel can stay up).
- Do not touch the `246c11b` rakazo-benchmark stack.

## Login

Two gates, both using `PREVIEW_LINK_PASSWORD` (Aman set this himself; it is not in `ACCESS.txt`):

1. Browser basic auth (username `aman`). The bcrypt hash is in `private/basic.bcrypt`.
2. The app's owner login (`APP_EMAIL`, Aman's existing owner account for the pilot restaurant). That email is not in `ECOMNOMICS_PLATFORM_ADMINS`. The gateway also returns 404 for `/admin` and `/admin/*`.


## Production static files and tunnel watchdog

Caddy serves `web-dist/` (a snapshot of `pnpm --filter @rakazo/web build`) and proxies `/api/*` and `/rpc*` to `127.0.0.1:3100`. Origin is rewritten to `http://127.0.0.1:5173` so the running API's trusted origin still matches. There is no Vite HMR websocket and no Vite host allow-list.

Quick tunnels on this cloudflared (2026.11.1) still log `ha-connections:1` even when `--ha-connections 4` is passed, so reliability comes from the watchdog, TCP keepalives, and a stable DNS path rather than extra edge connections.

The `ParseAddr("")` DNS error happened because `/etc/hosts` answered `region1.v2.argotunnel.com`, so cloudflared's resolver-discovery lookup never talked to a DNS server and got an empty address. `TUNNEL_DNS_RESOLVER_ADDRS` is set but is only wired on `cloudflared tunnel run`, not on a quick tunnel. The fix: `dns53-forward` (sudo, `127.0.0.1:53` -> local-dns `:5353`) plus cloudflared in a mount namespace with a private resolv.conf (`nameserver 127.0.0.1`) and a hosts file that does not override argotunnel names. Edge hostnames still resolve to `127.0.0.1` via local-dns. `edge-forward.py` enables TCP keepalives on the CONNECT hop.

`bin/watchdog.py` restarts Caddy, local-dns, or edge-forward if they die, and restarts only edge-forward (keeping the same cloudflared process and hostname) if the public URL stops returning 401. It starts a new cloudflared (new hostname) only if that process itself is dead.

`stop.sh` also stops the watchdog. Rebuild the web snapshot with `pnpm --filter @rakazo/web build` in the preview worktree and copy `apps/web/dist` to `web-dist/`.
