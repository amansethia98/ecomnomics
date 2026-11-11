import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTION_TRANSITIONS,
  actionStatusNeedsApproval,
  actionTransition,
  CreateJobRunSchema,
  DERIVED_METRIC_KEYS,
  isPlatformAdminEmail,
  isPlatformCommandVariable,
  METRIC_DEFINITIONS,
  METRIC_KEY_MEANINGS,
  METRIC_KEYS,
  PutMetricsSchema,
  parsePlatformAdminEmails,
  restaurantComputerEnv,
  unknownMetricKeyMessage,
} from "./restaurant-agent.js";

const spec = readFileSync(
  new URL("../../../docs/restaurant-agent-api.md", import.meta.url),
  "utf8",
);
const openapi = readFileSync(
  new URL("../../../docs/restaurant-agent-api.openapi.json", import.meta.url),
  "utf8",
);

describe("restaurant agent contract", () => {
  it("names every metric key once, with a meaning", () => {
    expect(new Set(METRIC_KEYS).size).toBe(METRIC_KEYS.length);
    expect(METRIC_KEYS).toHaveLength(50);
    expect(METRIC_KEYS).not.toContain("orders");
    expect(METRIC_KEYS).toContain("aov_paise");
    for (const key of DERIVED_METRIC_KEYS) {
      expect(METRIC_KEYS).not.toContain(key);
      expect(spec).toContain(key);
    }
    for (const key of METRIC_KEYS) {
      expect(METRIC_KEY_MEANINGS[key].length).toBeGreaterThan(10);
      expect(spec).toContain(key);
      expect(spec).toContain(METRIC_DEFINITIONS[key].definition);
      expect(openapi).toContain(key);
      expect(spec).toContain("docs/metric-dictionary.md");
    }
  });

  it("documents model cost as paise plus the dollar source and the rate", () => {
    expect(spec).toContain("costPaise");
    expect(spec).toContain("costUsdMicros");
    expect(spec).toContain("fxRate");
    expect(spec).toMatch(/model spend only/i);
    expect(spec).toMatch(/computer or server time/i);
    expect(openapi).toContain("costUsdMicros");
    expect(openapi).toContain("fxRate");
    expect(openapi).toContain("/agent/v1/runs");
  });

  it("requires the dollar source and the rate whenever paise is sent", () => {
    const base = {
      runId: "run-1",
      skill: "payout",
      status: "succeeded" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(CreateJobRunSchema.safeParse(base).success).toBe(true);
    expect(CreateJobRunSchema.safeParse({ ...base, costPaise: null }).success).toBe(true);
    const missing = CreateJobRunSchema.safeParse({ ...base, costPaise: 0 });
    expect(missing.success).toBe(false);
    const rateOnly = CreateJobRunSchema.safeParse({ ...base, costPaise: 100, fxRate: 83.5 });
    expect(rateOnly.success).toBe(false);
    const sourceOnly = CreateJobRunSchema.safeParse({
      ...base,
      costPaise: 100,
      costUsdMicros: 12,
    });
    expect(sourceOnly.success).toBe(false);
    expect(
      CreateJobRunSchema.safeParse({
        ...base,
        costPaise: 0,
        costUsdMicros: 0,
        fxRate: 83.25,
      }).success,
    ).toBe(true);
    expect(
      CreateJobRunSchema.safeParse({
        ...base,
        costPaise: 100,
        costUsdMicros: 12,
        fxRate: 0,
      }).success,
    ).toBe(false);
    expect(
      CreateJobRunSchema.safeParse({
        ...base,
        costPaise: 100,
        costUsdMicros: 12.5,
        fxRate: 83,
      }).success,
    ).toBe(false);
  });

  it("rejects a fractional count and a rating above 5", () => {
    const row = {
      outletId: "outlet",
      platform: "zomato" as const,
      granularity: "day" as const,
      periodStart: "2026-01-06T00:00:00.000Z",
      periodEnd: "2026-01-07T00:00:00.000Z",
      key: "delivered_orders" as const,
      value: 1.5,
    };
    expect(
      PutMetricsSchema.safeParse({
        runId: "r",
        source: "s",
        capturedAt: "2026-01-07T00:00:00.000Z",
        rows: [row],
      }).success,
    ).toBe(false);
    expect(
      PutMetricsSchema.safeParse({
        runId: "r",
        source: "s",
        capturedAt: "2026-01-07T00:00:00.000Z",
        rows: [{ ...row, key: "rating", value: 5.1 }],
      }).success,
    ).toBe(false);
    expect(
      PutMetricsSchema.safeParse({
        runId: "r",
        source: "s",
        capturedAt: "2026-01-07T00:00:00.000Z",
        rows: [{ ...row, key: "rating", value: 4.256 }],
      }).success,
    ).toBe(false);
  });

  it("accepts null and checks each key's unit", () => {
    const base = {
      outletId: "outlet",
      platform: "zomato" as const,
      granularity: "week" as const,
      periodStart: "2026-01-06T00:00:00.000+05:30",
      periodEnd: "2026-01-13T00:00:00.000+05:30",
    };
    const body = (row: { key: string; value: number | boolean | null }) => ({
      runId: "r",
      source: "s",
      capturedAt: "2026-01-13T00:00:00.000Z",
      rows: [{ ...base, ...row }],
    });
    expect(PutMetricsSchema.safeParse(body({ key: "delivered_orders", value: null })).success).toBe(
      true,
    );
    expect(PutMetricsSchema.safeParse(body({ key: "lag_banner", value: false })).success).toBe(
      true,
    );
    expect(PutMetricsSchema.safeParse(body({ key: "lag_banner", value: null })).success).toBe(true);
    expect(PutMetricsSchema.safeParse(body({ key: "lag_banner", value: 1 })).success).toBe(false);
    expect(PutMetricsSchema.safeParse(body({ key: "kpt_minutes", value: 16.5 })).success).toBe(
      true,
    );
    expect(PutMetricsSchema.safeParse(body({ key: "kpt_minutes", value: 16.55 })).success).toBe(
      false,
    );
    expect(PutMetricsSchema.safeParse(body({ key: "online_pct", value: 16.53 })).success).toBe(
      true,
    );
    expect(PutMetricsSchema.safeParse(body({ key: "online_pct", value: 100.01 })).success).toBe(
      false,
    );
    expect(PutMetricsSchema.safeParse(body({ key: "ads_roi", value: 150.5 })).success).toBe(true);
    expect(
      PutMetricsSchema.safeParse(body({ key: "gross_sales_paise", value: false })).success,
    ).toBe(false);
    expect(PutMetricsSchema.safeParse(body({ key: "orders", value: 1 })).success).toBe(false);
    expect(PutMetricsSchema.safeParse(body({ key: "fees_incl_gst_paise", value: 1 })).success).toBe(
      false,
    );
    expect(PutMetricsSchema.safeParse(body({ key: "ops_aov_paise", value: 1 })).success).toBe(
      false,
    );
    expect(isPlatformCommandVariable("restaurant_agent_token")).toBe(true);
    expect(isPlatformCommandVariable("restaurant-agent-token")).toBe(true);
    expect(isPlatformCommandVariable("netbird-setup-key")).toBe(false);
  });

  it("keeps the action state machine closed", () => {
    expect(actionTransition("proposed", "executing")).toBe("illegal");
    expect(actionTransition("proposed", "approved")).toBe("ok");
    expect(actionTransition("approved", "approved")).toBe("same");
    expect(actionTransition("executed", "reverted")).toBe("ok");
    expect(actionTransition("reverted", "proposed")).toBe("illegal");
    expect(ACTION_TRANSITIONS.rejected).toEqual([]);
    expect(actionStatusNeedsApproval("approved")).toBe(true);
    expect(actionStatusNeedsApproval("executing")).toBe(true);
    expect(actionStatusNeedsApproval("executed")).toBe(true);
    expect(actionStatusNeedsApproval("rejected")).toBe(false);
  });

  it("names the unknown key and the allowed list", () => {
    const message = unknownMetricKeyMessage(["tips"]);
    expect(message).toContain('"tips"');
    expect(message).toContain("gross_sales_paise");
  });

  it("treats the admin allowlist as verified emails only", () => {
    expect(parsePlatformAdminEmails(" A@Example.com, a@example.com ,,")).toEqual(["a@example.com"]);
    expect(isPlatformAdminEmail("a@example.com", ["a@example.com"], false)).toBe(false);
    expect(isPlatformAdminEmail("A@Example.com", ["a@example.com"], true)).toBe(true);
    expect(isPlatformAdminEmail("other@example.com", ["a@example.com"], true)).toBe(false);
  });

  it("puts the token in one computer env var", () => {
    expect(restaurantComputerEnv("ecom_agent_abc", "https://api.example")).toEqual({
      RESTAURANT_AGENT_TOKEN: "ecom_agent_abc",
      RESTAURANT_AGENT_API_BASE_URL: "https://api.example",
    });
    expect(() => restaurantComputerEnv("secret", "https://api.example")).toThrow();
  });
});
