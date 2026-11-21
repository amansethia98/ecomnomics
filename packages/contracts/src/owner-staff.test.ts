import { expect, it } from "vitest";
import { resolveOwnerPlot } from "./owner-dashboard.js";
import type { MarketingActionRecord, MarketingReading } from "./owner-staff.js";
import {
  answerStaffQuestion,
  choiceReply,
  composeStaffThread,
  presentMarketing,
  staffQuota,
} from "./owner-staff.js";

const suggestion = {
  id: "offer-1",
  title: "Lunch offer at HSR",
  detail: "A discount capped at the recent order count.",
  maxCostPaise: 1600000,
  platform: "swiggy" as const,
};

it("hides the question counter until five are left, then blocks the input", () => {
  expect(staffQuota(24)).toMatchObject({ remaining: 6, showCounter: false, inputDisabled: false });
  expect(staffQuota(25)).toMatchObject({ remaining: 5, showCounter: true, inputDisabled: false });
  expect(staffQuota(30)).toMatchObject({ remaining: 0, showCounter: false, inputDisabled: true });
});

it("greets a new restaurant and keeps the brief as the first message", () => {
  const fresh = composeStaffThread({
    restaurantName: "Kesar Kitchen",
    hasHistory: false,
    brief: null,
    messages: [],
    askedToday: 0,
  });
  expect(fresh.greeting).toMatch(/chief of staff/);
  expect(fresh.starters).toHaveLength(4);
  expect(fresh.messages).toEqual([]);

  const daily = composeStaffThread({
    restaurantName: "Kesar Kitchen",
    hasHistory: true,
    brief: { date: "2026-11-15", text: "Zomato healthy. Swiggy pending." },
    messages: [],
    askedToday: 30,
  });
  expect(daily.greeting).toBeNull();
  expect(daily.messages[0]).toMatchObject({ role: "brief", date: "2026-11-15" });
  const written = composeStaffThread({
    restaurantName: "Kesar Kitchen",
    hasHistory: true,
    brief: {
      date: "2026-11-15",
      text: "*Good morning · Kesar Kitchen*\n2026-11-15 vs 2026-11-08 · Healthy\nNet sales are in.",
    },
    messages: [],
    askedToday: 0,
  });
  expect(written.messages[0]?.blocks[0]).toMatchObject({
    heading: true,
    text: "Good morning · Kesar Kitchen",
  });
  expect(written.messages[0]?.blocks[1]).toMatchObject({
    kind: "text",
    text: "Sun 15 Nov vs Sun 8 Nov · Healthy",
  });
  expect(
    written.messages[0]?.blocks.some((block) => block.kind === "text" && block.text.includes("*")),
  ).toBe(false);
  expect(daily.starters).toEqual([]);
  expect(daily.quota.inputDisabled).toBe(true);
});

it("answers from the numbers it was given and does not count a failed try", () => {
  const dish = answerStaffQuestion(base("Which paneer dropped?"));
  expect(dish.blocks[0]).toMatchObject({ kind: "text" });
  expect(dish.blocks[0]?.kind === "text" && dish.blocks[0].text).toMatch(/dish-level sales/);
  expect(dish.counted).toBe(true);

  const scope = answerStaffQuestion(base("Who won the cricket?"));
  expect(scope.blocks[0]?.kind === "text" && scope.blocks[0].text).toMatch(/Zomato and Swiggy/);

  const pending = answerStaffQuestion({
    ...base("How were yesterday's sales?"),
    pendingPlatform: "swiggy",
  });
  expect(pending.blocks.map((block) => block.kind)).toEqual(["text", "metric"]);
  expect(pending.blocks[0]?.kind === "text" && pending.blocks[0].text).toMatch(/other app only/);

  const sales = answerStaffQuestion(base("Why did sales move?"));
  expect(sales.blocks.map((block) => block.kind)).toEqual(["text", "metric", "chart"]);
  const chart = sales.blocks[2];
  expect(chart?.kind === "chart" && chart.plot.marks[0]?.type).toBe("lineY");
  if (chart?.kind === "chart") {
    const row = chart.plot.marks[0]?.data?.[0] as { at?: unknown; sales?: number } | undefined;
    expect(row?.at).toBe("2026-11-02");
    expect(chart.plot.x?.format).toBe("date");
    expect(chart.plot.y?.format).toBe("inr");
    expect(JSON.stringify(chart.plot)).not.toContain("tickFormat");
    const tick = resolveOwnerPlot(chart.plot).y?.tickFormat as (value: number) => string;
    expect(tick(120)).toBe("₹1");
  }
  const lastWeek = answerStaffQuestion({
    ...base("How were sales last week?"),
    salesPaise: 500_000,
    changePct: 4,
    compare: "vs the same days last week",
    period: "Mon–Sun",
  });
  expect(lastWeek.blocks[0]?.kind === "text" && lastWeek.blocks[0].text).toBe(
    "Last week (Mon–Sun) vs the same days last week.",
  );

  const failed = answerStaffQuestion({
    ...base("Why did sales move?"),
    failed: true,
    failuresInARow: 0,
  });
  expect(failed.counted).toBe(false);
  expect(failed.blocks[0]?.kind === "text" && failed.blocks[0].text).toMatch(/Try again/);
  const looking = answerStaffQuestion({
    ...base("Why did sales move?"),
    failed: true,
    failuresInARow: 1,
  });
  expect(looking.blocks[0]?.kind === "text" && looking.blocks[0].text).toMatch(/looking into it/);
});

