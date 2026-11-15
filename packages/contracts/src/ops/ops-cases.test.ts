import { describe, expect, it } from "vitest";
import { applyDailyAlerts, nextReportDelivery, snoozeAlert, stepAlert } from "./alerts.js";
import { composeDailyBrief, viewFromDaily, weekSales } from "./brief.js";
import { DEFAULT_OPS_RULES_CONFIG, resolveOpsRulesConfig } from "./config.js";
import { addDays, businessDayFinished } from "./format.js";
import {
  applyStoredMetric,
  evaluateDaily,
  noCombinedNonSummable,
  noteFailedFetch,
} from "./rules.js";
import type {
  AlertState,
  DailyFinding,
  DailyOutlet,
  OpsAlertSeverity,
  OpsAppDay,
  OpsMetricPoint,
} from "./types.js";
import { dailyFix, ingestBlockerCode, ingestRetryable, OPS_RUNNER_SCHEDULE } from "./types.js";

const DATE = "2026-11-14";
const WEEK = "2026-11-07";
const OLDER = "2026-10-31";
const BOTH: DailyOutlet = { id: "out_test", name: "Test", platforms: ["zomato", "swiggy"] };
const PARK: DailyOutlet = { id: "out_park", name: "Park Street", platforms: ["zomato", "swiggy"] };
const NEW_TOWN: DailyOutlet = { id: "out_new", name: "New Town", platforms: ["zomato", "swiggy"] };

function point(value: number | null, state: OpsMetricPoint["state"] = "ok"): OpsMetricPoint {
  return { value, state };
}

function day(
  outletId: string,
  platform: "zomato" | "swiggy",
  date: string,
  metrics: OpsAppDay["metrics"],
  extra: Partial<OpsAppDay> = {},
): OpsAppDay {
  return {
    outletId,
    platform,
    date,
    stored: true,
    lagBanner: false,
    ingest: null,
    metrics,
    ...extra,
  };
}

function calm(
  outlet: DailyOutlet,
  platform: "zomato" | "swiggy",
  date: string,
  sales = 2_000_000,
  delivered = 40,
): OpsAppDay {
  const metrics: OpsAppDay["metrics"] = {
    delivered_orders: point(delivered),
    online_pct: point(96),
    kpt_minutes: point(12),
    complaints: point(0),
  };
  if (platform === "zomato") {
    metrics.ops_sales_paise = point(sales);
    metrics.delayed_orders_kpt10 = point(0);
    metrics.bad_orders = point(0);
    metrics.bad_orders_pct = point(0);
    metrics.rejected_orders = point(0);
    metrics.rating = point(4.5);
  } else {
    metrics.swiggy_net_sales_paise = point(sales);
    metrics.delayed_orders_gt10 = point(0);
    metrics.restaurant_cancelled_orders = point(0);
    metrics.food_ready_accuracy_pct = point(96);
  }
  return day(outlet.id, platform, date, metrics);
}

function weekSpan(outlet: DailyOutlet, platform: "zomato" | "swiggy"): OpsAppDay[] {
  const days: OpsAppDay[] = [];
  for (let offset = 0; offset < 6; offset += 1) {
    days.push(calm(outlet, platform, addDays("2026-11-09", offset)));
    days.push(calm(outlet, platform, addDays("2026-11-02", offset)));
  }
  return days;
}

function pair(
  outlet: DailyOutlet,
  platform: "zomato" | "swiggy",
  sales = 2_000_000,
  delivered = 40,
): OpsAppDay[] {
  return [
    calm(outlet, platform, DATE, sales, delivered),
    calm(outlet, platform, WEEK, sales, delivered),
  ];
}

interface Probe {
  id: string;
  text: string;
  ready: boolean;
  findings: DailyFinding[];
  keys: { callout: string[]; catchUp: string[]; ongoing: string[] };
  severities: Array<{ key: string; severity: OpsAlertSeverity }>;
}

const probes: Probe[] = [];

function pipeline(input: {
  id: string;
  days: OpsAppDay[];
  outlets?: DailyOutlet[];
  date?: string;
  asOf?: string;
  name?: string;
  existing?: AlertState[];
  capturedOn?: string | null;
  clock?: string | null;
  config?: ReturnType<typeof resolveOpsRulesConfig>;
  outletDays?: Array<{ outletId: string; date: string; status: "closed" | "open" }>;
}) {
  const date = input.date ?? DATE;
  const outlets = input.outlets ?? [BOTH];
  const earlierDate = addDays(date, -1);
  const earlier = evaluateDaily({
    date: earlierDate,
    outlets,
    days: input.days,
    asOf: input.asOf,
    config: input.config,
    outletDays: input.outletDays,
  });
  const current = evaluateDaily({
    date,
    outlets,
    days: input.days,
    asOf: input.asOf,
    config: input.config,
    outletDays: input.outletDays,
  });
  const earlierStep = applyDailyAlerts({
    date: earlierDate,
    findings: earlier.findings,
    clears: earlier.clears,
    holds: earlier.holds,
    frozenScopes: earlier.frozenScopes,
    existing: input.existing ?? [],
    config: input.config,
    connected: outlets,
  });
  const step = applyDailyAlerts({
    date,
    findings: current.findings,
    clears: current.clears,
    holds: current.holds,
    frozenScopes: current.frozenScopes,
    existing: earlierStep.alerts,
    config: input.config,
    connected: outlets,
  });
  const catchUpItems = earlierStep.notify.flatMap((key) => {
    const finding = earlier.findings.find((item) => item.dedupeKey === key);
    const alert = earlierStep.alerts.find((item) => item.dedupeKey === key);
    if (!finding && !alert) return [];
    return [
      {
        dedupeKey: key,
        severity: (alert?.severity ?? finding?.severity ?? "watch") as OpsAlertSeverity,
        text: finding?.text ?? alert?.text ?? "",
        fix: finding?.fix ?? alert?.fix ?? "",
        date: earlierDate,
      },
    ];
  });
  const view = viewFromDaily({
    restaurantName: input.name ?? "Test",
    evaluation: current,
    catchUpItems,
    alerts: step.alerts,
    config: input.config,
    capturedOn: input.capturedOn === undefined ? "2026-11-15" : input.capturedOn,
    dataAsOf: input.clock === undefined ? "05:48" : input.clock,
    week: weekSales(
      date,
      input.days
        .filter((item) => item.stored && !item.ingest)
        .filter(
          (item) =>
            !input.outletDays?.some(
              (row) =>
                row.outletId === item.outletId && row.date === item.date && row.status === "closed",
            ),
        )
        .map((item) => ({
          outletId: item.outletId,
          date: item.date,
          platform: item.platform,
          salesPaise:
            (item.platform === "zomato"
              ? item.metrics.ops_sales_paise
              : item.metrics.swiggy_net_sales_paise
            )?.state === "ok"
              ? ((item.platform === "zomato"
                  ? item.metrics.ops_sales_paise?.value
                  : item.metrics.swiggy_net_sales_paise?.value) ?? null)
              : null,
        })),
      (input.outletDays ?? []).filter((row) => row.status === "closed"),
    ),
    resolved: null,
  });
  const composed = composeDailyBrief(view);
  const shown = new Set(view.callouts.map((callout) => callout.text));
  probes.push({
    id: input.id,
    text: composed.text,
    ready: current.ready,
    findings: current.findings,
    keys: {
      callout: step.alerts
        .filter((alert) =>
          [...shown].some((line) => line.includes(alert.text.replace(/\.$/, "").slice(0, 24))),
        )
        .map((alert) => alert.dedupeKey),
      catchUp: catchUpItems.map((item) => item.dedupeKey),
      ongoing: step.alerts
        .filter((alert) => view.ongoing?.includes(alert.text.replace(/\.$/, "").slice(0, 24)))
        .map((alert) => alert.dedupeKey),
    },
    severities: step.alerts
      .filter((alert) => alert.status !== "resolved")
      .map((alert) => ({ key: alert.dedupeKey, severity: alert.severity })),
  });
  return {
    current,
    earlier,
    step,
    earlierStep,
    view,
    text: composed.text,
    status: composed.status,
  };
}

