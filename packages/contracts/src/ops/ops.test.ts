import { describe, expect, it } from "vitest";
import {
  applyDailyAlerts,
  dismissAlert,
  nextReportDelivery,
  snoozeAlert,
  stepAlert,
} from "./alerts.js";
import { composeDailyBrief, viewFromDaily } from "./brief.js";
import { addDays } from "./format.js";
import {
  displayFindings,
  evaluateDaily,
  findingsUseOnlyDailyPrep,
  noCombinedNonSummable,
} from "./rules.js";
import type { AlertOutcome, AlertState, DailyOutlet, OpsAppDay, OpsMetricPoint } from "./types.js";
import {
  ALL_GOOD_CHAR_LIMIT,
  BRIEF_CHAR_LIMIT,
  canSumAcrossApps,
  combinedDailyValue,
  combinedNetSales,
  dailyFix,
  ingestRetryable,
  weeklyRuleSet,
} from "./types.js";

const OUTLET: DailyOutlet = {
  id: "out_sample",
  name: "Sample Kitchen",
  platforms: ["zomato", "swiggy"],
};
const DATE = "2026-11-14";
const WEEK = "2026-11-07";
const OLDER = "2026-10-31";

function point(value: number | null, state: OpsMetricPoint["state"] = "ok"): OpsMetricPoint {
  return { value, state };
}

function day(
  platform: "zomato" | "swiggy",
  date: string,
  metrics: OpsAppDay["metrics"],
  extra: Partial<OpsAppDay> = {},
): OpsAppDay {
  return {
    outletId: OUTLET.id,
    platform,
    date,
    stored: true,
    lagBanner: false,
    ingest: null,
    metrics,
    ...extra,
  };
}

function run(days: OpsAppDay[], outlets: DailyOutlet[] = [OUTLET], date = DATE) {
  return evaluateDaily({ date, outlets, days });
}

function salesPair(current: number, baseline: number, platform: "zomato" | "swiggy" = "zomato") {
  const key = platform === "zomato" ? "ops_sales_paise" : "swiggy_net_sales_paise";
  return [
    day(platform, DATE, { [key]: point(current), delivered_orders: point(20) }),
    day(platform, WEEK, { [key]: point(baseline), delivered_orders: point(20) }),
  ];
}

