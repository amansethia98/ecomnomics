// @vitest-environment jsdom
import type { OwnerProfile } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
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

function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return host;
}

afterEach(() => {
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
  expect(host.querySelector("summary")?.textContent).toContain("•••");
  expect(host.querySelector("summary")?.textContent).toContain("More");
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
