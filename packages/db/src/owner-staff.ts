import { randomUUID } from "node:crypto";
import type {
  MarketingActionRecord,
  MarketingReading,
  StaffBlock,
  StaffMessage,
  StaffThread,
} from "@rakazo/contracts";
import {
  addIsoDays,
  answerStaffQuestion,
  choiceReply,
  composeStaffThread,
  DEFAULT_OPS_RULES_CONFIG,
  indiaCivilDate,
  presentMarketing,
  replaceWeekLine,
  STAFF_QUESTION_LIMIT,
  utcMidnight,
  weekMonday,
  weekSales,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";

type StaffStore = {
  ownerStaffTurn: PrismaClient["ownerStaffTurn"];
  marketingAction: PrismaClient["marketingAction"];
  metricValue: PrismaClient["metricValue"];
  outlet: PrismaClient["outlet"];
  report: PrismaClient["report"];
};

import { RestaurantAgentError } from "./restaurant-agent.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const CAP_PAISE_PER_ORDER = 4_000;

export async function readStaffForMember(db: PrismaClient, userId: string, restaurantId: string) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const today = indiaCivilDate(new Date());
    return loadThread(db, restaurant, userId, today);
  });
}

export async function askStaffForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  text: string,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const today = indiaCivilDate(new Date());
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-quota:${restaurant.restaurantId}:${userId}:${today}`}, 0))::text AS "lock"`;
      return recordQuestion(tx, restaurant, userId, today, text);
    });
  });
}

async function recordQuestion(
  db: StaffStore,
  restaurant: { restaurantId: string; spaceId: string; name: string },
  userId: string,
  today: string,
  text: string,
) {
  const asked = await askedToday(db, restaurant.restaurantId, restaurant.spaceId, userId, today);
  if (asked >= STAFF_QUESTION_LIMIT) {
    throw new RestaurantAgentError(
      "question_limit",
      429,
      "You've used today's 30 questions. Resets at midnight.",
    );
  }
  const context = await staffContext(db, restaurant, today);
  let failed = false;
  const weekQuestion = /\bweek\b/i.test(text);
  let answer = answerStaffQuestion({
    question: text,
    failuresInARow: context.failuresInARow,
    pendingPlatform: context.pendingPlatform,
    salesPaise: weekQuestion ? context.weekPaise : context.salesPaise,
    changePct: weekQuestion ? context.weekChange : context.changePct,
    compare: weekQuestion ? "vs the same days last week" : "the same weekday",
    period: weekQuestion ? context.weekPeriod : null,
    points: context.points,
    suggestion: context.suggestion,
    suppressedUntil: context.suppressedUntil,
  });
  if (context.readingsFailed) {
    failed = true;
    answer = answerStaffQuestion({
      question: text,
      failed: true,
      failuresInARow: context.failuresInARow,
      pendingPlatform: null,
      salesPaise: null,
      changePct: null,
      compare: null,
      period: null,
      points: [],
      suggestion: null,
      suppressedUntil: null,
    });
  }
  const day = utcMidnight(today);
  await db.ownerStaffTurn.create({
    data: {
      restaurantId: restaurant.restaurantId,
      spaceId: restaurant.spaceId,
      userId,
      businessDate: day,
      role: "owner",
      body: { text },
      counted: answer.counted,
      failed,
    },
  });
  await db.ownerStaffTurn.create({
    data: {
      restaurantId: restaurant.restaurantId,
      spaceId: restaurant.spaceId,
      userId,
      businessDate: day,
      role: "staff",
      body: { blocks: answer.blocks } as unknown as Prisma.InputJsonValue,
      counted: false,
      failed: answer.failed,
    },
  });
  if (answer.suggest && context.suggestion && context.createSuggestion) {
    await db.marketingAction.create({
      data: {
        id: context.suggestion.id,
        restaurantId: restaurant.restaurantId,
        spaceId: restaurant.spaceId,
        platform: context.suggestion.platform,
        kind: "discount",
        title: context.suggestion.title,
        detail: context.suggestion.detail,
        maxCostPaise: context.suggestion.maxCostPaise,
        decision: "suggested",
      },
    });
  }
  return loadThread(db, restaurant, userId, today);
}

