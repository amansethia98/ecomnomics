import { metricDefinition } from "../metric-dictionary.js";
import type { OpsRulesConfig } from "./config.js";
import { DEFAULT_OPS_RULES_CONFIG } from "./config.js";
import {
  addDays,
  formatCivilDay,
  formatPct1,
  formatRupees,
  formatSignedPct,
  formatWeekdayName,
  formatWeekdayShort,
  isoDayDiff,
  pctChange,
} from "./format.js";
import type {
  DailyAppSnapshot,
  DailyBlocker,
  DailyClear,
  DailyEvaluation,
  DailyEvaluationInput,
  DailyFinding,
  DailyHold,
  DailyOutlet,
  DailyRuleCode,
  DailySnapshot,
  OpsAlertSeverity,
  OpsAppDay,
  OpsCell,
  OpsMetricPoint,
  OpsPlatform,
  OpsScopePlatform,
  OwnerQuestion,
} from "./types.js";
import {
  appLabel,
  COMBINED_NET_SALES,
  combinedNetSales,
  DAILY_FIXES,
  dailyDedupeKey,
  dailyFix,
  ingestBlockerCode,
  ruleFamily,
} from "./types.js";

function rulesOf(input: DailyEvaluationInput): OpsRulesConfig {
  return input.config ?? DEFAULT_OPS_RULES_CONFIG;
}

const DELAYED_KEY: Record<OpsPlatform, string> = {
  zomato: "delayed_orders_kpt10",
  swiggy: "delayed_orders_gt10",
};

const SALES_KEY: Record<OpsPlatform, string> = {
  zomato: COMBINED_NET_SALES.zomato,
  swiggy: COMBINED_NET_SALES.swiggy,
};

type RuleDecision =
  | {
      kind: "fire";
      severity: OpsAlertSeverity;
      value: number | null;
      threshold: number | null;
      baselineValue: number | null;
      baselineDate: string | null;
      text: string;
      evidence: OpsCell[];
      provisional: boolean;
    }
  | { kind: "clear"; correction?: string }
  | { kind: "hold"; reason: DailyHold["reason"] };

/**
 * Daily rules. Same inputs always give the same findings. Weekly and payout
 * checks are declared in the types module and are not evaluated here.
 */
export function evaluateDaily(input: DailyEvaluationInput): DailyEvaluation {
  const findings: DailyFinding[] = [];
  const clears: DailyClear[] = [];
  const holds: DailyHold[] = [];
  const frozenScopes: Array<{ outletId: string; platform: OpsScopePlatform }> = [];
  const blockers: DailyBlocker[] = [];
  const snapshots: DailySnapshot[] = [];

  for (const outlet of input.outlets) {
    const apps: DailyAppSnapshot[] = [];
    let anyDown = false;
    for (const platform of ["zomato", "swiggy"] as const) {
      if (!outlet.platforms.includes(platform)) {
        apps.push(absentApp(platform));
        continue;
      }
      const current = findDay(input.days, outlet.id, platform, input.date);
      const mode = appMode(platform, current, input);
      if (mode.mode !== "ready") {
        anyDown = true;
        frozenScopes.push({ outletId: outlet.id, platform });
        if (mode.blocker)
          blockers.push({ outletId: outlet.id, ...mode.blocker, dates: [input.date] });
      }
      const baseline = isClosed(input, outlet.id, input.date)
        ? null
        : salesBaseline(input.days, outlet.id, platform, input.date, rulesOf(input), input);
      apps.push({
        platform,
        mode: mode.mode,
        ingest: mode.ingest,
        retryable: mode.retryable,
        gap: mode.gap,
        waitedOut: mode.waitedOut,
        lagBanner: current?.lagBanner ?? false,
        salesPaise: mode.mode === "ready" ? pointValue(current, SALES_KEY[platform]) : null,
        baselineSalesPaise: baseline?.value ?? null,
        baselineDate: baseline?.date ?? null,
        delivered: mode.mode === "ready" ? pointValue(current, "delivered_orders") : null,
        onlinePct: mode.mode === "ready" ? pointValue(current, "online_pct") : null,
        prepMinutes: mode.mode === "ready" ? pointValue(current, "kpt_minutes") : null,
        prepBaseline: prepBaseline(input.days, outlet.id, platform, input.date),
      });
      if (mode.mode === "ready" && isClosed(input, outlet.id, input.date)) {
        withdrawClosed(outlet, platform, input.date, clears);
        continue;
      }
      if (mode.mode !== "ready") continue;
      evaluateApp(input, outlet, platform, current, findings, clears, holds, rulesOf(input));
    }
    if (anyDown) frozenScopes.push({ outletId: outlet.id, platform: "combined" });
    if (isClosed(input, outlet.id, input.date)) {
      withdrawClosed(outlet, "combined", input.date, clears);
    } else if (!anyDown) evaluateCombinedSales(input, outlet, findings, clears, holds);
    snapshots.push({ outletId: outlet.id, name: outlet.name, apps });
  }

  return {
    date: input.date,
    findings,
    clears,
    holds,
    frozenScopes,
    blockers,
    snapshots,
    ready: isReady(snapshots),
    notes: [...collectNotes(input, snapshots), ...zeroQuestionNotes(input)],
    ownerQuestions: zeroQuestions(input),
  };
}