describe("daily thresholds", () => {
  it("does not add a non-summable metric across apps", () => {
    expect(canSumAcrossApps("delivered_orders")).toBe(true);
    expect(canSumAcrossApps("kpt_minutes")).toBe(false);
    expect(canSumAcrossApps("rating")).toBe(false);
    expect(canSumAcrossApps("delayed_orders_kpt10")).toBe(false);
    expect(canSumAcrossApps("ops_sales_paise")).toBe(false);
    expect(combinedDailyValue("rating", [4.9, 3.1])).toBeNull();
    expect(combinedDailyValue("delivered_orders", [10, 12])).toBe(22);
    expect(combinedNetSales(100, 40)).toBe(140);
  });

  it("fires a sales drop only past 25% and 40%, and only from a ₹3,000 baseline", () => {
    const drop = (current: number, baseline: number) =>
      run(salesPair(current, baseline)).findings.filter((finding) => finding.platform === "zomato");
    expect(drop(300_000, 400_000)).toEqual([]);
    expect(drop(299_900, 400_000)[0]?.severity).toBe("watch");
    expect(drop(240_000, 400_000)[0]?.severity).toBe("watch");
    expect(drop(239_900, 400_000)[0]?.severity).toBe("act_now");
    expect(drop(100_000, 299_900)).toEqual([]);
    expect(drop(100_000, 300_000)[0]?.severity).toBe("act_now");
  });

  it("uses the weekday two weeks back when last week is missing or under the guard", () => {
    const days = [
      day("zomato", DATE, { ops_sales_paise: point(100_000) }),
      day("zomato", WEEK, { ops_sales_paise: point(100_000) }),
      day("zomato", OLDER, { ops_sales_paise: point(400_000) }),
    ];
    const finding = run(days).findings.find((item) => item.platform === "zomato");
    expect(finding?.baselineDate).toBe(OLDER);
    expect(finding?.severity).toBe("act_now");
  });

  it("caps a lag-banner sales drop and zero orders at Watch", () => {
    const dropped = run([
      day(
        "swiggy",
        DATE,
        { swiggy_net_sales_paise: point(100_000), delivered_orders: point(20) },
        { lagBanner: true },
      ),
      day("swiggy", WEEK, { swiggy_net_sales_paise: point(400_000), delivered_orders: point(20) }),
    ]);
    const sales = dropped.findings.find((finding) => finding.code === "d_sales_drop");
    expect(sales?.severity).toBe("watch");
    expect(sales?.provisional).toBe(true);

    const quiet = run([
      day("swiggy", DATE, { delivered_orders: point(0) }, { lagBanner: true }),
      day("swiggy", WEEK, { delivered_orders: point(8) }),
    ]);
    const zero = quiet.findings.find((finding) => finding.code === "d_zero_orders");
    expect(zero?.severity).toBe("watch");
    expect(zero?.provisional).toBe(true);
    const plain = run([
      day("swiggy", DATE, { delivered_orders: point(0) }),
      day("swiggy", WEEK, { delivered_orders: point(5) }),
    ]).findings.find((finding) => finding.code === "d_zero_orders");
    expect(plain?.severity).toBe("act_now");
    expect(
      run([
        day("swiggy", DATE, { delivered_orders: point(0) }),
        day("swiggy", WEEK, { delivered_orders: point(4) }),
      ]).findings,
    ).toEqual([]);
  });

  it("guards rate rules at 15 delivered and 2 bad orders, with strict percent cuts", () => {
    const delayed = (count: number, delivered: number) =>
      run([
        day("zomato", DATE, {
          delayed_orders_kpt10: point(count),
          delivered_orders: point(delivered),
        }),
      ]).findings.find((finding) => finding.code === "d_delayed");
    expect(delayed(2, 25)).toBeUndefined();
    expect(delayed(2, 24)?.severity).toBe("watch");
    expect(delayed(3, 20)?.severity).toBe("watch");
    expect(delayed(4, 20)?.severity).toBe("act_now");
    expect(delayed(2, 14)).toBeUndefined();
    expect(delayed(1, 15)).toBeUndefined();
    expect(delayed(2, 15)?.severity).toBe("watch");

    const bad = (count: number, pct: number, delivered = 15) =>
      run([
        day("zomato", DATE, {
          bad_orders: point(count),
          bad_orders_pct: point(pct),
          delivered_orders: point(delivered),
        }),
      ]).findings.find((finding) => finding.code === "d_bad_orders");
    expect(bad(1, 25)).toBeUndefined();
    expect(bad(2, 12)).toBeUndefined();
    expect(bad(2, 12.01)?.severity).toBe("watch");
    expect(bad(2, 20)?.severity).toBe("watch");
    expect(bad(2, 20.01)?.severity).toBe("act_now");
  });

  it("judges food ready, online, prep, rating, complaints and rejections at their cuts", () => {
    const ready = (pct: number, delivered = 20) =>
      run([
        day("swiggy", DATE, {
          food_ready_accuracy_pct: point(pct),
          delivered_orders: point(delivered),
        }),
      ]).findings.find((finding) => finding.code === "d_food_ready");
    expect(ready(85)).toBeUndefined();
    expect(ready(84.9)?.severity).toBe("watch");
    expect(ready(75)?.severity).toBe("watch");
    expect(ready(74.9)?.severity).toBe("act_now");
    expect(ready(70, 14)).toBeUndefined();

    const online = (pct: number, delivered = 15) =>
      run([
        day("zomato", DATE, { online_pct: point(pct), delivered_orders: point(delivered) }),
      ]).findings.find((finding) => finding.code === "d_online");
    expect(online(85)).toBeUndefined();
    expect(online(84.9)?.severity).toBe("watch");
    expect(online(70)?.severity).toBe("watch");
    expect(online(69.9)?.severity).toBe("act_now");
    expect(online(60, 14)).toBeUndefined();

    const prep = (minutes: number, baseline: number | null) => {
      const days = [day("zomato", DATE, { kpt_minutes: point(minutes) })];
      if (baseline != null) days.push(day("zomato", WEEK, { kpt_minutes: point(baseline) }));
      return run(days).findings.find((finding) => finding.code === "d_prep");
    };
    expect(prep(18, 14)).toBeUndefined();
    expect(prep(18.1, 16.1)?.severity).toBe("watch");
    expect(prep(18.1, 17)).toBeUndefined();
    expect(prep(22, 18)?.severity).toBe("watch");
    expect(prep(22.1, null)?.severity).toBe("act_now");
    expect(
      findingsUseOnlyDailyPrep(run([day("zomato", DATE, { kpt_minutes: point(24) })]).findings),
    ).toBe(true);

    const rating = (value: number, baseline: number | null) => {
      const days = [day("zomato", DATE, { rating: point(value) })];
      if (baseline != null) days.push(day("zomato", WEEK, { rating: point(baseline) }));
      return run(days).findings.find((finding) => finding.code === "d_rating");
    };
    expect(rating(4, 4.04)).toBeUndefined();
    expect(rating(4, 4.05)?.severity).toBe("watch");
    expect(rating(3.99, null)?.severity).toBe("watch");
    expect(rating(3.8, null)?.severity).toBe("watch");
    expect(rating(3.79, null)?.severity).toBe("act_now");

    const complaints = (count: number, delivered: number) =>
      run([
        day("zomato", DATE, { complaints: point(count), delivered_orders: point(delivered) }),
      ]).findings.find((finding) => finding.code === "d_complaints");
    expect(complaints(3, 60)).toBeUndefined();
    expect(complaints(3, 59)?.severity).toBe("watch");
    expect(complaints(6, 60)?.severity).toBe("watch");
    expect(complaints(6, 59)?.severity).toBe("act_now");
    expect(complaints(5, 40)?.severity).toBe("watch");

    const rejected = (count: number, delivered: number) =>
      run([
        day("zomato", DATE, { rejected_orders: point(count), delivered_orders: point(delivered) }),
      ]).findings.find((finding) => finding.code === "d_cancel_reject");
    expect(rejected(3, 60)).toBeUndefined();
    expect(rejected(3, 59)?.severity).toBe("watch");
    expect(rejected(6, 200)?.severity).toBe("act_now");
    expect(rejected(2, 18)?.severity).toBe("act_now");
  });

  it("shows one sales call-out and one prep call-out, and never a combined delayed total", () => {
    const days = [
      day("zomato", DATE, {
        ops_sales_paise: point(570_000),
        delivered_orders: point(15),
        kpt_minutes: point(24),
        delayed_orders_kpt10: point(4),
      }),
      day("zomato", WEEK, { ops_sales_paise: point(1_070_000), kpt_minutes: point(15) }),
      day("swiggy", DATE, {
        swiggy_net_sales_paise: point(720_000),
        delivered_orders: point(18),
        kpt_minutes: point(19),
        delayed_orders_gt10: point(2),
      }),
      day("swiggy", WEEK, { swiggy_net_sales_paise: point(663_000), kpt_minutes: point(14) }),
    ];
    const result = run(days);
    expect(noCombinedNonSummable(result.findings)).toBe(true);
    const shown = displayFindings(result.findings);
    expect(shown.filter((finding) => finding.family === "sales")).toHaveLength(1);
    expect(shown.find((finding) => finding.family === "sales")?.platform).toBe("zomato");
    expect(shown.filter((finding) => finding.family === "prep")).toHaveLength(1);
    expect(shown.find((finding) => finding.family === "prep")?.text).toContain("Zomato");
    expect(shown.find((finding) => finding.family === "prep")?.text).toContain("Swiggy");
    expect(
      result.findings.some(
        (finding) => finding.code === "d_delayed" && finding.platform === "combined",
      ),
    ).toBe(false);
  });

  it("freezes an app that failed to ingest and does not retry a held fetch", () => {
    const held = run([
      day("swiggy", DATE, {}, { stored: false, ingest: { code: "fetch_held", retryable: false } }),
      day("zomato", DATE, { ops_sales_paise: point(1_000_000), delivered_orders: point(20) }),
      day("zomato", WEEK, { ops_sales_paise: point(1_000_000), delivered_orders: point(20) }),
    ]);
    expect(held.findings.some((finding) => finding.platform === "swiggy")).toBe(false);
    expect(held.frozenScopes).toContainEqual({ outletId: OUTLET.id, platform: "swiggy" });
    expect(held.frozenScopes).toContainEqual({ outletId: OUTLET.id, platform: "combined" });
    expect(held.blockers.find((blocker) => blocker.platform === "swiggy")).toMatchObject({
      code: "fetch_held",
      retryable: false,
    });
    expect(held.ready).toBe(true);
    expect(ingestRetryable("fetch_held")).toBe(false);
    expect(ingestRetryable("signed_out")).toBe(true);

    const both = run([
      day("zomato", DATE, {}, { stored: false, ingest: { code: "signed_out", retryable: true } }),
      day(
        "swiggy",
        DATE,
        {},
        { stored: false, ingest: { code: "download_failed", retryable: true } },
      ),
    ]);
    expect(both.ready).toBe(false);
    expect(both.findings).toEqual([]);

    const missing = run([
      day("zomato", DATE, { ops_sales_paise: point(1_120_000), delivered_orders: point(26) }),
      day("zomato", WEEK, { ops_sales_paise: point(1_070_000), delivered_orders: point(20) }),
    ]);
    expect(missing.blockers.find((blocker) => blocker.platform === "swiggy")?.code).toBe(
      "lag_missing",
    );
    expect(missing.ready).toBe(true);
  });

  it("does not treat an updating metric as zero", () => {
    const result = run([
      day("zomato", DATE, {
        ops_sales_paise: point(null, "updating"),
        delivered_orders: point(20),
      }),
      day("zomato", WEEK, { ops_sales_paise: point(400_000) }),
    ]);
    expect(result.findings.some((finding) => finding.code === "d_sales_drop")).toBe(false);
    expect(
      result.holds.some((hold) => hold.code === "d_sales_drop" && hold.reason === "updating"),
    ).toBe(true);
  });
});

