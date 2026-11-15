import type { OpsRulesConfig } from "./config.js";
import { DEFAULT_OPS_RULES_CONFIG } from "./config.js";
import { addDays, isoDayDiff } from "./format.js";
import type {
  AlertEventDraft,
  AlertOutcome,
  AlertState,
  AlertTransition,
  DailyClear,
  DailyFinding,
  DailyHold,
  OpsAlertSeverity,
  OpsScopePlatform,
} from "./types.js";

export function blankAlert(input: {
  dedupeKey: string;
  ruleCode: string;
  family: string | null;
  outletId: string | null;
  platform: OpsScopePlatform;
}): AlertState {
  return {
    id: "",
    dedupeKey: input.dedupeKey,
    cadence: "daily",
    ruleCode: input.ruleCode,
    family: input.family,
    outletId: input.outletId,
    platform: input.platform,
    severity: "watch",
    status: "open",
    firstSeenDate: "",
    lastSeenDate: "",
    occurrences: 0,
    consecutiveDays: 0,
    clearDays: 0,
    reopenCount: 0,
    escalatedAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolvedReason: null,
    lastValue: null,
    threshold: null,
    baselineValue: null,
    fixKey: input.ruleCode,
    fix: "",
    text: "",
    lastNotifiedAt: null,
    notifiedSeverity: null,
    evidence: [],
    book: {},
  };
}

/**
 * One business date against one alert. A second pass of the same date does
 * not add an occurrence. A missing or updating day freezes the row.
 */
export function stepAlert(
  existing: AlertState | null,
  input: {
    date: string;
    dedupeKey: string;
    ruleCode: string;
    family: string | null;
    outletId: string | null;
    platform: OpsScopePlatform;
    outcome: AlertOutcome;
    config?: OpsRulesConfig;
  },
): AlertTransition {
  const config = input.config ?? DEFAULT_OPS_RULES_CONFIG;
  if (!existing) {
    if (input.outcome.kind !== "fire") return ignore(null);
    return openNew(input.date, input, input.outcome);
  }
  // A retry evaluates the previous day before the report day. Once a later
  // day is already on the row, that older day must not move it again.
  const applied = laterDate(existing.book.evaluatedOn, existing.book.frozenOn);
  if (applied && input.date < applied) return ignore(existing);
  if (existing.book.evaluatedOn === input.date && input.outcome.kind === "fire") {
    return restate(existing, input.date, input.outcome);
  }
  if (existing.book.frozenOn === input.date && input.outcome.kind === "frozen")
    return ignore(existing);
  if (existing.status === "resolved") return reopen(existing, input);
  if (input.outcome.kind === "fire") return fireOpen(existing, input.date, input.outcome, config);
  if (input.outcome.kind === "clear") return clearOpen(existing, input.date, config);
  return freezeOpen(existing, input.date, config);
}