function evaluateApp(
  input: DailyEvaluationInput,
  outlet: DailyOutlet,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
  findings: DailyFinding[],
  clears: DailyClear[],
  holds: DailyHold[],
  config: OpsRulesConfig,
) {
  const decisions: Array<[DailyRuleCode, RuleDecision]> = [
    ["d_sales_drop", salesDrop(input, outlet.id, platform, day)],
    ["d_zero_orders", zeroOrders(input, outlet.id, platform, day)],
    ["d_delayed", delayed(input, platform, day)],
    ["d_bad_orders", platform === "zomato" ? badOrders(input, day) : skipped()],
    ["d_cancel_reject", cancellations(input, platform, day)],
    ["d_complaints", complaints(input, platform, day)],
    ["d_food_ready", platform === "swiggy" ? foodReady(input, day) : skipped()],
    ["d_online", online(input, platform, day)],
    ["d_prep", prep(input, outlet.id, platform, day)],
    ["d_rating", platform === "zomato" ? rating(input, outlet.id, day) : skipped()],
  ];
  for (const [code, decision] of decisions) {
    record(outlet, platform, code, decision, findings, clears, holds, config);
  }
}

function skipped(): RuleDecision {
  return { kind: "hold", reason: "missing" };
}

function record(
  outlet: DailyOutlet,
  platform: OpsScopePlatform,
  code: DailyRuleCode,
  decision: RuleDecision,
  findings: DailyFinding[],
  clears: DailyClear[],
  holds: DailyHold[],
  config: OpsRulesConfig,
) {
  if (decision.kind === "hold" && decision.reason === "missing" && !applies(code, platform)) return;
  const dedupeKey = dailyDedupeKey(code, outlet.id, platform);
  if (decision.kind === "fire") {
    findings.push({
      code,
      family: ruleFamily(code),
      dedupeKey,
      outletId: outlet.id,
      outletName: outlet.name,
      platform,
      severity: decision.severity,
      provisional: decision.provisional,
      value: decision.value,
      threshold: decision.threshold,
      baselineValue: decision.baselineValue,
      baselineDate: decision.baselineDate,
      fixKey: code,
      fix: dailyFix(code, platform, config),
      text: decision.text,
      evidence: decision.evidence,
    });
    return;
  }
  if (decision.kind === "clear") {
    if (!applies(code, platform)) return;
    clears.push({
      code,
      dedupeKey,
      outletId: outlet.id,
      platform,
      ...(decision.correction ? { correction: decision.correction } : {}),
    });
    return;
  }
  if (!applies(code, platform)) return;
  holds.push({ code, dedupeKey, outletId: outlet.id, platform, reason: decision.reason });
}

function applies(code: DailyRuleCode, platform: OpsScopePlatform): boolean {
  if (code === "d_bad_orders" || code === "d_rating") return platform === "zomato";
  if (code === "d_food_ready") return platform === "swiggy";
  if (code === "d_sales_drop") return true;
  return platform !== "combined";
}

/** How many daily rules run for the connected apps, including combined sales when both are on. */
export function dailyCheckCount(platforms: readonly OpsPlatform[]): number {
  const unique = [...new Set(platforms)];
  const codes = Object.keys(DAILY_FIXES) as DailyRuleCode[];
  let count = 0;
  for (const platform of unique) {
    for (const code of codes) {
      if (applies(code, platform)) count += 1;
    }
  }
  if (
    unique.includes("zomato") &&
    unique.includes("swiggy") &&
    applies("d_sales_drop", "combined")
  ) {
    count += 1;
  }
  return count;
}

function evaluateCombinedSales(
  input: DailyEvaluationInput,
  outlet: DailyOutlet,
  findings: DailyFinding[],
  clears: DailyClear[],
  holds: DailyHold[],
) {
  const zomato = findDay(input.days, outlet.id, "zomato", input.date);
  const swiggy = findDay(input.days, outlet.id, "swiggy", input.date);
  const zomatoSales = pointValue(zomato, SALES_KEY.zomato);
  const swiggySales = pointValue(swiggy, SALES_KEY.swiggy);
  if (zomatoSales == null || swiggySales == null) {
    holds.push({
      code: "d_sales_drop",
      dedupeKey: dailyDedupeKey("d_sales_drop", outlet.id, "combined"),
      outletId: outlet.id,
      platform: "combined",
      reason: "missing",
    });
    return;
  }
  const current = combinedNetSales(zomatoSales, swiggySales);
  const config = rulesOf(input);
  const zBase = salesBaseline(input.days, outlet.id, "zomato", input.date, config, input);
  const sBase = salesBaseline(input.days, outlet.id, "swiggy", input.date, config, input);
  if (!zBase || !sBase) {
    holds.push({
      code: "d_sales_drop",
      dedupeKey: dailyDedupeKey("d_sales_drop", outlet.id, "combined"),
      outletId: outlet.id,
      platform: "combined",
      reason: "guard",
    });
    return;
  }
  const baseline = combinedNetSales(zBase.value, sBase.value);
  const provisional =
    Boolean(zomato?.lagBanner || swiggy?.lagBanner) ||
    swiggy?.date === input.date ||
    isPartial(input, outlet.id, "zomato", zomato);
  record(
    outlet,
    "combined",
    "d_sales_drop",
    salesDecision(current, baseline, zBase.date, "combined", provisional, input.date, config),
    findings,
    clears,
    holds,
    config,
  );
}

function salesDrop(
  input: DailyEvaluationInput,
  outletId: string,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): RuleDecision {
  const current = pointValue(day, SALES_KEY[platform]);
  if (pointState(day, SALES_KEY[platform]) === "updating")
    return { kind: "hold", reason: "updating" };
  if (current == null) return { kind: "hold", reason: "missing" };
  if (current === 0 && pointValue(day, "delivered_orders") === 0) {
    return { kind: "hold", reason: "missing" };
  }
  const config = rulesOf(input);
  const baseline = salesBaseline(input.days, outletId, platform, input.date, config, input);
  if (!baseline) return { kind: "hold", reason: "guard" };
  return salesDecision(
    current,
    baseline.value,
    baseline.date,
    platform,
    salesProvisional(input, outletId, platform, day),
    input.date,
    config,
  );
}

