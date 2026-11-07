import { afterEach, describe, expect, it } from "vitest";
import {
  CLICK_LADDER_INSTRUCTION,
  clearClickLadder,
  noteClickLadder,
  takeoverAllowed,
} from "./click-ladder.js";

afterEach(() => {
  clearClickLadder("run-1");
});

describe("takeover after a blocked click", () => {
  it("refuses a blocked login before the ladder has failed", () => {
    expect(takeoverAllowed("run-1", "The login button is blocked by an iframe.")).toBe(false);
    expect(CLICK_LADDER_INSTRUCTION).toContain("press Enter");
    expect(CLICK_LADDER_INSTRUCTION).toContain("coordinate");
  });

  it("allows takeover once browser_act exhausted the ladder for that target", () => {
    noteClickLadder("run-1", { ok: false, ladder: "exhausted", ladderTarget: "e4" });
    expect(takeoverAllowed("run-1", "The login button is blocked by an iframe.")).toBe(true);
  });

  it("allows a code, a captcha, or a payment confirmation without the ladder", () => {
    expect(takeoverAllowed("run-1", "I do not have the OTP for this login.")).toBe(true);
    expect(takeoverAllowed("run-1", "The captcha failed and I cannot pass it.")).toBe(true);
    expect(takeoverAllowed("run-1", "Please confirm the payment.")).toBe(true);
  });

  it("does not treat a successful strategy as exhaustion", () => {
    noteClickLadder("run-1", { ok: true, ladder: "keyboard" });
    expect(takeoverAllowed("run-1", "Please finish the login.")).toBe(false);
  });
});
