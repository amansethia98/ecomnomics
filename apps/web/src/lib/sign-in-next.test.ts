import { expect, it } from "vitest";
import { newAccountDestination, ownerEntry, signInNext } from "./sign-in-next.js";

it("returns to integration setup, plugin admin, MCP sign-in and invite links only", () => {
  expect(signInNext("/integrations/setup")).toBe("/integrations/setup");
  expect(signInNext("/admin/plugins")).toBe("/admin/plugins");
  expect(signInNext("/mcp/oauth/callback?code=c&state=s")).toBe(
    "/mcp/oauth/callback?code=c&state=s",
  );
  expect(signInNext("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(signInNext(null)).toBeNull();
  expect(signInNext("/app")).toBeNull();
  expect(signInNext("https://example.com/invite/abc")).toBeNull();
  expect(signInNext("//example.com/invite/abc")).toBeNull();
  expect(signInNext("/invite/abc/../../app")).toBeNull();
  expect(signInNext("/invite/")).toBeNull();
});

it("sends a signed-in person to the owner app, not the agent shell", () => {
  expect(ownerEntry(null)).toBe("/restaurants");
  expect(ownerEntry("/")).toBe("/restaurants");
  expect(ownerEntry("/app")).toBe("/restaurants");
  expect(ownerEntry("/app/board")).toBe("/restaurants");
  expect(ownerEntry("/app?settings=account")).toBe("/restaurants");
  expect(ownerEntry("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(ownerEntry("/restaurants/r1/home")).toBe("/restaurants/r1/home");
});

it("starts a new account in onboarding unless it came for an invite", () => {
  expect(newAccountDestination("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(newAccountDestination("/integrations/setup")).toBe("/onboarding");
  expect(newAccountDestination(null)).toBe("/onboarding");
});
