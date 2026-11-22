import type { OpsRulesConfig } from "./config.js";
import { DEFAULT_OPS_RULES_CONFIG } from "./config.js";
import {
  formatCivilDay,
  formatPct1,
  formatRupees,
  formatSignedPct,
  formatWeekdayShort,
  isoDayDiff,
  pctChange,
  weekMonday,
} from "./format.js";
import { displayFindings } from "./rules.js";
import type {
  AlertState,
  DailyBriefView,
  DailyEvaluation,
  OpsAlertSeverity,
  OpsStatus,
} from "./types.js";
import {
  ALL_GOOD_CHAR_LIMIT,
  appLabel,
  BRIEF_CHAR_LIMIT,
  CALLOUT_LIMIT,
  canSumAcrossApps,
} from "./types.js";

const NO_DATA = "No new data this morning; we'll update this when it lands.";
const CONNECT = "Connect Zomato or Swiggy to get your morning brief.";

export interface CatchUpItem {
  dedupeKey: string;
  severity: OpsAlertSeverity;
  text: string;
  fix: string;
  date: string;
}

export function composeDailyBrief(view: DailyBriefView): {
  text: string;
  chars: number;
  status: OpsStatus;
} {
  if (view.connect) return done(CONNECT, "amber");
  if (view.form === "no_data") return done(NO_DATA, "amber");

  const callouts = view.callouts.slice(0, CALLOUT_LIMIT);
  const status = briefStatus(callouts.length > 0 ? callouts : statusCallouts(view));
  const lines: Line[] = [];
  for (const correction of view.corrections ?? []) lines.push({ text: correction });
  lines.push({ text: greeting(view) }, { text: headline(view, callouts) });
  const sales = salesLine(view);
  if (sales) lines.push({ text: sales });
  if (view.delivered != null) {
    const aov = view.aovPaise != null ? ` · AOV ${formatRupees(view.aovPaise)}` : "";
    lines.push({ text: `${view.delivered} delivered${aov}` });
  }
  if (view.week) lines.push({ text: weekLine(view), drop: "week" });
  if (view.outletSummary) lines.push({ text: view.outletSummary });
  if (view.outletCount > 1 && view.healthyOutlets > 0) {
    lines.push({ text: `${view.healthyOutlets} outlets healthy` });
  }
  if (callouts.length === 0) {
    lines.push({ text: view.closingText ?? closing(view) });
  } else {
    lines.push({ text: "" });
    for (const callout of callouts) lines.push({ text: calloutLine(callout) });
    if ((view.overflow ?? 0) > 0) lines.push({ text: `+${view.overflow} more in the app` });
  }
  for (const extra of view.catchUp) lines.push({ text: extra });
  if (view.ongoing) lines.push({ text: view.ongoing, drop: "ongoing" });
  if (view.resolved) lines.push({ text: view.resolved, drop: "resolved" });
  const note = noteLine(view);
  if (note) lines.push({ text: note });
  return done(cap(lines, callouts.length > 0), status);
}

export function briefStatus(callouts: Array<{ severity: OpsAlertSeverity }>): OpsStatus {
  if (callouts.some((callout) => callout.severity === "act_now")) return "red";
  if (callouts.length > 0) return "amber";
  return "green";
}

function statusCallouts(view: DailyBriefView): Array<{ severity: OpsAlertSeverity }> {
  const text = view.statusText ?? "";
  if (text.includes("🔴")) return [{ severity: "act_now" }];
  if (text.includes("🟡")) return [{ severity: "watch" }];
  return [];
}

