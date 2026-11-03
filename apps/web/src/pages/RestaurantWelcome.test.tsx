// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const restaurant = vi.hoisted(() => ({
  begin: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({ rpc: { restaurant } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { RestaurantWelcomePage } from "./RestaurantWelcome";

const openProfile = {
  name: "",
  cuisine: "",
  city: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  menuText: "",
  menuFileName: null,
  completed: false,
  outlets: [],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  restaurant.begin.mockReset();
  restaurant.save.mockReset();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/restaurant/welcome"]}>
        <Routes>
          <Route path="/restaurant/welcome" element={<RestaurantWelcomePage />} />
          <Route path="/onboarding" element={<p>onboarding</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { host, root };
}

async function fill(host: HTMLElement, id: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows the restaurant form until it is saved", async () => {
  restaurant.begin.mockResolvedValue(openProfile);
  const { host, root } = await render();
  expect(host.querySelector("h1")?.textContent).toBe("Your restaurant");
  expect(host.textContent).toContain("Ecomnomics");
  act(() => root.unmount());
});

it("saves the restaurant and continues to onboarding", async () => {
  restaurant.begin.mockResolvedValue(openProfile);
  restaurant.save.mockResolvedValue({ ...openProfile, completed: true, name: "Harbor Grill" });
  const { host, root } = await render();
  await fill(host, "restaurant-name", "Harbor Grill");
  await fill(host, "cuisine", "Grill");
  await fill(host, "city", "Lisbon");
  await fill(host, "contact-name", "Ada");
  await fill(host, "contact-email", "ada@example.test");
  await fill(host, "outlet-name-0", "Riverside");
  await fill(host, "outlet-address-0", "1 River Road");
  await fill(host, "outlet-hours-0", "09:00-22:00");
  await act(async () => host.querySelector("form")!.requestSubmit());
  expect(restaurant.save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Harbor Grill",
      cuisine: "Grill",
      city: "Lisbon",
      contactName: "Ada",
      contactEmail: "ada@example.test",
      outlets: [{ name: "Riverside", address: "1 River Road", openingHours: "09:00-22:00" }],
    }),
  );
  expect(host.textContent).toContain("onboarding");
  act(() => root.unmount());
});

it("continues when the restaurant was already saved", async () => {
  restaurant.begin.mockResolvedValue({ ...openProfile, completed: true });
  const { host, root } = await render();
  expect(host.textContent).toContain("onboarding");
  expect(host.querySelector("form")).toBeNull();
  act(() => root.unmount());
});

it("continues when restaurant signup is off", async () => {
  restaurant.begin.mockRejectedValue({ code: "NOT_FOUND" });
  const { host, root } = await render();
  expect(host.textContent).toContain("onboarding");
  act(() => root.unmount());
});
