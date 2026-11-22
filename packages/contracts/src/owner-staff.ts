import * as z from "zod";
import { addIsoDays } from "./metric-dates.js";
import { formatCivilDay } from "./ops/format.js";
import type { OwnerPlot } from "./owner-dashboard.js";
import { ownerDateAxis, ownerRupeeAxis } from "./owner-dashboard.js";

/** Questions one owner may ask in one Asia/Kolkata civil day. */
export const STAFF_QUESTION_LIMIT = 30;

/** The counter stays hidden until this many questions remain. */
export const STAFF_COUNTER_AT = 5;

export interface StaffMetricBlock {
  kind: "metric";
  label: string;
  paise: number | null;
  changePct: number | null;
  compare: string | null;
  pending: string | null;
}

export interface StaffChoiceBlock {
  kind: "choice";
  actionId: string;
  question: string;
  detail: string;
  maxCostPaise: number;
  answerId: "approve" | "change" | "not_now" | null;
}

export interface StaffChartBlock {
  kind: "chart";
  plot: OwnerPlot;
}

export interface StaffTextBlock {
  kind: "text";
  text: string;
  heading?: boolean;
}

export type StaffBlock = StaffTextBlock | StaffMetricBlock | StaffChartBlock | StaffChoiceBlock;

export interface StaffMessage {
  id: string;
  role: "owner" | "staff" | "brief";
  date: string;
  blocks: StaffBlock[];
  counted: boolean;
  failed: boolean;
}

export interface StaffQuota {
  asked: number;
  remaining: number;
  showCounter: boolean;
  inputDisabled: boolean;
}

export interface StaffThread {
  greeting: string | null;
  starters: string[];
  messages: StaffMessage[];
  quota: StaffQuota;
}

export interface StaffSuggestion {
  id: string;
  title: string;
  detail: string;
  maxCostPaise: number;
  platform: "zomato" | "swiggy";
}

export interface StaffAnswerInput {
  question: string;
  failed?: boolean;
  failuresInARow: number;
  pendingPlatform: "zomato" | "swiggy" | null;
  salesPaise: number | null;
  changePct: number | null;
  compare: string | null;
  /** Days actually compared, such as "Mon–Sun", when the question is about a week. */
  period?: string | null;
  points: ReadonlyArray<{ week: string; sales: number }>;
  suggestion: StaffSuggestion | null;
  suppressedUntil: string | null;
}

export interface StaffAnswer {
  blocks: StaffBlock[];
  counted: boolean;
  failed: boolean;
  /** True when the reply includes a choice that should be stored as suggested. */
  suggest: boolean;
}

export type MarketingKind = "discount" | "photo" | "combo";
export type MarketingDecision = "suggested" | "approved" | "declined";
export type MarketingDisplay =
  | "waiting"
  | "live"
  | "not_seen"
  | "too_early"
  | "festival"
  | "result";

export interface MarketingActionRecord {
  id: string;
  title: string;
  detail: string;
  platform: "zomato" | "swiggy" | "both";
  kind: MarketingKind;
  decision: MarketingDecision;
  maxCostPaise: number | null;
  approvedOn: string | null;
  createdOn: string;
  declinedUntil: string | null;
  confirmed: boolean;
}

export interface MarketingReading {
  date: string;
  discountPaise: number | null;
  salesPaise: number | null;
}

export interface MarketingRow {
  id: string;
  title: string;
  detail: string;
  display: MarketingDisplay;
  maxCostPaise: number | null;
  resultPaise: number | null;
}

export interface MarketingScreen {
  hero: "empty" | "waiting" | "result" | "open";
  /** True when the readings already cover a week, so the empty state is not a wait for data. */
  history: boolean;
  resultTitle: string | null;
  resultPaise: number | null;
  waiting: MarketingRow[];
  overflow: MarketingRow[];
  rows: MarketingRow[];
}

const STARTERS = [
  "What needs me today?",
  "Why did sales move?",
  "Should I run an offer?",
  "How is the payout?",
] as const;

const SCOPE =
  /\b(sales|order|payout|offer|discount|ads?|zomato|swiggy|menu|rating|yesterday|week|today|offline|delay|ready|need|outlet|kitchen)\b/i;
const DISH = /\b(dish|paneer|item|plate)\b/i;
const OFFER = /\b(offer|discount|ads?|what should i do)\b/i;

export const StaffQuestionSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

export const StaffChoiceSchema = z.object({
  actionId: z.string().trim().min(1).max(80),
  choice: z.enum(["approve", "change", "not_now"]),
});

export const MarketingConfirmSchema = z.object({
  done: z.boolean(),
});

/** Split a stored brief into chat blocks. Asterisks are headings, not visible marks. */
export function briefBlocks(text: string): StaffTextBlock[] {
  const dated = text.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (iso) => formatCivilDay(iso));
  const blocks: StaffTextBlock[] = [];
  for (const line of dated.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^\*+([^*]+)\*+$/) ?? trimmed.match(/^#{1,3}\s+(.+)$/);
    if (heading?.[1]) {
      blocks.push({ kind: "text", text: heading[1].trim(), heading: true });
      continue;
    }
    blocks.push({ kind: "text", text: trimmed.replace(/\*([^*]+)\*/g, "$1") });
  }
  return blocks.length > 0 ? blocks : [{ kind: "text", text: dated.trim() }];
}