export function viewFromDaily(input: {
  restaurantName: string;
  evaluation: DailyEvaluation;
  catchUp?: string[];
  catchUpItems?: readonly CatchUpItem[];
  ongoing?: string | null;
  resolved?: string | null;
  dataAsOf?: string | null;
  capturedOn?: string | null;
  week?: DailyBriefView["week"];
  alerts?: readonly AlertState[];
  config?: OpsRulesConfig;
  /** Open alert severity, which can be higher than today's own finding. */
  alertSeverity?: ReadonlyMap<string, "act_now" | "watch">;
}): DailyBriefView {
  const config = input.config ?? DEFAULT_OPS_RULES_CONFIG;
  const findings = displayFindings(input.evaluation.findings);
  const apps = input.evaluation.snapshots.flatMap((snapshot) => snapshot.apps);
  const connected = apps.filter((app) => app.mode !== "absent");
  const ready = connected.filter((app) => app.mode === "ready");
  const noData = connected.length > 1 && ready.length === 0;
  const zomato = sumApp(input.evaluation, "zomato");
  const swiggy = sumApp(input.evaluation, "swiggy");
  const both = zomato.sales != null && swiggy.sales != null ? zomato.sales + swiggy.sales : null;
  const deliveredParts = [zomato.delivered, swiggy.delivered].filter(
    (value): value is number => value != null,
  );
  const delivered =
    deliveredParts.length === 0
      ? null
      : deliveredParts.length === 1 || canSumAcrossApps("delivered_orders")
        ? deliveredParts.reduce((sum, value) => sum + value, 0)
        : null;
  const salesPaise = both ?? zomato.sales ?? swiggy.sales;
  const onlyReady = new Set(ready.map((app) => app.platform));
  const onlyApp =
    onlyReady.size === 1 ? (appLabel([...onlyReady][0] ?? "zomato") as "Zomato" | "Swiggy") : null;
  const built = input.alerts
    ? linesFromAlerts(input.evaluation, input.alerts, input.catchUpItems ?? [], config)
    : null;
  const callouts =
    built?.callouts ??
    findings.slice(0, CALLOUT_LIMIT).map((finding) => ({
      severity: input.alertSeverity?.get(finding.dedupeKey) ?? finding.severity,
      text:
        input.evaluation.snapshots.length > 1
          ? `${finding.outletName}: ${finding.text}`
          : finding.text,
      fix: finding.fix,
    }));
  const counts = built?.counts ?? countMarks(callouts);
  const asking = input.evaluation.ownerQuestions.length > 0;
  let statusText = headerStatus(counts, apps, config.header.namePendingApp);
  if (asking && statusText === "🟢 Healthy") statusText = "";
  const closing =
    asking && counts.act + counts.watch === 0
      ? ""
      : closingText(counts, apps, onlyApp, config.header.namePendingApp);
  const excluded = exclusionNote(input.evaluation);
  return {
    restaurantName: input.restaurantName,
    date: input.evaluation.date,
    baselineDate: zomato.baselineDate ?? swiggy.baselineDate,
    form: noData ? "no_data" : "brief",
    onlyApp,
    sales:
      zomato.sales == null && swiggy.sales == null
        ? null
        : {
            combinedPaise: both,
            zomatoPaise: zomato.sales,
            swiggyPaise: swiggy.sales,
            zomatoBaselinePaise: zomato.baseline,
            swiggyBaselinePaise: swiggy.baseline,
          },
    delivered,
    aovPaise: salesPaise != null && delivered ? Math.round(salesPaise / delivered) : null,
    week: input.week ?? null,
    callouts,
    ongoing: built?.ongoing ?? input.ongoing ?? null,
    resolved: input.resolved ?? null,
    notes: [...notesFor(input.evaluation), ...input.evaluation.notes, ...(built?.stale ?? [])],
    dataAsOf: input.dataAsOf ?? null,
    capturedOn: input.capturedOn ?? null,
    catchUp: built?.catchUp ?? input.catchUp ?? [],
    healthyOutlets: built?.healthyOutlets ?? healthyOutlets(input.evaluation, findings),
    outletCount: input.evaluation.snapshots.length,
    statusText,
    closingText: closing,
    overflow: built?.overflow ?? 0,
    corrections: config.correction.inBrief ? (built?.corrections ?? []) : [],
    outletSummary: built?.outletSummary ?? null,
    exclusion: excluded,
    connect: connected.length === 0,
  };
}