function salesProvisional(
  input: DailyEvaluationInput,
  outletId: string,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): boolean {
  if (day?.lagBanner && platform === "swiggy") return true;
  if (platform === "swiggy" && day?.date === input.date) return true;
  return isPartial(input, outletId, platform, day);
}

function salesDecision(
  current: number,
  baseline: number,
  baselineDate: string,
  platform: OpsScopePlatform,
  lagBanner: boolean,
  date: string,
  config: OpsRulesConfig,
): RuleDecision {
  if (current < 0) return { kind: "hold", reason: "guard" };
  const watchAbove = config.salesDrop.watchAbovePct.value;
  const actAbove = config.salesDrop.actNowAbovePct.value;
  if (baseline < config.guards.salesBaselinePaise.value) return { kind: "hold", reason: "guard" };
  const drop = ((baseline - current) / baseline) * 100;
  let severity: OpsAlertSeverity | null = null;
  if (drop > actAbove) severity = "act_now";
  else if (drop > watchAbove) severity = "watch";
  const change = pctChange(current, baseline);
  const correction =
    change == null
      ? undefined
      : `${formatWeekdayShort(date)}'s ${platform === "combined" ? "Total" : appLabel(platform)} sales are now ${formatRupees(current)} (${formatSignedPct(change)}); the earlier alert is withdrawn.`;
  if (!severity) return { kind: "clear", ...(correction ? { correction } : {}) };
  const provisional = lagBanner;
  if (provisional && severity === "act_now") severity = "watch";
  const holiday = config.holidayDates.includes(date) || config.holidayDates.includes(baselineDate);
  if (holiday && severity === "act_now") severity = "watch";
  const name = platform === "combined" ? "Total" : appLabel(platform);
  const festival = holiday ? " (festival week)" : "";
  const text = `${name} sales down ${formatPct1(drop)}% ${versus(date, baselineDate)} (${formatRupees(current)} vs ${formatRupees(baseline)})${festival}.`;
  return {
    kind: "fire",
    severity,
    value: drop,
    threshold: severity === "act_now" ? actAbove : watchAbove,
    baselineValue: baseline,
    baselineDate,
    text,
    provisional,
    evidence: [
      cell(
        platform === "swiggy" ? SALES_KEY.swiggy : SALES_KEY.zomato,
        "Net sales",
        "paise",
        current,
        date,
        baseline,
        baselineDate,
        pctChange(current, baseline),
      ),
    ],
  };
}

function zeroOrders(
  input: DailyEvaluationInput,
  outletId: string,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): RuleDecision {
  if (pointState(day, "delivered_orders") === "updating")
    return { kind: "hold", reason: "updating" };
  const delivered = pointValue(day, "delivered_orders");
  if (delivered == null || !day?.stored) return { kind: "hold", reason: "missing" };
  if (delivered !== 0) return { kind: "clear" };
  if (zeroStreak(input, outletId, platform, input.date) < rulesOf(input).zero.waitDays.value) {
    return { kind: "hold", reason: "guard" };
  }
  const baseline = countBaseline(
    input.days,
    outletId,
    platform,
    input.date,
    "delivered_orders",
    input,
  );
  if (!baseline || baseline.value < rulesOf(input).guards.zeroOrdersBaselineDelivered.value)
    return { kind: "hold", reason: "guard" };
  if (genuineOffline(day)) return { kind: "hold", reason: "missing" };
  const provisional = salesProvisional(input, outletId, platform, day);
  const text = `${appLabel(platform)} had no orders on ${formatCivilDay(input.date)} (usually ${baseline.value}).`;
  return {
    kind: "fire",
    severity: provisional ? "watch" : "act_now",
    value: 0,
    threshold: 0,
    baselineValue: baseline.value,
    baselineDate: baseline.date,
    text,
    provisional,
    evidence: [
      cell(
        "delivered_orders",
        "Delivered orders",
        "count",
        0,
        input.date,
        baseline.value,
        baseline.date,
        null,
      ),
    ],
  };
}

function delayed(
  input: DailyEvaluationInput,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): RuleDecision {
  const key = DELAYED_KEY[platform];
  const config = rulesOf(input);
  const watchAbove = config.delayed.watchAbovePct.value;
  const actAbove = config.delayed.actNowAbovePct.value;
  return countRate(day, key, config, (count, delivered, pct) => {
    let severity: OpsAlertSeverity | null = null;
    if (pct > actAbove) severity = "act_now";
    else if (pct > watchAbove) severity = "watch";
    if (!severity) return { kind: "clear" };
    return {
      kind: "fire",
      severity,
      value: pct,
      threshold: severity === "act_now" ? actAbove : watchAbove,
      baselineValue: null,
      baselineDate: null,
      provisional: false,
      text: `${appLabel(platform)} delayed orders ${count} of ${delivered} delivered (${formatPct1(pct)}%).`,
      evidence: [cell(key, "Delayed orders", "count", count, input.date, null, null, null)],
    };
  });
}

