# Payout installation and execution checks

## Installation regression

`COPY --chmod=644 ... /usr/local/lib/rakazo/payout/` left the destination directory
mode 0644 in the computer image. Files were readable but the sandbox user could
not traverse their directory. This is an image bug, not the read-only source
mount: the mounted source directory was mode 0755. Both installed calculator
wrappers depend on that installed directory.

The image now restores read/search permissions on all three installed library/data
directories and runs `payout-preflight --platform both` **as the sandbox user**
during the build. The preflight runs the selected calculators' `--help` without
reading credentials, financial files or accessing the network. It rejects the
0644-directory regression even if an operator accidentally invokes it as root.
The supervisor fingerprint includes the new helper, so an old computer image is
not considered current. Rebuild the computer image to deploy the permission fix;
changing the API alone cannot repair a previously built computer image.

The old 246c11b image did not contain these installed payout wrappers/library;
old trial helpers were provisioned separately. A successful Zomato report does
not establish that both installed commands work as an unprivileged user. The
archived Zomato thread has six failed shell calls despite its correct final
report; the compact archive does not preserve command arguments/results needed
to establish its exact successful fallback. Do not infer that the installed
Swiggy library was therefore healthy.

## Skills

The Payout reconciliation guide is still registered from
`restaurant-templates/payouts/skills/payout-reconciliation/SKILL.md` in the builtin
catalog. No upstream path/loading regression was found. An earlier Swiggy task
read the guide twice and a verified old Swiggy task read it once; the failing new
Swiggy task did not call `skill_read`. Being offered a catalog entry is not the
same as having read its body.

The bot template and run instructions now explicitly require reading the guide
before either platform's browser/shell work, including detailed requests and
separately authorized login. The run instruction also covers existing bots, not
only newly instantiated templates. Content is reused across credential replies
for the same task. This is model guidance, not a hard tool gate or proof that a
future model run obeys it. The guide includes Swiggy's fresh job marker and the
correct installed commands, avoiding helper discovery and missing-job detours.

## Timing evidence (11–12 November 2026, IST)

These are archived runs; no new paid or live run was used for this analysis.
The same `x-ai/grok-4.7` model was used in all comparisons.

| Run | Wall time | Model calls | Full snapshots | Browser acts | Shell calls | Skill reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Old verified Zomato, signed in | 72.37 s | 10 | 2 | 1 | 2 | 1 |
| Old verified Swiggy, signed in | 80.32 s | 9 | 1 | 2 | 2 | 1 |
| Old combined reconciliation | 184.50 s | 28 | 4 | 4 | 10 | 1 |
| New Zomato, fresh login | 401.25 s | 45 | 13 | 8 | 17 | 3 |
| New Swiggy, fresh login/outlet switch, failed calculator | 471.73 s | 40 | 7 | 15 | 16 | 0 |

Tool counts sum each UI step's `count`, not the number of grouped labels. A
browser act may itself contain several actions. The intermediate 71d39ef5
Swiggy run stopped at a budget guard during outlet switching, so its 203.08 s
is not a completed reconciliation baseline.

### Top three causes and changes

1. **Different starting state and owner wait.** The old reconciliation trials
   already had signed-in browsers and the selected outlet. New Zomato spent
   69.54 s explicitly waiting for the owner code. It used 11 calls before that
   reply and another 34 after. Swiggy acknowledged login/outlet progress about
   80–88 s after task start; the paid/download progress note was about 120 s in.
   These progress notes bound phases, not exact tool execution timestamps.
   Existing instructions preserve browser profiles. The guide now directs use
   of an outlet selector's visible exact-ID search when available, with the
   same ID/name verification. Expected saving: perhaps 10–30 s on a long outlet
   list; retaining a valid session can avoid roughly 1–2 minutes of fresh login,
   but that is not a new code optimization or a guarantee.
2. **Broken installed calculator and exploratory recovery.** New Swiggy used
   16 shell calls and three failed browser acts; its last approximately
   5m41s after the paid/download progress note included file collection,
   scope checks, calculation attempts and diagnostics. It is not possible to
   charge that whole interval to permissions alone. New Zomato also had six
   failed shell calls. The image fix removes the known permission failure;
   preflight now catches installation faults before login. In the isolated,
   network-disabled image smoke, both calculator imports/help checks completed
   as the sandbox user in about 0.3 s. Expected saving: tens of seconds to
   1–2 minutes of diagnosis in this failure case; it also prevents paying for
   a login that cannot possibly produce a report.
3. **More model turns and redundant page/helper work.** New Zomato/Swiggy used
   45/40 model calls versus 10/9 in the warm single-platform trials. Swiggy's
   context (including cached input) averaged about 55,596 tokens per call,
   versus 18,762 in the old Swiggy trial. The guide now reuses the fresh snapshot
   returned by an action, asks for focused snapshots only when needed, uses
   installed commands directly, batches independent path checks, and stops
   dashboard exploration after required evidence/download checks. It also
   distinguishes All from Swiggy-only scope before the comparison, rather than
   rediscovering an apparent discrepancy. Expected saving: 4–10 avoidable model
   turns, roughly 25–90 s, depending on dashboard state. This overlaps the
   diagnostic savings above; do not add these estimates as measured savings.

Median completion-to-completion intervals were 5.11 s (new Zomato), 7.23 s (new
Swiggy), 6.51 s (old Zomato), 6.84 s (old Swiggy), and 5.21 s (old combined).
Mean intervals were 8.66/11.71 s in the new runs, 6.14/7.88 s in the old single
platform runs, and 6.26 s in the old combined run. Long gaps include user waits,
tools, model processing and retries. The archives contain completion timestamps,
not model request starts or tool spans: **these are not model-only latencies**.
Exact snapshot, wait, retry and outlet-switch timings cannot be reconstructed.

Isolated stack startup was approximately 10 s/22 s and was outside the reported
Zomato/Swiggy run clocks. Completion detection added approximately 11 s per new
run; the old combined run also had approximately 14 s of such tail overhead.
Neither explains the multi-minute increase.

No login method, credential handling, mandatory outlet/period/freshness check,
financial tolerance, model selection, or authentication timeout is weakened.
Parallelizing/batching authentication clicks or using fixed dashboard URLs is
not included. Live performance improvement remains to be measured after rebuild.

## CI drift

The failed PR check passed lint, then failed `@rakazo/mobile:check` because
`expo install --check` fetched a newer remote patch recommendation for 21 SDK
packages. It was not an OTP TypeScript error. Static CI now sets the official
`EXPO_OFFLINE=1` flag so Expo still validates dependencies against its installed
SDK's bundled native-module map. Turbo's check task declares that environment
variable as cache input. No validation is disabled and no mobile dependencies
are upgraded. All 38 non-excluded manifest entries satisfy Expo 58.0.23's bundled
map; React and React DOM were already explicitly excluded in the existing
manifest. Actual mobile TypeScript checking still runs in CI.