function linesFromAlerts(
  evaluation: DailyEvaluation,
  alerts: readonly AlertState[],
  catchUpItems: readonly CatchUpItem[],
  config: OpsRulesConfig,
) {
  const date = evaluation.date;
  const catchKeys = new Set(catchUpItems.map((item) => item.dedupeKey));
  const visible = foldSales(alerts.filter((alert) => listed(alert, date)));
  const candidates = visible
    .filter(
      (alert) =>
        !catchKeys.has(alert.dedupeKey) && !alert.book.quiet && alert.lastSeenDate === date,
    )
    .sort(alertOrder(evaluation));
  const shown = candidates.slice(0, CALLOUT_LIMIT);
  const overflowAlerts = candidates.slice(CALLOUT_LIMIT);
  const shownKeys = new Set(shown.map((alert) => alert.dedupeKey));
  const overflowKeys = new Set(overflowAlerts.map((alert) => alert.dedupeKey));
  const ongoingAlerts = visible.filter(
    (alert) =>
      !catchKeys.has(alert.dedupeKey) &&
      !shownKeys.has(alert.dedupeKey) &&
      !overflowKeys.has(alert.dedupeKey),
  );
  const names = new Map(evaluation.snapshots.map((snapshot) => [snapshot.outletId, snapshot.name]));
  const prefix = evaluation.snapshots.length > 1;
  const callouts = shown.map((alert) => ({
    severity: alert.severity,
    text: calloutText(alert, names, prefix, config),
    fix: alert.fix,
  }));
  const counted = [
    ...catchUpItems.map((item) => item.severity),
    ...candidates.map((alert) => alert.severity),
    ...ongoingAlerts.map((alert) => alert.severity),
  ];
  const corrections = alerts
    .filter((alert) => alert.resolvedReason === "revised" && alert.resolvedAt === date)
    .flatMap((alert) => {
      const clear = evaluation.clears.find((item) => item.dedupeKey === alert.dedupeKey);
      return clear?.correction ? [`Correction: ${clear.correction}`] : [];
    });
  const stale = alerts
    .filter((alert) => alert.resolvedReason === "stale" && alert.resolvedAt === date)
    .map(
      (alert) =>
        `Stopped tracking ${alert.text.replace(/\.$/, "")} (no data for ${config.lifecycle.staleDays.value} days).`,
    );
  return {
    callouts,
    overflow: overflowAlerts.length,
    catchUp: catchUpItems.map((item) => datedCatchUp(item)),
    ongoing: ongoingLine(
      ongoingAlerts.map((alert) => {
        const when =
          alert.lastSeenDate === date ? "" : `${formatWeekdayShort(alert.lastSeenDate)}, `;
        const mark = alert.severity === "act_now" ? "🔴" : "🟡";
        return `${mark} ${alert.text.replace(/\.$/, "")} (${when}day ${alert.consecutiveDays})`;
      }),
    ),
    counts: {
      act: counted.filter((severity) => severity === "act_now").length,
      watch: counted.filter((severity) => severity === "watch").length,
    },
    corrections,
    stale,
    healthyOutlets: evaluation.snapshots.filter((snapshot) => {
      const connected = snapshot.apps.filter((app) => app.mode !== "absent");
      if (connected.length === 0 || connected.some((app) => app.mode !== "ready")) return false;
      return !visible.some((alert) => alert.outletId === snapshot.outletId);
    }).length,
    outletSummary: outletSummary(evaluation, visible),
  };
}

function foldSales(alerts: AlertState[]): AlertState[] {
  const rest = alerts.filter((alert) => alert.ruleCode !== "d_sales_drop");
  const sales = alerts.filter((alert) => alert.ruleCode === "d_sales_drop");
  const outlets = [...new Set(sales.map((alert) => alert.outletId))];
  const folded: AlertState[] = [...rest];
  for (const outletId of outlets) {
    const members = sales.filter((alert) => alert.outletId === outletId);
    const combined = members.find((alert) => alert.platform === "combined");
    const apps = members.filter((alert) => alert.platform !== "combined");
    if (combined && apps.length > 0) {
      const worst = [...apps].sort(
        (left, right) =>
          (right.severity === "act_now" ? 2 : 1) - (left.severity === "act_now" ? 2 : 1),
      )[0];
      if (!worst) continue;
      const base = worst.text.replace(/ \([^)]*\)\.$/, "").replace(/\.$/, "");
      folded.push({
        ...worst,
        text: `${base} (total down ${formatPct1(combined.lastValue ?? 0)}%).`,
      });
    } else {
      folded.push(
        ...members.map((alert) =>
          alert.platform === "combined"
            ? { ...alert, text: alert.text.replace(/^Both apps/, "Total") }
            : alert,
        ),
      );
    }
  }
  return folded;
}

