import { addDays, formatWeekdayName, pctChange } from "./ops/format.js";
import { dailyCheckCount } from "./ops/rules.js";
import type { OpsAlertSeverity, OpsPlatform, OpsScopePlatform } from "./ops/types.js";

const AVAILABILITY = new Set(["d_online", "d_sales_drop", "d_zero_orders"]);
const FOLD = 3;

export interface OwnerHomeAlert {
  id: string;
  severity: OpsAlertSeverity;
  ruleCode: string;
  family: string | null;
  outletId: string | null;
  outletName: string | null;
  platform: OpsScopePlatform;
  text: string;
  fix: string;
  consecutiveDays: number;
  /** Paise lost, when the alert carries a money figure. */
  impactPaise: number;
  /** Recent sales for the outlet, used only to break a tie. */
  outletSalesPaise: number;
  notifiedAt: string | null;
}

export interface OwnerHomeQuestion {
  outletId: string;
  outletName: string;
  platform: OpsPlatform;
  date: string;
}

export interface OwnerHomeSales {
  combinedPaise: number | null;
  zomatoPaise: number | null;
  swiggyPaise: number | null;
  zomatoBaselinePaise: number | null;
  swiggyBaselinePaise: number | null;
}

export interface OwnerHomeBrief {
  date: string;
  baselineDate: string | null;
  statusText: string | null;
  corrections: string[];
  form: "brief" | "lag_missing" | "no_data";
  sales: OwnerHomeSales | null;
  delivered: number | null;
  deliveredBaseline: number | null;
  notes: string[];
  exclusion: string | null;
  dataAsOf: string | null;
  connect: boolean;
}

export interface OwnerHomeInput {
  /** Civil date in Asia/Kolkata. */
  today: string;
  /** Instant the screen is read, ISO. */
  now: string;
  restaurantName: string;
  connected: readonly OpsPlatform[];
  hasHistory: boolean;
  brief: OwnerHomeBrief | null;
  alerts: readonly OwnerHomeAlert[];
  questions: readonly OwnerHomeQuestion[];
  /** Same-weekday sales, oldest first, last is the brief day. */
  weekdayHistory: readonly number[] | null;
  /** Last complete day when yesterday is not in yet. */
  lastComplete: { date: string; salesPaise: number | null; delivered: number | null } | null;
  payoutPaise: number | null;
  payoutToCheck: number;
}

export interface OwnerHomeItem {
  ids: string[];
  severity: OpsAlertSeverity;
  outletId: string | null;
  outletName: string | null;
  platform: OpsScopePlatform;
  text: string;
  fix: string;
  consecutiveDays: number;
  impactPaise: number;
  fresh: boolean;
  canSnooze: boolean;
}

export interface OwnerHomeNumber {
  paise: number | null;
  count: number | null;
  changePct: number | null;
  /** Set when one app is still pending, so the figure is not a total. */
  pendingPlatform: OpsPlatform | null;
  asOf: string | null;
}

export interface OwnerHomeModel {
  kind: "welcome" | "waiting" | "alerts" | "watch" | "clear";
  date: string | null;
  baselineDate: string | null;
  readiness: string | null;
  corrections: string[];
  staleNote: string | null;
  urgent: number;
  watch: number;
  card: OwnerHomeItem | null;
  rows: OwnerHomeItem[];
  overflow: OwnerHomeItem[];
  positive:
    | { kind: "best"; weekday: string; weeks: number; paise: number }
    | { kind: "steady"; weekday: string }
    | null;
  questions: OwnerHomeQuestion[];
  sales: OwnerHomeNumber;
  delivered: OwnerHomeNumber;
  payout: { paise: number | null; toCheck: number; nextDate: string };
  checksPassed: number;
  updated: { zomato: string | null; swiggy: string | null };
  askChief: boolean;
}

export function alertImpactPaise(alert: {
  ruleCode: string;
  lastValue: number | null;
  baselineValue: number | null;
  evidence: ReadonlyArray<{
    key: string;
    unit: string;
    value: number | null;
    baseline: { value: number | null } | null;
  }>;
}): number {
  for (const cell of alert.evidence) {
    if (cell.unit !== "paise" || cell.value == null) continue;
    if (cell.key.includes("lost") || cell.key.includes("loss"))
      return Math.max(0, Math.round(cell.value));
    const base = cell.baseline?.value;
    if (base != null && base > cell.value) return Math.round(base - cell.value);
  }
  if (
    alert.ruleCode === "d_sales_drop" &&
    alert.baselineValue != null &&
    alert.lastValue != null &&
    alert.lastValue > 0 &&
    alert.lastValue < 100
  ) {
    return Math.round((alert.baselineValue * alert.lastValue) / 100);
  }
  return 0;
}