describe("alert lifecycle", () => {
  const fire = (severity: "act_now" | "watch", value = 10) =>
    ({
      kind: "fire",
      severity,
      value,
      threshold: 8,
      baselineValue: null,
      text: "Swiggy delayed orders.",
      fixKey: "d_delayed",
      fix: dailyFix("d_delayed", "swiggy"),
      evidence: [],
      provisional: false,
    }) satisfies AlertOutcome;

  const identity = {
    dedupeKey: "daily:d_delayed:out_sample:swiggy",
    ruleCode: "d_delayed",
    family: "d_delayed",
    outletId: "out_sample",
    platform: "swiggy" as const,
  };

  function walk(
    outcomes: Array<{ date: string; outcome: Parameters<typeof stepAlert>[1]["outcome"] }>,
  ) {
    let alert: AlertState | null = null;
    const log: string[] = [];
    for (const step of outcomes) {
      const transition = stepAlert(alert, { date: step.date, ...identity, outcome: step.outcome });
      alert = transition.alert;
      log.push(
        `${step.date}:${transition.events.map((event) => event.kind).join("+") || "frozen"}:${alert?.severity}:${alert?.status}:${alert?.consecutiveDays}:${alert?.occurrences}`,
      );
    }
    return { alert, log };
  }

  it("opens, escalates on the third watch, de-escalates, and resolves after two clear days", () => {
    const { alert, log } = walk([
      { date: "2026-11-01", outcome: fire("watch") },
      { date: "2026-11-02", outcome: fire("watch") },
      { date: "2026-11-03", outcome: fire("watch") },
      { date: "2026-11-04", outcome: fire("watch") },
      { date: "2026-11-05", outcome: fire("watch") },
      { date: "2026-11-06", outcome: { kind: "clear" } },
      { date: "2026-11-07", outcome: { kind: "clear" } },
    ]);
    expect(log[0]).toContain("opened");
    expect(log[2]).toContain("escalated");
    expect(log[4]).toContain("deescalated");
    expect(alert?.status).toBe("resolved");
    expect(alert?.resolvedReason).toBe("cleared");
    expect(alert?.occurrences).toBe(5);
  });

  it("freezes on a missing day, goes stale after seven, and does not double-count a re-run", () => {
    const opened = stepAlert(null, {
      date: "2026-11-01",
      ...identity,
      outcome: fire("watch"),
    }).alert;
    const frozen = stepAlert(opened, {
      date: "2026-11-02",
      ...identity,
      outcome: { kind: "frozen" },
    });
    expect(frozen.alert?.consecutiveDays).toBe(1);
    expect(frozen.alert?.occurrences).toBe(1);
    const again = stepAlert(opened, {
      date: "2026-11-01",
      ...identity,
      outcome: fire("watch", 11),
    });
    expect(again.alert?.occurrences).toBe(1);
    expect(again.alert?.lastValue).toBe(11);
    expect(again.notify).toBe(false);
    const stale = stepAlert(opened, {
      date: "2026-11-08",
      ...identity,
      outcome: { kind: "frozen" },
    });
    expect(stale.alert?.resolvedReason).toBe("stale");
  });

  it("reopens within seven days and stays dismissed", () => {
    const opened = stepAlert(null, { date: "2026-11-01", ...identity, outcome: fire("watch") })
      .alert!;
    const cleared = stepAlert(opened, {
      date: "2026-11-02",
      ...identity,
      outcome: { kind: "clear" },
    }).alert!;
    const resolved = stepAlert(cleared, {
      date: "2026-11-03",
      ...identity,
      outcome: { kind: "clear" },
    }).alert!;
    const back = stepAlert(resolved, { date: "2026-11-06", ...identity, outcome: fire("act_now") });
    expect(back.events[0]?.kind).toBe("reopened");
    expect(back.alert?.severity).toBe("watch");
    expect(back.notifyReason).toBe("back_again");
    const dismissed = dismissAlert(resolved, "2026-11-03");
    const held = stepAlert(dismissed, {
      date: "2026-11-06",
      ...identity,
      outcome: fire("act_now"),
    });
    expect(held.action).toBe("ignore");
    const later = stepAlert(dismissed, {
      date: "2026-11-10",
      ...identity,
      outcome: fire("act_now"),
    });
    expect(later.action).toBe("create");
  });

  it("hides a snoozed Watch and still shows an escalation", () => {
    const opened = stepAlert(null, { date: "2026-11-01", ...identity, outcome: fire("watch") })
      .alert!;
    const snoozed = snoozeAlert(opened, 3, "2026-11-01");
    const quiet = stepAlert(snoozed, { date: "2026-11-02", ...identity, outcome: fire("watch") });
    expect(quiet.notify).toBe(false);
    const loud = stepAlert(
      { ...snoozed, consecutiveDays: 2, book: { ...snoozed.book, ruleSeverity: "watch" } },
      { date: "2026-11-03", ...identity, outcome: fire("watch") },
    );
    expect(loud.alert?.severity).toBe("act_now");
    expect(loud.notify).toBe(true);
  });

  it("keeps one open row per key across a re-run of the same date", () => {
    const first = applyDailyAlerts({
      date: DATE,
      findings: [
        {
          code: "d_delayed",
          family: "d_delayed",
          dedupeKey: identity.dedupeKey,
          outletId: OUTLET.id,
          outletName: OUTLET.name,
          platform: "swiggy",
          severity: "watch",
          provisional: false,
          value: 11,
          threshold: 8,
          baselineValue: null,
          baselineDate: null,
          fixKey: "d_delayed",
          fix: dailyFix("d_delayed", "swiggy"),
          text: "Swiggy delayed orders 2 of 18 delivered (11.1%).",
          evidence: [],
        },
      ],
      clears: [],
      holds: [],
      frozenScopes: [],
      existing: [],
    });
    const second = applyDailyAlerts({
      date: DATE,
      findings: first.alerts.length
        ? [
            {
              code: "d_delayed",
              family: "d_delayed",
              dedupeKey: identity.dedupeKey,
              outletId: OUTLET.id,
              outletName: OUTLET.name,
              platform: "swiggy",
              severity: "watch",
              provisional: false,
              value: 12,
              threshold: 8,
              baselineValue: null,
              baselineDate: null,
              fixKey: "d_delayed",
              fix: dailyFix("d_delayed", "swiggy"),
              text: "Swiggy delayed orders 2 of 18 delivered (11.1%).",
              evidence: [],
            },
          ]
        : [],
      clears: [],
      holds: [],
      frozenScopes: [],
      existing: first.alerts,
    });
    expect(second.alerts[0]?.occurrences).toBe(1);
    expect(second.alerts[0]?.lastValue).toBe(12);
    expect(second.notify).toEqual([]);
  });
});