function listed(alert: AlertState, date: string): boolean {
  const seen = alert.book.evaluatedOn ?? alert.lastSeenDate;
  if (seen && seen > date) return false;
  if (alert.status === "resolved") return false;
  if (alert.status === "snoozed" && alert.severity !== "act_now") return false;
  return true;
}

function alertOrder(evaluation: DailyEvaluation) {
  const names = new Map(evaluation.snapshots.map((snapshot) => [snapshot.outletId, snapshot.name]));
  return (left: AlertState, right: AlertState) => {
    const severity = (right.severity === "act_now" ? 2 : 1) - (left.severity === "act_now" ? 2 : 1);
    if (severity !== 0) return severity;
    const outlet = (names.get(left.outletId ?? "") ?? "").localeCompare(
      names.get(right.outletId ?? "") ?? "",
    );
    if (outlet !== 0) return outlet;
    const app = left.platform.localeCompare(right.platform);
    if (app !== 0) return app;
    return left.ruleCode.localeCompare(right.ruleCode);
  };
}

function calloutText(
  alert: AlertState,
  names: Map<string, string>,
  prefix: boolean,
  config: OpsRulesConfig,
): string {
  const held = alert.book.heldEscalation
    ? ` (held ${config.lifecycle.watchEscalateDays.value} days)`
    : "";
  const body = `${alert.text.replace(/\.$/, "")}${held}.`;
  const name = alert.outletId ? names.get(alert.outletId) : null;
  return prefix && name ? `${name}: ${body}` : body;
}

