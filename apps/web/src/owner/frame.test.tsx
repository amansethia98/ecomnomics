// @vitest-environment jsdom
import type { AdminPanel, OwnerProfile } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => text + (index ? String(values[index - 1]) : "") + part,
        "",
      ),
  }),
}));

import { AdminPanelScreen } from "./admin-screen";
import { OWNER_SCREENS, OwnerFrame } from "./frame";
import { SettingsProfile } from "./settings";

const profile: OwnerProfile = {
  restaurant: { id: "r1", name: "Kesar Kitchen", timezone: "Asia/Kolkata" },
  owner: { name: "Ravi Kumar", email: "owner@example.com", locale: "en" },
  outlets: [
    {
      id: "o1",
      name: "Indiranagar",
      city: "Bengaluru",
      active: true,
      connections: [
        { platform: "zomato", status: "connected" },
        { platform: "swiggy", status: "login_needs_attention" },
      ],
    },
    {
      id: "o2",
      name: "Koramangala",
      city: "Bengaluru",
      active: true,
      connections: [
        { platform: "zomato", status: "connected" },
        { platform: "swiggy", status: "not_connected" },
      ],
    },
  ],
};

const view = {
  range: "7d" as const,
  platform: "both" as const,
  outlet: "all",
  from: "2026-11-09",
  to: "2026-11-16",
};

const adminPanel: AdminPanel = {
  health: "All 1 restaurants updated",
  needsYou: false,
  runs: [{ restaurant: "Sample", state: "done", tries: 1, rows: 12, minutes: 3, costPaise: 1200 }],
  restaurants: [
    {
      restaurantId: "r1",
      name: "Sample",
      paused: false,
      outlets: 1,
      zomato: "connected",
      swiggy: "connected",
      run: "done",
      lastDownload: "2026-11-21",
      costPaise: 1200,
    },
  ],
  connections: [
    { restaurant: "Sample", outlet: "Indiranagar", zomato: "connected", swiggy: "connected" },
  ],
  messages: "No briefs yet",
  costsPaise: 1200,
  rules: "Confirmed",
  quality: [],
  night: { startedAt: "2026-11-22T00:37:00.000Z", endedAt: "2026-11-22T00:40:00.000Z" },
  freshness: Array.from({ length: 7 }, (_, index) => ({
    day: `2026-11-${String(15 + index).padStart(2, "0")}`,
    downloads: 1,
  })),
  nights: [],
  dailyCosts: [{ day: "2026-11-21", costPaise: 1200 }],
};

let root: Root | null = null;

function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

it("lists the nine owner screens", () => {
  expect(OWNER_SCREENS.map((screen) => screen.id)).toEqual([
    "home",
    "dashboard",
    "payments",
    "menu",
    "chief-of-staff",
    "marketing",
    "documents",
    "settings",
    "ratings",
  ]);
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={profile}
      screen="home"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Coming soon</p>
    </OwnerFrame>,
  );
  expect(host.textContent).toContain("Ecomnomics");
  expect(host.textContent).toContain("Chief of staff");
  expect(host.textContent).toContain("Ratings & reviews");
  expect(host.textContent).toContain("All outlets");
  expect(host.textContent).not.toContain("7D");
  expect(host.querySelector("select")?.textContent).toContain("Indiranagar");
  expect(host.querySelector("[data-testid='owner-more']")?.textContent).toContain("•••");
  expect(host.querySelector("[data-testid='owner-more']")?.textContent).toContain("More");
});

it("hides the outlet picker when the restaurant has one outlet", () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={{ ...profile, outlets: profile.outlets.slice(0, 1) }}
      screen="home"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Home</p>
    </OwnerFrame>,
  );
  expect(host.querySelector("select")).toBeNull();
});

it("shows the outlet picker when the restaurant has three outlets", () => {
  const third = profile.outlets[0];
  if (!third) throw new Error("fixture");
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={{
        ...profile,
        outlets: [...profile.outlets, { ...third, id: "o3", name: "HSR" }],
      }}
      screen="home"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Home</p>
    </OwnerFrame>,
  );
  expect(host.querySelector("select")?.textContent).toContain("HSR");
});