function badOrders(input: DailyEvaluationInput, day: OpsAppDay | undefined): RuleDecision {
  if (
    pointState(day, "bad_orders") === "updating" ||
    pointState(day, "bad_orders_pct") === "updating"
  ) {
    return { kind: "hold", reason: "updating" };
  }
  const delivered = pointValue(day, "delivered_orders");
  const count = pointValue(day, "bad_orders");
  const storedPct = pointValue(day, "bad_orders_pct");
  if (delivered == null || count == null) return { kind: "hold", reason: "missing" };
  const config = rulesOf(input);
  const guard = rateGuard(delivered, count, config);
  if (guard) return guard;
  const pct = storedPct ?? (count / delivered) * 100;
  const watchAbove = config.badOrders.watchAbovePct.value;
  const actAbove = config.badOrders.actNowAbovePct.value;
  let severity: OpsAlertSeverity | null = null;
  if (pct > actAbove) severity = "act_now";
  else if (pct > watchAbove) severity = "watch";
  if (!severity) return { kind: "clear" };
  return {
    kind: "fire",
    severity,
    value: pct,
    threshold: severity === "act_now" ? actAbove : watchAbove,
    baselineValue: null,
    baselineDate: null,
    provisional: false,
    text: `Zomato bad orders ${formatPct1(pct)}% (${count} of ${delivered}).`,
    evidence: [cell("bad_orders_pct", "Bad orders", "pct", pct, input.date, null, null, null)],
  };
}

function cancellations(
  input: DailyEvaluationInput,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): RuleDecision {
  const key = platform === "zomato" ? "rejected_orders" : "restaurant_cancelled_orders";
  const label = platform === "zomato" ? "rejected orders" : "cancellations";
  const config = rulesOf(input);
  const limits = config.cancellations;
  return countRate(day, key, config, (count, delivered, pct) => {
    const watch = count >= limits.watchCount.value && pct > limits.watchAbovePct.value;
    const act = count >= limits.actNowCount.value && pct > limits.actNowAbovePct.value;
    if (!watch && !act) return { kind: "clear" };
    const severity: OpsAlertSeverity = act ? "act_now" : "watch";
    return {
      kind: "fire",
      severity,
      value: count,
      threshold: severity === "act_now" ? limits.actNowCount.value : limits.watchCount.value,
      baselineValue: null,
      baselineDate: null,
      provisional: false,
      text: `${appLabel(platform)} ${label} ${count} of ${delivered} delivered (${formatPct1(pct)}%).`,
      evidence: [cell(key, label, "count", count, input.date, null, null, null)],
    };
  });
}

function complaints(
  input: DailyEvaluationInput,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): RuleDecision {
  const config = rulesOf(input);
  const limits = config.complaints;
  return countRate(day, "complaints", config, (count, delivered, pct) => {
    const watch = count >= limits.watchCount.value && pct > limits.watchAbovePct.value;
    const act = count >= limits.actNowCount.value && pct > limits.actNowAbovePct.value;
    if (!watch && !act) return { kind: "clear" };
    const severity: OpsAlertSeverity = act ? "act_now" : "watch";
    return {
      kind: "fire",
      severity,
      value: count,
      threshold: severity === "act_now" ? limits.actNowCount.value : limits.watchCount.value,
      baselineValue: null,
      baselineDate: null,
      provisional: false,
      text: `${appLabel(platform)} complaints ${count} of ${delivered} delivered (${formatPct1(pct)}%).`,
      evidence: [cell("complaints", "Complaints", "count", count, input.date, null, null, null)],
    };
  });
}

function foodReady(input: DailyEvaluationInput, day: OpsAppDay | undefined): RuleDecision {
  if (pointState(day, "food_ready_accuracy_pct") === "updating")
    return { kind: "hold", reason: "updating" };
  const pct = pointValue(day, "food_ready_accuracy_pct");
  const delivered = pointValue(day, "delivered_orders");
  if (pct == null || delivered == null) return { kind: "hold", reason: "missing" };
  const inaccurate = delivered * (1 - pct / 100);
  const config = rulesOf(input);
  const guard = rateGuard(delivered, inaccurate, config);
  if (guard) return guard;
  const watchBelow = config.foodReady.watchBelowPct.value;
  const actBelow = config.foodReady.actNowBelowPct.value;
  let severity: OpsAlertSeverity | null = null;
  if (pct < actBelow) severity = "act_now";
  else if (pct < watchBelow) severity = "watch";
  if (!severity) return { kind: "clear" };
  return {
    kind: "fire",
    severity,
    value: pct,
    threshold: severity === "act_now" ? actBelow : watchBelow,
    baselineValue: null,
    baselineDate: null,
    provisional: false,
    text: `Swiggy food ready ${formatPct1(pct)}%.`,
    evidence: [
      cell("food_ready_accuracy_pct", "Food ready", "pct", pct, input.date, null, null, null),
    ],
  };
}

function online(
  input: DailyEvaluationInput,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): RuleDecision {
  if (pointState(day, "online_pct") === "updating") return { kind: "hold", reason: "updating" };
  const pct = pointValue(day, "online_pct");
  const delivered = pointValue(day, "delivered_orders");
  if (pct == null || delivered == null) return { kind: "hold", reason: "missing" };
  if (pct === 0 && delivered > 0) return { kind: "hold", reason: "missing" };
  if (pct === 0 && delivered === 0 && genuineOffline(day)) {
    if (
      day &&
      zeroStreak(input, day.outletId, platform, input.date) < rulesOf(input).zero.waitDays.value
    ) {
      return { kind: "hold", reason: "guard" };
    }
    const usual = countBaseline(
      input.days,
      day?.outletId ?? "",
      platform,
      input.date,
      "delivered_orders",
    );
    return {
      kind: "fire",
      severity: "act_now",
      value: 0,
      threshold: 0,
      baselineValue: usual?.value ?? null,
      baselineDate: usual?.date ?? null,
      provisional: false,
      text: `${appLabel(platform)} was offline all day ${formatCivilDay(input.date)} (0 orders, usually ${usual?.value ?? 0}).`,
      evidence: [cell("online_pct", "Online", "pct", pct, input.date, null, null, null)],
    };
  }
  const config = rulesOf(input);
  if (delivered < config.guards.rateMinDelivered.value) return { kind: "hold", reason: "guard" };
  const watchBelow = config.online.watchBelowPct.value;
  const actBelow = config.online.actNowBelowPct.value;
  let severity: OpsAlertSeverity | null = null;
  if (pct < actBelow) severity = "act_now";
  else if (pct < watchBelow) severity = "watch";
  if (!severity) return { kind: "clear" };
  return {
    kind: "fire",
    severity,
    value: pct,
    threshold: severity === "act_now" ? actBelow : watchBelow,
    baselineValue: null,
    baselineDate: null,
    provisional: false,
    text: `${appLabel(platform)} online ${formatPct1(pct)}% on ${formatWeekdayShort(input.date)}.`,
    evidence: [cell("online_pct", "Online", "pct", pct, input.date, null, null, null)],
  };
}