function outletSummary(evaluation: DailyEvaluation, alerts: AlertState[]): string | null {
  if (evaluation.snapshots.length < 2) return null;
  const parts: string[] = [];
  for (const snapshot of evaluation.snapshots) {
    const mine = alerts.filter((alert) => alert.outletId === snapshot.outletId);
    if (mine.length === 0) continue;
    const act = mine.filter((alert) => alert.severity === "act_now").length;
    const watch = mine.filter((alert) => alert.severity === "watch").length;
    const mark = act > 0 ? `🔴 ${act}` : `🟡 ${watch}`;
    parts.push(`${snapshot.name}: ${mark}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function countMarks(callouts: Array<{ severity: OpsAlertSeverity }>) {
  return {
    act: callouts.filter((callout) => callout.severity === "act_now").length,
    watch: callouts.filter((callout) => callout.severity === "watch").length,
  };
}

function headerStatus(
  counts: { act: number; watch: number },
  apps: DailyEvaluation["snapshots"][number]["apps"],
  namePendingApp: boolean,
): string {
  const connected = apps.filter((app) => app.mode !== "absent");
  const tails = uniqueTails(connected, namePendingApp);
  const mark =
    counts.act > 0 && counts.watch > 0
      ? `🔴 Act now (${counts.act}) · 🟡 Watch (${counts.watch})`
      : counts.act > 0
        ? `🔴 Act now (${counts.act})`
        : counts.watch > 0
          ? `🟡 Watch (${counts.watch})`
          : null;
  if (mark) return tails.length > 0 ? `${mark} · ${tails.join(" · ")}` : mark;
  const ready = connected.filter((app) => app.mode === "ready");
  if (tails.length === 0 && ready.length === connected.length && connected.length > 0) {
    return "🟢 Healthy";
  }
  const healthy = [...new Set(ready.map((app) => appLabel(app.platform)))];
  if (healthy.length > 0 && tails.length > 0) {
    return `🟢 ${healthy.join(" and ")} healthy · ${tails.join(" · ")}`;
  }
  return tails.join(" · ");
}

function uniqueTails(
  apps: Array<{ platform: "zomato" | "swiggy"; mode: string }>,
  namePendingApp = true,
): string[] {
  if (!namePendingApp) {
    const tails: string[] = [];
    if (apps.some((app) => app.mode === "lag_missing")) tails.push("pending");
    if (apps.some((app) => app.mode === "failed")) tails.push("not updated");
    return tails;
  }
  const tails: string[] = [];
  for (const app of apps) {
    const label = appLabel(app.platform);
    if (app.mode === "lag_missing") tails.push(`${label} pending`);
    if (app.mode === "failed") tails.push(`${label} not updated`);
  }
  return [...new Set(tails)];
}

function closingText(
  counts: { act: number; watch: number },
  apps: DailyEvaluation["snapshots"][number]["apps"],
  onlyApp: "Zomato" | "Swiggy" | null,
  namePendingApp = true,
): string {
  if (counts.act + counts.watch > 0) return "";
  const connected = apps.filter((app) => app.mode !== "absent");
  const tails = uniqueTails(connected, namePendingApp);
  if (tails.length === 0) return `All good on ${onlyApp ?? "both apps"}.`;
  const ready = [
    ...new Set(
      connected.filter((app) => app.mode === "ready").map((app) => appLabel(app.platform)),
    ),
  ];
  const who = ready.length > 0 ? ready.join(" and ") : (onlyApp ?? "both apps");
  return `All good on ${who}; ${tails.join("; ")}.`;
}

function exclusionNote(evaluation: DailyEvaluation): string | null {
  const parts: string[] = [];
  for (const snapshot of evaluation.snapshots) {
    for (const app of snapshot.apps) {
      if (app.mode === "absent" || app.mode === "ready") continue;
      const why = app.mode === "failed" ? "not updated" : "not in yet";
      const name = evaluation.snapshots.length > 1 ? `${snapshot.name} ` : "";
      parts.push(`${name}${appLabel(app.platform)}, ${why}`);
    }
  }
  return parts.length > 0 ? `excl. ${parts.join(", ")}` : null;
}

function healthyOutlets(
  evaluation: DailyEvaluation,
  findings: DailyEvaluation["findings"],
): number {
  return evaluation.snapshots.filter((snapshot) => {
    const connected = snapshot.apps.filter((app) => app.mode !== "absent");
    if (connected.some((app) => app.mode !== "ready")) return false;
    return !findings.some((finding) => finding.outletId === snapshot.outletId);
  }).length;
}

export function weekSales(
  date: string,
  days: Array<{
    date: string;
    platform?: "zomato" | "swiggy";
    salesPaise: number | null;
    outletId?: string;
  }>,
  closed: ReadonlyArray<{ outletId: string; date: string }> = [],
): DailyBriefView["week"] {
  if (weekMonday(date) === date) return null;
  const closedKeys = new Set(closed.map((row) => `${row.outletId}|${row.date}`));
  const skipped = (day: { date: string; outletId?: string }) =>
    day.outletId != null && closedKeys.has(`${day.outletId}|${day.date}`);
  const start = weekMonday(date);
  const rows = new Map<string, Map<string, number>>();
  for (const day of days) {
    if (skipped(day) || day.salesPaise == null) continue;
    const key = `${day.outletId ?? ""}|${day.platform ?? "all"}`;
    const bucket = rows.get(day.date) ?? new Map<string, number>();
    bucket.set(key, (bucket.get(key) ?? 0) + day.salesPaise);
    rows.set(day.date, bucket);
  }
  let current = 0;
  let baseline = 0;
  let pairs = 0;
  let firstData: string | null = null;
  let lastData: string | null = null;
  const used = new Set<string>();
  for (const day of [...rows.keys()].filter((item) => item >= start && item <= date).sort()) {
    const now = rows.get(day);
    const prior = rows.get(addIso(day, -7));
    if (!now || !prior || now.size === 0) continue;
    let dayNow = 0;
    let dayBase = 0;
    let shared = 0;
    for (const [key, sales] of now) {
      const before = prior.get(key);
      if (before == null) continue;
      dayNow += sales;
      dayBase += before;
      shared += 1;
    }
    if (shared === 0) continue;
    current += dayNow;
    baseline += dayBase;
    pairs += 1;
    used.add(day);
    if (!firstData || day < firstData) firstData = day;
    if (!lastData || day > lastData) lastData = day;
  }
  if (pairs === 0 || baseline === 0 || !lastData || !firstData) return null;
  const change = pctChange(current, baseline);
  if (change == null) return null;
  const today = days.filter((day) => day.date === date);
  const todayClosed = today.length > 0 && today.every((day) => skipped(day));
  return {
    startLabel: formatWeekdayShort(firstData),
    endLabel: formatWeekdayShort(lastData),
    currentPaise: current,
    changePct: change,
    pendingLabel: used.has(date) || todayClosed ? null : `${formatWeekdayShort(date)} not in yet`,
  };
}

function addIso(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sumApp(evaluation: DailyEvaluation, platform: "zomato" | "swiggy") {
  let sales: number | null = null;
  let baseline: number | null = null;
  let baselineDate: string | null = null;
  let delivered: number | null = null;
  for (const snapshot of evaluation.snapshots) {
    const app = snapshot.apps.find((item) => item.platform === platform && item.mode === "ready");
    if (!app) continue;
    if (app.salesPaise != null) sales = (sales ?? 0) + app.salesPaise;
    if (app.baselineSalesPaise != null) baseline = (baseline ?? 0) + app.baselineSalesPaise;
    if (app.delivered != null) delivered = (delivered ?? 0) + app.delivered;
    baselineDate = baselineDate ?? app.baselineDate;
  }
  return { sales, baseline, baselineDate, delivered };
}

function notesFor(evaluation: DailyEvaluation): string[] {
  const notes: string[] = [];
  const apps = evaluation.snapshots.flatMap((snapshot) => snapshot.apps);
  const provisional = evaluation.findings.some((finding) => finding.provisional);
  if (apps.some((app) => app.mode === "ready" && app.lagBanner) || provisional) {
    notes.push(
      `Note: Swiggy figures for ${formatWeekdayShort(evaluation.date)} may change within 48 hours.`,
    );
  }
  for (const app of apps) {
    if (app.mode === "failed" && app.ingest) notes.push(ingestSentence(app.platform, app.ingest));
    if (app.mode !== "lag_missing") continue;
    const label = appLabel(app.platform);
    const day = formatCivilDay(evaluation.date);
    if (app.waitedOut) {
      notes.push(`${label}'s figures for ${day} never came in.`);
    } else if (app.platform === "swiggy" && !app.gap) {
      notes.push(
        `Swiggy's figures for ${day} aren't in yet (Swiggy can take up to 48 hours); we'll check them tomorrow.`,
      );
    } else {
      notes.push(`${label}'s figures for ${day} aren't in yet; we'll check them tomorrow.`);
    }
  }
  return [...new Set(notes)];
}

