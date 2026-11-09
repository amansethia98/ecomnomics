export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function emailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

/** Internal messaging users have no mailbox and cannot authenticate by email. */
export function isMessagingEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@messaging.invalid");
}

/** Sent on restaurant signup so the verification email can return to welcome. */
export const RESTAURANT_SIGNUP_HEADER = "x-restaurant-signup";
export const RESTAURANT_SIGNUP_PATH = "/restaurant/sign-up";
export const RESTAURANT_WELCOME_PATH = "/restaurant/welcome";

/**
 * Where the verification email sends someone. Restaurant signup returns to welcome.
 * Every other signup still returns to sign-in.
 */
export function restaurantVerificationPath(
  headers: Headers | null | undefined,
  enabled: boolean,
): string {
  if (enabled && headers?.get(RESTAURANT_SIGNUP_HEADER) === "1") {
    return `/sign-in?next=${encodeURIComponent(RESTAURANT_WELCOME_PATH)}`;
  }
  return "/sign-in";
}

/** A successful signup with an explicit null token awaits mailbox proof. */
export function signupRequiresEmailVerification(response: unknown): boolean {
  return Boolean(
    response && typeof response === "object" && "token" in response && response.token === null,
  );
}

export function signupsOpen(enabled: string | undefined): boolean {
  if (enabled === undefined) return true;
  return enabled !== "false" && enabled !== "0";
}

export function signupPolicyFromEnv(input: {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}): { enabled: boolean; allowlist: string[] } {
  return {
    enabled: signupsOpen(input.signupsEnabled),
    allowlist: parseAllowlist(input.signupAllowlist),
  };
}