export function applyDailyAlerts(input: {
  date: string;
  findings: DailyFinding[];
  clears: DailyClear[];
  holds: DailyHold[];
  frozenScopes: Array<{ outletId: string; platform: OpsScopePlatform }>;
  existing: AlertState[];
  config?: OpsRulesConfig;
}): {
  alerts: AlertState[];
  events: Array<{ dedupeKey: string; event: AlertEventDraft }>;
  opened: string[];
  escalated: string[];
  resolved: string[];
  ongoing: string[];
  notify: string[];
} {
  const byKey = new Map<string, AlertState>();
  for (const alert of input.existing) {
    const current = byKey.get(alert.dedupeKey);
    if (!current || current.status === "resolved") byKey.set(alert.dedupeKey, alert);
  }
  const events: Array<{ dedupeKey: string; event: AlertEventDraft }> = [];
  const opened: string[] = [];
  const escalated: string[] = [];
  const resolved: string[] = [];
  const notify: string[] = [];
  const touched = new Set<string>();

  const take = (key: string, transition: AlertTransition) => {
    touched.add(key);
    if (transition.action !== "ignore" && transition.alert) byKey.set(key, transition.alert);
    for (const event of transition.events) events.push({ dedupeKey: key, event });
    if (transition.notify) notify.push(key);
    if (transition.events.some((event) => event.kind === "opened" || event.kind === "reopened")) {
      opened.push(key);
    }
    if (transition.events.some((event) => event.kind === "escalated")) escalated.push(key);
    if (transition.events.some((event) => event.kind === "resolved")) resolved.push(key);
  };

  for (const finding of input.findings) {
    take(
      finding.dedupeKey,
      stepAlert(byKey.get(finding.dedupeKey) ?? null, {
        date: input.date,
        dedupeKey: finding.dedupeKey,
        ruleCode: finding.code,
        family: finding.family,
        outletId: finding.outletId,
        platform: finding.platform,
        outcome: {
          kind: "fire",
          severity: finding.severity,
          value: finding.value,
          threshold: finding.threshold,
          baselineValue: finding.baselineValue,
          text: finding.text,
          fixKey: finding.fixKey,
          fix: finding.fix,
          evidence: finding.evidence,
          provisional: finding.provisional,
        },
        config: input.config,
      }),
    );
  }
  for (const clear of input.clears) {
    if (touched.has(clear.dedupeKey)) continue;
    const existing = byKey.get(clear.dedupeKey);
    if (!existing) continue;
    take(
      clear.dedupeKey,
      stepAlert(existing, {
        date: input.date,
        dedupeKey: clear.dedupeKey,
        ruleCode: clear.code,
        family: existing.family,
        outletId: clear.outletId,
        platform: clear.platform,
        outcome: { kind: "clear" },
        config: input.config,
      }),
    );
  }
  for (const hold of input.holds) {
    if (touched.has(hold.dedupeKey)) continue;
    const existing = byKey.get(hold.dedupeKey);
    if (!existing || existing.status === "resolved") continue;
    take(
      hold.dedupeKey,
      stepAlert(existing, {
        date: input.date,
        dedupeKey: hold.dedupeKey,
        ruleCode: hold.code,
        family: existing.family,
        outletId: hold.outletId,
        platform: hold.platform,
        outcome: { kind: "frozen" },
        config: input.config,
      }),
    );
  }
  for (const alert of byKey.values()) {
    if (touched.has(alert.dedupeKey) || alert.status === "resolved") continue;
    const frozen = input.frozenScopes.some(
      (scope) => scope.outletId === alert.outletId && scope.platform === alert.platform,
    );
    if (!frozen) continue;
    take(
      alert.dedupeKey,
      stepAlert(alert, {
        date: input.date,
        dedupeKey: alert.dedupeKey,
        ruleCode: alert.ruleCode,
        family: alert.family,
        outletId: alert.outletId,
        platform: alert.platform,
        outcome: { kind: "frozen" },
        config: input.config,
      }),
    );
  }

  const alerts = [...byKey.values()];
  const ongoing = alerts
    .filter(
      (alert) =>
        alert.status !== "resolved" &&
        alert.lastSeenDate === input.date &&
        !notify.includes(alert.dedupeKey),
    )
    .map((alert) => alert.dedupeKey);
  return { alerts, events, opened, escalated, resolved, ongoing, notify };
}

/** Hide a Watch for 1, 3, or 7 days. An Act now is still listed. */
export function snoozeAlert(alert: AlertState, days: 1 | 3 | 7, today: string): AlertState {
  return {
    ...alert,
    status: "snoozed",
    snoozedUntil: addDays(today, days),
  };
}

export function dismissAlert(alert: AlertState, today: string): AlertState {
  return {
    ...alert,
    status: "resolved",
    resolvedAt: today,
    resolvedReason: "owner_dismissed",
    snoozedUntil: null,
  };
}

/** A snoozed Watch stays out of the open list until the snooze date has passed. */
export function alertVisible(
  alert: AlertState,
  today: string,
  status: string | undefined,
): boolean {
  if (status && status !== "open") return alert.status === status;
  if (alert.status === "open") return true;
  if (alert.status === "resolved") return false;
  if (alert.snoozedUntil && alert.snoozedUntil < today) return true;
  return alert.severity === "act_now";
}

function openNew(
  date: string,
  input: {
    dedupeKey: string;
    ruleCode: string;
    family: string | null;
    outletId: string | null;
    platform: OpsScopePlatform;
  },
  outcome: Extract<AlertOutcome, { kind: "fire" }>,
): AlertTransition {
  const alert = applyFire(blankAlert(input), date, outcome, true);
  return {
    action: "create",
    alert,
    events: [
      { kind: "opened", severity: alert.severity, value: outcome.value, businessDate: date },
      { kind: "notified", severity: alert.severity, value: outcome.value, businessDate: date },
    ],
    notify: true,
    notifyReason: "opened",
  };
}