function prep(
  input: DailyEvaluationInput,
  outletId: string,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): RuleDecision {
  if (pointState(day, "kpt_minutes") === "updating") return { kind: "hold", reason: "updating" };
  const minutes = pointValue(day, "kpt_minutes");
  if (minutes == null) return { kind: "hold", reason: "missing" };
  const config = rulesOf(input);
  const baseline = minuteBaseline(input.days, outletId, platform, input.date);
  const rise = baseline ? minutes - baseline.value : null;
  const actAbove = config.prep.actNowAboveMinutes.value;
  const watchAbove = config.prep.watchAboveMinutes.value;
  const act = minutes > actAbove;
  const watch = minutes > watchAbove && rise != null && rise >= config.prep.minRiseMinutes.value;
  if (!act && !watch) return { kind: "clear" };
  const severity: OpsAlertSeverity = act ? "act_now" : "watch";
  const was = baseline ? ` (was ${trimNumber(baseline.value)})` : "";
  return {
    kind: "fire",
    severity,
    value: minutes,
    threshold: severity === "act_now" ? actAbove : watchAbove,
    baselineValue: baseline?.value ?? null,
    baselineDate: baseline?.date ?? null,
    provisional: false,
    text: `${appLabel(platform)} prep time ${trimNumber(minutes)} min${was}`,
    evidence: [
      cell(
        "kpt_minutes",
        "Prep time",
        "minutes",
        minutes,
        input.date,
        baseline?.value ?? null,
        baseline?.date ?? null,
        null,
      ),
    ],
  };
}

function rating(
  input: DailyEvaluationInput,
  outletId: string,
  day: OpsAppDay | undefined,
): RuleDecision {
  if (pointState(day, "rating") === "updating") return { kind: "hold", reason: "updating" };
  const value = pointValue(day, "rating");
  if (value == null || value === 0) return { kind: "hold", reason: "missing" };
  const config = rulesOf(input);
  const actBelow = config.rating.actNowBelow.value;
  const watchBelow = config.rating.watchBelow.value;
  const baseline = minuteBaseline(input.days, outletId, "zomato", input.date, "rating");
  const drop = baseline ? Math.round((baseline.value - value) * 100) / 100 : null;
  const act = value < actBelow;
  const watch = value < watchBelow || (drop != null && drop >= config.rating.watchDrop.value);
  if (!act && !watch) return { kind: "clear" };
  const severity: OpsAlertSeverity = act ? "act_now" : "watch";
  const clause = act
    ? `, below ${actBelow.toFixed(2)}`
    : value < watchBelow
      ? `, below ${watchBelow.toFixed(2)}`
      : `, down from ${baseline?.value.toFixed(2)}`;
  return {
    kind: "fire",
    severity,
    value,
    threshold: severity === "act_now" ? actBelow : watchBelow,
    baselineValue: baseline?.value ?? null,
    baselineDate: baseline?.date ?? null,
    provisional: false,
    text: `Zomato rating ${value.toFixed(2)}${clause}.`,
    evidence: [
      cell(
        "rating",
        "Rating",
        "decimal",
        value,
        input.date,
        baseline?.value ?? null,
        baseline?.date ?? null,
        null,
      ),
    ],
  };
}

function countRate(
  day: OpsAppDay | undefined,
  key: string,
  config: OpsRulesConfig,
  decide: (count: number, delivered: number, pct: number) => RuleDecision,
): RuleDecision {
  if (pointState(day, key) === "updating" || pointState(day, "delivered_orders") === "updating") {
    return { kind: "hold", reason: "updating" };
  }
  const count = pointValue(day, key);
  const delivered = pointValue(day, "delivered_orders");
  if (count == null || delivered == null) return { kind: "hold", reason: "missing" };
  const guard = rateGuard(delivered, count, config);
  if (guard) return guard;
  if (delivered === 0) return { kind: "hold", reason: "guard" };
  return decide(count, delivered, (count / delivered) * 100);
}

function rateGuard(
  delivered: number,
  numerator: number,
  config: OpsRulesConfig,
): RuleDecision | null {
  if (delivered < config.guards.rateMinDelivered.value) return { kind: "hold", reason: "guard" };
  // One bad order cannot cross the rate lines once the day is large enough, so
  // the open alert can clear. Too few delivered orders stay frozen.
  if (numerator < config.guards.rateMinNumerator.value) return { kind: "clear" };
  return null;
}