describe("daily brief", () => {
  const allGood = `*Good morning · Sample Kitchen*
Sat 14 Nov vs Sat 7 Nov · 🟢 Healthy
Net sales ₹18,400 (+6.2%) · Zomato ₹11,200 (+4.7%) · Swiggy ₹7,200 (+8.6%)
42 delivered · AOV ₹438
Week so far (Mon–Sat): ₹1,02,300 (+2.1%)
All good on both apps. Data as of 05:48.`;

  const callouts = `*Good morning · Sample Kitchen*
Sat 14 Nov vs Sat 7 Nov · 🔴 Act now (2) · 🟡 Watch (1)
Net sales ₹12,900 (−25.6%) · Zomato ₹5,700 (−46.7%) · Swiggy ₹7,200 (+8.6%)
33 delivered · AOV ₹391

🔴 Zomato sales down 46.7% vs last Saturday (₹5,700 vs ₹10,700). Fix: confirm the outlet was open and visible on Zomato through dinner.
🔴 Zomato online 68.0% yesterday. Fix: check the outlet stayed online through promised hours; look at the offline log.
🟡 Swiggy delayed orders 2 of 18 delivered (11.1%). Fix: start prep on accept and mark food ready only when it is.
Ongoing: Swiggy food ready below 85% (day 2).
Note: Swiggy figures for Sat may change within 48 hours. Data as of 05:48.`;

  it("matches the all-good and call-out samples and stays inside the length caps", () => {
    const healthy = composeDailyBrief({
      restaurantName: "Sample Kitchen",
      date: DATE,
      baselineDate: WEEK,
      form: "brief",
      onlyApp: null,
      sales: {
        combinedPaise: 1_840_000,
        zomatoPaise: 1_120_000,
        swiggyPaise: 720_000,
        zomatoBaselinePaise: 1_070_000,
        swiggyBaselinePaise: 663_000,
      },
      delivered: 42,
      aovPaise: Math.round(1_840_000 / 42),
      week: { startLabel: "Mon", endLabel: "Sat", currentPaise: 10_230_000, changePct: 2.1 },
      callouts: [],
      ongoing: null,
      resolved: null,
      notes: [],
      dataAsOf: "05:48",
      catchUp: [],
      healthyOutlets: 1,
      outletCount: 1,
    });
    expect(healthy.text).toBe(allGood);
    expect(healthy.chars).toBeLessThanOrEqual(ALL_GOOD_CHAR_LIMIT);
    expect(healthy.chars).toBeLessThanOrEqual(400);

    const loud = composeDailyBrief({
      restaurantName: "Sample Kitchen",
      date: DATE,
      baselineDate: WEEK,
      form: "brief",
      onlyApp: null,
      sales: {
        combinedPaise: 1_290_000,
        zomatoPaise: 570_000,
        swiggyPaise: 720_000,
        zomatoBaselinePaise: 1_070_000,
        swiggyBaselinePaise: 663_000,
      },
      delivered: 33,
      aovPaise: Math.round(1_290_000 / 33),
      week: null,
      callouts: [
        {
          severity: "act_now",
          text: "Zomato sales down 46.7% vs last Saturday (₹5,700 vs ₹10,700).",
          fix: dailyFix("d_sales_drop", "zomato"),
        },
        {
          severity: "act_now",
          text: "Zomato online 68.0% yesterday.",
          fix: dailyFix("d_online", "zomato"),
        },
        {
          severity: "watch",
          text: "Swiggy delayed orders 2 of 18 delivered (11.1%).",
          fix: dailyFix("d_delayed", "swiggy"),
        },
      ],
      ongoing: "Ongoing: Swiggy food ready below 85% (day 2).",
      resolved: null,
      notes: ["Note: Swiggy figures for Sat may change within 48 hours."],
      dataAsOf: "05:48",
      catchUp: [],
      healthyOutlets: 0,
      outletCount: 1,
    });
    expect(loud.text).toBe(callouts);
    expect(loud.chars).toBeLessThanOrEqual(BRIEF_CHAR_LIMIT);
    expect(loud.status).toBe("red");
  });

  it("builds the lag, one-app and both-down briefs from the evaluation", () => {
    const lag = viewFromDaily({
      restaurantName: "Sample Kitchen",
      evaluation: run([
        day("zomato", DATE, { ops_sales_paise: point(1_120_000), delivered_orders: point(26) }),
        day("zomato", WEEK, { ops_sales_paise: point(1_070_000), delivered_orders: point(20) }),
      ]),
    });
    expect(composeDailyBrief(lag).text).toBe(
      "Swiggy's figures for Sat 14 Nov aren't in yet (Swiggy can take up to 48 hours); we'll check them tomorrow. *Zomato only:* net sales ₹11,200 (+4.7%) · 26 delivered. All good on Zomato.",
    );

    const down = composeDailyBrief(
      viewFromDaily({
        restaurantName: "Sample Kitchen",
        evaluation: run([
          day(
            "zomato",
            DATE,
            {},
            { stored: false, ingest: { code: "signed_out", retryable: true } },
          ),
          day(
            "swiggy",
            DATE,
            {},
            { stored: false, ingest: { code: "signed_out", retryable: true } },
          ),
        ]),
      }),
    );
    expect(down.text).toBe("No new data this morning; we'll update this when it lands.");
    expect(down.chars).toBeLessThan(120);

    const one = viewFromDaily({
      restaurantName: "Sample Kitchen",
      evaluation: run([
        day("zomato", DATE, {
          ops_sales_paise: point(1_120_000),
          delivered_orders: point(26),
          online_pct: point(96),
        }),
        day("zomato", WEEK, { ops_sales_paise: point(1_070_000), delivered_orders: point(20) }),
        day("swiggy", DATE, {}, { stored: false, ingest: { code: "signed_out", retryable: true } }),
      ]),
    });
    expect(one.notes.join(" ")).toContain(
      "Swiggy: not updated this morning (login expired, we're reconnecting).",
    );
    expect(one.onlyApp).toBe("Zomato");
  });

  it("cuts a brief at 1,200 characters", () => {
    const text = composeDailyBrief({
      restaurantName: "Sample Kitchen",
      date: DATE,
      baselineDate: WEEK,
      form: "brief",
      onlyApp: null,
      sales: null,
      delivered: null,
      aovPaise: null,
      week: null,
      callouts: Array.from({ length: 6 }, () => ({
        severity: "act_now" as const,
        text: "Zomato sales down 46.7% vs last Saturday (₹5,700 vs ₹10,700).",
        fix: "Confirm the outlet was open and visible on Zomato through dinner and then check the rest of the service.",
      })),
      ongoing: `Ongoing: ${"food ready below 85%, ".repeat(40)}`,
      resolved: null,
      notes: ["Note: Swiggy figures for Sat may change within 48 hours."],
      dataAsOf: "05:48",
      catchUp: [],
      healthyOutlets: 0,
      outletCount: 1,
    });
    expect(text.chars).toBeLessThanOrEqual(BRIEF_CHAR_LIMIT);
    expect(text.text.split("\n").filter((line) => line.startsWith("🔴"))).toHaveLength(3);
  });

  it("bumps the report only when the severity changes or the first ready brief arrives", () => {
    expect(nextReportDelivery(null, { status: "green", ready: true })).toEqual({
      version: 1,
      shouldNotify: true,
      reason: "first",
    });
    expect(nextReportDelivery(null, { status: "amber", ready: false })).toEqual({
      version: 1,
      shouldNotify: false,
      reason: "unchanged",
    });
    expect(
      nextReportDelivery(
        { version: 1, status: "green", ready: true },
        { status: "green", ready: true },
      ),
    ).toMatchObject({ version: 1, shouldNotify: false, reason: "unchanged" });
    expect(
      nextReportDelivery(
        { version: 1, status: "amber", ready: true },
        { status: "red", ready: true },
      ),
    ).toMatchObject({ version: 2, shouldNotify: true, reason: "severity_changed" });
    expect(
      nextReportDelivery(
        { version: 1, status: "amber", ready: false },
        { status: "amber", ready: true },
      ),
    ).toMatchObject({ version: 2, shouldNotify: true, reason: "first" });
  });

  it("leaves weekly and payout evaluation for the next release", () => {
    expect(weeklyRuleSet.evaluate({ weekStart: "2026-11-09" })).toBeNull();
  });

  it("does not put a UTR-like token in a brief", () => {
    const text = composeDailyBrief({
      restaurantName: "Sample Kitchen",
      date: DATE,
      baselineDate: WEEK,
      form: "brief",
      onlyApp: null,
      sales: null,
      delivered: 10,
      aovPaise: 40_000,
      week: null,
      callouts: [],
      ongoing: null,
      resolved: "✓ Swiggy delays back to normal.",
      notes: [],
      dataAsOf: "05:48",
      catchUp: [],
      healthyOutlets: 1,
      outletCount: 1,
    }).text;
    expect(text).toContain("✓ Swiggy delays back to normal.");
    expect(/\b[A-Z0-9]{12,22}\b/.test(text)).toBe(false);
    expect(addDays(DATE, -7)).toBe(WEEK);
  });
});
