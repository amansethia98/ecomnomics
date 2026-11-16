import { expect, it } from "vitest";
import type { OwnerHomeAlert, OwnerHomeInput } from "./owner-home.js";
import { composeOwnerHome, groupedHomeRows } from "./owner-home.js";

function alert(over: Partial<OwnerHomeAlert> & Pick<OwnerHomeAlert, "id">): OwnerHomeAlert {
  return {
    severity: "watch",
    ruleCode: "d_food_ready",
    family: "d_food_ready",
    outletId: "indiranagar",
    outletName: "Indiranagar",
    platform: "swiggy",
    text: "Food-ready marked on time for 78% of orders.",
    fix: "Mark food ready only when the order is packed.",
    consecutiveDays: 1,
    impactPaise: 0,
    outletSalesPaise: 100,
    notifiedAt: null,
    date: "2026-11-14",
    ...over,
  };
}

function input(over: Partial<OwnerHomeInput> = {}): OwnerHomeInput {
  return {
    today: "2026-11-16",
    now: "2026-11-16T06:00:00.000Z",
    restaurantName: "Kesar Kitchen",
    connected: ["zomato", "swiggy"],
    hasHistory: true,
    brief: {
      date: "2026-11-15",
      baselineDate: "2026-11-08",
      statusText: "🟢 Zomato healthy · Swiggy pending",
      corrections: [],
      form: "brief",
      sales: {
        combinedPaise: null,
        zomatoPaise: 11_248_000,
        swiggyPaise: null,
        zomatoBaselinePaise: 12_000_000,
        swiggyBaselinePaise: null,
      },
      delivered: 236,
      deliveredBaseline: 250,
      notes: [],
      exclusion: "excl. Swiggy, not in yet",
      dataAsOf: "05:42",
      connect: false,
    },
    alerts: [],
    questions: [],
    weekdayHistory: null,
    lastComplete: null,
    payoutPaise: null,
    payoutToCheck: 1,
    ...over,
  };
}

it("puts the top alert on the card and folds the rest", () => {
  const home = composeOwnerHome(
    input({
      alerts: [
        alert({
          id: "a",
          severity: "act_now",
          impactPaise: 640_000,
          ruleCode: "d_online",
          family: "d_online",
        }),
        alert({ id: "b", outletId: "hsr", outletName: "HSR", impactPaise: 10 }),
        alert({ id: "c", outletId: "koramangala", outletName: "Koramangala", impactPaise: 20 }),
        alert({ id: "d", outletId: "whitefield", outletName: "Whitefield", impactPaise: 30 }),
        alert({ id: "e", outletId: "jayanagar", outletName: "Jayanagar", impactPaise: 5 }),
      ],
    }),
  );
  expect(home.kind).toBe("alerts");
  expect(home.urgent).toBe(1);
  expect(home.card?.ids).toEqual(["a"]);
  expect(home.card?.canSnooze).toBe(false);
  expect(home.rows.map((row) => row.ids[0])).toEqual(["d", "c", "b"]);
  expect(home.overflow.map((row) => row.ids[0])).toEqual(["e"]);
  expect(home.readiness).toBe("🟢 Zomato healthy · Swiggy pending");
  expect(home.sales.pendingPlatform).toBe("swiggy");
  expect(home.sales.paise).toBe(11_248_000);
});