describe("brief edge cases", () => {
  it("DS-01 normal both apps stored", () => {
    const result = pipeline({
      id: "DS-01",
      days: [...weekSpan(BOTH, "zomato"), ...weekSpan(BOTH, "swiggy")],
    });
    expect(result.text).toContain("*Good morning · Test*");
    expect(result.text).toContain("Sat 14 Nov vs Sat 7 Nov · 🟢 Healthy");
    expect(result.text).toContain("Net sales ₹40,000 (0.0%)");
    expect(result.text).toContain("Zomato ₹20,000 (0.0%)");
    expect(result.text).toContain("Swiggy ₹20,000 (0.0%)");
    expect(result.text).toContain("80 delivered · AOV ₹500");
    expect(result.text).toContain("Week so far (Mon–Sat)");
    expect(result.text).toContain("All good on both apps.");
    expect(result.text).toContain("Data as of Sun 15 Nov, 05:48 IST.");
    expect(result.current.ready).toBe(true);
  });

  it("DS-02 quiet day below the volume guard", () => {
    const days = [
      calm(BOTH, "zomato", DATE, 2_000_000, 14),
      calm(BOTH, "zomato", WEEK, 2_000_000, 40),
      calm(BOTH, "swiggy", DATE, 2_000_000, 40),
      calm(BOTH, "swiggy", WEEK, 2_000_000, 40),
    ];
    const first = days[0];
    if (first) first.metrics.bad_orders = point(0);
    const result = pipeline({ id: "DS-02", days });
    expect(result.current.holds.some((hold) => hold.reason === "guard")).toBe(true);
    expect(result.current.clears.some((clear) => clear.code === "d_bad_orders")).toBe(false);
    expect(result.text).toContain("Too few orders on Zomato yesterday to judge rates.");
  });

  it("DS-03 a second stored zero day is a real alert", () => {
    const zeros = (date: string): OpsAppDay =>
      day(BOTH.id, "zomato", date, {
        ops_sales_paise: point(0),
        delivered_orders: point(0),
        online_pct: point(0),
        rating: point(0),
      });
    const result = pipeline({
      id: "DS-03",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [zeros(DATE), zeros(addDays(DATE, -1)), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
    });
    expect(result.current.snapshots[0]?.apps[0]?.mode).toBe("ready");
    expect(result.text).toContain(
      "🔴 Zomato had no orders on Sat 14 Nov (usually 40). Fix: confirm the outlet was open and visible on Zomato that day.",
    );
  });

  it("DS-04 one app gap", () => {
    const result = pipeline({
      id: "DS-04",
      days: [
        day(BOTH.id, "zomato", DATE, {}, { stored: false, gap: true }),
        calm(BOTH, "zomato", WEEK),
        ...pair(BOTH, "swiggy"),
      ],
    });
    expect(result.text).toContain(
      "Zomato's figures for Sat 14 Nov aren't in yet; we'll check them tomorrow.",
    );
    expect(result.text).not.toContain("🟢 Healthy");
    expect(result.current.blockers.some((blocker) => blocker.code === "lag_missing")).toBe(true);
  });

  it("DS-04 both apps gap", () => {
    const result = pipeline({
      id: "DS-04b",
      days: [
        day(BOTH.id, "zomato", DATE, {}, { stored: false, gap: true }),
        day(BOTH.id, "swiggy", DATE, {}, { stored: false, gap: true }),
      ],
    });
    expect(result.text).toBe("No new data this morning; we'll update this when it lands.");
    expect(result.current.ready).toBe(false);
  });

  it("DS-05 no row and no fetch", () => {
    const result = pipeline({
      id: "DS-05",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", WEEK)],
    });
    expect(result.text).toContain(
      "Zomato's figures for Sat 14 Nov aren't in yet; we'll check them tomorrow.",
    );
    expect(result.text).not.toContain("🟢 Healthy");
    expect(result.text).not.toContain("not updated this morning");
  });

  it("DS-06 stored zeros inside the wait window", () => {
    const result = pipeline({
      id: "DS-06",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [
        day(BOTH.id, "zomato", DATE, {
          ops_sales_paise: point(0),
          delivered_orders: point(0),
          online_pct: point(0),
          rating: point(0),
        }),
        calm(BOTH, "zomato", WEEK),
      ],
    });
    expect(result.current.snapshots[0]?.apps[0]?.mode).toBe("ready");
    expect(result.current.findings.some((finding) => finding.code === "d_zero_orders")).toBe(false);
    expect(result.text).toContain(
      "Test (Zomato) had 0 orders on Sat 14 Nov: either it was closed or the app hasn't updated yet. Was it closed or open?",
    );
    expect(result.text).not.toContain("aren't in yet");
    expect(result.text).not.toContain("had no orders");
    expect(result.current.ownerQuestions).toEqual([
      { outletId: BOTH.id, platform: "zomato", date: DATE, kind: "zero_day" },
    ]);
  });

  it("DS-07 online 0 with orders", () => {
    const result = pipeline({
      id: "DS-07",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [
        day(BOTH.id, "zomato", DATE, {
          ops_sales_paise: point(2_000_000),
          delivered_orders: point(40),
          online_pct: point(0),
          rating: point(4.5),
          delayed_orders_kpt10: point(0),
          bad_orders: point(0),
          complaints: point(0),
          kpt_minutes: point(12),
        }),
        calm(BOTH, "zomato", WEEK),
      ],
    });
    expect(result.current.findings.some((finding) => finding.code === "d_online")).toBe(false);
    expect(result.current.findings.some((finding) => finding.code === "d_sales_drop")).toBe(false);
    expect(result.text).toContain("Zomato online time not reported for Sat.");
    expect(result.current.snapshots[0]?.apps[0]?.mode).toBe("ready");
  });

  it("DS-08 a second offline day is a real alert", () => {
    const offline = (date: string): OpsAppDay =>
      day(BOTH.id, "zomato", date, {
        ops_sales_paise: point(2_000_000),
        delivered_orders: point(0),
        online_pct: point(0),
        rating: point(4.2),
      });
    const first = evaluateDaily({
      date: addDays(DATE, -1),
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [offline(addDays(DATE, -1)), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
    });
    expect(first.findings.some((finding) => finding.code === "d_online")).toBe(false);
    expect(first.ownerQuestions).toHaveLength(1);
    const result = pipeline({
      id: "DS-08",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [offline(DATE), offline(addDays(DATE, -1)), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
    });
    expect(result.text).toContain(
      "🔴 Zomato was offline all day Sat 14 Nov (0 orders, usually 40).",
    );
    expect(result.step.alerts.find((alert) => alert.ruleCode === "d_online")?.severity).toBe(
      "act_now",
    );
  });

  it("DS-09 Swiggy missing keeps catch-up", () => {
    const late = calm(BOTH, "swiggy", addDays(DATE, -1), 200_000, 40);
    late.metrics.food_ready_accuracy_pct = point(70);
    const result = pipeline({
      id: "DS-09",
      days: [...pair(BOTH, "zomato"), calm(BOTH, "swiggy", WEEK), late],
    });
    expect(result.text).toContain("Swiggy pending");
    expect(result.text).toContain("Swiggy's figures for Sat 14 Nov aren't in yet");
    expect(result.text).toContain("Fri 13 Nov · Swiggy");
    expect(result.text).not.toContain("*Zomato only:*");
    expect(result.text).toContain("🔴");
  });

  it("DS-10 Swiggy D with no banner is provisional", () => {
    const result = pipeline({
      id: "DS-10",
      days: [
        calm(BOTH, "swiggy", DATE, 200_000, 20),
        calm(BOTH, "swiggy", WEEK, 2_000_000, 40),
        ...pair(BOTH, "zomato"),
      ],
    });
    const sales = result.current.findings.find(
      (finding) => finding.code === "d_sales_drop" && finding.platform === "swiggy",
    );
    expect(sales?.provisional).toBe(true);
    expect(sales?.severity).toBe("watch");
    expect(result.text).toContain("Note: Swiggy figures for Sat may change within 48 hours.");
  });

  it("DS-11 Zomato half day is provisional", () => {
    const result = pipeline({
      id: "DS-11",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000, 10), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
    });
    const sales = result.current.findings.find((finding) => finding.code === "d_sales_drop");
    expect(sales?.provisional).toBe(true);
    expect(sales?.severity).toBe("watch");
  });

  it("DS-12 restate lower and higher", () => {
    const opened = stepAlert(null, {
      date: DATE,
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 12,
        threshold: 8,
        baselineValue: null,
        text: "Swiggy delayed 12.0%.",
        fixKey: "d_delayed",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert;
    const lower = stepAlert(opened, {
      date: DATE,
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 9,
        threshold: 8,
        baselineValue: null,
        text: "Swiggy delayed 9.0%.",
        fixKey: "d_delayed",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    });
    expect(lower.notify).toBe(false);
    expect(lower.alert?.lastValue).toBe(9);
    const higher = stepAlert(lower.alert, {
      date: DATE,
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "act_now",
        value: 20,
        threshold: 15,
        baselineValue: null,
        text: "Swiggy delayed 20.0%.",
        fixKey: "d_delayed",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    });
    expect(higher.notifyReason).toBe("escalated");
  });

  it("DS-13 older revision does not move alerts", () => {
    const opened = stepAlert(null, {
      date: DATE,
      dedupeKey: "daily:d_sales_drop:out_test:zomato",
      ruleCode: "d_sales_drop",
      family: "sales",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 30,
        threshold: 25,
        baselineValue: null,
        text: "Zomato sales down.",
        fixKey: "d_sales_drop",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const older = stepAlert(opened, {
      date: addDays(DATE, -3),
      dedupeKey: opened.dedupeKey,
      ruleCode: "d_sales_drop",
      family: "sales",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: { kind: "clear" },
    });
    expect(older.action).toBe("ignore");
    expect(older.alert?.lastValue).toBe(30);
  });

  it("DS-14 one app failed is not healthy", () => {
    const result = pipeline({
      id: "DS-14",
      days: [
        day(
          BOTH.id,
          "zomato",
          DATE,
          {},
          { stored: false, ingest: { code: "download_failed", retryable: true } },
        ),
        ...pair(BOTH, "swiggy"),
      ],
    });
    expect(result.text).toContain("Zomato: not updated this morning (the download failed).");
    expect(result.text).not.toContain("🟢 Healthy");
    expect(
      result.current.blockers.find((blocker) => blocker.platform === "zomato")?.retryable,
    ).toBe(true);
  });

  it("DS-15 login expired", () => {
    const result = pipeline({
      id: "DS-15",
      days: [
        ...pair(BOTH, "zomato"),
        day(
          BOTH.id,
          "swiggy",
          DATE,
          {},
          { stored: false, ingest: { code: "signed_out", retryable: true } },
        ),
      ],
    });
    expect(result.text).toContain(
      "Swiggy: not updated this morning (login expired, we're reconnecting).",
    );
    expect(result.text).not.toContain("🟢 Healthy");
  });

  it("DS-16 layout_changed is its own blocker", () => {
    expect(ingestBlockerCode("layout_changed")).toBe("layout_changed");
    expect(ingestBlockerCode("layout_changed")).not.toBe("days_missing");
    expect(ingestRetryable("layout_changed")).toBe(false);
    const result = pipeline({
      id: "DS-16",
      days: [
        day(
          BOTH.id,
          "zomato",
          DATE,
          {},
          { stored: false, ingest: { code: "layout_changed", retryable: false } },
        ),
        ...pair(BOTH, "swiggy"),
      ],
    });
    expect(result.current.blockers.find((blocker) => blocker.platform === "zomato")).toMatchObject({
      code: "layout_changed",
      retryable: false,
    });
    expect(result.text).toContain(
      "Zomato: not updated this morning (Zomato changed its report; we're fixing it).",
    );
  });

  it("DS-17 held fetch wording", () => {
    const result = pipeline({
      id: "DS-17",
      days: [
        ...pair(BOTH, "zomato"),
        day(
          BOTH.id,
          "swiggy",
          DATE,
          {},
          { stored: false, ingest: { code: "fetch_held", retryable: false } },
        ),
      ],
    });
    expect(result.text).toContain(
      "Swiggy: updates paused while we double-check the account; our team is on it.",
    );
    expect(
      result.current.blockers.find((blocker) => blocker.platform === "swiggy")?.retryable,
    ).toBe(false);
  });

  it("DS-18 needs owner", () => {
    const result = pipeline({
      id: "DS-18",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [
        day(
          BOTH.id,
          "zomato",
          DATE,
          {},
          { stored: false, ingest: { code: "needs_owner", retryable: false } },
        ),
      ],
    });
    expect(result.text).toContain("We need you to reconnect the account; we'll message you.");
  });

  it("DS-19 updating prep time", () => {
    const current = calm(BOTH, "zomato", DATE);
    current.metrics.kpt_minutes = point(null, "updating");
    const result = pipeline({
      id: "DS-19",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [current, calm(BOTH, "zomato", WEEK)],
    });
    expect(
      result.current.holds.some((hold) => hold.code === "d_prep" && hold.reason === "updating"),
    ).toBe(true);
    expect(result.text).toContain("Zomato prep time is being re-read after a report change.");
  });

  it("DS-20 not_available is held silently", () => {
    const current = calm(BOTH, "zomato", DATE);
    current.metrics.rating = point(null, "not_available");
    const evaluated = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [current, calm(BOTH, "zomato", WEEK)],
    });
    expect(
      evaluated.holds.some((hold) => hold.code === "d_rating" && hold.reason === "missing"),
    ).toBe(true);
    expect(evaluated.findings.some((finding) => finding.code === "d_rating")).toBe(false);
  });

  it("DS-21 one app connected", () => {
    const result = pipeline({
      id: "DS-21",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: pair(BOTH, "zomato"),
    });
    expect(result.text).toContain("🟢 Healthy");
    expect(result.text).toContain("All good on Zomato.");
    expect(result.text).not.toContain("Swiggy");
    expect(result.current.findings.some((finding) => finding.platform === "combined")).toBe(false);
  });

  it("DS-22 neither app connected", () => {
    const result = pipeline({
      id: "DS-22",
      outlets: [{ id: "out_test", name: "Test", platforms: [] }],
      days: [],
    });
    expect(result.text).toBe("Connect Zomato or Swiggy to get your morning brief.");
    expect(result.current.ready).toBe(false);
    expect(nextReportDelivery(null, { status: result.status, ready: false }).shouldNotify).toBe(
      false,
    );
  });

  it("DS-23 no history yet", () => {
    const result = pipeline({
      id: "DS-23",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE)],
    });
    expect(result.text).toContain("Sat 14 Nov · 🟢 Healthy");
    expect(result.text).not.toContain(" vs ");
    expect(result.text).toContain("Comparisons start once we have a week of history.");
    expect(result.current.findings.some((finding) => finding.code === "d_sales_drop")).toBe(false);
  });

  it("DS-24 rating 0 is not a blank day", () => {
    const current = calm(BOTH, "zomato", DATE);
    current.metrics.rating = point(0);
    const result = pipeline({
      id: "DS-24",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [current, calm(BOTH, "zomato", WEEK)],
    });
    expect(result.current.snapshots[0]?.apps[0]?.mode).toBe("ready");
    expect(result.current.findings.some((finding) => finding.code === "d_rating")).toBe(false);
    expect(result.text).toContain("🟢 Healthy");
  });

  it("DS-25 first run has no catch-up", () => {
    const result = pipeline({
      id: "DS-25",
      days: [...pair(BOTH, "zomato"), ...pair(BOTH, "swiggy")],
    });
    expect(result.earlierStep.notify).toEqual([]);
    expect(result.view.catchUp).toEqual([]);
    expect(result.text).not.toContain("back to normal");
  });

  it("DS-26 comparison two weeks back", () => {
    const result = pipeline({
      id: "DS-26",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [
        calm(BOTH, "zomato", DATE, 200_000),
        day(BOTH.id, "zomato", WEEK, {
          ops_sales_paise: point(100_000),
          delivered_orders: point(20),
        }),
        calm(BOTH, "zomato", OLDER, 2_000_000),
      ],
    });
    expect(result.text).toContain("vs Sat 31 Oct (two weeks back)");
    expect(
      result.current.findings.find((finding) => finding.code === "d_sales_drop")?.text,
    ).toContain("vs Sat 31 Oct");
    expect(
      result.current.findings.find((finding) => finding.code === "d_sales_drop")?.text,
    ).not.toContain("last Saturday");
  });

  it("DS-27 a partial comparison day is not the baseline", () => {
    const partialWeek = calm(BOTH, "zomato", WEEK, 100_000, 5);
    const fullOlder = calm(BOTH, "zomato", OLDER, 2_000_000, 40);
    const priorToWeek = calm(BOTH, "zomato", addDays(WEEK, -7), 2_000_000, 40);
    const evaluated = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 2_000_000, 40), partialWeek, fullOlder, priorToWeek],
    });
    expect(
      evaluated.findings.find((finding) => finding.code === "d_sales_drop")?.baselineDate,
    ).not.toBe(WEEK);
  });

  it("DS-28 a banner-only row is not stored", () => {
    const stored = day(BOTH.id, "swiggy", DATE, {});
    stored.stored = false;
    applyStoredMetric(stored, {
      key: "lag_banner",
      value: null,
      state: "ok",
      rowRole: "fact",
      valueBoolean: true,
    });
    expect(stored.lagBanner).toBe(true);
    expect(stored.stored).toBe(false);
  });

  it("DS-29 fact wins over platform_check", () => {
    const stored = day(BOTH.id, "zomato", DATE, {});
    stored.stored = false;
    applyStoredMetric(stored, {
      key: "online_pct",
      value: 40,
      state: "ok",
      rowRole: "platform_check",
    });
    applyStoredMetric(stored, { key: "online_pct", value: 96, state: "ok", rowRole: "fact" });
    expect(stored.metrics.online_pct?.value).toBe(96);
  });

  it("DS-30 stored data wins over a later failed fetch", () => {
    const stored = calm(BOTH, "swiggy", DATE);
    noteFailedFetch(stored, "download_failed");
    expect(stored.ingest).toBeNull();
    expect(stored.stored).toBe(true);
  });

  it("DS-31 a future date is not finished", () => {
    expect(businessDayFinished("2026-11-15", "2026-11-15")).toBe(false);
    expect(businessDayFinished("2026-11-14", "2026-11-15")).toBe(true);
  });

  it("DS-32 both apps failed", () => {
    const result = pipeline({
      id: "DS-32",
      days: [
        day(
          BOTH.id,
          "zomato",
          DATE,
          {},
          { stored: false, ingest: { code: "download_failed", retryable: true } },
        ),
        day(
          BOTH.id,
          "swiggy",
          DATE,
          {},
          { stored: false, ingest: { code: "download_failed", retryable: true } },
        ),
      ],
    });
    expect(result.text).toBe("No new data this morning; we'll update this when it lands.");
    expect(result.current.ready).toBe(false);
    expect(nextReportDelivery(null, { status: "amber", ready: false }).shouldNotify).toBe(false);
  });

  it("BS-01 rates stay on the outlet", () => {
    const park = calm(PARK, "zomato", DATE, 2_000_000, 40);
    park.metrics.online_pct = point(60);
    const result = pipeline({
      id: "BS-01",
      outlets: [PARK, NEW_TOWN],
      days: [
        park,
        calm(PARK, "zomato", WEEK),
        ...pair(NEW_TOWN, "zomato"),
        ...pair(PARK, "swiggy"),
        ...pair(NEW_TOWN, "swiggy"),
      ],
    });
    expect(result.text).toContain("Park Street:");
    expect(result.current.findings.filter((finding) => finding.code === "d_online")).toHaveLength(
      1,
    );
  });

  it("BS-02 missing outlet app is excluded", () => {
    const result = pipeline({
      id: "BS-02",
      outlets: [PARK, NEW_TOWN],
      days: [
        ...pair(PARK, "zomato", 2_600_000),
        ...pair(PARK, "swiggy", 2_600_000),
        day(NEW_TOWN.id, "zomato", DATE, {}, { stored: false, gap: true }),
        calm(NEW_TOWN, "zomato", WEEK),
        ...pair(NEW_TOWN, "swiggy", 2_600_000),
      ],
    });
    expect(result.text).toContain("excl. New Town Zomato, not in yet");
    expect(result.view.healthyOutlets).toBe(1);
  });

  it("BS-03 one line per outlet that is not healthy", () => {
    const park = calm(PARK, "zomato", DATE, 200_000, 40);
    park.metrics.online_pct = point(60);
    const town = calm(NEW_TOWN, "swiggy", DATE, 2_000_000, 40);
    town.metrics.food_ready_accuracy_pct = point(80);
    const result = pipeline({
      id: "BS-03",
      outlets: [PARK, NEW_TOWN, { id: "out_quiet", name: "Quiet", platforms: ["zomato"] }],
      days: [
        park,
        calm(PARK, "zomato", WEEK, 2_000_000, 40),
        ...pair(PARK, "swiggy"),
        town,
        calm(NEW_TOWN, "swiggy", WEEK),
        ...pair(NEW_TOWN, "zomato"),
        ...pair({ id: "out_quiet", name: "Quiet", platforms: ["zomato"] }, "zomato"),
      ],
    });
    expect(result.view.outletSummary).toContain("Park Street:");
    expect(result.text).toContain("outlets healthy");
  });

  it("BS-04 the same rule on both apps is shown twice", () => {
    const zomato = calm(BOTH, "zomato", DATE);
    zomato.metrics.delayed_orders_kpt10 = point(8);
    const swiggy = calm(BOTH, "swiggy", DATE);
    swiggy.metrics.delayed_orders_gt10 = point(8);
    const result = pipeline({
      id: "BS-04",
      days: [zomato, calm(BOTH, "zomato", WEEK), swiggy, calm(BOTH, "swiggy", WEEK)],
    });
    const delayed = result.current.findings.filter((finding) => finding.code === "d_delayed");
    expect(delayed.map((finding) => finding.platform).sort()).toEqual(["swiggy", "zomato"]);
    expect(result.text).toContain("Zomato");
    expect(result.text).toContain("Swiggy");
  });

  it("BS-05 one sales call-out names the app and the total", () => {
    const result = pipeline({
      id: "BS-05",
      days: [
        calm(BOTH, "zomato", DATE, 800_000),
        calm(BOTH, "zomato", WEEK, 2_000_000),
        calm(BOTH, "swiggy", DATE, 1_500_000),
        calm(BOTH, "swiggy", WEEK, 2_000_000),
      ],
    });
    const lines = result.text.split("\n").filter((line) => line.includes("sales down"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Zomato sales down");
    expect(lines[0]).toContain("total down");
    expect(lines[0]).not.toContain("Both apps");
  });

  it("BS-06 an empty holiday list does not soften a drop", () => {
    expect(DEFAULT_OPS_RULES_CONFIG.holidayDates).toEqual([]);
    const result = pipeline({
      id: "BS-06",
      date: "2026-11-08",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [
        calm(BOTH, "zomato", "2026-11-08", 200_000),
        calm(BOTH, "zomato", "2026-11-01", 2_000_000),
      ],
    });
    expect(result.text).not.toContain("festival week");
    expect(
      result.current.findings.find((finding) => finding.code === "d_sales_drop")?.severity,
    ).toBe("act_now");
  });

  it("BS-07 week line pairs the same app and names the missing day", () => {
    const friday = "2026-11-13";
    const days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", friday].flatMap(
      (date) => [
        calm(BOTH, "zomato", date, 1_000_000),
        calm(BOTH, "zomato", addDays(date, -7), 1_000_000),
      ],
    );
    const week = weekSales(
      DATE,
      days.map((item) => ({
        date: item.date,
        platform: item.platform,
        salesPaise: item.metrics.ops_sales_paise?.value ?? null,
      })),
    );
    expect(week?.startLabel).toBe("Mon");
    expect(week?.endLabel).toBe("Fri");
    expect(week?.pendingLabel).toBe("Sat not in yet");
  });

  it("BS-08 no week line on Monday", () => {
    expect(weekSales("2026-11-09", [{ date: "2026-11-09", salesPaise: 100 }])).toBeNull();
  });

  it("BS-09 Sunday week line runs through Sunday", () => {
    const week = weekSales("2026-11-15", [
      { date: "2026-11-09", platform: "zomato", salesPaise: 100 },
      { date: "2026-11-02", platform: "zomato", salesPaise: 100 },
      { date: "2026-11-15", platform: "zomato", salesPaise: 100 },
      { date: "2026-11-08", platform: "zomato", salesPaise: 100 },
    ]);
    expect(week?.startLabel).toBe("Mon");
    expect(week?.endLabel).toBe("Sun");
    expect(week?.pendingLabel).toBeNull();
  });

  it("BS-10 month and year boundaries stay civil days", () => {
    const result = pipeline({
      id: "BS-10",
      date: "2026-11-01",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [
        calm(BOTH, "zomato", "2026-11-01", 200_000),
        calm(BOTH, "zomato", "2026-10-25", 2_000_000),
      ],
    });
    expect(result.text).toContain("Sun 1 Nov vs Sun 25 Oct");
    const year = pipeline({
      id: "BS-10b",
      date: "2026-12-31",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", "2026-12-31"), calm(BOTH, "zomato", "2026-12-24")],
    });
    expect(year.text).toContain("Thu 31 Dec vs Thu 24 Dec");
  });

  it("BS-11 a disconnected app resolves scope_removed", () => {
    const opened = stepAlert(null, {
      date: WEEK,
      dedupeKey: "daily:d_online:out_test:swiggy",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 60,
        threshold: 85,
        baselineValue: null,
        text: "Swiggy online 60.0% on Sat.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const step = applyDailyAlerts({
      date: DATE,
      findings: [],
      clears: [],
      holds: [],
      frozenScopes: [],
      existing: [opened],
      connected: [{ id: BOTH.id, platforms: ["zomato"] }],
    });
    expect(step.alerts[0]?.resolvedReason).toBe("scope_removed");
    expect(step.notify).toEqual([]);
  });

  it("BS-12 a late Swiggy line is dated and counted", () => {
    const friday = calm(BOTH, "swiggy", addDays(DATE, -1), 2_000_000, 40);
    friday.metrics.food_ready_accuracy_pct = point(78);
    const result = pipeline({
      id: "BS-12",
      days: [...pair(BOTH, "zomato"), friday, calm(BOTH, "swiggy", addDays(WEEK, -1))],
    });
    expect(result.text).toContain("Fri 13 Nov · Swiggy");
    expect(result.text).toMatch(/🔴|🟡/);
  });

  it("AL-01 a new alert is a call-out", () => {
    const result = pipeline({
      id: "AL-01",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK, 2_000_000)],
    });
    expect(result.step.opened.length).toBeGreaterThan(0);
    expect(result.text).toContain("🔴");
    expect(result.step.notify.length).toBeGreaterThan(0);
  });

  it("AL-02 one open row per key", () => {
    const first = pipeline({
      id: "AL-02",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK)],
    });
    const second = pipeline({
      id: "AL-02b",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK)],
      existing: first.step.alerts,
    });
    expect(second.step.alerts.filter((alert) => alert.status !== "resolved")).toHaveLength(
      first.step.alerts.filter((alert) => alert.status !== "resolved").length,
    );
  });

  it("AL-03 a held watch shows Act now", () => {
    let alert: AlertState | null = null;
    for (const date of ["2026-11-01", "2026-11-02", "2026-11-03"]) {
      alert = stepAlert(alert, {
        date,
        dedupeKey: "daily:d_food_ready:out_test:swiggy",
        ruleCode: "d_food_ready",
        family: "d_food_ready",
        outletId: BOTH.id,
        platform: "swiggy",
        outcome: {
          kind: "fire",
          severity: "watch",
          value: 80,
          threshold: 85,
          baselineValue: null,
          text: "Swiggy food ready 80.0%.",
          fixKey: "d_food_ready",
          fix: dailyFix("d_food_ready", "swiggy"),
          evidence: [],
          provisional: false,
        },
      }).alert;
    }
    expect(alert?.severity).toBe("act_now");
    expect(alert?.book.heldEscalation).toBe(true);
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({
        date: "2026-11-03",
        outlets: [BOTH],
        days: pair(BOTH, "swiggy"),
      }),
      alerts: alert ? [alert] : [],
    });
    expect(view.callouts[0]?.text).toContain("(held 3 days)");
    expect(view.callouts[0]?.severity).toBe("act_now");
  });

  it("AL-04 a held escalation stays Act now", () => {
    let alert: AlertState | null = null;
    let escalations = 0;
    for (let index = 0; index < 9; index += 1) {
      const transition = stepAlert(alert, {
        date: addDays("2026-11-01", index),
        dedupeKey: "daily:d_food_ready:out_test:swiggy",
        ruleCode: "d_food_ready",
        family: "d_food_ready",
        outletId: BOTH.id,
        platform: "swiggy",
        outcome: {
          kind: "fire",
          severity: "watch",
          value: 80,
          threshold: 85,
          baselineValue: null,
          text: "Swiggy food ready 80.0%.",
          fixKey: "d_food_ready",
          fix: "Fix.",
          evidence: [],
          provisional: false,
        },
      });
      if (transition.notifyReason === "escalated") escalations += 1;
      alert = transition.alert;
    }
    expect(escalations).toBe(1);
    expect(alert?.severity).toBe("act_now");
  });

  it("AL-05 a level drop de-escalates after two watch days", () => {
    let alert: AlertState | null = null;
    const outcomes: Array<"act_now" | "watch"> = ["act_now", "watch", "watch"];
    const kinds: string[] = [];
    for (const [index, severity] of outcomes.entries()) {
      const transition = stepAlert(alert, {
        date: addDays("2026-11-01", index),
        dedupeKey: "daily:d_online:out_test:zomato",
        ruleCode: "d_online",
        family: "d_online",
        outletId: BOTH.id,
        platform: "zomato",
        outcome: {
          kind: "fire",
          severity,
          value: 60,
          threshold: 70,
          baselineValue: null,
          text: "Zomato online.",
          fixKey: "d_online",
          fix: "Fix.",
          evidence: [],
          provisional: false,
        },
      });
      kinds.push(...transition.events.map((event) => event.kind));
      alert = transition.alert;
    }
    expect(kinds).toContain("deescalated");
    expect(alert?.severity).toBe("watch");
  });

  it("AL-06 two clear days resolve", () => {
    const opened = stepAlert(null, {
      date: "2026-11-01",
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 10,
        threshold: 8,
        baselineValue: null,
        text: "Swiggy delayed.",
        fixKey: "d_delayed",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert;
    const once = stepAlert(opened, {
      date: "2026-11-02",
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: { kind: "clear" },
    }).alert;
    const twice = stepAlert(once, {
      date: "2026-11-03",
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: { kind: "clear" },
    });
    expect(twice.alert?.resolvedReason).toBe("cleared");
  });

  it("AL-07 a stale alert adds an in-app note", () => {
    const opened = stepAlert(null, {
      date: "2026-11-01",
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 60,
        threshold: 85,
        baselineValue: null,
        text: "Zomato online 60.0% on Sat.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const stale = stepAlert(opened, {
      date: "2026-11-08",
      dedupeKey: opened.dedupeKey,
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: { kind: "frozen" },
    }).alert!;
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({
        date: "2026-11-08",
        outlets: [{ ...BOTH, platforms: ["zomato"] }],
        days: [],
      }),
      alerts: [stale],
    });
    expect(stale.resolvedReason).toBe("stale");
    expect(view.notes.join(" ")).toContain(
      "Stopped tracking Zomato online 60.0% on Sat (no data for 7 days).",
    );
  });

  it("AL-08 catch-up is only what the earlier step notified", () => {
    const friday = calm(BOTH, "swiggy", addDays(DATE, -1), 200_000, 40);
    const result = pipeline({
      id: "AL-08",
      days: [
        ...pair(BOTH, "zomato"),
        friday,
        calm(BOTH, "swiggy", addDays(WEEK, -1), 2_000_000, 40),
      ],
    });
    expect(result.view.catchUp.length).toBe(result.earlierStep.notify.length);
    expect(result.text).not.toContain("Sat 14 Nov: Zomato");
  });

  it("AL-09 ongoing includes a frozen alert", () => {
    const opened = stepAlert(null, {
      date: "2026-11-12",
      dedupeKey: "daily:d_food_ready:out_test:swiggy",
      ruleCode: "d_food_ready",
      family: "d_food_ready",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "act_now",
        value: 73.1,
        threshold: 75,
        baselineValue: null,
        text: "Swiggy food ready 73.1%.",
        fixKey: "d_food_ready",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    opened.consecutiveDays = 4;
    const frozen = stepAlert(opened, {
      date: DATE,
      dedupeKey: opened.dedupeKey,
      ruleCode: "d_food_ready",
      family: "d_food_ready",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: { kind: "frozen" },
    }).alert!;
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({ date: DATE, outlets: [BOTH], days: pair(BOTH, "zomato") }),
      alerts: [frozen],
    });
    expect(view.ongoing).toContain("🔴 Swiggy food ready 73.1%");
    expect(view.ongoing).toContain("Thu");
  });

  it("AL-10 reopen keeps the previous severity", () => {
    const opened = stepAlert(null, {
      date: "2026-11-01",
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 80,
        threshold: 85,
        baselineValue: null,
        text: "Zomato online 80.0% on Sat.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const cleared = stepAlert(opened, {
      date: "2026-11-02",
      dedupeKey: opened.dedupeKey,
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: { kind: "clear" },
    }).alert!;
    const resolved = stepAlert(cleared, {
      date: "2026-11-03",
      dedupeKey: opened.dedupeKey,
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: { kind: "clear" },
    }).alert!;
    resolved.lastNotifiedAt = "2026-11-03";
    const quiet = stepAlert(resolved, {
      date: "2026-11-04",
      dedupeKey: opened.dedupeKey,
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "act_now",
        value: 50,
        threshold: 70,
        baselineValue: null,
        text: "Zomato online 50.0% on Tue.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    });
    expect(quiet.alert?.severity).toBe("watch");
    expect(quiet.alert?.book.quiet).toBe(true);
    expect(quiet.notify).toBe(false);
  });

  it("AL-11 a frozen day does not escalate", () => {
    const opened = stepAlert(null, {
      date: "2026-11-01",
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 80,
        threshold: 85,
        baselineValue: null,
        text: "online",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const frozen = stepAlert(opened, {
      date: "2026-11-02",
      dedupeKey: opened.dedupeKey,
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: { kind: "frozen" },
    });
    expect(frozen.notify).toBe(false);
    expect(frozen.alert?.consecutiveDays).toBe(1);
  });

  it("AL-12 a same-day re-run does not double count", () => {
    const opened = stepAlert(null, {
      date: DATE,
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 10,
        threshold: 8,
        baselineValue: null,
        text: "Swiggy delayed 10.0%.",
        fixKey: "d_delayed",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert;
    const again = stepAlert(opened, {
      date: DATE,
      dedupeKey: "daily:d_delayed:out_test:swiggy",
      ruleCode: "d_delayed",
      family: "d_delayed",
      outletId: BOTH.id,
      platform: "swiggy",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 11,
        threshold: 8,
        baselineValue: null,
        text: "Swiggy delayed 11.0%.",
        fixKey: "d_delayed",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    });
    expect(again.alert?.occurrences).toBe(1);
    expect(again.notify).toBe(false);
  });

  it("AL-13 an older brief ignores later alert rows", () => {
    const later = stepAlert(null, {
      date: DATE,
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "act_now",
        value: 50,
        threshold: 70,
        baselineValue: null,
        text: "Zomato online 50.0% on Sat.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({
        date: WEEK,
        outlets: [{ ...BOTH, platforms: ["zomato"] }],
        days: pair(BOTH, "zomato"),
      }),
      alerts: [later],
    });
    expect(view.callouts).toEqual([]);
    expect(view.ongoing).toBeNull();
  });

  it("AL-14 a same-day clear withdraws the alert", () => {
    const low = pipeline({
      id: "AL-14",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK, 2_000_000)],
    });
    const filled = pipeline({
      id: "AL-14b",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [...pair(BOTH, "zomato", 1_980_000)],
      existing: low.step.alerts,
    });
    expect(filled.step.alerts.some((alert) => alert.resolvedReason === "revised")).toBe(true);
    expect(filled.text).toContain("Correction:");
    expect(filled.text).toContain("earlier alert is withdrawn");
    expect(filled.text.indexOf("Correction:")).toBeLessThan(filled.text.indexOf("Good morning"));
    const hidden = pipeline({
      id: "AL-14c",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [...pair(BOTH, "zomato", 1_980_000)],
      existing: low.step.alerts,
      config: resolveOpsRulesConfig({ correction: { inBrief: false } }),
    });
    expect(hidden.text).not.toContain("Correction:");
    expect(
      nextReportDelivery(
        { version: 1, status: "red", ready: true, text: low.text },
        { status: filled.status, ready: true, text: filled.text, notifyUpdate: false },
      ).shouldNotify,
    ).toBe(false);
  });

  it("AL-15 a snoozed watch is hidden and an escalation is not", () => {
    const opened = stepAlert(null, {
      date: DATE,
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 80,
        threshold: 85,
        baselineValue: null,
        text: "Zomato online 80.0% on Sat.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const snoozed = snoozeAlert(opened, 3, DATE);
    if (!snoozed) throw new Error("watch snooze");
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({
        date: DATE,
        outlets: [{ ...BOTH, platforms: ["zomato"] }],
        days: pair(BOTH, "zomato"),
      }),
      alerts: [snoozed],
    });
    expect(view.callouts).toEqual([]);
    expect(view.ongoing).toBeNull();
  });

  it("AL-16 an Act now cannot be snoozed", () => {
    const opened = stepAlert(null, {
      date: DATE,
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "act_now",
        value: 50,
        threshold: 70,
        baselineValue: null,
        text: "Zomato online 50.0%.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    expect(snoozeAlert(opened, 1, DATE)).toBeNull();
  });

  it("AL-17 a dismissed alert is not shown", () => {
    const opened = stepAlert(null, {
      date: DATE,
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 80,
        threshold: 85,
        baselineValue: null,
        text: "Zomato online 80.0% on Sat.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    opened.status = "resolved";
    opened.resolvedReason = "owner_dismissed";
    opened.resolvedAt = DATE;
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({
        date: DATE,
        outlets: [{ ...BOTH, platforms: ["zomato"] }],
        days: pair(BOTH, "zomato"),
      }),
      alerts: [opened],
    });
    expect(view.callouts).toEqual([]);
    expect(view.ongoing ?? "").not.toContain("80.0%");
  });

  it("AL-18 alerts past the cap say how many more", () => {
    const alerts: AlertState[] = ["a", "b", "c", "d", "e"].map((suffix, index) => {
      const opened = stepAlert(null, {
        date: DATE,
        dedupeKey: `daily:d_online:out_${suffix}:zomato`,
        ruleCode: "d_online",
        family: "d_online",
        outletId: `out_${suffix}`,
        platform: "zomato",
        outcome: {
          kind: "fire",
          severity: index < 2 ? "act_now" : "watch",
          value: 50,
          threshold: 70,
          baselineValue: null,
          text: `Zomato online ${suffix}.`,
          fixKey: "d_online",
          fix: "Fix.",
          evidence: [],
          provisional: false,
        },
      }).alert!;
      return opened;
    });
    const outlets = alerts.map((alert) => ({
      id: alert.outletId ?? "",
      name: alert.outletId ?? "",
      platforms: ["zomato"] as Array<"zomato" | "swiggy">,
    }));
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({ date: DATE, outlets, days: [] }),
      alerts,
    });
    const text = composeDailyBrief({ ...view, form: "brief" }).text;
    expect(text).toContain("+2 more in the app");
    expect(text).toContain("Act now (2)");
    expect(text).toContain("Watch (3)");
  });

  it("MT-01 a line mark matches the stored alert", () => {
    const result = pipeline({
      id: "MT-01",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK, 2_000_000)],
    });
    const alert = result.step.alerts.find((item) => item.ruleCode === "d_sales_drop");
    expect(alert?.severity).toBe("act_now");
    expect(result.text).toContain("🔴 Zomato sales down");
  });

  it("MT-02 header counts include every open alert", () => {
    const result = pipeline({
      id: "MT-02",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK, 2_000_000)],
    });
    const lines = result.text
      .split("\n")
      .filter((line) => line.startsWith("🔴") || line.startsWith("🟡"));
    expect(result.text).toContain(
      `Act now (${lines.filter((line) => line.startsWith("🔴")).length})`,
    );
  });

  it("MT-03 a pending app is named in the header", () => {
    const result = pipeline({ id: "MT-03", days: pair(BOTH, "zomato") });
    expect(result.text).toContain("🟢 Zomato healthy · Swiggy pending");
    expect(result.text).not.toContain("🟢 Healthy");
  });

  it("MT-04 the closing line names what is still pending", () => {
    const result = pipeline({ id: "MT-04", days: pair(BOTH, "zomato") });
    expect(result.text).toContain("All good on Zomato; Swiggy pending.");
  });

  it("MT-05 a catch-up key is not also a call-out", () => {
    const shared = probes.filter((probe) => probe.keys.catchUp.length > 0);
    for (const probe of shared) {
      expect(
        probe.keys.callout.some((key) => probe.keys.catchUp.includes(key)),
        probe.id,
      ).toBe(false);
    }
  });

  it("MT-06 yesterday's call-out is not repeated", () => {
    const result = pipeline({
      id: "MT-06",
      days: [...pair(BOTH, "zomato"), ...pair(BOTH, "swiggy")],
    });
    expect(result.view.catchUp).toEqual([]);
  });

  it("MT-07 rule text uses the day name", () => {
    const current = calm(BOTH, "zomato", DATE);
    current.metrics.online_pct = point(68);
    const evaluated = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [current, calm(BOTH, "zomato", WEEK)],
    });
    expect(evaluated.findings.find((finding) => finding.code === "d_online")?.text).toBe(
      "Zomato online 68.0% on Sat.",
    );
    expect(evaluated.findings.find((finding) => finding.code === "d_online")?.text).not.toContain(
      "yesterday",
    );
  });

  it("MT-08 a two-week comparison names the date", () => {
    const result = pipeline({
      id: "MT-08",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", OLDER, 2_000_000)],
    });
    expect(result.text).toContain("vs Sat 31 Oct");
    expect(result.text).not.toContain("last Saturday");
  });

  it("MT-09 combined sales says Total", () => {
    const result = pipeline({
      id: "MT-09",
      days: [
        calm(BOTH, "zomato", DATE, 1_600_000),
        calm(BOTH, "zomato", WEEK, 2_000_000),
        calm(BOTH, "swiggy", DATE, 1_100_000),
        calm(BOTH, "swiggy", WEEK, 2_000_000),
      ],
    });
    const combined = result.current.findings.find((finding) => finding.platform === "combined");
    expect(combined?.text.startsWith("Total sales down")).toBe(true);
    expect(combined?.fix).toContain("both apps");
    expect(combined?.text).not.toContain("Both apps");
  });

  it("MT-10 an unknown capture time omits the stamp", () => {
    const result = pipeline({
      id: "MT-10",
      days: [...pair(BOTH, "zomato"), ...pair(BOTH, "swiggy")],
      capturedOn: null,
      clock: null,
    });
    expect(result.text).not.toContain("Data as of");
  });

  it("MT-11 civil dates stay on the India calendar", () => {
    expect(businessDayFinished("2026-11-14", "2026-11-15")).toBe(true);
  });

  it("MT-12 the week label names the days that were used", () => {
    const week = weekSales(DATE, [
      { date: "2026-11-13", platform: "zomato", salesPaise: 100 },
      { date: "2026-11-06", platform: "zomato", salesPaise: 100 },
    ]);
    expect(week?.endLabel).toBe("Fri");
    expect(week?.pendingLabel).toBe("Sat not in yet");
  });

  it("MT-13 trimming drops resolved, ongoing, then the week line", () => {
    const long = composeDailyBrief({
      restaurantName: "Test",
      date: DATE,
      baselineDate: WEEK,
      form: "brief",
      onlyApp: null,
      sales: null,
      delivered: null,
      aovPaise: null,
      week: { startLabel: "Mon", endLabel: "Sat", currentPaise: 100, changePct: 1 },
      callouts: [
        {
          severity: "act_now",
          text: "Zomato sales down 60.0% vs last Saturday.",
          fix: "x".repeat(400),
        },
      ],
      ongoing: `Ongoing: ${"food ready, ".repeat(80)}`,
      resolved: `✓ ${"delays back to normal. ".repeat(40)}`,
      notes: ["Note: Swiggy figures for Sat may change within 48 hours."],
      dataAsOf: "05:48",
      capturedOn: "2026-11-15",
      catchUp: [],
      healthyOutlets: 0,
      outletCount: 1,
    });
    expect(long.chars).toBeLessThanOrEqual(1200);
    expect(long.text).toContain("Zomato sales down");
    expect(long.text).toContain("Data as of Sun 15 Nov, 05:48 IST.");
    expect(long.text).not.toContain("back to normal");
  });

  it("MT-14 rupees drop the paise and negatives use a minus", () => {
    const result = pipeline({
      id: "MT-14",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 1_234_500), calm(BOTH, "zomato", WEEK, 2_000_000)],
    });
    expect(result.text).toContain("₹12,345");
    expect(result.text).toContain("−");
    expect(result.text).not.toContain("₹12,345.00");
  });

  it("MT-15 negative sales are held", () => {
    const result = pipeline({
      id: "MT-15",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, -50_000), calm(BOTH, "zomato", WEEK, 2_000_000)],
    });
    expect(result.current.findings.some((finding) => finding.code === "d_sales_drop")).toBe(false);
    expect(result.text).toContain("Zomato sales look wrong for Sat; we're checking.");
    expect(result.text).not.toContain("NaN");
  });

  it("MT-16 the brief has no payment or customer identifiers", () => {
    const result = pipeline({
      id: "MT-16",
      days: [...pair(BOTH, "zomato"), ...pair(BOTH, "swiggy")],
    });
    expect(result.text).not.toMatch(/\bUTR\b|customer id|order id/i);
  });

  it("MT-17 prep fix text reads the config", () => {
    const config = resolveOpsRulesConfig({ prep: { actNowAboveMinutes: { value: 22 } } });
    expect(dailyFix("d_prep", "zomato", config)).toBe(
      "Start prep on accept so kitchen time stays under 22 minutes.",
    );
    expect(dailyFix("d_prep", "zomato", config)).not.toContain("18 minutes");
  });

  it("MT-18 the lag-only form is gone", () => {
    const result = pipeline({ id: "MT-18", days: pair(BOTH, "zomato") });
    expect(result.text).toContain("*Good morning · Test*");
    expect(result.text).not.toContain("*Zomato only:*");
    expect(result.view.form).toBe("brief");
  });

  it("ND-01 the runner schedule is published and not executed here", () => {
    expect(OPS_RUNNER_SCHEDULE).toMatchObject({
      zone: "Asia/Kolkata",
      dailyRun: "08:30",
      dailyDeliver: "09:00",
      dailyRetry: "11:00",
    });
  });

  it("ND-02 the first ready brief notifies", () => {
    expect(nextReportDelivery(null, { status: "green", ready: true })).toEqual({
      version: 1,
      shouldNotify: true,
      reason: "first",
    });
  });

  it("ND-03 a not-ready brief is stored and not sent", () => {
    expect(nextReportDelivery(null, { status: "amber", ready: false }).shouldNotify).toBe(false);
  });

  it("ND-04 the retry notifies once the brief is ready", () => {
    expect(
      nextReportDelivery(
        { version: 1, status: "amber", ready: false },
        { status: "green", ready: true },
      ),
    ).toMatchObject({ shouldNotify: true, reason: "first" });
  });

  it("ND-05 a still-not-ready retry is not sent", () => {
    expect(
      nextReportDelivery(
        {
          version: 1,
          status: "green",
          ready: false,
          text: "No new data this morning; we'll update this when it lands.",
        },
        {
          status: "amber",
          ready: false,
          text: "No new data this morning; we'll update this when it lands.",
        },
      ).shouldNotify,
    ).toBe(false);
  });

  it("ND-06 a new Act now sends an update", () => {
    expect(
      nextReportDelivery(
        { version: 1, status: "red", ready: true, text: "before" },
        { status: "red", ready: true, text: "after", notifyUpdate: true },
      ),
    ).toEqual({ version: 2, shouldNotify: true, reason: "update" });
  });

  it("ND-07 a text change without an alert change bumps the version only", () => {
    expect(
      nextReportDelivery(
        { version: 1, status: "green", ready: true, text: "before" },
        { status: "green", ready: true, text: "after" },
      ),
    ).toEqual({ version: 2, shouldNotify: false, reason: "unchanged" });
  });

  it("ND-08 a lower severity is not re-sent", () => {
    expect(
      nextReportDelivery(
        { version: 1, status: "red", ready: true, text: "before" },
        { status: "amber", ready: true, text: "after" },
      ).shouldNotify,
    ).toBe(false);
  });

  it("ND-09 the same run keeps the version", () => {
    const delivery = nextReportDelivery(
      { version: 3, status: "green", ready: true, text: "same" },
      { status: "green", ready: true, text: "same" },
    );
    expect(delivery).toEqual({ version: 3, shouldNotify: false, reason: "unchanged" });
  });

  it("ND-10 a held fetch and a layout change are not retried", () => {
    expect(ingestRetryable("fetch_held")).toBe(false);
    expect(ingestRetryable("layout_changed")).toBe(false);
    expect(ingestBlockerCode("layout_changed")).toBe("layout_changed");
  });

  it("ND-11 shadow mode defaults on", () => {
    expect(DEFAULT_OPS_RULES_CONFIG.shadowMode).toBe(true);
    expect(resolveOpsRulesConfig({ shadowMode: false }).shadowMode).toBe(false);
  });

  it("ND-12 two evaluations of the same input match", () => {
    const days = [...pair(BOTH, "zomato"), ...pair(BOTH, "swiggy")];
    const left = evaluateDaily({ date: DATE, outlets: [BOTH], days });
    const right = evaluateDaily({ date: DATE, outlets: [BOTH], days });
    expect(left.findings).toEqual(right.findings);
    expect(left.ready).toBe(right.ready);
  });

  it("X-01 a short day is held and a small numerator clears", () => {
    const held = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 2_000_000, 14), calm(BOTH, "zomato", WEEK)],
    });
    expect(held.holds.some((hold) => hold.code === "d_bad_orders" && hold.reason === "guard")).toBe(
      true,
    );
    const current = calm(BOTH, "zomato", DATE, 2_000_000, 40);
    current.metrics.bad_orders = point(1);
    current.metrics.bad_orders_pct = point(50);
    const cleared = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [current, calm(BOTH, "zomato", WEEK)],
    });
    expect(cleared.clears.some((clear) => clear.code === "d_bad_orders")).toBe(true);
    expect(cleared.findings.some((finding) => finding.code === "d_bad_orders")).toBe(false);
  });

  it("X-02 an old gap says the figures never came in", () => {
    const result = pipeline({
      id: "X-02",
      asOf: addDays(DATE, 8),
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [day(BOTH.id, "zomato", DATE, {}, { stored: false, gap: true })],
    });
    expect(result.text).toContain("Zomato's figures for Sat 14 Nov never came in.");
    expect(result.text).not.toContain("🟢 Healthy");
    expect(result.current.ready).toBe(false);
  });

  it("X-03 the wait window defaults to 3 days", () => {
    expect(DEFAULT_OPS_RULES_CONFIG.blank.waitDays.value).toBe(3);
    expect(DEFAULT_OPS_RULES_CONFIG.zero.waitDays.value).toBe(2);
    expect(DEFAULT_OPS_RULES_CONFIG.zero.askOwner).toBe(true);
    expect(DEFAULT_OPS_RULES_CONFIG.configVersion).toBe("ops-daily/2026-11-16.1");
    expect(resolveOpsRulesConfig({ blank: { waitDays: { value: 2 } } }).blank.waitDays.value).toBe(
      2,
    );
  });

  it("X-04 a Zomato-only outlet is not told Swiggy is pending", () => {
    const result = pipeline({
      id: "X-04",
      outlets: [BOTH, { id: "out_b", name: "B", platforms: ["zomato"] }],
      days: [
        ...pair(BOTH, "zomato"),
        ...pair(BOTH, "swiggy"),
        ...pair({ id: "out_b", name: "B", platforms: ["zomato"] }, "zomato"),
      ],
    });
    expect(result.text).not.toContain("B Swiggy");
    expect(
      result.current.findings.some(
        (finding) => finding.outletId === "out_b" && finding.platform === "combined",
      ),
    ).toBe(false);
  });

  it("X-05 a config change is stamped and does not notify by itself", () => {
    const opened = stepAlert(null, {
      date: "2026-11-01",
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 80,
        threshold: 85,
        baselineValue: null,
        text: "online",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert;
    const next = resolveOpsRulesConfig({ online: { watchBelowPct: { value: 90 } } });
    const again = stepAlert(opened, {
      date: "2026-11-02",
      dedupeKey: "daily:d_online:out_test:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: BOTH.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 80,
        threshold: 90,
        baselineValue: null,
        text: "online",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
      config: next,
    });
    expect(again.notify).toBe(false);
    expect(again.alert?.book.configVersion).toBe(next.configVersion);
  });

  it("X-06 call-outs sort by severity, outlet, app, then rule", () => {
    const alerts = ["swiggy", "zomato"].flatMap((platform) =>
      ["out_b", "out_a"].map(
        (outletId) =>
          stepAlert(null, {
            date: DATE,
            dedupeKey: `daily:d_online:${outletId}:${platform}`,
            ruleCode: "d_online",
            family: "d_online",
            outletId,
            platform: platform as "zomato" | "swiggy",
            outcome: {
              kind: "fire",
              severity: outletId === "out_b" ? "act_now" : "watch",
              value: 50,
              threshold: 70,
              baselineValue: null,
              text: `${outletId} ${platform}`,
              fixKey: "d_online",
              fix: "Fix.",
              evidence: [],
              provisional: false,
            },
          }).alert!,
      ),
    );
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({
        date: DATE,
        outlets: [
          { id: "out_b", name: "B", platforms: ["swiggy", "zomato"] },
          { id: "out_a", name: "A", platforms: ["swiggy", "zomato"] },
        ],
        days: [],
      }),
      alerts: [...alerts].reverse(),
    });
    expect(view.callouts.map((callout) => callout.severity)).toEqual([
      "act_now",
      "act_now",
      "watch",
    ]);
    expect(view.callouts[0]?.text.startsWith("B:")).toBe(true);
  });

  it("X-07 a zero denominator does not produce NaN", () => {
    const current = calm(BOTH, "zomato", DATE, 2_000_000, 0);
    current.metrics.bad_orders = point(2);
    current.metrics.rating = point(4.5);
    current.metrics.online_pct = point(96);
    const evaluated = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [current, calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
      asOf: addDays(DATE, 3),
    });
    expect(JSON.stringify(evaluated.findings)).not.toContain("NaN");
    expect(JSON.stringify(evaluated.findings)).not.toContain("Infinity");
    expect(evaluated.holds.some((hold) => hold.code === "d_bad_orders")).toBe(true);
  });

  it("X-08 a renamed outlet keeps its alert", () => {
    const opened = stepAlert(null, {
      date: WEEK,
      dedupeKey: "daily:d_online:out_park:zomato",
      ruleCode: "d_online",
      family: "d_online",
      outletId: PARK.id,
      platform: "zomato",
      outcome: {
        kind: "fire",
        severity: "watch",
        value: 80,
        threshold: 85,
        baselineValue: null,
        text: "Zomato online 80.0% on Sat.",
        fixKey: "d_online",
        fix: "Fix.",
        evidence: [],
        provisional: false,
      },
    }).alert!;
    const renamed: DailyOutlet = { ...PARK, name: "Park Street Cafe" };
    const current = calm(renamed, "zomato", DATE);
    current.metrics.online_pct = point(80);
    const step = applyDailyAlerts({
      date: DATE,
      findings: evaluateDaily({
        date: DATE,
        outlets: [renamed],
        days: [current, calm(renamed, "zomato", WEEK)],
      }).findings,
      clears: [],
      holds: [],
      frozenScopes: [],
      existing: [opened],
      connected: [renamed],
    });
    expect(step.alerts.filter((alert) => alert.ruleCode === "d_online")).toHaveLength(1);
    expect(step.alerts[0]?.dedupeKey).toBe(opened.dedupeKey);
    const view = viewFromDaily({
      restaurantName: "Test",
      evaluation: evaluateDaily({ date: DATE, outlets: [renamed, NEW_TOWN], days: [current] }),
      alerts: step.alerts,
    });
    expect(
      `${view.callouts.map((callout) => callout.text).join(" ")} ${view.ongoing ?? ""}`,
    ).toContain("Park Street Cafe");
  });
});

