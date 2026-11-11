# Generic payout installation and performance rules

These rules apply to any configured restaurant/outlet. Never put restaurant
identities, contact details, credentials, financial evidence or live-run archives
in this repository. Keep them in the tenant's private runtime storage.

## Installation

`COPY --chmod=644` can leave a destination directory non-searchable even when its
files are readable. The image restores read/search permissions on the installed
library/data directories and runs `payout-preflight --platform both` as the
sandbox user during the build. Preflight invokes calculators' `--help` without
opening credentials or financial files and without network access. A regression
test uses a temporary fake installation with a deliberately broken directory mode.

The supervisor fingerprint includes the helper. Rebuild the computer image to
deploy permission changes: updating only the API cannot repair an old image.
The old 246c11b image did not bundle the new payout library/wrappers, so its
separately provisioned test helpers are not proof that a new image is healthy.

## Speed interventions (all generic)

1. **Fail fast before login.** Check the installed calculator for the platform
   requested in this task. A broken image stops immediately, without spending
   time on login, downloads or repeated repair attempts.
2. **Read the guide once per task.** Both the template and runtime instructions
   require the available Payout reconciliation skill before payout work. Reuse
   it across credential/code replies for that task, including existing bots.
   This is model guidance, not a hard gate or proof of future model compliance.
3. **Reuse valid browser state.** Keep the restaurant's existing browser profile;
   inspect the current page and use the proven login only when genuinely needed.
   Never clear cookies or log out merely to begin another reconciliation.
4. **Find the configured outlet.** If the visible selector supports search,
   search using the outlet ID from this restaurant's settings. Verify the
   selected ID and name against those settings. Never hardcode an outlet,
   restaurant name, locality, city, phone, URL parameter or list position.
5. **Reuse action snapshots.** After sign-in, use the fresh structured page
   returned by an action; request another snapshot only if the relevant state
   is missing, changed or still loading. Prefer focused queries over repeatedly
   reading the entire page. Do not alter the separately authorized login flow.
6. **Match observed payment scope.** Determine components and service period from
   the current export and dashboard. No particular tab name, brand combination,
   cycle weekday, settlement delay or account layout is assumed. If the export,
   screen and calculator cannot support the same scope, stop and explain it.
7. **Use installed commands directly.** Batch independent path checks when
   needed, avoid repeated helper/source discovery, and never calculate owner
   figures in the model or invent a report after calculator failure.
8. **Stop after evidence is complete.** Once the configured outlet, actual
   period, paid status, payment scope and fresh download are verified, run the
   calculator and deliver its permitted output; avoid unnecessary UI exploration.

## How to measure improvements

Use clearly fake data for offline fixtures and keep real-run measurements outside
Git. Compare equivalent starting states: fresh login against fresh login, or a
signed-in reconciliation against a signed-in reconciliation. Record model-call
counts, grouped tool-step counts, snapshots, retries, owner waits, profile reuse,
outlet-selection work, calculator failures, startup and completion-monitor tail.
Sum each UI step's `count`; a grouped label is not necessarily one invocation.

Completion-to-completion intervals include model, tools, network, retries and
owner waits. Do not call them model-only latency without request-start and
request-end spans. Separate stack startup and monitoring overhead from task time.
Report savings only after measurement; do not generalize one restaurant's timings
or costs into a guarantee for others. Fewer redundant model turns and avoiding
broken-installation detours should help, without weakening verification.

## CI dependency validation

Static CI sets official `EXPO_OFFLINE=1` so Expo validates the mobile manifest
against the installed SDK's bundled native-module map, rather than mutable remote
patch recommendations. Turbo declares that flag as a check-task cache input.
Validation remains enabled; existing React/React DOM exclusions are unchanged.
Actual mobile TypeScript checking still runs in CI.