/** 09:00 Asia/Kolkata on a civil date, as UTC. */
export function istMorning(date: string): string {
  return `${date}T03:30:00.000Z`;
}

export function nextThursday(today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  const weekday = date.getUTCDay();
  const ahead = (4 - weekday + 7) % 7;
  return addDays(today, ahead);
}

export function composeOwnerHome(input: OwnerHomeInput): OwnerHomeModel {
  const morning = istMorning(input.today);
  const ranked = rankHomeAlerts(input.alerts, morning, input.now);
  const urgent = ranked.filter((item) => item.severity === "act_now").length;
  const watch = ranked.filter((item) => item.severity === "watch").length;
  const card = ranked[0] ?? null;
  const rest = ranked.slice(1);
  const rows = rest.slice(0, FOLD);
  const overflow = rest.slice(FOLD);
  const questions = [...input.questions]
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) || left.outletName.localeCompare(right.outletName),
    )
    .slice(0, FOLD);
  const brief = input.brief;
  const stale = brief?.notes.find((note) => /login|reconnect|not updated/i.test(note)) ?? null;
  const bothLate = brief?.form === "no_data";
  const welcome = !input.hasHistory && brief == null && ranked.length === 0;
  const kind = welcome
    ? "welcome"
    : bothLate
      ? "waiting"
      : urgent > 0
        ? "alerts"
        : watch > 0
          ? "watch"
          : "clear";
  const sales = salesNumber(brief, input.lastComplete, bothLate);
  const delivered = deliveredNumber(brief, input.lastComplete, bothLate);
  const weekday = brief?.baselineDate
    ? formatWeekdayName(brief.baselineDate)
    : brief
      ? formatWeekdayName(brief.date)
      : "day";
  return {
    kind,
    date: brief?.date ?? null,
    baselineDate: brief?.baselineDate ?? null,
    readiness: welcome ? null : displayedReadiness(brief?.statusText ?? null, urgent, watch),
    corrections: brief?.corrections ?? [],
    staleNote: stale,
    urgent,
    watch,
    card,
    rows,
    overflow,
    positive: kind === "clear" && brief ? standout(input.weekdayHistory, weekday) : null,
    questions: welcome || bothLate ? [] : questions,
    sales,
    delivered,
    payout: {
      paise: input.payoutPaise,
      toCheck: input.payoutToCheck,
      nextDate: nextThursday(input.today),
    },
    checksPassed: dailyCheckCount(input.connected),
    updated: {
      zomato: brief?.dataAsOf ?? null,
      swiggy: sales.pendingPlatform === "swiggy" ? null : (brief?.dataAsOf ?? null),
    },
    askChief: welcome,
  };
}

function displayedReadiness(text: string | null, urgent: number, watch: number): string | null {
  if (!text) return null;
  return text
    .replace(/Act now \(\d+\)/g, `Act now (${urgent})`)
    .replace(/Watch \(\d+\)/g, `Watch (${watch})`);
}

function salesNumber(
  brief: OwnerHomeBrief | null,
  last: OwnerHomeInput["lastComplete"],
  waiting: boolean,
): OwnerHomeNumber {
  if (waiting) {
    return {
      paise: last?.salesPaise ?? null,
      count: null,
      changePct: null,
      pendingPlatform: null,
      asOf: last?.date ?? null,
    };
  }
  const sales = brief?.sales;
  if (!sales)
    return { paise: null, count: null, changePct: null, pendingPlatform: null, asOf: null };
  const pending = pendingPlatform(sales);
  const current = sales.combinedPaise ?? sales.zomatoPaise ?? sales.swiggyPaise;
  const baseline =
    sales.zomatoBaselinePaise != null &&
    sales.swiggyBaselinePaise != null &&
    sales.combinedPaise != null
      ? sales.zomatoBaselinePaise + sales.swiggyBaselinePaise
      : sales.zomatoPaise != null
        ? sales.zomatoBaselinePaise
        : sales.swiggyBaselinePaise;
  return {
    paise: current,
    count: null,
    changePct: current != null && baseline != null ? pctChange(current, baseline) : null,
    pendingPlatform: pending,
    asOf: null,
  };
}

function deliveredNumber(
  brief: OwnerHomeBrief | null,
  last: OwnerHomeInput["lastComplete"],
  waiting: boolean,
): OwnerHomeNumber {
  if (waiting) {
    return {
      paise: null,
      count: last?.delivered ?? null,
      changePct: null,
      pendingPlatform: null,
      asOf: last?.date ?? null,
    };
  }
  const pending = brief?.sales ? pendingPlatform(brief.sales) : null;
  const current = brief?.delivered ?? null;
  const baseline = brief?.deliveredBaseline ?? null;
  return {
    paise: null,
    count: current,
    changePct: current != null && baseline != null ? pctChange(current, baseline) : null,
    pendingPlatform: pending,
    asOf: null,
  };
}