function ingestSentence(platform: "zomato" | "swiggy", code: string): string {
  const label = appLabel(platform);
  if (code === "layout_changed") {
    return `${label}: not updated this morning (${label} changed its report; we're fixing it).`;
  }
  if (code === "fetch_held") {
    return `${label}: updates paused while we double-check the account; our team is on it.`;
  }
  if (code === "needs_owner") {
    return `${label}: not updated this morning. We need you to reconnect the account; we'll message you.`;
  }
  if (code === "signed_out") {
    return `${label}: not updated this morning (login expired, we're reconnecting).`;
  }
  return `${label}: not updated this morning (the download failed).`;
}

/** Add the sales that are present. A missing outlet or app is left out, not stored as zero. */
export function combinedDaySales(rows: Array<{ salesPaise: number | null }>): number | null {
  let total: number | null = null;
  for (const row of rows) {
    if (row.salesPaise == null) continue;
    total = (total ?? 0) + row.salesPaise;
  }
  return total;
}

function greeting(view: DailyBriefView): string {
  return `*Good morning · ${view.restaurantName}*`;
}

function headline(view: DailyBriefView, callouts: DailyBriefView["callouts"]): string {
  const compared = view.baselineDate ? comparedWith(view.date, view.baselineDate) : null;
  const when = compared ? `${formatCivilDay(view.date)} vs ${compared}` : formatCivilDay(view.date);
  const status = view.statusText ?? statusLabel(callouts);
  return status ? `${when} · ${status}` : when;
}

function comparedWith(date: string, baseline: string): string {
  if (isoDayDiff(baseline, date) > 8) return `${formatCivilDay(baseline)} (two weeks back)`;
  return formatCivilDay(baseline);
}

function statusLabel(callouts: DailyBriefView["callouts"]): string {
  const act = callouts.filter((callout) => callout.severity === "act_now").length;
  const watch = callouts.filter((callout) => callout.severity === "watch").length;
  if (act > 0 && watch > 0) return `🔴 Act now (${act}) · 🟡 Watch (${watch})`;
  if (act > 0) return `🔴 Act now (${act})`;
  if (watch > 0) return `🟡 Watch (${watch})`;
  return "🟢 Healthy";
}