it("formats a chart that was stored before format keys existed", () => {
  const legacy = {
    id: "staff-sales",
    width: 640,
    height: 160,
    x: {
      label: null,
      type: "utc",
      domain: ["2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z"],
      ticks: ["2026-11-02T00:00:00.000Z"],
      clamp: true,
      padding: 0,
    },
    y: { label: null, grid: true, domain: [100, 500_000] },
    marks: [
      {
        type: "lineY" as const,
        data: [{ at: "2026-11-02", sales: 120 }],
        options: { x: "at", y: "sales" },
      },
    ],
  };
  const resolved = resolveOwnerPlot(legacy);
  const yTick = resolved.y?.tickFormat as (value: number) => string;
  const xTick = resolved.x?.tickFormat as (value: Date) => string;
  expect(yTick(500_000)).toBe("₹5k");
  expect(yTick(500_000)).not.toBe("00,000");
  expect(xTick(new Date("2026-11-02T00:00:00.000Z"))).toBe("2 Nov");
});

it("offers an action once, and records the owner's choice in words", () => {
  const offer = answerStaffQuestion(base("Should I run an offer?"));
  expect(offer.suggest).toBe(true);
  expect(offer.blocks[1]).toMatchObject({ kind: "choice", actionId: "offer-1", answerId: null });

  const quiet = answerStaffQuestion({
    ...base("Should I run an offer?"),
    suggestion: null,
    suppressedUntil: "2026-11-22",
  });
  expect(quiet.suggest).toBe(false);
  expect(quiet.blocks[0]?.kind === "text" && quiet.blocks[0].text).toMatch(/2026-11-22/);

  expect(choiceReply("approve")).toBe("Approved · saved to Marketing actions");
  expect(choiceReply("not_now")).toMatch(/won't suggest this again this week/);
  expect(choiceReply("change")).toMatch(/what to change/);
});

it("lists waiting offers, and refuses a result that is early or on a festival", () => {
  const waiting = Array.from({ length: 5 }, (_, index) =>
    action(`w${index}`, "suggested", null, (5 - index) * 100),
  );
  const listed = presentMarketing({
    today: "2026-11-16",
    holidays: [],
    actions: waiting,
    readings: [],
  });
  expect(listed.hero).toBe("waiting");
  expect(listed.waiting).toHaveLength(3);
  expect(listed.waiting[0]?.maxCostPaise).toBe(500);
  expect(listed.overflow).toHaveLength(2);

  expect(
    presentMarketing({ today: "2026-11-16", holidays: [], actions: [], readings: [] }).history,
  ).toBe(false);
  expect(
    presentMarketing({
      today: "2026-11-16",
      holidays: [],
      actions: [],
      readings: days("2026-08-01", 90, 0, 100),
    }).history,
  ).toBe(true);

  const early = presentMarketing({
    today: "2026-10-04",
    holidays: [],
    actions: [action("a", "approved", "2026-10-01", 1000)],
    readings: days("2026-10-01", 3, 0, 100),
  });
  expect(early.rows[0]?.display).toBe("too_early");

  const unseen = presentMarketing({
    today: "2026-10-10",
    holidays: [],
    actions: [action("a", "approved", "2026-10-01", 1000)],
    readings: days("2026-10-01", 9, 0, 100),
  });
  expect(unseen.rows[0]?.display).toBe("not_seen");

  const live = presentMarketing({
    today: "2026-10-04",
    holidays: [],
    actions: [action("a", "approved", "2026-10-01", 1000)],
    readings: days("2026-10-01", 3, 500, 100),
  });
  expect(live.rows[0]?.display).toBe("live");

  const festival = presentMarketing({
    today: "2026-10-20",
    holidays: ["2026-10-05"],
    actions: [action("a", "approved", "2026-10-01", 1000)],
    readings: days("2026-09-17", 28, 500, 100),
  });
  expect(festival.rows[0]?.display).toBe("festival");
  expect(festival.rows[0]?.resultPaise).toBeNull();

  const before = days("2026-09-17", 14, 0, 100);
  const after = days("2026-10-01", 14, 200, 180);
  const result = presentMarketing({
    today: "2026-10-20",
    holidays: [],
    actions: [action("a", "approved", "2026-10-01", 1000)],
    readings: [...before, ...after],
  });
  expect(result.hero).toBe("result");
  expect(result.resultPaise).toBe(14 * 80);

  const gapped = before.filter((reading) => reading.date !== "2026-09-20");
  const incomplete = presentMarketing({
    today: "2026-10-20",
    holidays: [],
    actions: [action("a", "approved", "2026-10-01", 1000)],
    readings: [...gapped, ...after],
  });
  expect(incomplete.hero).not.toBe("result");
  expect(incomplete.rows[0]?.display).toBe("too_early");
  expect(incomplete.resultPaise).toBeNull();
});

function base(question: string) {
  return {
    question,
    failuresInARow: 0,
    pendingPlatform: null,
    salesPaise: 11248000,
    changePct: -6,
    compare: "last Sunday",
    points: [
      { week: "2026-11-02", sales: 100 },
      { week: "2026-11-09", sales: 120 },
    ],
    suggestion,
    suppressedUntil: null,
  };
}

function action(
  id: string,
  decision: MarketingActionRecord["decision"],
  approvedOn: string | null,
  maxCostPaise: number,
): MarketingActionRecord {
  return {
    id,
    title: "Lunch offer",
    detail: "Discount cap",
    platform: "swiggy",
    kind: "discount",
    decision,
    maxCostPaise,
    approvedOn,
    createdOn: approvedOn ?? "2026-11-01",
    declinedUntil: null,
    confirmed: false,
  };
}

function days(
  start: string,
  count: number,
  discountPaise: number,
  salesPaise: number,
): MarketingReading[] {
  const [year, month, day] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + index));
    return {
      date: date.toISOString().slice(0, 10),
      discountPaise,
      salesPaise,
    };
  });
}
