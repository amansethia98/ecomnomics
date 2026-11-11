# Experimental encrypted platform session backup — OFF by default

This experiment is isolated from the proven login flow. It adds a trusted
supervisor endpoint, not an automatically offered model tool or a replacement
login method. A trusted orchestrator must explicitly call it around the existing
login/reconciliation workflow during an approved test. Do not enable production
or add automatic integration until both platforms pass that live test.

## What already persisted

Old 246c11b and current `rakazo-browser` use the durable home profile
`/home/rakazo/.browser-profiles/chromium` (display-specific siblings for other
screens), `--user-data-dir` and `--restore-last-session`. Cookies, local storage
and the rest of the normal profile remain in that tenant's home. The upstream
browser-wrapper changes add language handling and isolated Python execution;
they do not remove profile persistence. Current supervisor replacement/stop
logic retains the home and checkpoints browser profiles.

Fresh test tenants or new data roots do not inherit another tenant's login.
For a session-reuse benchmark, keep the same stable bot, space, durable data root
and restaurant settings. Use fresh tenant homes only when testing fresh login.
Never make session reuse faster by sharing cookies between restaurant tenants.

## Opt-in protocol

The supervisor flag `RAKAZO_BROWSER_SESSIONS_ENABLED=1` is required. Any other or
missing value disables the endpoint before any computer, key, storage or CDP
access. The native helper also defaults off. Configure a separately generated
32-byte base64 `RAKAZO_BROWSER_SESSIONS_KEY` **only on the supervisor**, using the
existing deployment secret mechanism. No key is generated, committed, returned,
logged or passed to the computer. Missing/wrong keys fall back to the current
profile and proven login; never use a default encryption key.

The authenticated, identity-fenced supervisor endpoint is:
`POST /computers/:id/browser-session`. Use the normal supervisor client and its
bot/space/screen/lease headers, never a model-visible bearer token.

- **After a verified successful login:** call
  `{"command":"save","platform":"<zomato-or-swiggy>","verifiedSignedIn":true}`.
  The orchestrator must first verify the configured restaurant/outlet in the
  ordinary live browser. Capture is read-only, rejects visible login/OTP forms,
  and requires a visible first-party HTTPS dashboard.
- **At the next task, before any new platform navigation:** call
  `{"command":"restore","platform":"<zomato-or-swiggy>"}`.
  Any existing platform cookies or open platform tab take precedence; the helper
  does not overwrite a potentially newer or token-only current session. With a
  usable backup and an otherwise empty profile, it opens the saved dashboard
  URL, restores first-party cookies and exact-origin local/session storage via
  native Chromium CDP, and removes the one-time storage preload script.
- **Always verify the real page:** `verify_live_page` is not proof of login.
  Check the actual dashboard and configured outlet ID/name before proceeding.
  A visible auth form or auth redirect returns `proven_login_required`.
  Missing, expired, corrupt or unsupported backups return the current-profile
  fallback. Inspect it; if sign-in is needed, use the existing proven full login.
  The helper never types, requests/resends a code, submits a login, or logs out.

There is no Playwright dependency or Playwright browser interaction.

## Storage and scope

Encrypted artifacts live outside Git and outside the bot home:
`<supervisor DATA_DIR>/encrypted-browser-sessions/<SHA256([spaceId,botId])>/<platform>.session.enc`.
They are AES-256-GCM authenticated, with independently HKDF-derived tenant/platform
keys and tenant/platform/version associated data. Files are mode 0600, private
directories mode 0700, and writes are atomic. Copying a blob between tenants or
platforms fails authentication. Scope comes only from the verified supervisor
identity, never an outlet name or a request-supplied filesystem path. Keep
independent restaurant accounts in separate bot/computer identities; multiple
outlets under one authorized platform account may use its existing bot.

The backup contains only that platform's first-party cookies and the selected
dashboard origin's web storage. Cookie/storage values travel only through private
in-memory supervisor/CDP/stdin buffers, not HTTP results, argv, logs, model context
or plaintext files. The master key stays on the supervisor. The ordinary live
Chrome profile necessarily remains normal browser state in its private home;
this experiment encrypts the **backup**, not Chrome's entire active filesystem.
Do not invoke the internal helper from a model shell: capture stdout is a private
transport consumed only by the supervisor and never streamed to a caller.

Artifacts expire after 24 hours. Expired cookies are not restored. Server-side
revocation is detected only from the real page, not by guessing token validity.
Partitioned cookies, IndexedDB, service-worker state and client certificates are
not supported by this prototype; failures retain the full-login fallback. It is
not claimed to work live until the test below passes.

## Approval-gated live test and cost

Test one configured restaurant/platform first, on the isolated test stack:

1. With the flag off, complete the proven full login and read-only reconciliation;
   compare with that restaurant's verified report. Enable the experimental flag
   with its supervisor-only key and save only after live outlet verification.
2. Stop that test computer cleanly. Reversibly archive only its test browser
   profile, keeping the same bot/space, encrypted store, key and private settings.
   Restart to an empty profile, restore before platform navigation, verify the
   configured outlet and session without any credential prompt, and run the
   same read-only reconciliation with a fresh download. Compare every row.
3. Test an expired/corrupt **test copy** of the artifact. Confirm no cached login
   is claimed, then approve one current proven full-login fallback and verify
   the report again. No account logout/revocation or OTP resend is required.
4. Stop the isolated stack and retain only private encrypted evidence. Repeat
   for the other platform only after the first passes.

Estimated—not measured—cost: roughly ₹80–150 for each full-login reconciliation
and ₹10–30 for the restored-session check, about ₹170–330 per platform for all
three stages. Keep each individual run within its separately approved ceiling.
A valid restored session could avoid roughly 1–2 minutes of login plus owner-code
waiting; an already valid durable profile gains essentially no additional login
saving from this backup. No live runs or paid calls were made to develop it.
