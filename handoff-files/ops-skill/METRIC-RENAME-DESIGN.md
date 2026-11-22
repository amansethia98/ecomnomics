# Renamed or missing metric labels: design (self-fixing label check)

Status: design only, for Aman's approval. No code, no PR, no push. PR #19 stays on hold until this is approved.
Author: Engineer - SaaS. Date: 15 Nov 2026 (IST).
Read against: main `b9b88449`, PR #19 head `ae70a200` (Swiggy xlsx), PR #21 head `0e2c33be` (payout cross-check), `ops-skill/FETCH-JOB-DESIGN.md`, `ops-skill/DATA-PLAN.md`, `step3-fixtures/LAYOUT.md`.

---

## 0. The problem in plain words

Zomato and Swiggy sometimes rename a row in the business report or a column in the payout workbook. Today every label we read is a string in code, so a rename quietly breaks the numbers.

What the code does today when a label is renamed (checked on main):

| Where | Today's behaviour | Why it is bad |
|---|---|---|
| Business report (`metric-parse.ts`, `read(column, section, label)`) | The lookup misses, `push()` stores `value: null`, the fetch is still `stored` | Null looks the same as "the platform had no figure" |
| Business re-fetch (`planReplaceWindow` in `metric-window.ts`) | The renamed key is still in the incoming rows with `null`, and `sameValue` sees a change, so the **good value stored last week is superseded by null** | A rename destroys history on the next re-fetch, not just new days |
| Payout workbook (`payout-parse.ts`, `col` / `colIncludes` / `cell` then `costPaise`) | A missing column gives `""`, and `costPaise("")` returns **0** | A fee or tax silently becomes ₹0; the cross-check then fails for an unclear reason, or worse, passes when the term was small |
| Payout dedupe | Same file bytes + same parser version = `skipped` | After a fix, the same file cannot be re-read without a parser-version bump |

So the fix has four parts: labels become data, a missing label is detected and stored as "pending", a confident rename fixes itself, and the affected days are fetched again on their own.

---

## 1. Label registry: aliases as data (requirement 1)

### 1.1 What a "slot" is

A **slot** is one thing a parser reads from a file: one business-report row, or one payout column or breakup line. It is not the same as a metric key, because one label can feed several keys (Swiggy `New Customer Order %` feeds `swiggy_new_customer_pct` and the derived `swiggy_new_customer_orders`) and payout columns feed order fields, not dictionary keys.

Slot ids are stable strings, for example `swiggy.business.SALES.net_sales`, `zomato.business.Customer funnel.cart_builds`, `swiggy.payout.order_level.commission`, `zomato.payout.order_level.gst_restaurant_payable`, `zomato.payout.breakup.net_payout`.

### 1.2 Tables (global, not per tenant)

Migration `20261215120000_metric_labels`.

**`metric_label_slots`** (one row per slot; seeded, rarely changed)

| Column | Type | Notes |
|---|---|---|
| id | text PK | the slot id above |
| platform | text | `zomato` / `swiggy` |
| family | text | `business`, `payout_order_level`, `payout_breakup`, `payout_adjustments`, `payout_summary` |
| section | text | business `Overview` value (`SALES`, `Customer funnel`…) or the sheet name for payouts |
| valueType | text | `money`, `count`, `decimal`, `pct`, `minutes`, `hours`, `score_100`, `rating_5`, `ratio`, `date`, `text_id`, `flag` |
| summable | boolean | true for counts and money; false for pct, ratio, rating, score, averages, AOV, KPT |
| required | boolean | absent → finding. False for optional columns with a defined fallback (Zomato AJ, Swiggy MFR flags, `paid amount`) |
| anchor | boolean | the file cannot be read at all without it (payout `order id`, `order status`, `order date`; business header prefix is handled separately) |
| relations | jsonb | checks that tie this slot to others, used as evidence (§3.3). Example for `swiggy.business.CONVERSION_FUNNEL.menu_to_cart`: `pct ≈ cart_builds / menu_opens × 100 ± 1` |
| bounds | jsonb | sanity limits, e.g. pct 0–100, rating 0–5, count integral ≥ 0 |
| autoApply | boolean | default true; false for slots where a wrong guess is too costly (UTR, customer id, order id) |
| feedsKeys | text[] | documentation only: dictionary keys or payout fields this slot feeds |
| retiredFrom | date null | set when the platform has really stopped reporting it (§6.7) |

**`metric_label_aliases`** (the list of known names; this is what admins add to)