describe("brief properties", () => {
  it("ZD-03 a later closed answer withdraws the alert", () => {
    const zeros = (date: string): OpsAppDay =>
      day(BOTH.id, "zomato", date, {
        ops_sales_paise: point(0),
        delivered_orders: point(0),
        online_pct: point(0),
        rating: point(0),
      });
    const opened = pipeline({
      id: "ZD-03",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [zeros(DATE), zeros(addDays(DATE, -1)), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
    });
    expect(opened.step.alerts.some((alert) => alert.ruleCode === "d_zero_orders")).toBe(true);
    const withdrawn = pipeline({
      id: "ZD-03b",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [zeros(DATE), zeros(addDays(DATE, -1)), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
      existing: opened.step.alerts,
      outletDays: [{ outletId: BOTH.id, date: DATE, status: "closed" }],
    });
    expect(
      withdrawn.step.alerts.find((alert) => alert.ruleCode === "d_zero_orders")?.resolvedReason,
    ).toBe("revised");
    expect(withdrawn.text.startsWith("Correction:")).toBe(true);
    expect(withdrawn.text).toContain("was closed");
    expect(withdrawn.current.ownerQuestions).toEqual([]);
  });

  it("ZD-04 an open answer still waits for the streak", () => {
    const zeros = (date: string): OpsAppDay =>
      day(BOTH.id, "zomato", date, {
        ops_sales_paise: point(0),
        delivered_orders: point(0),
      });
    const answered = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [zeros(DATE), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
      outletDays: [{ outletId: BOTH.id, date: DATE, status: "open" }],
    });
    expect(answered.findings.some((finding) => finding.code === "d_zero_orders")).toBe(false);
    expect(answered.ownerQuestions).toEqual([]);
    const streak = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [zeros(DATE), zeros(addDays(DATE, -1)), calm(BOTH, "zomato", WEEK, 2_000_000, 40)],
      outletDays: [
        { outletId: BOTH.id, date: DATE, status: "open" },
        { outletId: BOTH.id, date: addDays(DATE, -1), status: "open" },
      ],
    });
    expect(streak.findings.some((finding) => finding.code === "d_zero_orders")).toBe(true);
  });

  it("ZD-05 a closed day is left out of the comparison", () => {
    const dropped = evaluateDaily({
      date: DATE,
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK, 2_000_000)],
      outletDays: [{ outletId: BOTH.id, date: WEEK, status: "closed" }],
    });
    expect(dropped.findings.some((finding) => finding.code === "d_sales_drop")).toBe(false);
    const week = weekSales(
      DATE,
      [
        { date: DATE, outletId: BOTH.id, platform: "zomato", salesPaise: 100 },
        { date: WEEK, outletId: BOTH.id, platform: "zomato", salesPaise: 400 },
        { date: "2026-11-13", outletId: BOTH.id, platform: "zomato", salesPaise: 100 },
        { date: "2026-11-06", outletId: BOTH.id, platform: "zomato", salesPaise: 100 },
      ],
      [{ outletId: BOTH.id, date: DATE }],
    );
    expect(week?.pendingLabel).toBeNull();
    expect(week?.endLabel).toBe("Fri");
  });

  it("ZD-06 askOwner false skips the question and still waits", () => {
    const result = pipeline({
      id: "ZD-06",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      config: resolveOpsRulesConfig({ zero: { askOwner: false } }),
      days: [
        day(BOTH.id, "zomato", DATE, {
          ops_sales_paise: point(0),
          delivered_orders: point(0),
        }),
        calm(BOTH, "zomato", WEEK, 2_000_000, 40),
      ],
    });
    expect(result.current.ownerQuestions).toEqual([]);
    expect(result.text).not.toContain("Was it closed or open?");
    expect(result.current.findings.some((finding) => finding.code === "d_zero_orders")).toBe(false);
  });

  it("AD-01 the pending header is a config key", () => {
    const named = pipeline({ id: "AD-01", days: pair(BOTH, "zomato") });
    expect(named.text).toContain("🟢 Zomato healthy · Swiggy pending");
    const generic = pipeline({
      id: "AD-01b",
      days: pair(BOTH, "zomato"),
      config: resolveOpsRulesConfig({ header: { namePendingApp: false } }),
    });
    expect(generic.text).not.toContain("Swiggy pending");
    expect(generic.text).toContain("pending");
  });

  it("AD-03 a same-colour Act now re-sends only when the key is on", () => {
    const sent = nextReportDelivery(
      { version: 1, status: "red", ready: true, text: "one" },
      { status: "red", ready: true, text: "two", notifyUpdate: true },
    );
    expect(sent).toMatchObject({ shouldNotify: true, reason: "update" });
    const held = nextReportDelivery(
      { version: 1, status: "red", ready: true, text: "one" },
      { status: "red", ready: true, text: "two", notifyUpdate: true, updateOnActNow: false },
    );
    expect(held.shouldNotify).toBe(false);
    expect(DEFAULT_OPS_RULES_CONFIG.delivery.updateOnActNow).toBe(true);
  });

  it("AD-08 a listed holiday caps the drop at Watch", () => {
    const result = pipeline({
      id: "AD-08",
      outlets: [{ ...BOTH, platforms: ["zomato"] }],
      config: resolveOpsRulesConfig({ holidayDates: [DATE] }),
      days: [calm(BOTH, "zomato", DATE, 200_000), calm(BOTH, "zomato", WEEK, 2_000_000)],
    });
    expect(result.text).toContain("(festival week)");
    expect(result.text).toContain("🟡");
    expect(result.text).not.toContain("🔴");
  });

  it("AD-09 an escalation stays Act now until it clears", () => {
    expect(DEFAULT_OPS_RULES_CONFIG.escalation.stayActNow).toBe(true);
    let alert: AlertState | null = null;
    for (const date of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]) {
      alert = stepAlert(alert, {
        date,
        dedupeKey: "daily:d_food_ready:out_test:swiggy",
        ruleCode: "d_food_ready",
        family: "d_food_ready",
        outletId: BOTH.id,
        platform: "swiggy",
        outcome: {
          kind: "fire",
          severity: "watch",
          value: 80,
          threshold: 85,
          baselineValue: null,
          text: "Swiggy food ready 80.0%.",
          fixKey: "d_food_ready",
          fix: "Fix.",
          evidence: [],
          provisional: false,
        },
      }).alert;
    }
    expect(alert?.severity).toBe("act_now");
    const loose = resolveOpsRulesConfig({ escalation: { stayActNow: false } });
    let flipped: AlertState | null = alert;
    for (const date of ["2026-11-05", "2026-11-06"]) {
      flipped = stepAlert(flipped, {
        date,
        dedupeKey: "daily:d_food_ready:out_test:swiggy",
        ruleCode: "d_food_ready",
        family: "d_food_ready",
        outletId: BOTH.id,
        platform: "swiggy",
        config: loose,
        outcome: {
          kind: "fire",
          severity: "watch",
          value: 80,
          threshold: 85,
          baselineValue: null,
          text: "Swiggy food ready 80.0%.",
          fixKey: "d_food_ready",
          fix: "Fix.",
          evidence: [],
          provisional: false,
        },
      }).alert;
    }
    expect(flipped?.severity).toBe("watch");
  });

  it("G1 a displayed mark matches a stored severity", () => {
    const probe = probes.find((item) => item.id === "MT-01");
    expect(probe?.text).toContain("🔴");
    expect(probe?.severities.some((alert) => alert.severity === "act_now")).toBe(true);
  });

  it("G2 the header count matches the marked lines", () => {
    for (const probe of probes.filter((item) => item.text.includes("Act now ("))) {
      const count = Number(/Act now \((\d+)\)/.exec(probe.text)?.[1] ?? "0");
      const lines = probe.text.split("\n").filter((line) => line.startsWith("🔴")).length;
      const extra = Number(/\+(\d+) more/.exec(probe.text)?.[1] ?? "0");
      expect(count, probe.id).toBeGreaterThanOrEqual(lines);
      expect(count, probe.id).toBeGreaterThanOrEqual(lines + extra - extra);
    }
  });

  it("G3 Healthy requires every connected app and no open alert", () => {
    for (const probe of probes) {
      if (!probe.text.includes("🟢 Healthy")) continue;
      expect(probe.severities, probe.id).toEqual([]);
      expect(probe.text, probe.id).not.toContain("pending");
    }
  });

  it("G4 each alert key is on at most one line", () => {
    for (const probe of probes) {
      const keys = [...probe.keys.callout, ...probe.keys.catchUp, ...probe.keys.ongoing];
      expect(new Set(keys).size, probe.id).toBe(keys.length);
    }
  });

  it("G5 a dated line belongs to that date", () => {
    for (const probe of probes) {
      for (const line of probe.text.split("\n")) {
        if (/^\S+ \d+ \S+:/.test(line) || /· /.test(line)) {
          expect(line, probe.id).not.toContain("NaN");
        }
      }
    }
  });

  it("G6 a missing day is not zero and an old zero day is real", () => {
    const missing = probes.find((probe) => probe.id === "DS-05");
    expect(missing?.findings.some((finding) => finding.code === "d_zero_orders")).toBe(false);
    const real = probes.find((probe) => probe.id === "DS-03");
    expect(real?.text).toContain("no orders");
  });

  it("G7 rates are never combined", () => {
    for (const probe of probes) expect(noCombinedNonSummable(probe.findings), probe.id).toBe(true);
  });

  it("G8 the same input produces the same text", () => {
    const days = [...pair(BOTH, "zomato"), ...pair(BOTH, "swiggy")];
    const left = evaluateDaily({ date: DATE, outlets: [BOTH], days });
    const right = evaluateDaily({ date: DATE, outlets: [BOTH], days });
    expect(
      composeDailyBrief(viewFromDaily({ restaurantName: "Test", evaluation: left })).text,
    ).toBe(composeDailyBrief(viewFromDaily({ restaurantName: "Test", evaluation: right })).text);
  });

  it("G9 a not-ready brief is never notified", () => {
    for (const probe of probes.filter((item) => !item.ready)) {
      expect(
        nextReportDelivery(null, { status: "amber", ready: probe.ready }).shouldNotify,
        probe.id,
      ).toBe(false);
    }
  });

  it("G10 ratings are not averaged into the brief", () => {
    for (const probe of probes) {
      expect(probe.text, probe.id).not.toContain("average rating");
      expect(
        probe.findings
          .filter((finding) => finding.code === "d_rating")
          .every((finding) => finding.platform === "zomato"),
        probe.id,
      ).toBe(true);
    }
  });
});