export async function chooseStaffForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  actionId: string,
  choice: "approve" | "change" | "not_now",
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const today = indiaCivilDate(new Date());
    const action = await db.marketingAction.findFirst({
      where: { id: actionId, restaurantId, spaceId: restaurant.spaceId },
    });
    if (!action)
      throw new RestaurantAgentError("not_found", 404, "That action is not in this restaurant.");
    if (action.decision === "suggested") {
      if (choice === "approve") {
        await db.marketingAction.update({
          where: { id: action.id },
          data: { decision: "approved", approvedAt: new Date() },
        });
      } else if (choice === "not_now") {
        await db.marketingAction.update({
          where: { id: action.id },
          data: { decision: "declined", declinedUntil: utcMidnight(addIsoDays(today, 7)) },
        });
      }
    }
    if (choice !== "change") await stampChoice(db, restaurant, actionId, choice);
    if (choice !== "approve") {
      await db.ownerStaffTurn.create({
        data: {
          restaurantId,
          spaceId: restaurant.spaceId,
          userId,
          businessDate: utcMidnight(today),
          role: "staff",
          body: { blocks: [{ kind: "text", text: choiceReply(choice) }] },
          counted: false,
          failed: false,
        },
      });
    }
    return loadThread(db, restaurant, userId, today);
  });
}

export async function readMarketingForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const today = indiaCivilDate(new Date());
    const actions = await db.marketingAction.findMany({
      where: { restaurantId, spaceId: restaurant.spaceId },
      orderBy: { createdAt: "desc" },
    });
    const readings = await dayReadings(db, restaurant, today, readingsSince(actions, today));
    return presentMarketing({
      today,
      holidays: DEFAULT_OPS_RULES_CONFIG.holidayDates,
      actions: actions.map(toRecord),
      readings,
    });
  });
}

export async function confirmMarketingForMember(
  db: PrismaClient,
  userId: string,
  restaurantId: string,
  actionId: string,
  done: boolean,
) {
  const restaurant = await memberRestaurant(db, userId, restaurantId);
  return runAsTenant({ spaceId: restaurant.spaceId, userId }, async () => {
    const action = await db.marketingAction.findFirst({
      where: { id: actionId, restaurantId, spaceId: restaurant.spaceId },
    });
    if (!action)
      throw new RestaurantAgentError("not_found", 404, "That action is not in this restaurant.");
    if (done && action.decision === "approved") {
      await db.marketingAction.update({
        where: { id: action.id },
        data: { confirmedAt: new Date() },
      });
    }
    const today = indiaCivilDate(new Date());
    const actions = await db.marketingAction.findMany({
      where: { restaurantId, spaceId: restaurant.spaceId },
      orderBy: { createdAt: "desc" },
    });
    const readings = await dayReadings(db, restaurant, today, readingsSince(actions, today));
    return presentMarketing({
      today,
      holidays: DEFAULT_OPS_RULES_CONFIG.holidayDates,
      actions: actions.map(toRecord),
      readings,
    });
  });
}

function readingsSince(actions: ReadonlyArray<{ approvedAt: Date | null }>, today: string): string {
  const oldest = actions
    .map((action) => action.approvedAt)
    .filter((date): date is Date => date != null)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return oldest ? addIsoDays(indiaCivilDate(oldest), -14) : addIsoDays(today, -42);
}

async function loadThread(
  db: StaffStore,
  restaurant: { restaurantId: string; spaceId: string; name: string },
  userId: string,
  today: string,
): Promise<StaffThread> {
  const [turns, brief, asked, history, readings] = await Promise.all([
    db.ownerStaffTurn.findMany({
      where: { restaurantId: restaurant.restaurantId, spaceId: restaurant.spaceId },
      orderBy: { createdAt: "asc" },
      take: 200,
    }),
    db.report.findFirst({
      where: {
        restaurantId: restaurant.restaurantId,
        spaceId: restaurant.spaceId,
        kind: "daily_brief",
      },
      orderBy: { businessDate: "desc" },
      select: { businessDate: true, summaryMarkdown: true },
    }),
    askedToday(db, restaurant.restaurantId, restaurant.spaceId, userId, today),
    db.metricValue.findFirst({
      where: {
        restaurantId: restaurant.restaurantId,
        spaceId: restaurant.spaceId,
        supersededAt: null,
      },
      select: { id: true },
    }),
    dayReadings(db, restaurant, today),
  ]);
  const week = weekAnswer(readings, today).week;
  const messages: StaffMessage[] = turns.map((turn) => ({
    id: turn.id,
    role: turn.role === "owner" ? "owner" : "staff",
    date: indiaCivilDate(turn.businessDate),
    blocks:
      turn.role === "owner" ? [{ kind: "text", text: textOf(turn.body) }] : blocksOf(turn.body),
    counted: turn.counted,
    failed: turn.failed,
  }));
  return composeStaffThread({
    restaurantName: restaurant.name,
    hasHistory: history != null || brief != null,
    brief:
      brief?.businessDate && brief.summaryMarkdown
        ? {
            date: indiaCivilDate(brief.businessDate),
            text: replaceWeekLine(brief.summaryMarkdown, week),
          }
        : null,
    messages,
    askedToday: asked,
  });
}