| Column | Type | Notes |
|---|---|---|
| id | text PK (cuid) | |
| platform, family, section | text | copied from the slot so ignore-rows (no slot) also have a scope |
| slotId | text null FK | null when `role = ignore` |
| role | text | `read` (maps to the slot), `ignore` (known label we do not read), `section` (an alias for a section name), `item_pattern` (dynamic rows such as Swiggy `<item> Revenue %`) |
| label | text | as printed, for display |
| normLabel | text | normalised form (§1.4); the lookup key |
| matchMode | text | `exact` (all business labels, and every alias added later) or `tokens` (payout seeds only, see §1.3) |
| includeTokens / excludeTokens | text[] | for `tokens` mode |
| source | text | `seed`, `auto`, `admin` |
| findingId | text null | the finding that created it |
| version | int | registry version when it was added |
| createdBy | text null | admin user id; null for seed and auto |
| retiredAt | timestamptz null | |

Unique index: `(platform, family, section, normLabel) WHERE retiredAt IS NULL AND matchMode = 'exact'`. This is the collision guard: one live label can only mean one thing in one place.

**`metric_label_registry`** is a single row `{ id: 'global', version int, updatedAt }`. Every alias insert or retire bumps `version` in the same transaction. This version is the "alias-set version" used for caching and re-ingest (§4).

### 1.3 Seeding from today's code

