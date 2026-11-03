// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearRestaurantSignup,
  markRestaurantSignup,
  restaurantSignInTarget,
} from "./restaurant-signup";

afterEach(() => {
  clearRestaurantSignup();
});

describe("restaurant sign-in return", () => {
  it("returns to welcome from the email link or a marked signup", () => {
    expect(restaurantSignInTarget("/restaurant/welcome", false)).toBe("/restaurant/welcome");
    expect(restaurantSignInTarget("", true)).toBe("/restaurant/welcome");
    expect(restaurantSignInTarget("", false)).toBeNull();
    expect(restaurantSignInTarget("/app", true)).toBeNull();
  });

  it("remembers a restaurant signup in this browser", () => {
    expect(restaurantSignInTarget("")).toBeNull();
    markRestaurantSignup();
    expect(restaurantSignInTarget("")).toBe("/restaurant/welcome");
    clearRestaurantSignup();
    expect(restaurantSignInTarget("")).toBeNull();
  });
});
