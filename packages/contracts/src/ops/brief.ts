import {
  formatCivilDay,
  formatPct1,
  formatRupees,
  formatSignedPct,
  formatWeekdayShort,
  pctChange,
  weekMonday,
} from "./format.js";
import { displayFindings } from "./rules.js";
import type { DailyBriefView, DailyEvaluation, OpsAlertSeverity, OpsStatus } from "./types.js";
import {
  ALL_GOOD_CHAR_LIMIT,
  appLabel,
  BRIEF_CHAR_LIMIT,
  CALLOUT_LIMIT,
  canSumAcrossApps,
  INGEST_NOTE,
} from "./types.js";

const NO_DATA = "No new data this morning; we'll update this when it lands.";

export function composeDailyBrief(view: DailyBriefView): {
  text: string;
  chars: number;
  status: OpsStatus;
} {
  if (view.form === "no_data") return done(NO_DATA, "amber");
  if (view.form === "lag_missing") return done(lagSentence(view), "amber");

  const callouts = view.callouts.slice(0, CALLOUT_LIMIT);
  const status = briefStatus(callouts);
  const lines: string[] = [greeting(view), headline(view, callouts)];
  const sales = salesLine(view);
  if (sales) lines.push(sales);
  if (view.delivered != null) {
    const aov = view.aovPaise != null ? ` · AOV ${formatRupees(view.aovPaise)}` : "";
    lines.push(`${view.delivered} delivered${aov}`);
  }
  if (view.week) lines.push(weekLine(view));
  if (view.outletCount > 1 && view.healthyOutlets > 0) {
    lines.push(`${view.healthyOutlets} outlets healthy`);
  }
  if (callouts.length === 0) {
    lines.push(closing(view));
  } else {
    lines.push("");
    for (const callout of callouts) lines.push(calloutLine(callout));
  }
  for (const extra of view.catchUp) lines.push(extra);
  if (view.ongoing) lines.push(view.ongoing);
  if (view.resolved) lines.push(view.resolved);
  const note = noteLine(view);
  if (note) lines.push(note);
  return done(
    cap(
      lines.filter((line, index) => line.length > 0 || index > 0).join("\n"),
      callouts.length > 0,
    ),
    status,
  );
}

export function briefStatus(callouts: Array<{ severity: OpsAlertSeverity }>): OpsStatus {
  if (callouts.some((callout) => callout.severity === "act_now")) return "red";
  if (callouts.length > 0) return "amber";
  return "green";
}

export function viewFromDaily(input: {
  restaurantName: string;
  evaluation: DailyEvaluation;
  catchUp?: string[];
  ongoing?: string | null;
  resolved?: string | null;
  dataAsOf?: string | null;
  week?: DailyBriefView["week"];
}): DailyBriefView {
  const findings = displayFindings(input.evaluation.findings);
  const apps = input.evaluation.snapshots.flatMap((snapshot) => snapshot.apps);
  const connected = apps.filter((app) => app.mode !== "absent");
  const ready = connected.filter((app) => app.mode === "ready");
  const failed = connected.filter((app) => app.mode === "failed" || app.mode === "lag_missing");
  const noData = connected.length === 0 || (ready.length === 0 && failed.length > 0);
  const lagOnly =
    findings.length === 0 &&
    ready.some((app) => app.platform === "zomato") &&
    apps.some((app) => app.platform === "swiggy" && app.mode === "lag_missing") &&
    !apps.some((app) => app.mode === "failed");
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
  const healthyOutlets = input.evaluation.snapshots.filter((snapshot) => {
    return !findings.some((finding) => finding.outletId === snapshot.outletId);
  }).length;
  return {
    restaurantName: input.restaurantName,
    date: input.evaluation.date,
    baselineDate: zomato.baselineDate ?? swiggy.baselineDate,
    form: noData ? "no_data" : lagOnly ? "lag_missing" : "brief",
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
    callouts: findings.slice(0, CALLOUT_LIMIT).map((finding) => ({
      severity: finding.severity,
      text:
        input.evaluation.snapshots.length > 1
          ? `${finding.outletName}: ${finding.text}`
          : finding.text,
      fix: finding.fix,
    })),
    ongoing: input.ongoing ?? null,
    resolved: input.resolved ?? null,
    notes: notesFor(input.evaluation),
    dataAsOf: input.dataAsOf ?? null,
    catchUp: input.catchUp ?? [],
    healthyOutlets,
    outletCount: input.evaluation.snapshots.length,
  };
}

