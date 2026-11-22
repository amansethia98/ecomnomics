// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { OwnerEntry } from "./owner-entry";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("sends an owner who has a restaurant to that restaurant", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ restaurants: [{ id: "r1" }] }),
      }),
    ),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/app"]}>
        <Routes>
          <Route path="/app" element={<OwnerEntry fallback={<p>Shell</p>} />} />
          <Route path="/restaurants/:id/home" element={<Here />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.textContent).toContain("/restaurants/r1/home");
  expect(host.textContent).not.toContain("Shell");
  await act(async () => root.unmount());
});

it("keeps the shell when onboarding has no restaurant yet", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ restaurants: [] }),
      }),
    ),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<OwnerEntry fallback={<p>Shell</p>} />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.textContent).toContain("Shell");
  await act(async () => root.unmount());
});

function Here(): ReactNode {
  const location = useLocation();
  return <p>{location.pathname}</p>;
}