it("counts a merged hero as one row on the readiness line", () => {
  const home = composeOwnerHome(
    input({
      brief: {
        ...input().brief!,
        statusText: "🔴 Act now (3) · 🟡 Watch (2) · Swiggy pending",
      },
      alerts: [
        alert({
          id: "swiggy-online",
          severity: "act_now",
          ruleCode: "d_online",
          family: "d_online",
          platform: "swiggy",
        }),
        alert({
          id: "swiggy-sales",
          severity: "act_now",
          ruleCode: "d_sales_drop",
          family: "d_sales_drop",
          platform: "swiggy",
        }),
        alert({
          id: "zomato-prep",
          severity: "act_now",
          ruleCode: "d_prep",
          family: "prep",
          platform: "zomato",
          outletId: "hsr",
          outletName: "HSR",
        }),
        alert({ id: "watch-a", outletId: "koramangala", outletName: "Koramangala" }),
        alert({
          id: "watch-b",
          outletId: "jayanagar",
          outletName: "Jayanagar",
          ruleCode: "d_complaints",
          family: "d_complaints",
        }),
      ],
    }),
  );
  expect(home.urgent).toBe(2);
  expect(home.watch).toBe(2);
  expect(home.card?.ids).toEqual(["swiggy-online", "swiggy-sales"]);
  expect(home.readiness).toBe("🔴 Act now (2) · 🟡 Watch (2) · Swiggy pending");
});

it("ranks act now, then rupees, then a longer run, then the busier outlet", () => {
  const home = composeOwnerHome(
    input({
      alerts: [
        alert({
          id: "small",
          severity: "act_now",
          impactPaise: 100,
          consecutiveDays: 1,
          outletSalesPaise: 1,
          ruleCode: "d_prep",
          family: "prep",
        }),
        alert({
          id: "rich",
          severity: "watch",
          impactPaise: 9_000,
          outletId: "hsr",
          outletName: "HSR",
          ruleCode: "d_complaints",
          family: "d_complaints",
        }),
        alert({
          id: "long",
          severity: "watch",
          impactPaise: 500,
          consecutiveDays: 4,
          outletId: "koramangala",
          outletName: "Koramangala",
          outletSalesPaise: 10,
        }),
        alert({
          id: "busy",
          severity: "watch",
          impactPaise: 500,
          consecutiveDays: 4,
          outletId: "indiranagar",
          outletName: "Indiranagar",
          outletSalesPaise: 90,
        }),
      ],
    }),
  );
  expect(home.card?.ids).toEqual(["small"]);
  expect([home.rows[0]?.ids[0], home.rows[1]?.ids[0], home.rows[2]?.ids[0]]).toEqual([
    "rich",
    "busy",
    "long",
  ]);
});

it("merges an offline day and its lost sales into one item", () => {
  const home = composeOwnerHome(
    input({
      alerts: [
        alert({
          id: "off",
          severity: "act_now",
          ruleCode: "d_online",
          family: "d_online",
          impactPaise: 100,
          text: "Indiranagar was offline.",
        }),
        alert({
          id: "lost",
          severity: "watch",
          ruleCode: "d_sales_drop",
          family: "sales",
          impactPaise: 640_000,
          text: "Lost sales.",
        }),
      ],
    }),
  );
  expect(home.card?.ids).toEqual(["off", "lost"]);
  expect(home.card?.severity).toBe("act_now");
  expect(home.card?.canSnooze).toBe(false);
  expect(home.card?.impactPaise).toBe(640_100);
  expect(home.rows).toEqual([]);
});

it("keeps one card and three rows when there are many alerts, and groups the rest by outlet", () => {
  const alerts = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, index) =>
    alert({
      id,
      severity: index < 3 ? "act_now" : "watch",
      impactPaise: 100 - index,
      outletId: index % 2 === 0 ? "indiranagar" : "hsr",
      outletName: index % 2 === 0 ? "Indiranagar" : "HSR",
      ruleCode: `d_${id}`,
      family: `d_${id}`,
    }),
  );
  const home = composeOwnerHome(input({ alerts }));
  expect(home.card?.severity).toBe("act_now");
  expect(home.rows).toHaveLength(3);
  expect(home.overflow).toHaveLength(4);
  const grouped = groupedHomeRows(home.overflow);
  expect(
    grouped.every(
      (group) =>
        group.items[0]?.severity === "act_now" ||
        group.items.every((item) => item.severity === "watch"),
    ),
  ).toBe(true);
});

it("shows the all-good line and the checks that ran", () => {
  const home = composeOwnerHome(input());
  expect(home.kind).toBe("clear");
  expect(home.card).toBeNull();
  expect(home.checksPassed).toBe(18);
  expect(home.positive).toEqual({ kind: "steady", weekday: "Sunday" });
  expect(home.questions).toEqual([]);
});