export function weekSales(
  date: string,
  days: Array<{ date: string; salesPaise: number | null }>,
): DailyBriefView["week"] {
  if (weekMonday(date) === date) return null;
  const start = weekMonday(date);
  let current = 0;
  let baseline = 0;
  let pairs = 0;
  for (const day of days) {
    if (day.date < start || day.date > date || day.salesPaise == null) continue;
    const prior = days.find(
      (item) => item.date === addIso(day.date, -7) && item.salesPaise != null,
    );
    if (!prior || prior.salesPaise == null) continue;
    current += day.salesPaise;
    baseline += prior.salesPaise;
    pairs += 1;
  }
  if (pairs === 0 || baseline === 0) return null;
  const change = pctChange(current, baseline);
  if (change == null) return null;
  return {
    startLabel: "Mon",
    endLabel: formatWeekdayShort(date),
    currentPaise: current,
    changePct: change,
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
  if (apps.some((app) => app.mode === "ready" && app.lagBanner)) {
    notes.push(
      `Note: Swiggy figures for ${formatWeekdayShort(evaluation.date)} may change within 48 hours.`,
    );
  }
  for (const app of apps) {
    if (app.mode === "failed" && app.ingest) {
      notes.push(
        `${appLabel(app.platform)}: not updated this morning (${INGEST_NOTE[app.ingest]}).`,
      );
    }
    if (app.mode === "lag_missing") {
      notes.push(
        `Swiggy's figures for ${formatCivilDay(evaluation.date)} aren't in yet (Swiggy can take up to 48 hours); we'll check them tomorrow.`,
      );
    }
  }
  return [...new Set(notes)];
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
  const when = view.baselineDate
    ? `${formatCivilDay(view.date)} vs ${formatCivilDay(view.baselineDate)}`
    : formatCivilDay(view.date);
  return `${when} · ${statusLabel(callouts)}`;
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
    if (change != null)
      parts.push(`Net sales ${formatRupees(combinedPaise)} (${formatSignedPct(change)})`);
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
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function weekLine(view: DailyBriefView): string {
  const week = view.week;
  if (!week) return "";
  return `Week so far (${week.startLabel}–${week.endLabel}): ${formatRupees(week.currentPaise)} (${formatSignedPct(week.changePct)})`;
}

function closing(view: DailyBriefView): string {
  const who = view.onlyApp ? view.onlyApp : "both apps";
  const stamp = view.notes.length === 0 ? ` ${dataStamp(view)}` : "";
  return `All good on ${who}.${stamp}`;
}

function dataStamp(view: DailyBriefView): string {
  const day = formatCivilDay(view.date).replace(/^\S+\s/, "");
  return view.dataAsOf ? `Data as of ${day}, ${view.dataAsOf}.` : `Data as of ${day}.`;
}

function calloutLine(callout: { severity: OpsAlertSeverity; text: string; fix: string }): string {
  const mark = callout.severity === "act_now" ? "🔴" : "🟡";
  const sentence = callout.text.endsWith(".") ? callout.text : `${callout.text}.`;
  return `${mark} ${sentence} Fix: ${lowerFirst(callout.fix)}`;
}

function noteLine(view: DailyBriefView): string | null {
  if (view.notes.length === 0) {
    if (view.callouts.length === 0) return null;
    return dataStamp(view);
  }
  return [view.notes.join(" "), dataStamp(view)].filter((part) => part.length > 0).join(" ");
}

function lagSentence(view: DailyBriefView): string {
  const sales = view.sales?.zomatoPaise;
  const baseline = view.sales?.zomatoBaselinePaise;
  const change = sales != null && baseline != null ? pctChange(sales, baseline) : null;
  const money =
    sales != null && change != null
      ? `net sales ${formatRupees(sales)} (${formatSignedPct(change)})`
      : "figures in";
  const delivered = view.delivered != null ? ` · ${view.delivered} delivered` : "";
  return `Swiggy's figures for ${formatCivilDay(view.date)} aren't in yet (Swiggy can take up to 48 hours); we'll check them tomorrow. *Zomato only:* ${money}${delivered}. All good on Zomato.`;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function cap(text: string, withCallouts: boolean): string {
  const limit = withCallouts ? BRIEF_CHAR_LIMIT : ALL_GOOD_CHAR_LIMIT;
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  while (lines.join("\n").length > limit && lines.length > 2) lines.pop();
  const trimmed = lines.join("\n");
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function done(text: string, status: OpsStatus): { text: string; chars: number; status: OpsStatus } {
  return { text, chars: text.length, status };
}

export function catchUpLine(date: string, text: string): string {
  const sentence = text.endsWith(".") ? text : `${text}.`;
  return `${formatCivilDay(date)}: ${sentence}`;
}

/** Catch-up and Ongoing, rebuilt from stored alerts so a second run writes the same lines. */
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
}): { catchUp: string[]; ongoing: string | null } {
  const catchUpAlerts = input.alerts.filter(
    (alert) =>
      alert.lastNotifiedAt === input.previousDate &&
      alert.status !== "resolved" &&
      !input.calloutKeys.has(alert.dedupeKey),
  );
  const catchUpKeys = new Set(catchUpAlerts.map((alert) => alert.dedupeKey));
  const ongoingKeys = new Set(input.ongoingKeys);
  return {
    catchUp: catchUpAlerts.map((alert) => catchUpLine(input.previousDate, alert.text)),
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