function salesBaseline(
  days: OpsAppDay[],
  outletId: string,
  platform: OpsPlatform,
  date: string,
  config: OpsRulesConfig,
  input?: DailyEvaluationInput,
): { date: string; value: number } | null {
  for (const back of [7, 14]) {
    const priorDate = addDays(date, -back);
    if (input && isClosed(input, outletId, priorDate)) continue;
    const prior = findDay(days, outletId, platform, priorDate);
    if (!prior?.stored || prior.ingest || prior.gap || blankPattern(prior)) continue;
    if (pointState(prior, SALES_KEY[platform]) !== "ok") continue;
    if (partialAgainstPrior(prior, days, outletId, platform, config)) continue;
    const value = pointValue(prior, SALES_KEY[platform]);
    if (value == null) continue;
    if (value < config.guards.salesBaselinePaise.value) continue;
    return { date: prior.date, value };
  }
  return null;
}

function countBaseline(
  days: OpsAppDay[],
  outletId: string,
  platform: OpsPlatform,
  date: string,
  key: string,
  input?: DailyEvaluationInput,
): { date: string; value: number } | null {
  for (const back of [7, 14]) {
    const priorDate = addDays(date, -back);
    if (input && isClosed(input, outletId, priorDate)) continue;
    const prior = findDay(days, outletId, platform, priorDate);
    if (!prior?.stored || prior.ingest) continue;
    if (pointState(prior, key) !== "ok") continue;
    const value = pointValue(prior, key);
    if (value == null) continue;
    return { date: prior.date, value };
  }
  return null;
}

function minuteBaseline(
  days: OpsAppDay[],
  outletId: string,
  platform: OpsPlatform,
  date: string,
  key = "kpt_minutes",
): { date: string; value: number } | null {
  return countBaseline(days, outletId, platform, date, key);
}

function prepBaseline(
  days: OpsAppDay[],
  outletId: string,
  platform: OpsPlatform,
  date: string,
): number | null {
  return minuteBaseline(days, outletId, platform, date)?.value ?? null;
}

function findDay(
  days: OpsAppDay[],
  outletId: string,
  platform: OpsPlatform,
  date: string,
): OpsAppDay | undefined {
  return days.find(
    (day) => day.outletId === outletId && day.platform === platform && day.date === date,
  );
}

function point(day: OpsAppDay | undefined, key: string): OpsMetricPoint | undefined {
  return day?.metrics[key];
}

function pointState(day: OpsAppDay | undefined, key: string): OpsMetricPoint["state"] | "missing" {
  return point(day, key)?.state ?? "missing";
}

function isClosed(input: DailyEvaluationInput, outletId: string, date: string): boolean {
  return (input.outletDays ?? []).some(
    (row) => row.outletId === outletId && row.date === date && row.status === "closed",
  );
}

function answered(input: DailyEvaluationInput, outletId: string, date: string): boolean {
  return (input.outletDays ?? []).some((row) => row.outletId === outletId && row.date === date);
}

/** Stored figures arrived and the outlet had no orders. A gap or a missing row is not this. */
function arrivedZero(day: OpsAppDay | undefined): boolean {
  if (!day?.stored || day.ingest || day.gap) return false;
  return pointValue(day, "delivered_orders") === 0;
}

