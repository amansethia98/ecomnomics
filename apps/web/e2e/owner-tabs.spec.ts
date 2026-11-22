import { expect, test } from "@playwright/test";
import { signup } from "./helpers";

const SCREENS = [
  "home",
  "dashboard",
  "payments",
  "menu",
  "chief-of-staff",
  "marketing",
  "documents",
  "settings",
  "ratings",
] as const;

const number = {
  paise: null,
  count: null,
  changePct: null,
  pendingPlatform: null,
  asOf: null,
};

function ownerPayload(url: string): unknown {
  if (url.endsWith("/api/v1/restaurants") || url.includes("/api/v1/restaurants?")) {
    return { restaurants: [{ id: "r1", name: "Sample Kitchen" }] };
  }
  if (url.endsWith("/profile")) {
    return {
      restaurant: { id: "r1", name: "Sample Kitchen", timezone: "Asia/Kolkata" },
      owner: { name: "Owner", email: "owner@example.com", locale: "en" },
      outlets: [
        {
          id: "o1",
          name: "Indiranagar",
          city: "Bengaluru",
          active: true,
          connections: [
            { platform: "zomato", status: "connected" },
            { platform: "swiggy", status: "connected" },
          ],
        },
      ],
    };
  }
  if (url.includes("/home")) {
    return {
      kind: "welcome",
      date: "2026-11-21",
      baselineDate: null,
      readiness: null,
      corrections: [],
      staleNote: null,
      urgent: 0,
      watch: 0,
      card: null,
      rows: [],
      overflow: [],
      positive: null,
      questions: [],
      sales: number,
      delivered: number,
      payout: { paise: null, toCheck: 0, nextDate: "2026-11-26" },
      checksPassed: 0,
      updated: { zomato: null, swiggy: null },
      askChief: false,
    };
  }
  if (url.includes("/metrics")) {
    return {
      basis: "order_date",
      platform: "all",
      from: "2026-06-01",
      to: "2026-11-23",
      grain: "day",
      likeForLike: false,
      provisional: false,
      lagBanner: null,
      outlets: [],
      note: null,
      series: [],
    };
  }
  if (url.includes("/staff") || url.includes("/marketing")) {
    if (url.includes("/marketing")) {
      return {
        hero: "empty",
        history: false,
        resultTitle: null,
        resultPaise: null,
        waiting: [],
        overflow: [],
        rows: [],
      };
    }
    return {
      greeting: null,
      starters: [],
      messages: [],
      quota: { asked: 0, remaining: 3, showCounter: false, inputDisabled: false },
    };
  }
  if (url.includes("/payments")) {
    return {
      payouts: [],
      selectedId: null,
      breakdown: [],
      deductions: [],
      plot: null,
      orders: [],
      adjustments: [],
    };
  }
  if (url.includes("/documents")) {
    return {
      reference: null,
      expiresOn: null,
      gstin: null,
      reminder: null,
      daysLeft: null,
      reports: [],
    };
  }
  if (url.includes("/menu")) return { editing: false, missingCount: 0, rows: [], swiggy: null };
  return { rating: null, reviews: [], apps: [] };
}

test("Payments and More stay tappable on every owner page at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/restaurants**", async (route) => {
    await route.fulfill({ json: ownerPayload(route.request().url()) });
  });
  await signup(page, `owner-tabs-${Date.now()}@example.test`, "password12", "Owner");
  for (const screen of SCREENS) {
    await page.goto(`/restaurants/r1/${screen}`);
    await expect(page.getByTestId("owner-more")).toBeVisible();
    if (screen === "dashboard") {
      await expect(page.locator(".recharts-cartesian-axis-tick-value").first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("sales-heatmap")).toBeVisible();
    }
    for (const name of ["Payments", "More"] as const) {
      const target =
        name === "More"
          ? page.getByTestId("owner-more")
          : page.getByRole("link", { name: "Payments", exact: true });
      const box = await target.boundingBox();
      expect(box, `${screen} ${name}`).toBeTruthy();
      const hit = await page.evaluate(
        ({ x, y }) => {
          const node = document.elementFromPoint(x, y);
          return node?.closest("a,button")?.textContent ?? "";
        },
        { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 },
      );
      expect(hit, `${screen} ${name}`).toContain(name);
    }
    await page.getByRole("link", { name: "Payments", exact: true }).click();
    await expect(page).toHaveURL(/\/restaurants\/r1\/payments/);
    await page.goto(`/restaurants/r1/${screen}`);
    await page.getByTestId("owner-more").click();
    await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
  }
});