async function staffContext(
  db: StaffStore,
  restaurant: { restaurantId: string; spaceId: string },
  today: string,
) {
  try {
    const readings = await dayReadings(db, restaurant, today);
    const sales = readings.filter((reading) => reading.salesPaise != null);
    const latest = sales.at(-1) ?? null;
    const weekAgo = sales.find((reading) => reading.date === addIsoDays(latest?.date ?? today, -7));
    const orders = readings
      .filter((reading) => reading.date >= addIsoDays(today, -7))
      .reduce((sum, reading) => sum + reading.orders, 0);
    const declined = await db.marketingAction.findFirst({
      where: {
        restaurantId: restaurant.restaurantId,
        spaceId: restaurant.spaceId,
        decision: "declined",
        declinedUntil: { gte: utcMidnight(today) },
      },
      orderBy: { declinedUntil: "desc" },
    });
    const open = await db.marketingAction.findFirst({
      where: {
        restaurantId: restaurant.restaurantId,
        spaceId: restaurant.spaceId,
        decision: "suggested",
      },
      orderBy: { createdAt: "desc" },
    });
    const outlets = await db.outlet.findMany({
      where: { restaurantId: restaurant.restaurantId, spaceId: restaurant.spaceId, active: true },
      select: { swiggyRid: true, zomatoResId: true },
    });
    const platform: "swiggy" | "zomato" = outlets.some((outlet) => outlet.swiggyRid)
      ? "swiggy"
      : "zomato";
    const pending = await db.metricValue.findFirst({
      where: {
        restaurantId: restaurant.restaurantId,
        spaceId: restaurant.spaceId,
        supersededAt: null,
        state: "pending_label",
        periodStart: { gte: utcMidnight(addIsoDays(today, -1)), lt: utcMidnight(today) },
      },
      select: { platform: true },
    });
    return {
      readingsFailed: false,
      failuresInARow: await trailingFailures(db, restaurant),
      pendingPlatform: namedPlatform(pending?.platform),
      salesPaise: latest?.salesPaise ?? null,
      changePct:
        latest?.salesPaise != null && weekAgo?.salesPaise
          ? ((latest.salesPaise - weekAgo.salesPaise) / weekAgo.salesPaise) * 100
          : null,
      ...weekAnswer(readings, today),
      points: weekPoints(readings),
      suggestion: open
        ? {
            id: open.id,
            title: open.title,
            detail: open.detail,
            maxCostPaise: open.maxCostPaise ?? 0,
            platform: namedPlatform(open.platform) ?? platform,
          }
        : orders > 0 && !declined
          ? {
              id: randomUUID(),
              title: "A capped weekday discount",
              detail:
                "The maximum cost is the recent orders times a ₹40 cap. It does not predict extra orders.",
              maxCostPaise: orders * CAP_PAISE_PER_ORDER,
              platform,
            }
          : null,
      createSuggestion: open == null && orders > 0 && !declined,
      suppressedUntil: declined?.declinedUntil ? indiaCivilDate(declined.declinedUntil) : null,
    };
  } catch {
    return {
      readingsFailed: true,
      failuresInARow: await trailingFailures(db, restaurant),
      pendingPlatform: null,
      salesPaise: null,
      changePct: null,
      weekPaise: null,
      weekChange: null,
      weekPeriod: null,
      week: null,
      points: [] as Array<{ week: string; sales: number }>,
      suggestion: null,
      createSuggestion: false,
      suppressedUntil: null,
    };
  }
}