function fireOpen(
  existing: AlertState,
  date: string,
  outcome: Extract<AlertOutcome, { kind: "fire" }>,
  config: OpsRulesConfig,
): AlertTransition {
  const continued = existing.clearDays === 0 && existing.book.ruleSeverity != null;
  const consecutive = continued ? existing.consecutiveDays + 1 : 1;
  let severity = outcome.severity;
  let watchLevelDays = outcome.severity === "watch" ? (existing.book.watchLevelDays ?? 0) : 0;
  const events: AlertEventDraft[] = [];
  let notify = false;
  let notifyReason: AlertTransition["notifyReason"] = null;
  if (
    existing.severity === "watch" &&
    outcome.severity === "watch" &&
    consecutive >= config.lifecycle.watchEscalateDays.value
  ) {
    severity = "act_now";
    watchLevelDays = 0;
    notify = true;
    notifyReason = "escalated";
    events.push({ kind: "escalated", severity, value: outcome.value, businessDate: date });
  } else if (existing.severity === "act_now" && outcome.severity === "watch") {
    const previousWatch = existing.book.ruleSeverity === "watch";
    watchLevelDays = previousWatch ? (existing.book.watchLevelDays ?? 0) + 1 : 1;
    if (watchLevelDays >= config.lifecycle.watchDeescalateDays.value) {
      severity = "watch";
      events.push({ kind: "deescalated", severity, value: outcome.value, businessDate: date });
    } else {
      severity = "act_now";
      events.push({ kind: "seen", severity, value: outcome.value, businessDate: date });
    }
  } else if (outcome.severity === "act_now" && existing.severity === "watch") {
    severity = "act_now";
    watchLevelDays = 0;
    notify = true;
    notifyReason = "escalated";
    events.push({ kind: "escalated", severity, value: outcome.value, businessDate: date });
  } else {
    events.push({ kind: "seen", severity, value: outcome.value, businessDate: date });
  }
  const snoozed = stillSnoozed(existing, date);
  if (snoozed && severity === "watch") notify = false;
  if (notify) {
    events.push({ kind: "notified", severity, value: outcome.value, businessDate: date });
  }
  const alert: AlertState = {
    ...existing,
    severity,
    status: snoozed ? "snoozed" : "open",
    lastSeenDate: date,
    occurrences: existing.occurrences + 1,
    consecutiveDays: consecutive,
    clearDays: 0,
    escalatedAt: notifyReason === "escalated" ? date : existing.escalatedAt,
    lastValue: outcome.value,
    threshold: outcome.threshold,
    baselineValue: outcome.baselineValue,
    fixKey: outcome.fixKey,
    fix: outcome.fix,
    text: outcome.text,
    evidence: outcome.evidence,
    lastNotifiedAt: notify ? date : existing.lastNotifiedAt,
    notifiedSeverity: notify ? severity : existing.notifiedSeverity,
    book: {
      evaluatedOn: date,
      ruleSeverity: outcome.severity,
      watchLevelDays,
      lastEvaluableDate: date,
      provisional: outcome.provisional,
    },
  };
  return { action: "update", alert, events, notify, notifyReason: notify ? notifyReason : null };
}

function restate(
  existing: AlertState,
  date: string,
  outcome: Extract<AlertOutcome, { kind: "fire" }>,
): AlertTransition {
  const worsened = rank(outcome.severity) > rank(existing.severity);
  const alert: AlertState = {
    ...existing,
    severity: worsened ? outcome.severity : existing.severity,
    lastValue: outcome.value,
    threshold: outcome.threshold,
    baselineValue: outcome.baselineValue,
    text: outcome.text,
    evidence: outcome.evidence,
    book: {
      ...existing.book,
      evaluatedOn: date,
      provisional: outcome.provisional,
      ruleSeverity: outcome.severity,
    },
    lastNotifiedAt: worsened ? date : existing.lastNotifiedAt,
    notifiedSeverity: worsened ? outcome.severity : existing.notifiedSeverity,
  };
  return {
    action: "update",
    alert,
    events: worsened
      ? [
          {
            kind: "escalated",
            severity: outcome.severity,
            value: outcome.value,
            businessDate: date,
          },
        ]
      : [],
    notify: worsened,
    notifyReason: worsened ? "escalated" : null,
  };
}

function clearOpen(existing: AlertState, date: string, config: OpsRulesConfig): AlertTransition {
  if (existing.book.evaluatedOn === date) return ignore(existing);
  const clearDays = existing.clearDays + 1;
  const resolved = clearDays >= config.lifecycle.clearResolveDays.value;
  const alert: AlertState = {
    ...existing,
    clearDays,
    status: resolved ? "resolved" : existing.status,
    resolvedAt: resolved ? date : existing.resolvedAt,
    resolvedReason: resolved ? "cleared" : existing.resolvedReason,
    book: {
      ...existing.book,
      evaluatedOn: date,
      ruleSeverity: null,
      watchLevelDays: 0,
      lastEvaluableDate: date,
    },
  };
  return {
    action: "update",
    alert,
    events: [
      {
        kind: resolved ? "resolved" : "seen",
        severity: existing.severity,
        value: existing.lastValue,
        businessDate: date,
      },
    ],
    notify: false,
    notifyReason: null,
  };
}