it("names a standout weekday when this one beats the earlier ones", () => {
  const home = composeOwnerHome(input({ weekdayHistory: [100, 110, 90, 140] }));
  expect(home.positive).toEqual({ kind: "best", weekday: "Sunday", weeks: 4, paise: 140 });
});

it("uses the watch style when nothing is urgent, and lets those rows be snoozed", () => {
  const home = composeOwnerHome(input({ alerts: [alert({ id: "w", severity: "watch" })] }));
  expect(home.kind).toBe("watch");
  expect(home.urgent).toBe(0);
  expect(home.card?.canSnooze).toBe(true);
  expect(home.card?.severity).toBe("watch");
});

it("prefixes a watch alert with the day it is about", () => {
  const home = composeOwnerHome(
    input({
      alerts: [
        alert({
          id: "sales",
          severity: "watch",
          platform: "combined",
          text: "Total sales down 12.0% on Sat 14 Nov vs last Saturday.",
        }),
      ],
    }),
  );
  expect(home.card?.text).toBe("Sat 14 Nov · Total sales down 12.0% vs last Saturday.");
});

it("asks the oldest blank days and drops the question block when there are none", () => {
  const questions = [1, 2, 3, 4].map((day) => ({
    outletId: `o${day}`,
    outletName: `Outlet ${day}`,
    platform: "swiggy" as const,
    date: `2026-11-0${day}`,
  }));
  const home = composeOwnerHome(input({ questions }));
  expect(home.questions.map((question) => question.date)).toEqual([
    "2026-11-01",
    "2026-11-02",
    "2026-11-03",
  ]);
  expect(composeOwnerHome(input()).questions).toEqual([]);
});

it("tags an act-now that arrived after 9 AM", () => {
  const home = composeOwnerHome(
    input({
      now: "2026-11-16T06:30:00.000Z",
      alerts: [alert({ id: "new", severity: "act_now", notifiedAt: "2026-11-16T05:30:00.000Z" })],
    }),
  );
  expect(home.card?.fresh).toBe(true);
  const earlier = composeOwnerHome(
    input({
      alerts: [alert({ id: "old", severity: "act_now", notifiedAt: "2026-11-16T02:00:00.000Z" })],
    }),
  );
  expect(earlier.card?.fresh).toBe(false);
});

it("keeps a correction and a stale-login note above the headline", () => {
  const home = composeOwnerHome(
    input({
      brief: {
        ...input().brief!,
        corrections: ["Correction: yesterday's Swiggy sales alert was a false alarm (late data)."],
        notes: ["Swiggy: not updated this morning (login expired, we're reconnecting)."],
      },
    }),
  );
  expect(home.corrections).toHaveLength(1);
  expect(home.staleNote).toMatch(/login expired/);
});

it("welcomes a restaurant that has no history yet", () => {
  const home = composeOwnerHome(
    input({ hasHistory: false, brief: null, payoutPaise: null, payoutToCheck: 0 }),
  );
  expect(home.kind).toBe("welcome");
  expect(home.askChief).toBe(true);
  expect(home.card).toBeNull();
  expect(home.questions).toEqual([]);
});

it("uses the last complete day when yesterday is not in yet", () => {
  const home = composeOwnerHome(
    input({
      brief: { ...input().brief!, form: "no_data", sales: null, delivered: null, statusText: "" },
      lastComplete: { date: "2026-11-14", salesPaise: 80_000, delivered: 12 },
    }),
  );
  expect(home.kind).toBe("waiting");
  expect(home.sales).toMatchObject({ paise: 80_000, asOf: "2026-11-14" });
  expect(home.delivered).toMatchObject({ count: 12, asOf: "2026-11-14" });
  expect(home.questions).toEqual([]);
});

it("names the next Thursday for the payout tile", () => {
  expect(composeOwnerHome(input()).payout.nextDate).toBe("2026-11-19");
});