function salesLine(view: DailyBriefView): string | null {
  if (!view.sales) return null;
  const parts: string[] = [];
  const { combinedPaise, zomatoPaise, swiggyPaise, zomatoBaselinePaise, swiggyBaselinePaise } =
    view.sales;
  if (combinedPaise != null && zomatoBaselinePaise != null && swiggyBaselinePaise != null) {
    const change = pctChange(combinedPaise, zomatoBaselinePaise + swiggyBaselinePaise);
    if (change != null) {
      const exclusion = view.exclusion ? `, ${view.exclusion}` : "";
      parts.push(
        `Net sales ${formatRupees(combinedPaise)} (${formatSignedPct(change)}${exclusion})`,
      );
    }
  }
  if (zomatoPaise != null && zomatoBaselinePaise != null) {
    const change = pctChange(zomatoPaise, zomatoBaselinePaise);
    if (change != null)
      parts.push(`Zomato ${formatRupees(zomatoPaise)} (${formatSignedPct(change)})`);
  }
  if (swiggyPaise != null && swiggyBaselinePaise != null) {
    const change = pctChange(swiggyPaise, swiggyBaselinePaise);
    if (change != null)
      parts.push(`Swiggy ${formatRupees(swiggyPaise)} (${formatSignedPct(change)})`);
  }
  if (parts.length === 0 && view.exclusion) return `Net sales (${view.exclusion})`;
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

export function formatWeekLine(week: {
  startLabel: string;
  endLabel: string;
  currentPaise: number;
  changePct: number;
  pendingLabel?: string | null;
}): string {
  const pending = week.pendingLabel ? `, ${week.pendingLabel}` : "";
  return `Week so far (${week.startLabel}–${week.endLabel}${pending}): ${formatRupees(week.currentPaise)} vs the same days last week (${formatSignedPct(week.changePct)})`;
}

/** Swap a stored week sentence for the same days, measured again. */
export function replaceWeekLine(
  markdown: string,
  week: {
    startLabel: string;
    endLabel: string;
    currentPaise: number;
    changePct: number;
    pendingLabel?: string | null;
  } | null,
): string {
  if (!week || !markdown.includes("Week so far (")) return markdown;
  return markdown.replace(/Week so far \([^)\n]*\):[^\n]*/, formatWeekLine(week));
}

function weekLine(view: DailyBriefView): string {
  return view.week ? formatWeekLine(view.week) : "";
}

/** Rewrite a stored brief's pending line and data stamp from the latest fetch. */
export function refreshBriefClosing(
  markdown: string,
  fresh: {
    capturedOn: string | null;
    dataAsOf: string | null;
    missing: ReadonlyArray<{ platform: "zomato" | "swiggy"; date: string }>;
  },
): string {
  let text = markdown
    .replace(/(?:Zomato|Swiggy)'s figures for [^.]*(?:aren't in yet|never came in)[^.]*\./g, "")
    .replace(/Data as of [^.]+\./g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const gaps = fresh.missing.map((gap) => {
    const day = formatCivilDay(gap.date);
    return gap.platform === "swiggy"
      ? `Swiggy's figures for ${day} aren't in yet (Swiggy can take up to 48 hours); we'll check them tomorrow.`
      : `Zomato's figures for ${day} aren't in yet; we'll check them tomorrow.`;
  });
  if (gaps.length > 0) text = [text, ...gaps].filter((part) => part.length > 0).join("\n");
  if (fresh.capturedOn) {
    const clock = fresh.dataAsOf ? `, ${fresh.dataAsOf}` : "";
    text = `${text} Data as of ${formatCivilDay(fresh.capturedOn)}${clock} IST.`.trim();
  }
  return text;
}

function closing(view: DailyBriefView): string {
  if (view.closingText) return view.closingText;
  const who = view.onlyApp ? view.onlyApp : "both apps";
  const stamp = dataStamp(view);
  return `All good on ${who}.${view.notes.length === 0 && stamp ? ` ${stamp}` : ""}`;
}