it("leaves an inactive outlet out of the selector", () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={{
        ...profile,
        outlets: [
          ...(profile.outlets[0] ? [profile.outlets[0]] : []),
          { ...profile.outlets[1]!, active: false },
        ],
      }}
      screen="home"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Home</p>
    </OwnerFrame>,
  );
  expect(host.querySelector("select")).toBeNull();
  expect(host.textContent).not.toContain("Koramangala");
});

it("keeps the header quiet when the restaurant has one outlet", () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={{ ...profile, outlets: profile.outlets.slice(0, 1) }}
      screen="home"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Home</p>
    </OwnerFrame>,
  );
  expect(host.querySelector("select")).toBeNull();
  expect(host.textContent).not.toContain("All outlets");
});

it("hides the range on settings and the outlet list when there is one outlet", () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={{ ...profile, outlets: profile.outlets.slice(0, 1) }}
      screen="settings"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <SettingsProfile
        profile={{ ...profile, outlets: profile.outlets.slice(0, 1) }}
        saving={false}
        onSave={() => undefined}
      />
    </OwnerFrame>,
  );
  expect(host.textContent).not.toContain("7D");
  expect(host.querySelector("select")?.getAttribute("aria-label")).not.toBe("Outlet");
  expect(host.textContent).toContain("Zomato connected");
  expect(host.textContent).toContain("Swiggy login needs attention");
  expect(host.textContent).toContain("We never ask for a Zomato or Swiggy password.");
  expect(host.textContent).toContain("Names come from Zomato and Swiggy.");
  const labels = [...host.querySelectorAll("label")].map((item) => item.textContent ?? "");
  const restaurant = labels.findIndex((label) => label.includes("Restaurant name"));
  const city = labels.findIndex((label) => label.startsWith("City"));
  expect(restaurant).toBeGreaterThanOrEqual(0);
  expect(city).toBeGreaterThan(restaurant);
  expect(host.querySelector("button[type='submit']")?.hasAttribute("disabled")).toBe(true);
});

it("hides the platform toggle when only one app is connected", () => {
  const first = profile.outlets[0];
  if (!first) throw new Error("fixture");
  const one: OwnerProfile = {
    ...profile,
    outlets: [
      {
        ...first,
        connections: [
          { platform: "zomato", status: "connected" },
          { platform: "swiggy", status: "not_connected" },
        ],
      },
    ],
  };
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={one}
      screen="dashboard"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Coming soon</p>
    </OwnerFrame>,
  );
  expect(host.textContent).toContain("7D");
  expect(host.textContent).not.toContain("Both");
});

it("opens a calendar for Custom and leaves the current range in place", () => {
  const onView = vi.fn();
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={profile}
      screen="dashboard"
      view={{ ...view, range: "12w", from: "2026-08-24", to: "2026-11-16" }}
      today="2026-11-15"
      onView={onView}
      confirmLeave={() => true}
    >
      <p>Dashboard</p>
    </OwnerFrame>,
  );
  const custom = [...host.querySelectorAll("button")].find((item) => item.textContent === "Custom");
  act(() => {
    custom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onView).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Last 14 days");
  expect(document.querySelector("[data-testid='range-end']")?.textContent).toBe("To Sun 8 Nov");
  expect(document.body.textContent).not.toContain("To Sun 15 Nov");
});

it("prefills Custom with the open range's last day", () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={profile}
      screen="dashboard"
      view={{ ...view, range: "4w", from: "2026-10-26", to: "2026-11-23" }}
      today="2026-11-22"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Dashboard</p>
    </OwnerFrame>,
  );
  const custom = [...host.querySelectorAll("button")].find((item) => item.textContent === "Custom");
  act(() => {
    custom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(document.querySelector("[data-testid='range-end']")?.textContent).toBe("To Sun 15 Nov");
  expect(document.body.textContent).not.toContain("To Sun 22 Nov");
});

