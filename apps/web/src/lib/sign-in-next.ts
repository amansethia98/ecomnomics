export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
export const SLACK_INSTALL_CALLBACK_PATH = "/messaging/slack/callback";

const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{1,200}$/;

/** The page sign-in or sign-up may return to; anything else is ignored, so `next` can't redirect off the app. */
export function signInNext(next: string | null): string | null {
  if (!next) return null;
  // A connector sign-in started on another device lands here signed out; finish it after sign-in.
  if (
    next === "/integrations/setup" ||
    next === "/admin/plugins" ||
    next === "/admin/access" ||
    next.startsWith(`${MCP_OAUTH_CALLBACK_PATH}?`) ||
    next.startsWith(`${SLACK_INSTALL_CALLBACK_PATH}?`) ||
    INVITE_PATH.test(next)
  ) {
    return next;
  }
  return null;
}

/** Where a new account starts: an invite it came for, otherwise onboarding. */
export function newAccountDestination(next: string | null): string {
  return next && INVITE_PATH.test(next) ? next : "/onboarding";
}

/**
 * Where a sign-in with no page of its own returns. The site root and the bare agent
 * shell open the restaurant list. A page the person asked for still opens, including
 * a bot chat, because onboarding and a protected link finish there.
 */
export function ownerEntry(next: string | null): string {
  if (!next || next === "/" || next === "/app" || next.startsWith("/app?")) {
    return "/restaurants";
  }
  return next;
}