export function staffQuota(asked: number): StaffQuota {
  const used = Math.max(0, asked);
  const remaining = Math.max(0, STAFF_QUESTION_LIMIT - used);
  return {
    asked: used,
    remaining,
    showCounter: remaining > 0 && remaining <= STAFF_COUNTER_AT,
    inputDisabled: remaining === 0,
  };
}

export function composeStaffThread(input: {
  restaurantName: string;
  hasHistory: boolean;
  brief: { date: string; text: string } | null;
  messages: readonly StaffMessage[];
  askedToday: number;
}): StaffThread {
  const quota = staffQuota(input.askedToday);
  const briefMessage: StaffMessage | null = input.brief
    ? {
        id: `brief-${input.brief.date}`,
        role: "brief",
        date: input.brief.date,
        blocks: briefBlocks(input.brief.text),
        counted: false,
        failed: false,
      }
    : null;
  const messages = collapseSameDay(
    briefMessage ? [briefMessage, ...input.messages] : [...input.messages],
  );
  const first = messages.length === 0;
  return {
    greeting:
      first && !input.hasHistory
        ? `Hi, I'm your chief of staff. I've read your Zomato and Swiggy numbers, ${input.restaurantName}.`
        : null,
    starters: quota.inputDisabled ? [] : [...STARTERS],
    messages,
    quota,
  };
}

/** One answer per question on a day. A later identical ask is the same reply. */
function collapseSameDay(messages: readonly StaffMessage[]): StaffMessage[] {
  const seen = new Set<string>();
  const kept: StaffMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "owner") {
      kept.push(message);
      continue;
    }
    const text = message.blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n")
      .trim()
      .toLowerCase();
    const next = messages[index + 1];
    const paired = Boolean(next && next.role === "staff" && next.date === message.date);
    const key = `${message.date}\n${text}`;
    if (text && !message.failed && seen.has(key)) {
      if (paired) index += 1;
      continue;
    }
    if (text && !message.failed) seen.add(key);
    kept.push(message);
  }
  return kept;
}

export function answerStaffQuestion(input: StaffAnswerInput): StaffAnswer {
  if (input.failed) {
    const again = input.failuresInARow >= 1;
    return {
      counted: false,
      failed: true,
      suggest: false,
      blocks: [
        {
          kind: "text",
          text: again ? "We're looking into it." : "That took too long. Try again.",
        },
      ],
    };
  }
  if (DISH.test(input.question)) {
    return {
      counted: true,
      failed: false,
      suggest: false,
      blocks: [
        {
          kind: "text",
          text: "I don't have dish-level sales yet, so I can't tell which dish dropped. I can tell you orders and sales by day.",
        },
      ],
    };
  }
  if (!SCOPE.test(input.question)) {
    return {
      counted: true,
      failed: false,
      suggest: false,
      blocks: [
        {
          kind: "text",
          text: "I can only help with your restaurant's Zomato and Swiggy business.",
        },
      ],
    };
  }
  if (input.pendingPlatform && /\b(yesterday|today|sales|pending)\b/i.test(input.question)) {
    const name = input.pendingPlatform === "swiggy" ? "Swiggy" : "Zomato";
    return {
      counted: true,
      failed: false,
      suggest: false,
      blocks: [
        {
          kind: "text",
          text: `${name} is still pending. This answer uses the other app only.`,
        },
        metric(input),
      ],
    };
  }
  if (OFFER.test(input.question)) {
    if (input.suppressedUntil) {
      return {
        counted: true,
        failed: false,
        suggest: false,
        blocks: [
          {
            kind: "text",
            text: `Okay, I won't suggest this again until ${input.suppressedUntil}.`,
          },
        ],
      };
    }
    if (input.suggestion) {
      return {
        counted: true,
        failed: false,
        suggest: true,
        blocks: [
          {
            kind: "text",
            text: "The most this offer can cost is below. I'll compare orders after 2 weeks. You switch it on in the app.",
          },
          {
            kind: "choice",
            actionId: input.suggestion.id,
            question: input.suggestion.title,
            detail: input.suggestion.detail,
            maxCostPaise: input.suggestion.maxCostPaise,
            answerId: null,
          },
        ],
      };
    }
  }
  const blocks: StaffBlock[] = [
    {
      kind: "text",
      text:
        input.salesPaise == null
          ? "Your first numbers arrive after tonight's download."
          : /\bweek\b/i.test(input.question) && input.period
            ? `Last week (${input.period}) vs the same days last week.`
            : "Here is the latest week I can measure.",
    },
    metric(input),
  ];
  if (input.points.length >= 2) {
    blocks.push({
      kind: "chart",
      plot: {
        id: "staff-sales",
        width: 640,
        height: 160,
        x: ownerDateAxis(input.points.map((point) => point.week)),
        y: ownerRupeeAxis(input.points.map((point) => point.sales)),
        marks: [
          {
            type: "lineY",
            data: input.points.map((point) => ({
              at: point.week,
              sales: point.sales,
            })),
            options: { x: "at", y: "sales", stroke: "var(--owner-zomato)" },
          },
        ],
      },
    });
  }
  return { blocks, counted: true, failed: false, suggest: false };
}