function zeroStreak(
  input: DailyEvaluationInput,
  outletId: string,
  platform: OpsPlatform,
  date: string,
): number {
  let count = 0;
  let cursor = date;
  for (let back = 0; back < 14; back += 1) {
    if (isClosed(input, outletId, cursor)) break;
    if (!arrivedZero(findDay(input.days, outletId, platform, cursor))) break;
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

const WITHDRAW_CODES: DailyRuleCode[] = [
  "d_sales_drop",
  "d_zero_orders",
  "d_delayed",
  "d_bad_orders",
  "d_cancel_reject",
  "d_complaints",
  "d_food_ready",
  "d_online",
  "d_prep",
  "d_rating",
];

function withdrawClosed(
  outlet: DailyOutlet,
  platform: OpsScopePlatform,
  date: string,
  clears: DailyClear[],
) {
  for (const code of WITHDRAW_CODES) {
    if (!applies(code, platform)) continue;
    const who = platform === "combined" ? "Total" : appLabel(platform);
    clears.push({
      code,
      dedupeKey: dailyDedupeKey(code, outlet.id, platform),
      outletId: outlet.id,
      platform,
      withdraw: true,
      correction: `${formatWeekdayShort(date)}'s ${who} alert is withdrawn; ${outlet.name} was closed.`,
    });
  }
}

function zeroQuestions(input: DailyEvaluationInput): OwnerQuestion[] {
  if (!rulesOf(input).zero.askOwner) return [];
  const wait = rulesOf(input).zero.waitDays.value;
  const outlets = [...input.outlets].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  const questions: OwnerQuestion[] = [];
  for (const outlet of outlets) {
    for (const platform of ["zomato", "swiggy"] as const) {
      if (!outlet.platforms.includes(platform)) continue;
      if (!arrivedZero(findDay(input.days, outlet.id, platform, input.date))) continue;
      if (answered(input, outlet.id, input.date)) continue;
      if (zeroStreak(input, outlet.id, platform, input.date) >= wait) continue;
      questions.push({ outletId: outlet.id, platform, date: input.date, kind: "zero_day" });
    }
  }
  return questions;
}

function zeroQuestionNotes(input: DailyEvaluationInput): string[] {
  const names = new Map(input.outlets.map((outlet) => [outlet.id, outlet.name]));
  return zeroQuestions(input).map((question) => {
    const name = names.get(question.outletId) ?? "Outlet";
    return `${name} (${appLabel(question.platform)}) had 0 orders on ${formatCivilDay(question.date)}: either it was closed or the app hasn't updated yet. Was it closed or not sure?`;
  });
}

/**
 * A stored day with no orders, no sales, and no rating or online reading.
 * Online at 0% with real orders is a feed gap, not a blank day.
 */
function blankPattern(day: OpsAppDay | undefined): boolean {
  if (!day?.stored || day.ingest) return false;
  if (pointValue(day, "delivered_orders") !== 0) return false;
  const sales = pointValue(day, SALES_KEY[day.platform]);
  if (sales != null && sales !== 0) return false;
  if (pointValue(day, "online_pct") != null && pointValue(day, "online_pct") !== 0) return false;
  const rating = pointValue(day, "rating");
  return rating == null || rating === 0;
}

/** Online 0% and no orders, but some other real signal, so the day is not blank. */
function genuineOffline(day: OpsAppDay | undefined): boolean {
  if (!day?.stored) return false;
  if (pointValue(day, "online_pct") !== 0) return false;
  if (pointValue(day, "delivered_orders") !== 0) return false;
  return !blankPattern(day);
}

function ageOf(input: DailyEvaluationInput, date: string): number {
  return isoDayDiff(date, input.asOf ?? addDays(input.date, 1));
}

function versus(date: string, baselineDate: string): string {
  if (isoDayDiff(baselineDate, date) <= 8) return `vs last ${formatWeekdayName(baselineDate)}`;
  return `vs ${formatCivilDay(baselineDate)}`;
}

function isPartial(
  input: DailyEvaluationInput,
  outletId: string,
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
): boolean {
  if (!day) return false;
  return partialAgainstPrior(day, input.days, outletId, platform, rulesOf(input));
}

function partialAgainstPrior(
  day: OpsAppDay,
  days: OpsAppDay[],
  outletId: string,
  platform: OpsPlatform,
  config: OpsRulesConfig,
): boolean {
  if (!day.stored || day.ingest) return false;
  const delivered = pointValue(day, "delivered_orders");
  if (delivered === 0) return false;
  const prior = findDay(days, outletId, platform, addDays(day.date, -7));
  const priorDelivered = pointValue(prior, "delivered_orders");
  if (delivered == null || priorDelivered == null || priorDelivered <= 0) return false;
  return delivered < config.partial.deliveredRatio.value * priorDelivered;
}

function collectNotes(input: DailyEvaluationInput, snapshots: DailySnapshot[]): string[] {
  const notes: string[] = [];
  const config = rulesOf(input);
  let history = false;
  for (const outlet of input.outlets) {
    for (const platform of outlet.platforms) {
      const day = findDay(input.days, outlet.id, platform, input.date);
      if (!day?.stored || day.ingest) continue;
      const sales = pointValue(day, SALES_KEY[platform]);
      if (sales != null && sales < 0) {
        notes.push(
          `${appLabel(platform)} sales look wrong for ${formatWeekdayShort(input.date)}; we're checking.`,
        );
      }
      const delivered = pointValue(day, "delivered_orders");
      const online = pointValue(day, "online_pct");
      if (online === 0 && delivered != null && delivered > 0) {
        notes.push(
          `${appLabel(platform)} online time not reported for ${formatWeekdayShort(input.date)}.`,
        );
      }
      if (delivered != null && delivered > 0 && delivered < config.guards.rateMinDelivered.value) {
        notes.push(`Too few orders on ${appLabel(platform)} yesterday to judge rates.`);
      }
      if (pointState(day, "kpt_minutes") === "updating") {
        notes.push(`${appLabel(platform)} prep time is being re-read after a report change.`);
      }
      if (
        sales != null &&
        !salesBaseline(input.days, outlet.id, platform, input.date, config, input)
      ) {
        history = true;
      }
    }
  }
  if (history && snapshots.some((snapshot) => snapshot.apps.some((app) => app.mode === "ready"))) {
    notes.push("Comparisons start once we have a week of history.");
  }
  return [...new Set(notes)];
}

/** Fold one stored metric into a day. A banner alone does not make the day stored. A fact row replaces a platform check. */
export function applyStoredMetric(
  day: OpsAppDay,
  row: {
    key: string;
    value: number | null;
    state: OpsMetricPoint["state"];
    rowRole: "fact" | "platform_check";
    valueBoolean?: boolean | null;
  },
): void {
  if (row.key === "lag_banner") {
    day.lagBanner = row.valueBoolean === true;
    return;
  }
  const current = day.metrics[row.key];
  if (current && row.rowRole !== "fact") return;
  day.metrics[row.key] = { value: row.value, state: row.state };
  if (row.state === "ok" && row.value != null) day.stored = true;
}

/** A later failed fetch does not wipe a day that already has stored metrics. */
export function noteFailedFetch(
  day: OpsAppDay,
  code: "signed_out" | "download_failed" | "layout_changed" | "needs_owner" | "fetch_held",
): void {
  if (day.stored || day.gap) return;
  day.ingest = { code, retryable: code === "signed_out" || code === "download_failed" };
}

function pointValue(day: OpsAppDay | undefined, key: string): number | null {
  const metric = point(day, key);
  if (metric?.state !== "ok") return null;
  return metric.value;
}

function appMode(
  platform: OpsPlatform,
  day: OpsAppDay | undefined,
  input: DailyEvaluationInput,
): {
  mode: DailyAppSnapshot["mode"];
  ingest: DailyAppSnapshot["ingest"];
  retryable: boolean;
  gap: boolean;
  waitedOut: boolean;
  blocker: Omit<DailyBlocker, "outletId" | "dates"> | null;
} {
  const wait = rulesOf(input).blank.waitDays.value;
  const age = ageOf(input, day?.date ?? input.date);
  const waiting = (gap: boolean, waitedOut: boolean) => ({
    mode: "lag_missing" as const,
    ingest: null,
    retryable: true,
    gap,
    waitedOut,
    blocker: { platform, code: "lag_missing" as const, retryable: true },
  });
  if (day?.gap && !day.stored && !day.ingest) return waiting(true, age >= wait);
  if (day?.ingest) {
    return {
      mode: "failed",
      ingest: day.ingest.code,
      retryable: day.ingest.retryable,
      blocker: {
        platform,
        code: ingestBlockerCode(day.ingest.code),
        retryable: day.ingest.retryable,
      },
      gap: false,
      waitedOut: false,
    };
  }
  if (!day?.stored) {
    if (platform === "swiggy") return waiting(false, age >= wait);
    return waiting(true, age >= wait);
  }
  return {
    mode: "ready",
    ingest: null,
    retryable: false,
    gap: false,
    waitedOut: false,
    blocker: null,
  };
}

function absentApp(platform: OpsPlatform): DailyAppSnapshot {
  return {
    platform,
    mode: "absent",
    ingest: null,
    retryable: false,
    gap: false,
    waitedOut: false,
    lagBanner: false,
    salesPaise: null,
    baselineSalesPaise: null,
    baselineDate: null,
    delivered: null,
    onlinePct: null,
    prepMinutes: null,
    prepBaseline: null,
  };
}

function isReady(snapshots: DailySnapshot[]): boolean {
  const connected = snapshots.flatMap((snapshot) =>
    snapshot.apps.filter((app) => app.mode !== "absent"),
  );
  if (connected.length === 0) return false;
  return connected.some((app) => app.mode === "ready");
}

/** Sales and delivered orders add across outlets. Rates stay on each outlet. */
export function rollupDailyApps(snapshots: DailySnapshot[]): DailyAppSnapshot[] {
  return (["zomato", "swiggy"] as const).map((platform) => {
    const ready = snapshots.flatMap((snapshot) =>
      snapshot.apps.filter((app) => app.platform === platform && app.mode === "ready"),
    );
    if (ready.length === 0) {
      const present = snapshots.some((snapshot) =>
        snapshot.apps.some((app) => app.platform === platform && app.mode !== "absent"),
      );
      return present ? { ...absentApp(platform), mode: "failed" as const } : absentApp(platform);
    }
    return {
      platform,
      mode: "ready",
      ingest: null,
      retryable: false,
      gap: false,
      waitedOut: false,
      lagBanner: ready.some((app) => app.lagBanner),
      salesPaise: sumPresent(ready.map((app) => app.salesPaise)),
      baselineSalesPaise: sumPresent(ready.map((app) => app.baselineSalesPaise)),
      baselineDate: ready.find((app) => app.baselineDate)?.baselineDate ?? null,
      delivered: sumPresent(ready.map((app) => app.delivered)),
      onlinePct: null,
      prepMinutes: null,
      prepBaseline: null,
    };
  });
}

function sumPresent(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0);
}

function cell(
  key: string,
  label: string,
  unit: OpsCell["unit"],
  value: number | null,
  date: string,
  baseline: number | null,
  baselineDate: string | null,
  changePct: number | null,
): OpsCell {
  const definition = metricDefinition(key);
  return {
    key,
    label,
    unit,
    value,
    pctOfDelivered: null,
    status: "ok",
    coverageDays: 1,
    expectedDays: 1,
    missingDates: [],
    updatingDates: [],
    baseline: baselineDate ? { weekStart: baselineDate, value: baseline } : null,
    changePct,
    changePoints: null,
    source: "daily",
    accuracy: definition?.accuracy === "approx" ? "approx" : "exact",
    warned: true,
    window: { from: date, to: addDays(date, 1) },
  };
}

/** One line per outlet, app and rule. An app sales drop and the combined drop share one line. */
export function displayFindings(findings: DailyFinding[]): DailyFinding[] {
  const shown: DailyFinding[] = [];
  const outlets = [...new Set(findings.map((finding) => finding.outletId))];
  for (const outletId of outlets) {
    const members = findings.filter((finding) => finding.outletId === outletId);
    const sales = members.filter((finding) => finding.family === "sales");
    const rest = members.filter((finding) => finding.family !== "sales");
    shown.push(...rest);
    const combined = sales.find((finding) => finding.platform === "combined");
    const apps = sales.filter((finding) => finding.platform !== "combined");
    if (apps.length > 0 && combined) {
      const worst = [...apps].sort((a, b) => rank(b.severity) - rank(a.severity))[0];
      if (!worst) continue;
      const base = worst.text.replace(/ \([^)]*\)\.$/, "").replace(/\.$/, "");
      shown.push({
        ...worst,
        text: `${base} (total down ${formatPct1(combined.value ?? 0)}%).`,
      });
    } else {
      shown.push(...sales);
    }
  }
  return sortFindings(shown);
}

function sortFindings(findings: DailyFinding[]): DailyFinding[] {
  return [...findings].sort((a, b) => {
    const severity = rank(b.severity) - rank(a.severity);
    if (severity !== 0) return severity;
    const outlet = a.outletName.localeCompare(b.outletName);
    if (outlet !== 0) return outlet;
    const app = a.platform.localeCompare(b.platform);
    if (app !== 0) return app;
    return a.code.localeCompare(b.code);
  });
}

function rank(severity: OpsAlertSeverity): number {
  return severity === "act_now" ? 2 : 1;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : formatPct1(value);
}

export function findingsUseOnlyDailyPrep(findings: DailyFinding[]): boolean {
  return findings
    .filter((finding) => finding.code === "d_prep")
    .every((finding) => finding.evidence.every((item) => item.key === "kpt_minutes"));
}

export function noCombinedNonSummable(findings: DailyFinding[]): boolean {
  return findings.every(
    (finding) => finding.platform !== "combined" || finding.code === "d_sales_drop",
  );
}