function dataStamp(view: DailyBriefView): string {
  if (!view.capturedOn) return "";
  const clock = view.dataAsOf ? `, ${view.dataAsOf}` : "";
  return `Data as of ${formatCivilDay(view.capturedOn)}${clock} IST.`;
}

function calloutLine(callout: { severity: OpsAlertSeverity; text: string; fix: string }): string {
  const mark = callout.severity === "act_now" ? "🔴" : "🟡";
  const sentence = callout.text.endsWith(".") ? callout.text : `${callout.text}.`;
  return `${mark} ${sentence} Fix: ${lowerFirst(callout.fix)}`;
}

function noteLine(view: DailyBriefView): string | null {
  const stamp = dataStamp(view);
  if (view.notes.length === 0) {
    if (view.callouts.length === 0 && !view.closingText) return null;
    return stamp || null;
  }
  return [view.notes.join(" "), stamp].filter((part) => part.length > 0).join(" ");
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

interface Line {
  text: string;
  drop?: "resolved" | "ongoing" | "week";
}

function cap(lines: Line[], withCallouts: boolean): string {
  const limit = withCallouts ? BRIEF_CHAR_LIMIT : ALL_GOOD_CHAR_LIMIT;
  const kept = lines.filter((line) => line.text.length > 0 || line.drop == null);
  const dropOrder = ["resolved", "ongoing", "week"] as const;
  for (const kind of dropOrder) {
    if (kept.map((line) => line.text).join("\n").length <= limit) break;
    const index = kept.findIndex((line) => line.drop === kind);
    if (index >= 0) kept.splice(index, 1);
  }
  let text = kept
    .map((line) => line.text)
    .filter((line, index) => line.length > 0 || index > 0)
    .join("\n");
  if (text.length <= limit) return text;
  text = text.slice(0, limit - 1).trimEnd();
  return `${text}…`;
}

function done(text: string, status: OpsStatus): { text: string; chars: number; status: OpsStatus } {
  return { text, chars: text.length, status };
}

export function datedCatchUp(item: CatchUpItem): string {
  const mark = item.severity === "act_now" ? "🔴" : "🟡";
  const sentence = item.text.endsWith(".") ? item.text : `${item.text}.`;
  const fix = item.fix ? ` Fix: ${lowerFirst(item.fix)}` : "";
  return `${mark} ${formatCivilDay(item.date)} · ${sentence}${fix}`;
}

export function catchUpLine(date: string, text: string): string {
  const sentence = text.endsWith(".") ? text : `${text}.`;
  return `${formatCivilDay(date)}: ${sentence}`;
}

/**
 * Ongoing leaves out today's call-outs. Catch-up lines are only the findings
 * the caller passes, which are the ones today's earlier step notified.
 */
export function carryForward(input: {
  alerts: Array<{
    dedupeKey: string;
    text: string;
    consecutiveDays: number;
    status: string;
    lastNotifiedAt: string | null;
  }>;
  ongoingKeys: readonly string[];
  calloutKeys: ReadonlySet<string>;
  previousDate: string;
  lateFindings?: ReadonlyArray<{ dedupeKey: string; text: string }>;
}): { catchUp: string[]; ongoing: string | null } {
  const late = input.lateFindings ?? [];
  const catchUpKeys = new Set(late.map((finding) => finding.dedupeKey));
  const ongoingKeys = new Set(input.ongoingKeys);
  return {
    catchUp: late.map((finding) => catchUpLine(input.previousDate, finding.text)),
    ongoing: ongoingLine(
      input.alerts
        .filter(
          (alert) =>
            ongoingKeys.has(alert.dedupeKey) &&
            !input.calloutKeys.has(alert.dedupeKey) &&
            !catchUpKeys.has(alert.dedupeKey) &&
            alert.status !== "resolved",
        )
        .map((alert) => `${alert.text.replace(/\.$/, "")} (day ${alert.consecutiveDays})`),
    ),
  };
}

export function ongoingLine(parts: string[]): string | null {
  if (parts.length === 0) return null;
  return `Ongoing: ${parts.join("; ")}.`;
}

export function resolvedLine(parts: string[]): string | null {
  if (parts.length === 0) return null;
  return `${parts.map((part) => `✓ ${part} back to normal`).join(". ")}.`;
}

export { formatPct1 };
