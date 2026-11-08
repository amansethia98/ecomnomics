/**
 * A blocked click walks a ladder inside browser_act before a person is asked to take over.
 * The page browser reports which strategy worked, or that the ladder is exhausted for that target.
 */

const exhaustedByRun = new Map<string, string>();

const HUMAN_ONLY =
  /\b(otp|2fa|two-factor|one-time(?: password)?|verification code|passkey|captcha|re\s?captcha|hcaptcha)\b|\b(confirm(?: the)? payment|payment confirmation|approve (?:the )?payment)\b/i;

export function noteClickLadder(runId: string, result: unknown) {
  if (!result || typeof result !== "object") return;
  const record = result as { ladder?: unknown; ladderTarget?: unknown };
  if (record.ladder === "exhausted") {
    exhaustedByRun.set(runId, typeof record.ladderTarget === "string" ? record.ladderTarget : "");
  }
}

export function clickLadderExhausted(runId: string): boolean {
  return exhaustedByRun.has(runId);
}

/** Drop the ladder record when the run finishes, so a later run starts clean. */
export function clearClickLadder(runId: string) {
  exhaustedByRun.delete(runId);
}

export const CLICK_LADDER_INSTRUCTION =
  "Do not hand this to the user yet. A blocked click still has strategies left, and browser_act tries them before it fails: scroll the control into view, dismiss an obvious cookie or consent overlay or click inside the frame that holds it, focus the related field and press Enter then Tab and Enter, call the element's click or the form's requestSubmit, a coordinate click at the center of its box, and reload once while keeping what was typed. request_takeover is only for an OTP or 2FA code you do not have, a captcha you could not pass, or a payment confirmation, or after that ladder has failed for this target.";

/** A person has to act, or the click ladder already failed for a target in this run. */
export function takeoverAllowed(runId: string, reason: string): boolean {
  return HUMAN_ONLY.test(reason) || clickLadderExhausted(runId);
}
