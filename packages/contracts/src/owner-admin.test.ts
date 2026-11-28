import { describe, expect, it } from "vitest";
import {
  adminQualityNotes,
  composeAdminPanel,
  filterAdminRestaurants,
  funnelGapLines,
  ownerViewFromRestaurant,
  panelFromAdminRows,
} from "./owner-admin.js";
import type { DashReading } from "./funnel-gap.js";

const outlet = {
  name: "HSR",
  city: "Bengaluru",
  active: true,
  zomato: "connected" as const,
  swiggy: "not_connected" as const,
};

describe("platform admin panel", () => {
  it("asks for the first restaurant and hides an empty list", () => {
    const panel = composeAdminPanel({ restaurants: [], openFindings: 0 });
    expect(panel.health).toBe("Add your first restaurant");
    expect(panel.restaurants).toEqual([]);
    expect(panel.needsYou).toBe(false);
    expect(panel.rules).toBe("No rule placeholders left.");
    expect(panel.messages).toBe("Message log isn't readable from admin yet.");
  });

  it("counts a run that is still going and leaves a paused restaurant out", () => {
    const panel = composeAdminPanel({
      openFindings: 0,
      restaurants: [
        {
          restaurantId: "r-live",
          name: "Live",
          outlets: [outlet],
          runs: [
            { status: "ok", startedAt: "2026-11-21T00:00:00.000Z", endedAt: null, costPaise: 100 },
          ],
        },
        {
          restaurantId: "r-done",
          name: "Done",
          outlets: [outlet],
          runs: [
            {
              status: "ok",
              startedAt: "2026-11-21T00:00:00.000Z",
              endedAt: "2026-11-21T01:00:00.000Z",
              costPaise: 0,
            },
          ],
        },
        {
          restaurantId: "r-paused",
          name: "Paused",
          outlets: [{ ...outlet, active: false }],
          runs: [],
        },
      ],
    });
    expect(panel.health).toBe("Run in progress, 1 of 2 done");
    expect(panel.runs.find((run) => run.restaurant === "Paused")?.state).toBe("paused");
    expect(panel.connections.map((row) => row.restaurant)).toEqual(["Done", "Live"]);
    expect(panel.costsPaise).toBe(100);
    expect(panel.needsYou).toBe(true);
  });

  it("says the run did not start when an active restaurant has no run", () => {
    const panel = composeAdminPanel({
      openFindings: 2,
      restaurants: [{ restaurantId: "r1", name: "Sample", outlets: [outlet], runs: [] }],
    });
    expect(panel.health).toBe("Last night's run didn't start");
    expect(panel.restaurants[0]).toMatchObject({
      zomato: "connected",
      swiggy: "not_connected",
      run: "not_started",
      lastDownload: null,
      costPaise: null,
    });
    expect(
      filterAdminRestaurants(panel.restaurants, "sam", "attention").map((row) => row.name),
    ).toEqual(["Sample"]);
    expect(filterAdminRestaurants(panel.restaurants, "other", "all")).toEqual([]);
    expect(panel.rules).toBe("2 need a person");
    expect(panel.costsPaise).toBeNull();
  });

  it("drops platform ids from a view-as-owner snapshot", () => {
    const view = ownerViewFromRestaurant({
      restaurantId: "r1",
      name: "Sample",
      outlets: [
        {
          name: "HSR",
          city: "Bengaluru",
          active: true,
          zomato: { resId: "should-not-leak" },
          swiggy: null,
        },
      ],
    });
    expect(view.readOnly).toBe(true);
    expect(view.outlets[0]).toEqual({
      name: "HSR",
      city: "Bengaluru",
      active: true,
      zomato: "connected",
      swiggy: "not_connected",
    });
    const encoded = JSON.stringify(view);
    expect(encoded).not.toContain("should-not-leak");
    expect(encoded).not.toMatch(/password|token|secret|resId/i);
    const panel = panelFromAdminRows(
      [
        {
          restaurantId: "r1",
          name: "Sample",
          outlets: [
            {
              name: "HSR",
              city: "Bengaluru",
              active: true,
              zomato: { resId: "should-not-leak" },
              swiggy: null,
            },
          ],
          jobRuns: [],
        },
      ],
      0,
    );
    expect(JSON.stringify(panel)).not.toContain("should-not-leak");
    expect(panel.connections[0]?.zomato).toBe("connected");
  });

  it("takes the last download from the newest stored fetch, in India time", () => {
    const panel = composeAdminPanel({
      openFindings: 0,
      restaurants: [
        {
          restaurantId: "r1",
          name: "Sample",
          outlets: [outlet],
          runs: [
            {
              status: "ok",
              startedAt: "2026-11-12T00:00:00.000Z",
              endedAt: "2026-11-12T01:00:00.000Z",
              costPaise: 0,
            },
          ],
          fetches: [{ createdAt: "2026-11-21T21:00:00.000Z", platform: "zomato" }],
        },
      ],
    });
    expect(panel.restaurants[0]?.lastDownload).toBe("2026-11-22");
    expect(panel.health).toBe("1 restaurant updated");
    const readings: DashReading[] = [
      {
        from: "2026-11-18",
        grain: "day",
        platform: "zomato",
        key: "cart_builds",
        value: 4,
        state: "ok",
      },
      {
        from: "2026-11-18",
        grain: "day",
        platform: "zomato",
        key: "placed_orders",
        value: 9,
        state: "ok",
      },
    ];
    expect(
      adminQualityNotes({ readings, badPayouts: [{ platform: "zomato", mark: "unreadable" }] }),
    ).toEqual([
      "Carts and orders do not match on 2026-11-18",
      "zomato payout mark unreadable could not be read",
    ]);
  });

  it("reads last night from the nightly download and counts files", () => {
    const panel = composeAdminPanel({
      today: "2026-11-22",
      openFindings: 0,
      restaurants: [
        {
          restaurantId: "r1",
          name: "Sample",
          outlets: [outlet],
          runs: [
            {
              status: "ok",
              startedAt: "2026-11-12T01:00:00.000Z",
              endedAt: "2026-11-12T02:00:00.000Z",
              costPaise: 10,
            },
          ],
          fetches: [
            {
              createdAt: "2026-11-22T00:37:00.000Z",
              platform: "zomato",
              status: "stored",
              runId: "nightly-a",
              attemptCount: 1,
              periodStart: "2026-11-20",
            },
            {
              createdAt: "2026-11-22T00:40:00.000Z",
              platform: "swiggy",
              status: "stored",
              runId: "nightly-a",
              attemptCount: 2,
              periodStart: "2026-11-20",
            },
            {
              createdAt: "2026-11-22T00:40:00.000Z",
              platform: "swiggy",
              status: "download_failed",
              runId: "nightly-a",
              attemptCount: 1,
              periodStart: "2026-11-19",
            },
          ],
          reports: [{ kind: "daily_brief", on: "2026-11-16" }],
        },
      ],
    });
    expect(panel.night).toEqual({
      startedAt: "2026-11-22T00:37:00.000Z",
      endedAt: "2026-11-22T00:40:00.000Z",
    });
    expect(panel.downloads).toEqual({ ok: 2, total: 3 });
    expect(panel.pendingSwiggy).toBeGreaterThan(0);
    expect(panel.pendingZomato).toBe(panel.pendingSwiggy);
    expect(panel.messageRows).toEqual(["Daily brief · Mon 16 Nov · Sent"]);
    expect(panel.runs[0]).toMatchObject({ tries: 4, rows: 2, minutes: 60 });
    expect(
      funnelGapLines([
        {
          from: "2026-11-18",
          grain: "day",
          platform: "zomato",
          key: "cart_builds",
          value: 4,
          state: "ok",
        },
        {
          from: "2026-11-18",
          grain: "day",
          platform: "zomato",
          key: "placed_orders",
          value: 9,
          state: "ok",
        },
      ]),
    ).toEqual(["Zomato Wed 18 Nov: 4 carts → 9 orders"]);
  });

  it("builds the night window, a seven-day download grid, and the stored costs", () => {
    const panel = composeAdminPanel({
      openFindings: 0,
      restaurants: [
        {
          restaurantId: "r1",
          name: "Sample",
          outlets: [outlet],
          runs: [
            {
              status: "ok",
              startedAt: "2026-11-10T20:00:00.000Z",
              endedAt: "2026-11-10T21:00:00.000Z",
              costPaise: 100,
            },
            {
              status: "ok",
              startedAt: "2026-11-11T20:00:00.000Z",
              endedAt: "2026-11-11T22:00:00.000Z",
              costPaise: 250,
            },
          ],
          fetches: [
            { createdAt: "2026-11-11T20:00:00.000Z", platform: "zomato" },
            { createdAt: "2026-11-11T21:00:00.000Z", platform: "swiggy" },
          ],
        },
      ],
    });
    expect(panel.night).toEqual({
      startedAt: "2026-11-11T20:00:00.000Z",
      endedAt: "2026-11-11T22:00:00.000Z",
    });
    expect(panel.freshness).toHaveLength(7);
    expect(panel.freshness.at(-1)?.downloads).toBe(2);
    expect(panel.nights.map((night) => night.runs)).toEqual([1, 1]);
    expect(panel.dailyCosts).toHaveLength(7);
    expect(panel.dailyCosts.map((day) => day.costPaise)).toEqual([0, 0, 0, 0, 0, 100, 250]);
  });

  it("reads the nightly id as the start and counts only that night's files", () => {
    const panel = composeAdminPanel({
      today: "2026-11-22",
      openFindings: 0,
      restaurants: [
        {
          restaurantId: "r1",
          name: "Sample",
          outlets: [outlet],
          runs: [],
          fetches: [
            {
              createdAt: "2026-11-22T00:40:08.000Z",
              platform: "swiggy",
              status: "stored",
              runId: "nightly-20261122-0607",
              attemptCount: 2,
              periodStart: "2026-11-22",
            },
            {
              createdAt: "2026-11-22T02:32:00.000Z",
              platform: "zomato",
              status: "stored",
              runId: "daytime",
              attemptCount: 40,
              periodStart: "2026-11-22",
            },
          ],
          reports: [
            {
              kind: "daily_brief",
              on: "2026-11-15",
              createdAt: "2026-11-16T03:30:00.000Z",
            },
            { kind: "payout_check", on: "2026-11-12" },
            { kind: "payout_check", on: "2026-11-12" },
          ],
        },
      ],
    });
    expect(panel.night?.startedAt).toBe("2026-11-22T00:37:00.000Z");
    expect(panel.night?.endedAt).toBe("2026-11-22T00:40:08.000Z");
    expect(panel.downloads).toEqual({ ok: 1, total: 1 });
    expect(panel.pendingSwiggy).toBe(1);
    expect(panel.pendingZomato).toBe(1);
    expect(panel.pendingNote).toBe("Sat 21 is pending on both apps");
    expect(panel.runs[0]).toMatchObject({ tries: 2, rows: 1 });
    expect(panel.messageRows).toEqual([
      "Daily brief · Mon 16 Nov · Sent",
      "Payout check · Thu 12 Nov · Sent",
    ]);
  });
});