function freezeOpen(existing: AlertState, date: string, config: OpsRulesConfig): AlertTransition {
  const last = existing.book.lastEvaluableDate ?? existing.lastSeenDate;
  const stale = last.length > 0 && isoDayDiff(last, date) >= config.lifecycle.staleDays.value;
  if (stale) {
    return {
      action: "update",
      alert: {
        ...existing,
        status: "resolved",
        resolvedAt: date,
        resolvedReason: "stale",
        book: { ...existing.book, frozenOn: date },
      },
      events: [
        {
          kind: "resolved",
          severity: existing.severity,
          value: existing.lastValue,
          businessDate: date,
        },
      ],
      notify: false,
      notifyReason: null,
    };
  }
  return {
    action: "update",
    alert: { ...existing, book: { ...existing.book, frozenOn: date } },
    events: [],
    notify: false,
    notifyReason: null,
  };
}

function reopen(
  existing: AlertState,
  input: {
    date: string;
    dedupeKey: string;
    ruleCode: string;
    family: string | null;
    outletId: string | null;
    platform: OpsScopePlatform;
    outcome: AlertOutcome;
    config?: OpsRulesConfig;
  },
): AlertTransition {
  if (input.outcome.kind !== "fire") return ignore(existing);
  const config = input.config ?? DEFAULT_OPS_RULES_CONFIG;
  const resolvedOn = existing.resolvedAt ?? existing.lastSeenDate;
  const age = isoDayDiff(resolvedOn, input.date);
  if (existing.resolvedReason === "owner_dismissed" && age < config.lifecycle.reopenDays.value) {
    return ignore(existing);
  }
  if (age >= config.lifecycle.reopenDays.value) return openNew(input.date, input, input.outcome);
  const sinceNotify = existing.lastNotifiedAt
    ? isoDayDiff(existing.lastNotifiedAt, input.date)
    : config.lifecycle.backAgainDays.value;
  const notify = sinceNotify >= config.lifecycle.backAgainDays.value;
  const alert: AlertState = {
    ...applyFire(existing, input.date, input.outcome, false),
    status: "open",
    severity: existing.severity,
    reopenCount: existing.reopenCount + 1,
    resolvedAt: null,
    resolvedReason: null,
    firstSeenDate: existing.firstSeenDate,
    occurrences: existing.occurrences + 1,
    consecutiveDays: 1,
    clearDays: 0,
    lastNotifiedAt: notify ? input.date : existing.lastNotifiedAt,
    notifiedSeverity: notify ? existing.severity : existing.notifiedSeverity,
  };
  const events: AlertEventDraft[] = [
    {
      kind: "reopened",
      severity: alert.severity,
      value: input.outcome.value,
      businessDate: input.date,
    },
  ];
  if (notify) {
    events.push({
      kind: "notified",
      severity: alert.severity,
      value: input.outcome.value,
      businessDate: input.date,
    });
  }
  return { action: "update", alert, events, notify, notifyReason: notify ? "back_again" : null };
}

function applyFire(
  existing: AlertState,
  date: string,
  outcome: Extract<AlertOutcome, { kind: "fire" }>,
  first: boolean,
): AlertState {
  return {
    ...existing,
    severity: outcome.severity,
    status: "open",
    firstSeenDate: first ? date : existing.firstSeenDate,
    lastSeenDate: date,
    occurrences: 1,
    consecutiveDays: 1,
    clearDays: 0,
    lastValue: outcome.value,
    threshold: outcome.threshold,
    baselineValue: outcome.baselineValue,
    fixKey: outcome.fixKey,
    fix: outcome.fix,
    text: outcome.text,
    evidence: outcome.evidence,
    lastNotifiedAt: date,
    notifiedSeverity: outcome.severity,
    book: {
      evaluatedOn: date,
      ruleSeverity: outcome.severity,
      watchLevelDays: 0,
      lastEvaluableDate: date,
      provisional: outcome.provisional,
    },
  };
}

function stillSnoozed(alert: AlertState, date: string): boolean {
  return alert.status === "snoozed" && alert.snoozedUntil != null && alert.snoozedUntil >= date;
}

function ignore(alert: AlertState | null): AlertTransition {
  return { action: "ignore", alert, events: [], notify: false, notifyReason: null };
}

function laterDate(left: string | undefined, right: string | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return left > right ? left : right;
}

function rank(severity: OpsAlertSeverity): number {
  return severity === "act_now" ? 2 : 1;
}

export function nextReportDelivery(
  existing: { version: number; status: "red" | "amber" | "green"; ready: boolean } | null,
  next: { status: "red" | "amber" | "green"; ready: boolean },
): { version: number; shouldNotify: boolean; reason: "first" | "severity_changed" | "unchanged" } {
  if (!existing) {
    return {
      version: 1,
      shouldNotify: next.ready,
      reason: next.ready ? "first" : "unchanged",
    };
  }
  if (existing.status !== next.status) {
    return { version: existing.version + 1, shouldNotify: true, reason: "severity_changed" };
  }
  if (!existing.ready && next.ready) {
    return { version: existing.version + 1, shouldNotify: true, reason: "first" };
  }
  return { version: existing.version, shouldNotify: false, reason: "unchanged" };
}