it("shows yesterday as plain text on Home", () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={profile}
      screen="home"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Home</p>
    </OwnerFrame>,
  );
  const day = [...host.querySelectorAll("span")].find((item) => item.textContent === "Sat 14 Nov");
  expect(day).toBeTruthy();
  expect(day?.className).not.toContain("border");
  expect(host.querySelector("button")?.textContent).not.toBe("Sat 14 Nov");
});

it("closes More after a screen is chosen", async () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={profile}
      screen="home"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Home</p>
    </OwnerFrame>,
  );
  const more = host.querySelector("[data-testid='owner-more']");
  act(() => {
    more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const menu = [...host.querySelectorAll("button")].find((item) => item.textContent === "Menu");
  expect(menu).toBeTruthy();
  await act(async () => {
    menu?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  expect([...host.querySelectorAll("button")].some((item) => item.textContent === "Menu")).toBe(
    false,
  );
});

it("keeps every phone tab inside the bar", () => {
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={profile}
      screen="dashboard"
      view={view}
      today="2026-11-15"
      onView={() => undefined}
      confirmLeave={() => true}
    >
      <p>Dashboard</p>
    </OwnerFrame>,
  );
  const bar = host.querySelector(".owner-tabbar");
  expect(bar).not.toBeNull();
  const items = [...(bar?.children ?? [])];
  expect(items.length).toBe(5);
  for (const item of items) expect(item.className).toContain("min-w-0");
});

it("keeps every owner page inside a 390px frame", () => {
  for (const screen of OWNER_SCREENS) {
    const host = render(
      <div style={{ width: "390px" }}>
        <OwnerFrame
          restaurantId="r1"
          profile={profile}
          screen={screen.id}
          view={view}
          today="2026-11-22"
          onView={() => undefined}
          confirmLeave={() => true}
        >
          <p>Page</p>
        </OwnerFrame>
      </div>,
    );
    host.style.width = "390px";
    const shell = host.querySelector(".ecomnomics");
    expect(shell?.className).toContain("overflow-x-clip");
    expect(shell?.className).toContain("max-w-full");
    expect(host.querySelector("main")?.className).toContain("min-w-0");
    const bar = host.querySelector(".owner-tabbar");
    expect(bar?.className).toContain("z-50");
    expect(bar?.children.length).toBe(5);
    for (const item of bar?.children ?? []) expect(item.className).toContain("min-w-0");
    for (const node of host.querySelectorAll<HTMLElement>("[style]")) {
      const min = Number.parseFloat(node.style.minWidth);
      if (Number.isFinite(min)) expect(min).toBeLessThanOrEqual(390);
    }
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  }
});

it("keeps every admin page inside a 390px frame", () => {
  const host = render(
    <div style={{ width: "390px" }}>
      <AdminPanelScreen panel={adminPanel} onView={() => undefined} />
    </div>,
  );
  host.style.width = "390px";
  const page = host.querySelector("[data-testid='admin-page']");
  expect(page?.className).toContain("overflow-x-clip");
  expect(page?.className).toContain("max-w-full");
  expect(page?.className).toContain("flex-col");
  for (const label of [
    "Platform health",
    "Restaurants",
    "Nightly runs",
    "Logins & connections",
    "Messages sent",
    "Costs & usage",
    "Rules & data quality",
  ]) {
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(button, label).toBeTruthy();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector("main")?.className).toContain("min-w-0");
    for (const node of host.querySelectorAll<HTMLElement>("[style]")) {
      const min = Number.parseFloat(node.style.minWidth);
      if (Number.isFinite(min)) expect(min).toBeLessThanOrEqual(390);
      const width = Number.parseFloat(node.style.width);
      if (Number.isFinite(width) && node.style.width.endsWith("px")) {
        expect(width).toBeLessThanOrEqual(390);
      }
    }
  }
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

it("keeps 4W selected when that range is chosen", () => {
  const seen: string[] = [];
  const host = render(
    <OwnerFrame
      restaurantId="r1"
      profile={profile}
      screen="dashboard"
      view={view}
      today="2026-11-15"
      onView={(next) => seen.push(next.range)}
      confirmLeave={() => true}
    >
      <p>Dashboard</p>
    </OwnerFrame>,
  );
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "4W");
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(seen).toEqual(["4w"]);
});