function metric(input: StaffAnswerInput): StaffMetricBlock {
  return {
    kind: "metric",
    label: "Net sales",
    paise: input.salesPaise,
    changePct: input.changePct,
    compare: input.compare,
    pending: input.pendingPlatform,
  };
}

export function choiceReply(choice: "approve" | "change" | "not_now"): string {
  if (choice === "approve") return "Approved · saved to Marketing actions";
  if (choice === "not_now") return "Okay, I won't suggest this again this week";
  return "Tell me what to change and I'll redraft it.";
}

export function presentMarketing(input: {
  today: string;
  holidays: readonly string[];
  actions: readonly MarketingActionRecord[];
  readings: readonly MarketingReading[];
}): MarketingScreen {
  const history = salesHistory(input.readings);
  const visible = input.actions.filter((action) => action.decision !== "declined");
  if (visible.length === 0) {
    return {
      hero: "empty",
      history,
      resultTitle: null,
      resultPaise: null,
      waiting: [],
      overflow: [],
      rows: [],
    };
  }
  const judged = visible.map((action) => judge(action, input));
  const waiting = judged
    .filter((row) => row.display === "waiting")
    .sort((left, right) => (right.maxCostPaise ?? 0) - (left.maxCostPaise ?? 0));
  const latest =
    [...input.actions]
      .filter((action) => action.approvedOn)
      .sort((left, right) => (right.approvedOn ?? "").localeCompare(left.approvedOn ?? ""))
      .map((action) => judged.find((row) => row.id === action.id && row.display === "result"))
      .find((row) => row != null) ?? null;
  const rest = judged.filter(
    (row) => row.display !== "waiting" && !(waiting.length === 0 && row.id === latest?.id),
  );
  return {
    hero: waiting.length > 0 ? "waiting" : latest ? "result" : "open",
    history,
    resultTitle: latest?.title ?? null,
    resultPaise: latest?.resultPaise ?? null,
    waiting: waiting.slice(0, 3),
    overflow: waiting.slice(3),
    rows: rest,
  };
}

function salesHistory(readings: readonly MarketingReading[]): boolean {
  const dates = [
    ...new Set(
      readings.filter((reading) => reading.salesPaise != null).map((reading) => reading.date),
    ),
  ].sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (!first || !last) return false;
  return last >= addIsoDays(first, 6);
}

function judge(
  action: MarketingActionRecord,
  input: { today: string; holidays: readonly string[]; readings: readonly MarketingReading[] },
): MarketingRow {
  if (action.decision === "suggested" || !action.approvedOn) {
    return row(action, "waiting", null);
  }
  const afterEnd = addIsoDays(action.approvedOn, 14);
  const elapsed = input.readings.filter(
    (reading) => reading.date >= action.approvedOn! && reading.date < input.today,
  );
  const window = datesFrom(action.approvedOn, 14);
  const festival = window.some((date) => input.holidays.includes(date) && date <= input.today);
  if (festival) return row(action, "festival", null);
  const seen =
    action.confirmed ||
    (action.kind === "discount" &&
      elapsed.some((reading) => reading.discountPaise != null && reading.discountPaise > 0));
  const age = daysBetween(action.approvedOn, input.today);
  if (action.kind === "discount" && !seen && age >= 7) return row(action, "not_seen", null);
  if (afterEnd > input.today) return row(action, seen ? "live" : "too_early", null);
  const before = sumSales(input.readings, addIsoDays(action.approvedOn, -14), action.approvedOn);
  const after = sumSales(input.readings, action.approvedOn, afterEnd);
  if (before == null || after == null) return row(action, "too_early", null);
  return row(action, "result", after - before);
}

function row(
  action: MarketingActionRecord,
  display: MarketingDisplay,
  resultPaise: number | null,
): MarketingRow {
  return {
    id: action.id,
    title: action.title,
    detail: action.detail,
    display,
    maxCostPaise: action.maxCostPaise,
    resultPaise,
  };
}

function datesFrom(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addIsoDays(start, index));
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function sumSales(readings: readonly MarketingReading[], from: string, to: string): number | null {
  const byDate = new Map(readings.map((reading) => [reading.date, reading.salesPaise]));
  const dates = datesFrom(from, daysBetween(from, to));
  if (dates.length === 0) return null;
  let total = 0;
  for (const date of dates) {
    const sales = byDate.get(date);
    if (sales == null) return null;
    total += sales;
  }
  return total;
}
