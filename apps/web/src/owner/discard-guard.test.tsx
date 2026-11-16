// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useDiscardGuard } from "./discard-guard";

function Harness({ active }: { active: boolean }) {
  const confirmLeave = useDiscardGuard(active, "Leave without saving?");
  const location = useLocation();
  return (
    <button type="button" onClick={() => confirmLeave()}>
      {location.pathname}
      {location.search}
    </button>
  );
}

function render(active: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/restaurants/r1/settings?range=7d"]}>
        <Harness active={active} />
      </MemoryRouter>,
    );
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
  vi.restoreAllMocks();
});

it("puts the settings address back when Back is declined", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const view = render(true);
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(confirm).toHaveBeenCalledWith("Leave without saving?");
  expect(view.host.textContent).toBe("/restaurants/r1/settings?range=7d");
  view.unmount();
});

it("lets Back through after the owner confirms", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  const view = render(true);
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("does not ask when nothing is unsaved", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const view = render(false);
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(confirm).not.toHaveBeenCalled();
  view.unmount();
});
