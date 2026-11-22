import { describe, expect, it } from "vitest";
import {
  adminQualityNotes,
  composeAdminPanel,
  filterAdminRestaurants,
  ownerViewFromRestaurant,
  panelFromAdminRows,
} from "./owner-admin.js";
import type { DashReading } from "./owner-dashboard.js";

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
    expect(panel.messages).toBe("No messages are in this view.");
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
});
