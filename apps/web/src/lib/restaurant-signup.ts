import { RESTAURANT_WELCOME_PATH } from "@rakazo/core";

const STORAGE_KEY = "rakazo.restaurant-signup";

export function markRestaurantSignup(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // A private browser can reject storage. The verification email still returns to welcome.
  }
}

export function restaurantSignupMarked(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearRestaurantSignup(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage that is unavailable.
  }
}

/** Sign-in lands on welcome when this browser just started restaurant signup. */
export function restaurantSignInTarget(
  next: string,
  marked = restaurantSignupMarked(),
): string | null {
  if (next === RESTAURANT_WELCOME_PATH || (next === "" && marked)) return RESTAURANT_WELCOME_PATH;
  return null;
}