function pendingPlatform(sales: OwnerHomeSales): OpsPlatform | null {
  if (sales.zomatoPaise == null && sales.swiggyPaise != null) return "zomato";
  if (sales.swiggyPaise == null && sales.zomatoPaise != null) return "swiggy";
  return null;
}

function standout(history: readonly number[] | null, weekday: string): OwnerHomeModel["positive"] {
  if (!history || history.length < 2) return { kind: "steady", weekday };
  const latest = history[history.length - 1] ?? 0;
  const earlier = history.slice(0, -1);
  const best = Math.max(...earlier);
  if (latest > best && latest >= best * 1.1) {
    return { kind: "best", weekday, weeks: history.length, paise: latest };
  }
  return { kind: "steady", weekday };
}

function rankHomeAlerts(
  alerts: readonly OwnerHomeAlert[],
  morning: string,
  now: string,
): OwnerHomeItem[] {
  const groups = new Map<string, OwnerHomeAlert[]>();
  for (const alert of alerts) {
    const cause = AVAILABILITY.has(alert.ruleCode)
      ? "availability"
      : (alert.family ?? alert.ruleCode);
    const key = `${alert.outletId ?? ""}:${cause}`;
    const list = groups.get(key) ?? [];
    list.push(alert);
    groups.set(key, list);
  }
  const items = [...groups.values()].map((group) => mergeGroup(group, morning, now));
  items.sort((left, right) => {
    const severity = rank(right.severity) - rank(left.severity);
    if (severity !== 0) return severity;
    if (right.impactPaise !== left.impactPaise) return right.impactPaise - left.impactPaise;
    if (right.consecutiveDays !== left.consecutiveDays)
      return right.consecutiveDays - left.consecutiveDays;
    const sales = outletSales(right, alerts) - outletSales(left, alerts);
    if (sales !== 0) return sales;
    return left.ids[0]?.localeCompare(right.ids[0] ?? "") ?? 0;
  });
  return items;
}

function mergeGroup(group: OwnerHomeAlert[], morning: string, now: string): OwnerHomeItem {
  const ordered = [...group].sort((left, right) => {
    const severity = rank(right.severity) - rank(left.severity);
    if (severity !== 0) return severity;
    return right.impactPaise - left.impactPaise;
  });
  const top = ordered[0];
  if (!top) {
    return {
      ids: [],
      severity: "watch",
      outletId: null,
      outletName: null,
      platform: "combined",
      text: "",
      fix: "",
      consecutiveDays: 0,
      impactPaise: 0,
      fresh: false,
      canSnooze: false,
    };
  }
  const act = ordered.some((alert) => alert.severity === "act_now");
  return {
    ids: ordered.map((alert) => alert.id),
    severity: act ? "act_now" : "watch",
    outletId: top.outletId,
    outletName: top.outletName,
    platform: top.platform,
    text: top.text,
    fix: top.fix,
    consecutiveDays: Math.max(...ordered.map((alert) => alert.consecutiveDays)),
    impactPaise: ordered.reduce((sum, alert) => sum + alert.impactPaise, 0),
    fresh:
      act &&
      ordered.some(
        (alert) =>
          alert.notifiedAt != null && alert.notifiedAt >= morning && alert.notifiedAt <= now,
      ),
    canSnooze: !act,
  };
}

function rank(severity: OpsAlertSeverity): number {
  return severity === "act_now" ? 2 : 1;
}

function outletSales(item: OwnerHomeItem, alerts: readonly OwnerHomeAlert[]): number {
  return alerts.find((alert) => alert.id === item.ids[0])?.outletSalesPaise ?? 0;
}

export function groupedHomeRows(items: readonly OwnerHomeItem[]): Array<{
  outletId: string | null;
  outletName: string;
  items: OwnerHomeItem[];
}> {
  const groups: Array<{ outletId: string | null; outletName: string; items: OwnerHomeItem[] }> = [];
  for (const item of items) {
    const found = groups.find((group) => group.outletId === item.outletId);
    if (found) found.items.push(item);
    else
      groups.push({
        outletId: item.outletId,
        outletName: item.outletName ?? "Outlet",
        items: [item],
      });
  }
  for (const group of groups) {
    group.items.sort((left, right) => rank(right.severity) - rank(left.severity));
  }
  groups.sort(
    (left, right) =>
      rank(right.items[0]?.severity ?? "watch") - rank(left.items[0]?.severity ?? "watch"),
  );
  return groups;
}