- A seed file `packages/contracts/src/metric-label-seed.ts` lists every slot and alias, generated once from `SWIGGY_SUMS`, the `emitSwiggy` / `emitZomato` reads and the `payout-parse.ts` column helpers. The migration inserts it with `ON CONFLICT DO NOTHING`, and a small idempotent `db:seed-labels` step re-applies new seed rows on deploy, so a code-added alias never overwrites an admin one.
- Business labels seed as `exact` aliases.
- Payout helpers today are substring predicates (`colIncludes(header, "gst collected")`, `label.includes("service fee") && !label.includes("%") && …`). They seed 1:1 as `tokens` aliases (`includeTokens: ["service fee"]`, `excludeTokens: ["%","payment","tax"]`), and keep their first-match order through an `order` field, so behaviour does not change. The PR #21 GST helper seeds two optional slots: `gst_paid_9_5` (`gst` + `9(5)`) and `gst_restaurant_payable` (`gst` + `restaurant partner`, or `to be paid` + `govt`), with the documented fallback "collected − 9(5)".
- The Swiggy item rows (`<name> Revenue %`) seed as one `item_pattern` alias, so item names are never "unknown".
- **Golden test:** every synthetic fixture (step-1 business CSVs, PR #19 workbooks, step-3 payout workbooks) is parsed by the old code and the new registry-driven code, and the outputs must be identical. This is how we prove the seed matches the code.

### 1.4 Normalisation (one function, shared by parsers and admin)

`normaliseLabel(text)`:
1. Unicode NFKC, then trim and collapse all whitespace to one space; lowercase.
2. Currency: `₹`, `rs`, `rs.`, `(rs)`, `inr` become the token `inr`.
3. Percent: `%`, `(%)`, `pct`, `percent`, `percentage` become `pct`.
4. `&` becomes `and`; `<` becomes ` lt `, `>` becomes ` gt ` (so `Delayed Orders (>5 mins)` and `Orders with <6 min Prep time` stay distinct).
5. Remove brackets, quotes, dots, commas, hyphens and slashes, but keep their contents and keep digits (`9(5)` becomes `9 5`, `(>5 mins)` becomes `gt 5 mins`). `mins`/`min`/`minutes` become `min`.
6. Collapse whitespace again.

A CI test asserts that the seed's normalised labels are unique within each `(platform, family, section)`; if a future normalisation rule merges two real labels, the build fails.

Units are part of the label for Zomato (`Sales (Rs)`, `Online %`) and part of the cell for Swiggy (`₹1,234`, `93%`, `14 mins`). Both are kept: the normalised label keeps `inr`/`pct`, and the cell kind from `parseCell` is checked separately as evidence (§3).

### 1.5 How parsers use it, and caching

- Parsers stay pure functions in `packages/contracts`. They receive a `LabelBook` object (slots plus aliases, indexed by `(platform, family, section, normLabel)`), instead of reaching for constants. `evaluateBusinessReport(csv, expected, book)` and `parsePayoutWorkbook(bytes, platform, salt, book)`.
- `packages/db` builds the book with `loadLabelBook(db)`. It is cached in-process keyed by registry `version`. Each ingest does one indexed read of `metric_label_registry.version`; if it is unchanged the cached book is used, otherwise it reloads. No TTL guessing; a new alias is live on the very next upload on every API instance.
- Tests and the agent's local precheck can build a book from the seed file with no database.

### 1.6 Global scope and RLS

These tables hold platform layout facts, never restaurant data, so they are global (no `spaceId`), like a reference table.
- `metric_label_slots`, `metric_label_aliases`, `metric_label_registry`: RLS enabled with a `SELECT USING (true)` policy, so an agent request inside `runAsTenant` can read them. INSERT/UPDATE only for the `ecomnomics_admin` role (platform admin routes, through `runAsPlatformAdmin`) and for the named system bypass `runAsSystemInTransaction("metric label auto-apply", …)`. The agent token can never write them.
- They are not added to `ROW_SECURITY_MODELS` as tenant models; a test asserts an agent route cannot insert an alias.

---

## 2. Detection and the stored finding (requirement 2)

### 2.1 What the parser reports

After reading every period column, the parser also returns a `labelReport` for the file:
- `absent`: required slots with no matching row or column. For business files, per section.
- `unknown`: rows or columns whose `(section, normLabel)` matches no `read`, `ignore` or `item_pattern` alias. Fully blank rows are skipped.
- `suspect`: present slots whose values break `bounds` or type (a pct of 340, a fractional count, money in a count slot).
- For each unknown and absent: row or column index, the two neighbouring resolved labels, the cell kind seen, and per-period values. Values are used in memory and only **summaries** are stored (§2.3).

### 2.2 Pending, never null and never zero

- Migration `20261215140000_metric_value_state` adds `state text NOT NULL DEFAULT 'ok'` to `restaurant_metric_values`, with a check `('ok','pending_label','label_unrecoverable')`.
- An absent slot writes its keys (and the keys derived from it) with `value = null`, `state = 'pending_label'`, `source = 'pending_label:<findingId>'`. A suspect slot writes `pending_label` too.
- **Pending never overwrites a real value.** In the ingest, if the current row for that slot already holds a real value (`state = ok`, value not null), the pending row is not written and the real value stays. `sameValue` in `planReplaceWindow` compares `(value, state)`, so a later real value always supersedes a pending one.
- `platform_check` rows (daily display values and weekly/monthly totals) for a pending slot are pending too, and `writeChecks` skips them (no false failure in `metric_checks`).
- Payouts: see §7.

### 2.3 Tables for findings

Migration `20261215130000_metric_label_findings`.

**`metric_label_findings`** (global; read and written only by platform admins and the system bypass)

| Column | Notes |
|---|---|
| id | cuid |
| kind | `metric_label_change` (absent + unknown candidate), `metric_absent` (absent, no candidate), `label_suspect` (present but values break bounds, including suspected swaps), `section_rename`, `layout_change` |
| platform, family, reportKind | `daily` / `weekly` / `monthly` / `payout` |
| section | |
| slotId | the old/canonical slot |
| oldLabel | the slot's current primary alias |
| candidateLabel, candidateNorm | null for `metric_absent` and `layout_change` |
| evidence | jsonb: `similarity` (token Jaccard and edit ratio), `position` (row/column index, last good index, neighbours before and after, `sameNeighbours` bool), `unitMatch`, `kindMatch`, `valueEvidence` (relation checks passed or failed, continuity medians, payout rebuild pass rates), `contradictions` |
| confidence | `high` / `low`, plus `ruleResults` (each auto-apply condition true/false, §3) |
| firstSeenAt, lastSeenAt | |
| occurrences | count of files |
| outletsAffected | int; the outlet list lives in observations |
| daysAffected | int |
| status | `open`, `auto_applied`, `approved`, `rejected_ignored`, `rejected_not_rename`, `metric_removed`, `superseded` |
| resolvedAt, resolvedBy | null user id when auto |
| aliasId | alias created on approval |

Dedupe: unique `(kind, platform, family, section, slotId, coalesce(candidateNorm,''))` where `status = 'open'`. A second file with the same pair updates `lastSeenAt`, `occurrences`, counts and evidence; it never makes a second finding. A pair that was rejected as "not a rename" is not reopened by the same pair; a different candidate opens a new finding.

**`metric_label_observations`** (tenant table, `spaceId` + RLS like `fetch_holds`; written inside the tenant transaction of the ingest)

`id, findingId, restaurantId, spaceId, outletId, platform, fetchId, reportKind, periods (daterange list), rowIndex, evidence summary, createdAt`. This is where "which outlets, which days" lives. The finding's counters are refreshed from it by a system-bypass upsert in the same request. Admin reads join through `runAsPlatformAdmin`.

Privacy rules for evidence: business evidence keeps per-file medians, min, max and counts, never per-order data. Payout evidence keeps only types, pass rates and counts; **never a cell value from a payout file**, so no UTR, customer id, PAN or GSTIN can land in a finding.

### 2.4 What is not a finding

- An unknown label with no absent slot in the same section: a new metric the platform added. It is counted in a per-label `unknown` observation (visible in the admin "Unknown labels" list) and nothing is pending. If an admin marks it as a new slot later, that is a normal seed or admin change.

---

## 3. When a rename fixes itself (requirement 3)

### 3.1 The rule (deterministic, all conditions must hold)

A `metric_label_change` finding (slot S absent, candidate label L) is **auto-applied** only when every one of these is true:

| # | Condition | Exact test |
|---|---|---|
| A1 | One-to-one in the section | In every observed file, the section (business) or header row (payout) has **exactly one** absent required slot and **exactly one** unknown label |
| A2 | Same place | L's row or column index equals S's last good index (from the most recent stored file of the same platform and report kind) **±1**, or L sits between the same two resolved neighbour labels S had |
| A3 | Same unit and type | Normalised unit tokens match (`inr`, `pct`, `min`, `hours`, none), and the cell kind matches S's `valueType` (money/pct/minutes/number). For `count`, every value is integral. All values are inside S's `bounds` |
| A4 | Similar name | On normalised tokens, Jaccard ≥ 0.5 **or** edit-distance ratio ≥ 0.8, **or** one token set contains the other (`Carts Builds` → `Cart Builds`, `Total CPC Spends` → `CPC Spends`) |
| A5 | No collision | L is not a live alias (any role) anywhere in the same platform and family; no other open finding proposes L for a different slot |
| A6 | Values agree | **Summable slot:** at least one `relations` check of S passes with L's values in ≥ 1 file (e.g. orders bands sum to delivered orders ±1; complaints = non-refunded + refunded; weekly or monthly file reconciles with daily facts within the existing `comparePlatformValue` tolerance; payout: with L plugged in, ≥ 99% of delivered rows rebuild within ₹1 and the pass rate is ≥ 20 points better than with L treated as 0). **Non-summable slot** (pct, ratio, rating, score, averages): a relation check passes where S has one (AOV ≈ net sales / delivered; funnel pct ≈ count ratio ±1 point; KPT weighted sum consistent), otherwise **continuity**: the median of L over the new days is within the band of S's median over the previous 7 stored days for the same outlet (pct and score ±15 points, rating ±0.5, minutes and hours ±50% relative) |
| A7 | Seen enough | Seen in **≥ 2 distinct outlets** (any restaurant), **or ≥ 3 distinct files fetched on ≥ 2 different nights** for one outlet |
| A8 | No contradiction | No file since `firstSeenAt` has S's old label and L both carrying values for the same period, and no outlet on the same platform and report still shows the old label on a period after L was first seen (a platform A/B test) |
| A9 | Allowed | Slot has `autoApply = true` and the env switch `ECOMNOMICS_LABEL_AUTO_APPLY=on` |

If any condition is false, the finding stays `open` with `confidence = low` and goes to the admin panel. The finding stores each condition's result, so the panel shows exactly why it was not automatic.

`metric_absent`, `label_suspect`, `section_rename` with < 80% exact label matches, and `layout_change` are **never** auto-applied. A `section_rename` where ≥ 80% of the section's labels match exactly under one unknown section name, and A5, A7 and A8 hold, is auto-applied as a `section` alias.

### 3.2 Applying (auto or approve) and rejecting

Approve or auto-apply runs in one transaction: insert alias (`role read`, `source auto|admin`, `exact`), bump registry version, set finding status, write a `metric_label_events` row, then queue re-ingest (§4). The alias is global, so every restaurant benefits immediately.

Admin choices in the panel, each one click:
- **Approve**: as above. Returns 409 if the label would collide (§6.5); the panel then shows the conflict.
- **Reject: new unrelated metric**: L becomes an `ignore` alias; S stays absent, so its days stay pending and a fresh `metric_absent` finding takes over.
- **Reject: not a rename, keep pending**: finding `rejected_not_rename`; nothing else changes; a different candidate can still appear.
- **Metric removed by platform** (on `metric_absent`): sets `retiredFrom` on S from the first absent date; pending days on or after that date become `not_available` with the reason "platform no longer reports this".

### 3.3 Audit

- **`metric_label_events`** (global, append-only): `id, at, actor ('system:auto' or admin user id), action (alias_added, alias_retired, finding_approved, finding_rejected, auto_applied, slot_retired, layout_alert_resolved), findingId, aliasId, slotId, before jsonb, after jsonb, registryVersion`. This is the history of every alias-set change, automatic or not.
- Admin actions also write the existing `admin_audit_log` through `readAdmin`, like `clear_fetch_hold` does today.

---

## 4. Re-fetch and re-ingest after a fix (requirement 4)

Raw files are deleted after upload, so a fix can only take effect by downloading the days again. Today that second upload would be `skipped`: `ingestBusinessReport` and `checkStoredFetches` match on `(sha256 or rawSha256, parserVersion, window, status = stored)`.

### 4.1 What changes on the fetch row

Migration `20261215150000_metric_fetch_label_version` adds to `metric_fetches`:
- `labelSetVersion int` (registry version used to parse it);
- `pendingLabels int default 0` (pending slots it wrote).

### 4.2 Dedupe rule

A stored fetch counts as "already stored" only if `pendingLabels = 0` **or** `labelSetVersion = current version`. So:
- Same bytes uploaded again after a fix: the old fetch had pending labels and an older version, so the file is parsed again. That is the re-ingest.
- Same bytes uploaded again with nothing fixed: same version, so `skipped`. No loop.
- `POST /agent/v1/fetches/check` applies the same rule and returns `stored: false, reingest: true` for such files, so the runner does not drop them.

### 4.3 Fetch-plan

- `FETCH_WINDOW_REASONS` gains `"relabel"`. `readFetchPlan` adds windows covering current `pending_label` rows for the outlet whose slot now has an alias added after that row's fetch version. Windows are cut to the platform's chunk sizes (Zomato 30 days, Swiggy daily 7) and merged with any scheduled window for the same days.
- A window carries `relabel: { findingIds: string[] }` so the run summary can say why it ran.
- No new endpoint; the nightly 05:30 IST job already follows the plan, so no person is in the loop.

### 4.4 Writing the re-ingested file

The same ingest path as any re-fetch: `planReplaceWindow` replaces only slots whose value or state changed. In practice that is the pending slots; a value the platform has corrected since is recorded as a normal restatement, exactly as a scheduled re-fetch would. It is idempotent: the second identical upload is a no-op.

### 4.5 Limits and failure

- At most 30 relabel days per outlet and platform per night, newest first, inside the existing 90-day horizon.
- Each `(finding, outlet, window)` gets **3 attempts on 3 different nights**. An attempt fails when the download fails, the window comes back as a gap (PR #18 `missingPeriods`), or the slot is still absent.
- After 3 failures, or when the day is older than the platform serves (outside the 90-day horizon), the rows move to `state = label_unrecoverable` and the owner sees "Not available" with a reason, not "updating" forever. For summable slots the job then tries one weekly or monthly file covering those days and stores the window total as a `platform_check` only, so a monthly total can still be shown as partial.
- Re-fetches never bypass a hold: a held outlet (`fetch_held`, 423) gets no relabel windows until an admin clears it.

---

## 5. Owner dashboard shows "Updating" (requirement 5)

- `OwnerMetricValue.status` becomes `"ok" | "not_available" | "updating"`, and gains `updatingDates: string[]` next to `missingDates` and `partialDates`.
- A range where some days are pending: the value is computed from the non-pending days only, `status = "updating"`, and those days are listed. A range where all days are pending: `value = null`, `status = "updating"`. Never 0, never blank.
- Derived metrics (AOV, rates, weighted averages) are `updating` if any input is pending. The combined Zomato + Swiggy view is `updating` and partial if either platform is pending ("Swiggy part updating").
- `label_unrecoverable` days give `not_available` with `reason: "platform_report_changed"`.
- UI (M1, on hold): a quiet shimmer chip "Updating" with the tooltip "Swiggy changed its report. We're re-reading these days." Totals show a small "partial" mark.
- `GET /agent/v1/metrics` returns the same fields, so the Chief of Staff agent sees "updating" and does not reason on a partial total as if it were whole.

---

## 6. Edge cases

1. **Metrics that can't be summed** (ratios, ratings, pct, averages, scores): value similarity uses relations and continuity bands (A6), never sums. Window files only give `platform_check` rows for these, so a rename found only in a weekly or monthly file is confirmed against the daily facts.
2. **Partial-day rename (mid-backfill).**
   - Across files: days fetched before the rename keep the old label and stay `ok`; only later days are pending and re-fetched.
   - In one file: if the old row and L are both present with values on **disjoint** periods, it is a mid-file rename. Before approval, L's periods are pending; after, each period takes whichever row has a value. If both have values on the same period, it is a contradiction (A8) and not a rename.
3. **Multi-outlet.** One finding aggregates all outlets through observations. The alias is global, and fetch-plan queues re-ingest per outlet that has pending rows. If only one outlet shows it while others still show the old label after `firstSeenAt`, that is a contradiction: no auto-apply, but an admin can still approve. Both labels then live as aliases of S, which is fine.
4. **Rename on only one platform.** Aliases are scoped by platform and family, so the other platform is untouched. Labels are never compared across platforms. The combined view shows partial.
5. **Alias collisions.**
   - L is already a live alias of another slot T: A5 fails; L is not "unknown" anyway, so S becomes `metric_absent`. If T's values then fail T's bounds, a `label_suspect` is raised on T.
   - Two slots claim the same label: blocked by the unique index; approve returns 409 and the panel asks to retire the older alias first.
   - Label swap (A↔B, as Zomato already does with "Orders with offers" and "Gross sales from offers"): both labels are present, so nothing is absent. Bounds and type checks catch it (a fractional "orders", money-sized counts). The finding is `label_suspect`, never automatic, and both slots are stored as pending for those days. The existing `assignOffers` special case stays.
6. **Label reused for a different meaning.** The label resolves, but values break hard bounds or type → `label_suspect`, values pending. A continuity breach alone (business really changed) only goes into evidence, not pending.
7. **Metric truly removed.** Absent, no candidate → `metric_absent`, days pending. An admin "Metric removed" sets `retiredFrom`. Long term, with no human: if absent in ≥ 2 outlets for 14 consecutive days with no candidate, the system marks those days `not_available` (reversible, the slot is not retired) and keeps the finding open for review.
8. **New metric added, nothing absent.** Logged as unknown, no finding, nothing pending (§2.4).
9. **Duplicate findings.** Deduped by the open-finding key (§2.3); repeats only update counters.
10. **Section renamed.** Every label in a section absent and the same labels present under an unknown section → `section_rename` (§3.1), not 20 separate findings.
11. **Dynamic rows.** Swiggy item revenue rows match the `item_pattern` alias and are never unknown.

---

## 7. Payout workbook columns (requirement 7)

- **Header lookup.** Each payout field the parser reads becomes a slot in `payout_order_level`, `payout_breakup`, `payout_adjustments` or `payout_summary`, seeded from today's predicates (§1.3). Lookup order: exact aliases first, then `tokens` aliases in seed order, so `tcsColumns` (several columns), `paidColumn` (with "unsettled" excluded) and the PR #21 GST columns behave exactly as now.
- **Absent is not zero.** Migration `20261215160000_payout_label_pending` makes the eleven amount columns of `payout_orders` nullable and adds `pendingFields text[]` to `payout_orders` and `payout_cycles`. An absent required column stores `null` and lists the field; a present column with a blank cell still means 0 as today (`costPaise`).
- **Cross-check rebuild.** The rebuild formulas (`cv − commission − payment − taxes − tds − tcs − complaints + additions + restaurant GST` for Zomato; the Swiggy formula with the PR #21 customer-cancelled rule) refer to slots. If any slot in a formula is pending, that check is stored as `skipped` with `reason: pending_label`, not failed. The Swiggy customer-cancellation rule needs `cancelled_by`; if that column is pending, cancelled-row checks are skipped, not flagged.
- **Rebuild as evidence.** For an order-level money column, A6 plugs L into the rebuild: ≥ 99% of delivered rows within ₹1 and a ≥ 20-point gain over treating L as 0. This is the strongest auto-apply evidence we have.
- **Optional columns with fallbacks** (Zomato AJ "GST to be paid by Restaurant partner to Govt."): `required = false`. If AJ is absent, PR #21's fallback (collected − 9(5)) is used and an `unknown` observation is logged, so the rebuild still works and nothing is pending.
- **Zomato Payout Breakup** "Particular" labels are formulas into Order Level headers (LAYOUT.md), so a column rename usually renames a breakup line too. Approving one proposes the matching breakup alias in the same finding.
- **Anchors.** `order id`, `order status` and `order date` are anchors; if any is absent the file is a layout change (§8). UTR, customer id and order id have `autoApply = false`.
- **Re-ingest for payouts.** The same rule as §4: the payout fetch row gets `labelSetVersion` and `pendingLabels`, and fetch-plan returns a `relabel` payout window for the cycle. The existing payout supersede replaces the cycle's orders.

---

## 8. Whole-layout change: clean rejection, not a hold (requirement 6)

A file is a **layout change** when any of these is true:
- the business header prefix differs (`SWIGGY_HEADER` / `ZOMATO_HEADER`), or a date column label can't be read (today's two rejections);
- more than **25%** of the required slots for that platform and report are absent;
- absences in more than **3 sections**;
- more than **10** unknown labels (item rows excluded);
- a payout anchor column is absent, or more than **30%** of required payout columns are absent.

What happens:
- Nothing is stored. The fetch row is `parse_failed` with a new reason code `layout_changed` and `identityMismatch = false`. `noteIdentityMismatch` is not called, and its count only looks at `rejected_mismatch` with `identityMismatch = true` and `local_mismatch`, so **this never counts toward the 24h hold** (PR #17). A test covers it.
- The API answers 422 with `code: "layout_changed"` (today `rejectedFile` sends `file_identity` for every parse failure; that changes for this case only).
- A `layout_change` finding is opened or updated (deduped per platform and report kind), which is the admin alert. It shows the header and labels seen, never values.
- The runner deletes the file, does not retry that report that night, and the 08:00 IST summary includes it. The runner's local precheck must log a layout problem as `layout_changed` (a new log status), **never** `local_mismatch`, which does count toward the hold.
- After an admin adds the aliases (or a parser change ships), fetch-plan re-includes the missed days because nothing was stored for them.

---

## 9. API changes

**Agent (`/agent/v1`)**

| Endpoint | Change |
|---|---|
| `POST /metric-reports`, `POST /payout-reports` | 200 `stored` gains `labels: { pendingSlots: n, findings: [{ findingId, slotId, kind, status }] }`. The runner just records it in the summary; no action needed. 422 `layout_changed` as §8 |
| `POST /fetches/check` | adds `reingest: boolean` per file (§4.2) |
| `GET /fetch-plan` | windows may carry reason `relabel` and `relabel.findingIds` |
| `POST /fetches` (log) | new log status `layout_changed` |
| `GET /metrics` | `updating` status and `updatingDates` (§5) |

The agent token can't read findings or aliases beyond its own response.

**Platform admin (`/admin/v1`, `ECOMNOMICS_PLATFORM_ADMINS` only, audited)**

| Endpoint | Purpose |
|---|---|
| `GET /label-findings?status=open&platform=&kind=` | list with evidence, rule results, outlet names and counts |
| `GET /label-findings/:id` | detail: observations by outlet and day |
| `POST /label-findings/:id/approve` | add alias, bump version, queue re-ingest; 409 on collision |
| `POST /label-findings/:id/reject` | body `{ mode: "ignore_label" \| "not_rename" \| "metric_removed" }` |
| `POST /label-findings/:id/resolve` | for `layout_change` alerts once handled |
| `GET /metric-labels?platform=&family=` | slots and their aliases |
| `POST /metric-labels/slots/:slotId/aliases` | manual add `{ label }` |
| `POST /metric-labels/aliases/:id/retire` | retire a wrong alias (pending days are re-fetched again) |
| `GET /metric-labels/unknown` | unknown labels seen, with counts |

Nothing in these responses includes credentials, tokens, payout cell values, UTRs or customer ids.

---

## 10. How it fits the existing pieces

- **Gaps (#18):** a gap is a missing period (column); pending is a missing slot (row) in a period that is present. Both can exist on one fetch. A relabel window that returns as a gap counts as a failed attempt.
- **Identity hold (#17):** findings and layout changes never touch the counter. A held outlet gets no relabel windows, and `assertFetchOpen` still applies to re-ingests.
- **Fetch-plan and dedupe (#16):** §4. The raw-hash path and the content-hash path both use the new rule.
- **Swiggy xlsx (#19):** the workbook becomes CSV and then goes through `evaluateBusinessReport`, so the label book applies to it with no change to #19. #19 can merge as it is once this design is approved; PR 1 below rebases on it.
- **Payout cross-check (#21):** its GST and cancelled-row rules become slot-based in PR 6 without changing their maths.

---

## 11. Rollout as small PRs, in order

| # | PR | What it does | Behaviour change |
|---|---|---|---|
| 1 | Label registry and seed | Tables (`20261215120000_metric_labels`), normaliser, `LabelBook`, seed generated from today's code, parsers read through the book, golden test | None (golden test proves it) |
| 2 | Detect and store pending (business) | `labelReport`, findings and observations tables (`…130000_metric_label_findings`), `state` on metric values (`…140000_metric_value_state`), "pending never overwrites real", `layout_changed` code, `labels` in the response. Auto-apply computed but **shadow only** (stored as "would auto-apply") | Renames stop writing null over history |
| 3 | Admin API | List, approve, reject, resolve, manual alias, retire, events and audit log | Admins can fix renames |
| 4 | Re-ingest | `labelSetVersion` and `pendingLabels` (`…150000_metric_fetch_label_version`), dedupe rule, `reingest` in check, `relabel` fetch-plan windows, attempt caps, `label_unrecoverable` | Fixed days refill on their own |
| 5 | Owner "updating" | `updating` status, `updatingDates`, partial totals in owner and agent metric reads | Dashboard never shows 0 for pending |
| 6 | Payout columns | Payout slots used for detection, nullable amounts and `pendingFields` (`…160000_payout_label_pending`), skipped checks, rebuild evidence | Missing payout column is no longer ₹0 |
| 7 | Turn on auto-apply | `ECOMNOMICS_LABEL_AUTO_APPLY=on` after the shadow log shows no wrong "would auto-apply" | Fully self-fixing |

Each PR: synthetic fixtures only, CI verified, Aman's own yes before merge, Engineer - AI agents merges.

**Agent-side work (Engineer - AI agents):** accept the `relabel` window reason; treat 422 `layout_changed` as no-retry plus summary line; log `layout_changed`, never `local_mismatch`, for a layout problem in the local precheck; respect `reingest: true` from the check. That is small and can ship with PRs 2 and 4.

---

## 12. Test plan (synthetic fixtures only, fake ids 900001/900002/900003)

Fixture builders extend the existing step-1 CSVs, the PR #19 workbook writer and `step3-fixtures/_build_fixtures.py`. No real Pawan Putra data.

| Fixture | Expect |
|---|---|
| Swiggy daily, `Carts Builds` → `Cart Builds` | finding, all A1–A6 true; auto-apply after 2 outlets or 3 files; re-ingest fills `cart_builds` |
| Swiggy daily, `Menu to Cart` → `Menu → Cart Conversion` (pct) | continuity and the funnel relation used; no sums |
| Zomato daily, `Sales (Rs)` → `Net sales (Rs)` | A6 by weekly reconcile; unit `inr` kept |
| Unit changed (`Online %` → `Online time (in hours)`) | A3 fails → admin |
| Two renames in one section | A1 fails → two low-confidence findings |
| Rename and swap of the offers rows | `label_suspect`, both slots pending |
| Section `ADS_CPC` → `ADS - CPC` | one `section_rename`, auto-applied |
| Header prefix changed; 40% of labels renamed | 422 `layout_changed`, nothing stored, hold counter unchanged after 5 such uploads |
| Mid-file rename (old row on days 1–2, new on 3–7) | days 3–7 pending; after approval each day from the right row |
| Same rename on outlets 900001 and 900003 | one finding, two outlets, re-ingest per outlet |
| Only one outlet renamed, the other still old | contradiction, no auto |
| New label, nothing absent | unknown only, no finding |
| Label removed, no candidate | `metric_absent`, pending; "Metric removed" gives `not_available` |
| Candidate is already an alias of another slot | 409 on approve, no auto |
| Swiggy annexure `Commission` → `Commission Fee` | rebuild evidence passes, auto-eligible; checks skipped while pending |
| Zomato Order Level AJ header renamed | optional slot, fallback used, nothing pending |
| Payout `Order ID` renamed | layout change |

Postgres tests: RLS (tenant can read aliases, can't write; can't read findings; admin can), finding dedupe, pending never overwrites a real value, `sameValue` with state, dedupe rule (same bytes after approval re-parse; again → skipped), fetch-plan relabel windows and caps, 3-night failure → unrecoverable, held outlet gets no relabel windows, owner read `updating`. Unit tests: normaliser uniqueness over the seed, each auto-apply condition on its own.

---

## 13. Open questions for Aman

1. **Auto-apply start:** run in shadow mode (decide and log, don't apply) for 2 weeks after PR 2, then switch on (PR 7)? Or on from day one?
2. **Corroboration (A7):** 2 outlets, or 3 files over 2 nights for one outlet. With one restaurant today, the second branch is what will fire. OK?
3. **Admin screen:** the step 5 panel is on hold. Approve and Reject need one click from you or Raghav. Can I build only a small "Label changes" page early (PR 3), or should alerts go through Engineer - AI agents' morning summary until the panel exists?
4. **Unrecoverable days:** after 3 failed nights, show "Not available — platform changed its report" (and use a weekly or monthly total where possible)? Or keep "Updating" longer?
5. **Re-ingest writes:** re-ingest goes through the normal replace path, so a value the platform has corrected since is also updated (as any re-fetch does). Fine, or limit re-ingest strictly to the pending slots?
6. **Payout schema:** OK to make the eleven payout amount columns nullable (PR 6)? This is how "absent" stays different from ₹0.
7. **Removed metrics:** OK to auto-mark days `not_available` after 14 days absent in 2 outlets, while the finding stays open for you?
8. **Owner wording:** is "Updating" plus "Swiggy changed its report. We're re-reading these days." the right owner message, or should owners see only "Updating"?
