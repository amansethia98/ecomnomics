// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
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

import { ChangeBadge, MetricState, PlatformDot, StatusPill } from "./marks";

function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

it("draws the status pills with their icons", () => {
  const view = render(
    <div className="ecomnomics">
      <StatusPill kind="act_now" label="Act now" />
      <StatusPill kind="watch" label="Watch" />
      <StatusPill kind="good" label="All good" />
    </div>,
  );
  expect(view.host.textContent).toContain("Act now");
  expect(view.host.querySelector(".owner-pill-act")).not.toBeNull();
  expect(view.host.querySelector(".owner-pill-watch")).not.toBeNull();
  expect(view.host.querySelector(".owner-pill-good")).not.toBeNull();
  view.unmount();
});

it("uses platform colour only on the dot", () => {
  const view = render(
    <div className="ecomnomics">
      <PlatformDot platform="zomato" />
      <PlatformDot platform="swiggy" />
    </div>,
  );
  expect(view.host.querySelector(".owner-dot-zomato")).not.toBeNull();
  expect(view.host.querySelector(".owner-dot-swiggy")).not.toBeNull();
  expect(view.host.querySelector(".owner-dot-zomato")?.textContent).toBe("");
  view.unmount();
});

it("marks a fall in wine and a rise in green", () => {
  const view = render(
    <div className="ecomnomics">
      <ChangeBadge direction="down" label="6%" />
      <ChangeBadge direction="up" label="4%" />
    </div>,
  );
  expect(view.host.querySelector(".owner-change-down")?.textContent).toContain("6%");
  expect(view.host.querySelector(".owner-change-up")?.textContent).toContain("4%");
  view.unmount();
});

it("does not show a zero for pending, a gap, or a running fetch", () => {
  for (const kind of ["pending", "not_in_yet", "updating", "not_applicable", "empty"] as const) {
    const view = render(<MetricState kind={kind} />);
    expect(view.host.textContent).not.toContain("0");
    expect(view.host.textContent?.length).toBeGreaterThan(0);
    view.unmount();
  }
});