async function dayReadings(
  db: StaffStore,
  restaurant: { restaurantId: string; spaceId: string },
  today: string,
  since?: string,
): Promise<
  Array<
    MarketingReading & {
      orders: number;
      apps: Array<{ platform: "zomato" | "swiggy"; salesPaise: number }>;
    }
  >
> {
  const outlets = await db.outlet.findMany({
    where: { restaurantId: restaurant.restaurantId, spaceId: restaurant.spaceId, active: true },
    select: { swiggyRid: true, zomatoResId: true },
  });
  const wantZomato = outlets.some((outlet) => outlet.zomatoResId);
  const wantSwiggy = outlets.some((outlet) => outlet.swiggyRid);
  const rows = await db.metricValue.findMany({
    where: {
      restaurantId: restaurant.restaurantId,
      spaceId: restaurant.spaceId,
      supersededAt: null,
      rowRole: "fact",
      granularity: "day",
      state: "ok",
      key: {
        in: ["ops_sales_paise", "swiggy_net_sales_paise", "delivered_orders", "discount_paise"],
      },
      periodStart: { gte: utcMidnight(since ?? addIsoDays(today, -42)) },
    },
    select: { key: true, periodStart: true, value: true },
  });
  const byDate = new Map<
    string,
    MarketingReading & { orders: number; zomato: number | null; swiggy: number | null }
  >();
  for (const row of rows) {
    const date = indiaCivilDate(row.periodStart);
    const current = byDate.get(date) ?? {
      date,
      discountPaise: null,
      salesPaise: null,
      orders: 0,
      zomato: null,
      swiggy: null,
    };
    const value = row.value == null ? null : Number(row.value);
    if (row.key === "discount_paise" && value != null) {
      current.discountPaise = (current.discountPaise ?? 0) + value;
    }
    if (row.key === "ops_sales_paise" && value != null)
      current.zomato = (current.zomato ?? 0) + value;
    if (row.key === "swiggy_net_sales_paise" && value != null) {
      current.swiggy = (current.swiggy ?? 0) + value;
    }
    if (row.key === "delivered_orders" && value != null) current.orders += value;
    byDate.set(date, current);
  }
  const requireZomato = wantZomato || !wantSwiggy;
  const requireSwiggy = wantSwiggy || !wantZomato;
  return [...byDate.values()]
    .map((bucket) => {
      const parts = [
        ...(requireZomato ? [bucket.zomato] : []),
        ...(requireSwiggy ? [bucket.swiggy] : []),
      ];
      const salesPaise = parts.every((part) => part != null)
        ? parts.reduce((sum, part) => sum + (part ?? 0), 0)
        : null;
      const apps = [
        ...(bucket.zomato != null
          ? [{ platform: "zomato" as const, salesPaise: bucket.zomato }]
          : []),
        ...(bucket.swiggy != null
          ? [{ platform: "swiggy" as const, salesPaise: bucket.swiggy }]
          : []),
      ];
      return {
        date: bucket.date,
        discountPaise: bucket.discountPaise,
        salesPaise,
        orders: bucket.orders,
        apps,
      };
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function weekAnswer(
  readings: ReadonlyArray<{
    date: string;
    apps: ReadonlyArray<{ platform: "zomato" | "swiggy"; salesPaise: number }>;
  }>,
  today: string,
) {
  const yesterday = addIsoDays(today, -1);
  const monday = weekMonday(yesterday);
  const sunday = addIsoDays(monday, 6);
  const end = yesterday >= sunday ? sunday : addIsoDays(monday, -1);
  const week = weekSales(
    end,
    readings.flatMap((reading) =>
      reading.apps.map((app) => ({
        date: reading.date,
        platform: app.platform,
        salesPaise: app.salesPaise,
      })),
    ),
  );
  return {
    weekPaise: week?.currentPaise ?? null,
    weekChange: week?.changePct ?? null,
    weekPeriod: week ? `${week.startLabel}–${week.endLabel}` : null,
    week,
  };
}

function weekPoints(
  readings: ReadonlyArray<{ date: string; apps: ReadonlyArray<{ salesPaise: number }> }>,
) {
  const weeks = new Map<string, number>();
  for (const reading of readings) {
    if (reading.apps.length === 0) continue;
    const sales = reading.apps.reduce((sum, app) => sum + app.salesPaise, 0);
    const week = weekMonday(reading.date);
    weeks.set(week, (weeks.get(week) ?? 0) + sales);
  }
  return [...weeks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-8)
    .map(([week, sales]) => ({ week, sales }));
}

async function trailingFailures(
  db: StaffStore,
  restaurant: { restaurantId: string; spaceId: string },
) {
  const recent = await db.ownerStaffTurn.findMany({
    where: { restaurantId: restaurant.restaurantId, spaceId: restaurant.spaceId, role: "staff" },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { failed: true },
  });
  let count = 0;
  for (const turn of recent) {
    if (!turn.failed) break;
    count += 1;
  }
  return count;
}

async function askedToday(
  db: StaffStore,
  restaurantId: string,
  spaceId: string,
  userId: string,
  today: string,
) {
  return db.ownerStaffTurn.count({
    where: {
      restaurantId,
      spaceId,
      userId,
      role: "owner",
      counted: true,
      businessDate: utcMidnight(today),
    },
  });
}

function toRecord(action: {
  id: string;
  title: string;
  detail: string;
  platform: string;
  kind: string;
  decision: string;
  maxCostPaise: number | null;
  approvedAt: Date | null;
  createdAt: Date;
  declinedUntil: Date | null;
  confirmedAt: Date | null;
}): MarketingActionRecord {
  const decision =
    action.decision === "approved" || action.decision === "declined"
      ? action.decision
      : "suggested";
  const kind = action.kind === "photo" || action.kind === "combo" ? action.kind : "discount";
  const platform =
    action.platform === "zomato" || action.platform === "both" ? action.platform : "swiggy";
  return {
    id: action.id,
    title: action.title,
    detail: action.detail,
    platform,
    kind,
    decision,
    maxCostPaise: action.maxCostPaise,
    approvedOn: action.approvedAt ? indiaCivilDate(action.approvedAt) : null,
    createdOn: indiaCivilDate(action.createdAt),
    declinedUntil: action.declinedUntil ? indiaCivilDate(action.declinedUntil) : null,
    confirmed: action.confirmedAt != null,
  };
}

function namedPlatform(value: string | null | undefined): "zomato" | "swiggy" | null {
  return value === "zomato" || value === "swiggy" ? value : null;
}

function textOf(body: Prisma.JsonValue): string {
  if (body && typeof body === "object" && !Array.isArray(body) && typeof body.text === "string") {
    return body.text;
  }
  return "";
}

function blocksOf(body: Prisma.JsonValue): StaffBlock[] {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.blocks))
    return [];
  return body.blocks.flatMap((block) => (isBlock(block) ? [block] : []));
}

function isBlock(value: unknown): value is StaffBlock {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  return kind === "text" || kind === "metric" || kind === "chart" || kind === "choice";
}

async function stampChoice(
  db: StaffStore,
  restaurant: { restaurantId: string; spaceId: string },
  actionId: string,
  choice: "approve" | "not_now",
) {
  const turns = await db.ownerStaffTurn.findMany({
    where: { restaurantId: restaurant.restaurantId, spaceId: restaurant.spaceId, role: "staff" },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  for (const turn of turns) {
    const blocks = blocksOf(turn.body);
    const index = blocks.findIndex(
      (block) => block.kind === "choice" && block.actionId === actionId && block.answerId == null,
    );
    if (index < 0) continue;
    const next = blocks.map((block, position) =>
      position === index && block.kind === "choice" ? { ...block, answerId: choice } : block,
    );
    await db.ownerStaffTurn.update({
      where: { id: turn.id },
      data: { body: { blocks: next } as unknown as Prisma.InputJsonValue },
    });
    return;
  }
}

async function memberRestaurant(db: PrismaClient, userId: string, restaurantId: string) {
  const restaurant = await runAsSystem("owner staff membership", () =>
    db.restaurant.findFirst({
      where: { id: restaurantId, space: { deletingAt: null, memberships: { some: { userId } } } },
      select: { id: true, spaceId: true, name: true },
    }),
  );
  if (!restaurant) throw new RestaurantAgentError("not_found", 404, "Restaurant not found.");
  return { restaurantId: restaurant.id, spaceId: restaurant.spaceId, name: restaurant.name };
}
