/**
 * Machine-readable metric dictionary. docs/metric-dictionary.md is the same
 * list in prose. The agent API rejects any key that is not here.
 *
 * Money is integer paise. A missing figure is null, never a guessed zero.
 * Rates are not averaged: a ratio or weighted average is rebuilt from its parts.
 */

export const METRIC_UNITS = [
  "paise",
  "count",
  "decimal",
  "pct",
  "minutes",
  "hours",
  "boolean",
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export const AGGREGATION_KINDS = [
  "sum",
  "ratio",
  "weighted_avg",
  "snapshot_mean",
  "snapshot_latest",
  "distinct",
  "platform_only",
] as const;
export type AggregationKind = (typeof AGGREGATION_KINDS)[number];

export const GRANULARITIES = ["day", "week_sun_sat", "week_mon_sun", "month", "custom"] as const;
export type MetricGranularity = (typeof GRANULARITIES)[number];

export const METRIC_PLATFORMS = ["zomato", "swiggy"] as const;
export type MetricPlatform = (typeof METRIC_PLATFORMS)[number];

/** Swiggy's Daily download refuses a range longer than this. Backfills are chunked. */
export const SWIGGY_DAILY_MAX_DAYS = 7;

/** After this many identity mismatches for one request, the fetch is needs_owner. */
export const FILE_IDENTITY_ATTEMPT_LIMIT = 3;

export const METRIC_PARSER_VERSION = "2026-11-12.1";

export type MetricAccuracy = "exact" | "approx";

export type CheckMode = "absolute" | "relative" | "points" | "minutes";

export interface ActiveCheck {
  readonly mode: CheckMode;
  /** Absolute gap, a relative fraction (0.005 = 0.5%), percentage points, or minutes. */
  readonly amount: number;
  /** Added to the absolute gap as a fraction of the platform value. 0 means no relative slack. */
  readonly relative?: number;
}

export interface CheckRule {
  readonly mode: CheckMode | "excluded";
  readonly amount?: number;
  /** Fraction of the platform value added to an absolute tolerance. */
  readonly relative?: number;
  readonly reason?: string;
  /** When both are omitted, the exclusion always applies. */
  readonly when?: { readonly platform?: MetricPlatform; readonly granularity?: MetricGranularity };
  readonly fallback?: ActiveCheck;
}

export interface SourceLabel {
  readonly section?: string;
  readonly label: string;
}

export interface MetricDefinition {
  readonly unit: MetricUnit;
  readonly definition: string;
  readonly kind: AggregationKind;
  readonly accuracy: MetricAccuracy;
  readonly crossPlatform: boolean;
  readonly platforms: readonly MetricPlatform[];
  readonly sourceLabel: { readonly zomato?: SourceLabel; readonly swiggy?: SourceLabel };
  readonly numeratorKey?: string;
  readonly denominatorKey?: string;
  readonly numeratorByPlatform?: { readonly zomato?: string; readonly swiggy?: string };
  readonly weightKey?: string;
  readonly valueKey?: string;
  /** Multiply the part ratio by 100 when the unit is pct. */
  readonly presentAs?: "pct";
  /** Named formula the rollup computes from daily parts. */
  readonly formula?: "zomato_ads_roi";
  /** Stored as source derived:<formula>. Computed per day, then summed. */
  readonly derivation?: string;
  /** A parsed 0 is not a value. Menu scores use this. */
  readonly skipZero?: boolean;
  /** PUT validation. File ingest stores the file's number. */
  readonly max?: number;
  readonly decimals?: number;
  readonly check: CheckRule;
}

const both = ["zomato", "swiggy"] as const;
const zOnly = ["zomato"] as const;
const sOnly = ["swiggy"] as const;

/** Count sums must match exactly. Paise sums allow ₹1 of 2-dp rounding and no relative slack. */
export const PAISE_SUM_TOLERANCE = 100;

const sumCheck: CheckRule = { mode: "absolute", amount: 0 };
const paiseSumCheck: CheckRule = { mode: "absolute", amount: PAISE_SUM_TOLERANCE, relative: 0 };
const ratioCheck: CheckRule = { mode: "relative", amount: 0.005 };
const pointsCheck: CheckRule = { mode: "points", amount: 0.05 };
const minuteCheck: CheckRule = { mode: "minutes", amount: 0.05 };

const offlineExcluded: CheckRule = {
  mode: "excluded",
  reason: "Zomato rounds offline hours to whole hours a day, so the days do not add up.",
};

const cpcDepthCheck: CheckRule = {
  mode: "excluded",
  reason: "Swiggy's monthly CPC Ads Depth does not match its own parts.",
  when: { platform: "swiggy", granularity: "month" },
  fallback: { mode: "relative", amount: 0.005 },
};

function label(section: string, text: string): SourceLabel {
  return { section, label: text };
}

type Draft = MetricDefinition;

function payout(
  unit: MetricUnit,
  definition: string,
  zomato: string,
  swiggy: string,
  crossPlatform: boolean,
): Draft {
  return {
    unit,
    definition,
    kind: "sum",
    accuracy: "exact",
    crossPlatform,
    platforms: both,
    sourceLabel: {
      zomato: { label: zomato },
      swiggy: { label: swiggy },
    },
    check: unit === "paise" ? paiseSumCheck : sumCheck,
  };
}

export const METRIC_DEFINITIONS = {
  gross_sales_paise: payout(
    "paise",
    "Item total plus packaging (ST+PC), before GST and before restaurant-funded discounts.",
    "Subtotal (items total) + Packaging charge",
    "Item Total + Packaging Charges",
    true,
  ),
  net_payout_paise: payout(
    "paise",
    "Owner Net Payout: commissionable value minus ads minus commission, other fees, and GST on fees.",
    "CV − Ads − Comm.+PG+GST",
    "CV − Ads − Swiggy fees, GST on fees outside this row",
    true,
  ),
  platform_net_payout_paise: payout(
    "paise",
    "The platform's own net payout figure, before comparing it to the bank.",
    "I Net Payout",
    "G Net Payout",
    true,
  ),
  commission_paise: payout(
    "paise",
    "Platform commission or base service fee only, not long-distance, payment-gateway, or GST on fees.",
    "Base service fee",
    "Commission",
    true,
  ),
  platform_fees_paise: payout(
    "paise",
    "Other platform fees besides commission, excluding GST on fees.",
    "Long distance and payment mechanism fee",
    "Swiggy fees minus Commission",
    true,
  ),
  taxes_paise: payout(
    "paise",
    "18% GST on platform fees only. Not customer GST, and not TDS or TCS.",
    "Taxes on service and payment mechanism fees",
    "GST on Service Fee @18%",
    true,
  ),
  tds_paise: payout(
    "paise",
    "Tax deducted at source and withheld from the payout. A tax credit, not a cost.",
    "TDS 194O amount",
    "TDS",
    true,
  ),
  tcs_paise: payout(
    "paise",
    "Tax collected at source, including TCS IGST where it is present.",
    "TCS",
    "TCS",
    true,
  ),
  cv_paise: payout(
    "paise",
    "Commissionable value: item total plus packaging, minus the restaurant-funded discount.",
    "ST+PC − merchant discount",
    "ST+PC − merchant discount",
    true,
  ),
  paid_amount_paise: payout(
    "paise",
    "Amount marked paid on the Payouts screen, tied to a bank reference stored as the last 4 digits.",
    "Payouts screen paid amount",
    "Payouts screen paid amount",
    true,
  ),
  payout_orders: payout(
    "count",
    "Payout-file orders: delivered plus cancelled or rejected, for the payout period.",
    "Number of Orders",
    "Orders",
    true,
  ),
  commission_pg_gst_paise: payout(
    "paise",
    "The payout calculator's Comm.+PG+GST row as printed. Swiggy's row excludes GST on fees.",
    "Service fee + payment fee + GST on those fees",
    "B Swiggy Fees",
    false,
  ),
  gst_collected_paise: payout(
    "paise",
    "GST collected from customers. Not restaurant revenue on delivery orders.",
    "Total GST collected from customers",
    "GST Collected",
    false,
  ),
  complaints_cancellation_charges_paise: payout(
    "paise",
    "Complaint refunds and cancellation charges deducted from the payout.",
    "Other order level deductions",
    "Customer Complaints and Cancellation Charges",
    false,
  ),
  discount_paise: {
    unit: "paise",
    definition:
      "Discounts the restaurant pays for. Zomato's business-report Discount given is not confirmed as the same figure.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Offers", "Discount given (Rs)"),
      swiggy: label("DISCOUNTS", "Discount Given by Restaurant(RDGMV)"),
    },
    check: sumCheck,
  },
  ad_spend_paise: {
    unit: "paise",
    definition:
      "Ads charged to the restaurant for that period, counted once. Swiggy's export spend is not this payout figure.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Ads", "Ads spend (Rs)"),
      swiggy: { label: "Growth Investment In Ads" },
    },
    check: sumCheck,
  },
  delivered_orders: {
    unit: "count",
    definition:
      "Orders delivered. This is the ops orders figure, and the denominator of most rates.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: true,
    platforms: both,
    sourceLabel: {
      zomato: label("Sales", "Delivered orders"),
      swiggy: label("SALES", "Delivered Orders"),
    },
    check: sumCheck,
  },
  ops_sales_paise: {
    unit: "paise",
    definition:
      "Zomato business-report sales, stored apart from payout ST+PC and from Swiggy net sales.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Sales", "Sales (Rs)") },
    check: sumCheck,
  },
  swiggy_net_sales_paise: {
    unit: "paise",
    definition: "Swiggy Net Sales. Not Zomato sales and not payout ST+PC.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("SALES", "Net Sales") },
    check: sumCheck,
  },
  aov_paise: {
    unit: "paise",
    definition: "Average order value rebuilt as platform sales divided by delivered orders.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Sales", "Average order value"),
      swiggy: label("SALES", "Net AOV"),
    },
    numeratorByPlatform: { zomato: "ops_sales_paise", swiggy: "swiggy_net_sales_paise" },
    denominatorKey: "delivered_orders",
    check: ratioCheck,
  },
  cancelled_orders: {
    unit: "count",
    definition:
      "All cancellations on a payout file. Swiggy's business export uses restaurant_cancelled_orders instead.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: { label: "Cancelled/Rejected" },
      swiggy: { label: "Payout Breakup Cancelled" },
    },
    check: sumCheck,
  },
  restaurant_cancelled_orders: {
    unit: "count",
    definition: "Orders the restaurant cancelled on Swiggy. Not every cancellation.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("SALES", "Restaurant Cancelled Orders") },
    check: sumCheck,
  },
  cancelled_order_loss_paise: {
    unit: "paise",
    definition: "Money Swiggy reports as lost to restaurant-cancelled orders.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("SALES", "Cancelled Order Loss") },
    check: sumCheck,
  },
  orders_band_lt250: band(
    "Number of Orders below ₹250",
    "Delivered orders with a value below ₹250.",
  ),
  orders_band_250_450: band(
    "Number of Orders between ₹250 and ₹450",
    "Delivered orders with a value from ₹250 to ₹450.",
  ),
  orders_band_450_650: band(
    "Number of Orders between ₹450 and ₹650",
    "Delivered orders with a value from ₹450 to ₹650.",
  ),
  orders_band_650_850: band(
    "Number of Orders between ₹650 and ₹850",
    "Delivered orders with a value from ₹650 to ₹850.",
  ),
  orders_band_gt850: band(
    "Number of Orders above ₹850",
    "Delivered orders with a value above ₹850.",
  ),
  market_share_pct: {
    unit: "pct",
    definition: "The platform's market-share figure. There is no market total to rebuild it from.",
    kind: "platform_only",
    accuracy: "approx",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Sales", "Market share (%)"),
      swiggy: label("SALES", "Market Share"),
    },
    decimals: 2,
    check: ratioCheck,
  },
  bolt_orders: {
    unit: "count",
    definition: "Swiggy Bolt orders, the fast-delivery channel.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("BOLT", "Orders") },
    check: sumCheck,
  },
  bolt_orders_pct: pctRatio(
    "Share of delivered orders that were Bolt orders.",
    "BOLT",
    "% of Bolt Orders",
    "bolt_orders",
    "delivered_orders",
  ),
  bolt_sales_paise: {
    unit: "paise",
    definition: "Bolt sales, Bolt AOV times Bolt orders, summed after the daily product.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("BOLT", "AOV") },
    derivation: "round(bolt_aov_paise*bolt_orders)",
    check: sumCheck,
  },
  bolt_prep_wsum: {
    unit: "decimal",
    definition: "Bolt prep minutes times Bolt orders. The weight for Bolt prep time.",
    kind: "sum",
    accuracy: "approx",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("BOLT", "Avg Prep Time") },
    derivation: "bolt_prep_minutes*bolt_orders",
    decimals: 4,
    check: sumCheck,
  },
  bolt_prep_minutes: {
    unit: "minutes",
    definition: "Swiggy Bolt average prep time, weighted by Bolt orders.",
    kind: "weighted_avg",
    accuracy: "approx",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("BOLT", "Avg Prep Time") },
    valueKey: "bolt_prep_wsum",
    weightKey: "bolt_orders",
    decimals: 2,
    check: minuteCheck,
  },
  bolt_fast_prep_orders: derivedCount(
    "Bolt orders with prep under 6 minutes.",
    "BOLT",
    "Orders with <6 min Prep time",
    "round(bolt_fast_prep_pct*bolt_orders/100)",
  ),
  bolt_fast_prep_pct: pctRatio(
    "Share of Bolt orders prepared in under 6 minutes.",
    "BOLT",
    "Orders with <6 min Prep time",
    "bolt_fast_prep_orders",
    "bolt_orders",
  ),
  bolt_delayed_orders_gt5: {
    unit: "count",
    definition: "Bolt orders delayed by more than 5 minutes.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("BOLT", "Delayed Orders (>5 mins)") },
    check: sumCheck,
  },
  rated_orders: {
    unit: "count",
    definition:
      "Orders that received a rating. The same label is not confirmed to mean the same thing.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", "Rated orders"),
      swiggy: label("RATINGS", "total rated orders"),
    },
    check: sumCheck,
  },
  poor_rated_orders: {
    unit: "count",
    definition: "Orders with a poor customer rating.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", "Poor rated orders"),
      swiggy: label("RATINGS", "Poor Rated Orders"),
    },
    check: sumCheck,
  },
  rating_snapshot_sum: {
    unit: "decimal",
    definition: "Zomato's daily platform rating. A range is the sum of these snapshots.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Average rating") },
    decimals: 4,
    check: sumCheck,
  },
  rating_snapshot_days: {
    unit: "count",
    definition: "One for each day that has a Zomato platform rating snapshot.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Average rating") },
    check: sumCheck,
  },
  rating: {
    unit: "decimal",
    definition:
      "Zomato platform rating: the sum of daily snapshots divided by days with a snapshot.",
    kind: "snapshot_mean",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Average rating") },
    valueKey: "rating_snapshot_sum",
    weightKey: "rating_snapshot_days",
    max: 5,
    decimals: 2,
    check: ratioCheck,
  },
  bad_orders: {
    unit: "count",
    definition:
      "Zomato's bad-order count. It is the platform's own count, not the sum of its slices.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Bad orders") },
    check: sumCheck,
  },
  bad_orders_pct: pctRatioZ(
    "Share of delivered orders Zomato treats as bad.",
    "Customer experience",
    "Bad orders %",
    "bad_orders",
    "delivered_orders",
  ),
  rejected_orders: {
    unit: "count",
    definition: "Rejected orders in Zomato's bad-orders breakdown.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Rejected orders") },
    check: sumCheck,
  },
  delayed_orders_kpt10: {
    unit: "count",
    definition: "Zomato orders delayed by KPT plus 10 minutes.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "KPT+10 delayed orders") },
    check: sumCheck,
  },
  delayed_orders_gt10: derivedCount(
    "Swiggy orders delayed by more than 10 minutes.",
    "OPERATIONS",
    "Delayed Orders (> 10 mins)",
    "round(delayed_gt10_pct*delivered_orders/100)",
  ),
  delayed_orders_gt10_pct: pctRatio(
    "Share of delivered Swiggy orders delayed by more than 10 minutes.",
    "OPERATIONS",
    "Delayed Orders (> 10 mins)",
    "delayed_orders_gt10",
    "delivered_orders",
  ),
  complaints: {
    unit: "count",
    definition:
      "Complaints. Zomato's total, or Swiggy's non-refunded plus refunded. Not added across platforms.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", "Total complaints"),
      swiggy: label("COMPLAINTS", "Non-refunded Complaints"),
    },
    check: sumCheck,
  },
  non_refunded_complaints: {
    unit: "count",
    definition:
      "Complaints that were not refunded. This is not the slice inside Zomato bad orders.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", "Non-refunded complaints"),
      swiggy: label("COMPLAINTS", "Non-refunded Complaints"),
    },
    check: sumCheck,
  },
  refunded_complaints: {
    unit: "count",
    definition: "Swiggy complaints the customer was refunded for.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("COMPLAINTS", "Customer Refunded Complaints") },
    check: sumCheck,
  },
  complaints_missing: complaint(
    "Missing items",
    "Missing Items",
    "Complaints about missing items.",
  ),
  complaints_quality: complaint("Poor quality", "Quality Issues", "Complaints about food quality."),
  complaints_wrong: complaint("Wrong order", "Wrong Items", "Complaints about a wrong item."),
  complaints_packaging: complaint(
    "Poor packaging",
    "Packaging & Spillage",
    "Complaints about packaging. Swiggy's label also includes spillage.",
  ),
  complaints_quantity: {
    unit: "count",
    definition: "Swiggy complaints about quantity.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("COMPLAINTS", "Quantity Issues") },
    check: sumCheck,
  },
  complaint_orders: derivedCount(
    "Swiggy orders that had a complaint. One order can carry more than one complaint.",
    "COMPLAINTS",
    "% Orders with Complaints",
    "round(complaint_orders_pct*delivered_orders/100)",
  ),
  complaint_orders_pct: pctRatio(
    "Share of delivered Swiggy orders that had a complaint.",
    "COMPLAINTS",
    "% Orders with Complaints",
    "complaint_orders",
    "delivered_orders",
  ),
  self_logged_ors: {
    unit: "count",
    definition: "Zomato self-logged other order issues. Not part of the bad-order count.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Self logs other ors") },
    check: sumCheck,
  },
  lost_sales_paise: {
    unit: "paise",
    definition: "Sales Zomato reports as lost, for example from being offline or rejecting.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Lost sales (Rs)") },
    check: sumCheck,
  },
  online_hours: {
    unit: "hours",
    definition: "Hours the outlet was online. Empty until scheduled hours are stored.",
    kind: "sum",
    accuracy: "approx",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {},
    decimals: 4,
    check: sumCheck,
  },
  scheduled_hours: {
    unit: "hours",
    definition: "Hours the outlet was scheduled to be open. The weight for online percentage.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {},
    decimals: 4,
    check: sumCheck,
  },
  online_pct: {
    unit: "pct",
    definition:
      "Share of time the outlet was online. Days with scheduled hours are weighted by those hours. A day without scheduled hours counts as one day, and that result stays approximate.",
    kind: "weighted_avg",
    accuracy: "approx",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", "Online %"),
      swiggy: label("OPERATIONS", "Online Availability %"),
    },
    valueKey: "online_hours",
    weightKey: "scheduled_hours",
    presentAs: "pct",
    decimals: 2,
    max: 100,
    check: ratioCheck,
  },
  offline_time_hours: {
    unit: "hours",
    definition:
      "Zomato's offline time for one platform window. The rounded daily hours do not add up.",
    kind: "platform_only",
    accuracy: "approx",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "Offline time (in hours)") },
    decimals: 4,
    check: offlineExcluded,
  },
  kpt_weighted_sum: {
    unit: "decimal",
    definition: "Kitchen prep minutes times delivered orders.",
    kind: "sum",
    accuracy: "approx",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", "KPT (in minutes)"),
      swiggy: label("OPERATIONS", "Kitchen Prep Time"),
    },
    derivation: "kpt_minutes*delivered_orders",
    decimals: 4,
    check: sumCheck,
  },
  kpt_minutes: {
    unit: "minutes",
    definition: "Kitchen preparation time, weighted by delivered orders. An approximation.",
    kind: "weighted_avg",
    accuracy: "approx",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", "KPT (in minutes)"),
      swiggy: label("OPERATIONS", "Kitchen Prep Time"),
    },
    valueKey: "kpt_weighted_sum",
    weightKey: "delivered_orders",
    decimals: 1,
    check: minuteCheck,
  },
  for_accurate_est: {
    unit: "decimal",
    definition: "Zomato FOR accuracy times delivered orders. The daily percentage is rounded.",
    kind: "sum",
    accuracy: "approx",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "FOR accuracy (%)") },
    derivation: "for_pct/100*delivered_orders",
    decimals: 4,
    check: sumCheck,
  },
  for_accuracy_pct: {
    unit: "pct",
    definition: "Zomato food-order-ready accuracy, weighted by delivered orders.",
    kind: "weighted_avg",
    accuracy: "approx",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer experience", "FOR accuracy (%)") },
    valueKey: "for_accurate_est",
    weightKey: "delivered_orders",
    presentAs: "pct",
    decimals: 2,
    check: pointsCheck,
  },
  mfr_accurate_orders: derivedCount(
    "Swiggy orders marked food-ready on time. The denominator is delivered orders.",
    "OPERATIONS",
    "Food Ready Accuracy (MFR)",
    "round(mfr_pct*delivered_orders/100)",
  ),
  food_ready_accuracy_pct: pctRatio(
    "Swiggy food-ready accuracy: accurate orders divided by delivered orders.",
    "OPERATIONS",
    "Food Ready Accuracy (MFR)",
    "mfr_accurate_orders",
    "delivered_orders",
  ),
  impressions: {
    unit: "decimal",
    definition: "Menu impressions. Swiggy's figures keep their decimals.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer funnel", "Impressions"),
      swiggy: label("CONVERSION_FUNNEL", "Impressions"),
    },
    decimals: 4,
    check: sumCheck,
  },
  menu_opens: countBoth(
    "Menu opens.",
    label("Customer funnel", "Menu opens"),
    label("CONVERSION_FUNNEL", "Menu Opens"),
  ),
  cart_builds: countBoth(
    "Cart builds.",
    label("Customer funnel", "Cart builds"),
    label("CONVERSION_FUNNEL", "Carts Builds"),
  ),
  placed_orders: {
    unit: "count",
    definition:
      "Zomato placed orders. This is above delivered, and it is not Swiggy's funnel count.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer funnel", "Placed Orders") },
    check: sumCheck,
  },
  swiggy_funnel_orders: {
    unit: "count",
    definition:
      "Swiggy Orders Placed. It stays below delivered orders, so it is a funnel count only.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("CONVERSION_FUNNEL", "Orders Placed") },
    check: sumCheck,
  },
  impressions_to_menu_pct: {
    ...pctRatioBoth("Share of impressions that became menu opens.", "menu_opens", "impressions"),
    sourceLabel: {
      zomato: label("Customer funnel", "Impressions to menu (%)"),
      swiggy: label("CONVERSION_FUNNEL", "Impressions to Menu"),
    },
    check: pointsCheck,
  },
  menu_to_cart_pct: {
    ...pctRatioBoth("Share of menu opens that became cart builds.", "cart_builds", "menu_opens"),
    sourceLabel: {
      zomato: label("Customer funnel", "Menu to cart (%)"),
      swiggy: label("CONVERSION_FUNNEL", "Menu to Cart"),
    },
    check: pointsCheck,
  },
  cart_to_orders_pct: {
    unit: "pct",
    definition:
      "Share of cart builds that became funnel orders. The numerator differs by platform.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer funnel", "Cart to orders (%)"),
      swiggy: label("CONVERSION_FUNNEL", "Cart to Order"),
    },
    numeratorByPlatform: { zomato: "placed_orders", swiggy: "swiggy_funnel_orders" },
    denominatorKey: "cart_builds",
    presentAs: "pct",
    decimals: 2,
    max: 100,
    check: pointsCheck,
  },
  menu_conversion_pct: {
    unit: "pct",
    definition:
      "Legacy single funnel rate. It is not rolled up. Use the three funnel rates instead.",
    kind: "platform_only",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {},
    decimals: 2,
    max: 100,
    check: pointsCheck,
  },
  new_user_orders: {
    unit: "count",
    definition:
      "Zomato orders from new users. Together with repeat and lapsed, these match placed orders.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer segmentation", "New user orders") },
    check: sumCheck,
  },
  repeat_user_orders: {
    unit: "count",
    definition: "Zomato orders from repeat users.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer segmentation", "Repeat user orders") },
    check: sumCheck,
  },
  lapsed_user_orders: {
    unit: "count",
    definition: "Zomato orders from lapsed users. Not Swiggy's dormant orders.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer segmentation", "Lapsed user orders") },
    check: sumCheck,
  },
  swiggy_new_customer_orders: derivedCount(
    "Swiggy delivered orders from new customers.",
    "CUSTOMERS",
    "New Customer Order %",
    "round(new_customer_pct*delivered_orders/100)",
  ),
  swiggy_new_customer_pct: pctRatio(
    "Share of delivered Swiggy orders from new customers.",
    "CUSTOMERS",
    "New Customer Order %",
    "swiggy_new_customer_orders",
    "delivered_orders",
  ),
  swiggy_repeat_customer_orders: derivedCount(
    "Swiggy delivered orders from repeat customers.",
    "CUSTOMERS",
    "Repeat Customer Order %",
    "round(repeat_customer_pct*delivered_orders/100)",
  ),
  swiggy_repeat_customer_pct: pctRatio(
    "Share of delivered Swiggy orders from repeat customers.",
    "CUSTOMERS",
    "Repeat Customer Order %",
    "swiggy_repeat_customer_orders",
    "delivered_orders",
  ),
  dormant_user_orders: derivedCount(
    "Swiggy delivered orders from dormant customers. Not Zomato lapsed orders.",
    "CUSTOMERS",
    "Dormant Customer Order %",
    "round(dormant_customer_pct*delivered_orders/100)",
  ),
  dormant_customer_pct: pctRatio(
    "Share of delivered Swiggy orders from dormant customers.",
    "CUSTOMERS",
    "Dormant Customer Order %",
    "dormant_user_orders",
    "delivered_orders",
  ),
  swiggy_new_customers: customers("New Customers", "Distinct new customers in one Swiggy window."),
  swiggy_repeat_customers: customers(
    "Repeat Customers",
    "Distinct repeat customers in one Swiggy window.",
  ),
  swiggy_dormant_customers: customers(
    "Dormant Customers",
    "Distinct dormant customers in one Swiggy window.",
  ),
  unique_customers: {
    unit: "count",
    definition: "Distinct Zomato customers in the range, from salted payout hashes.",
    kind: "distinct",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: { label: "salted customer id" } },
    check: sumCheck,
  },
  breakfast_orders: meal("Breakfast orders"),
  lunch_orders: meal("Lunch orders"),
  snacks_orders: meal("Snacks orders"),
  dinner_orders: meal("Dinner orders"),
  late_night_orders: meal("Late night orders"),
  ads_sales_paise: {
    unit: "paise",
    definition: "Zomato sales from ads.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Ads", "Sales from ads (Rs)") },
    check: sumCheck,
  },
  ad_orders: {
    unit: "count",
    definition: "Zomato orders attributed to ads. Swiggy CPC orders are cpc_orders.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Ads", "Ads orders") },
    check: sumCheck,
  },
  ads_impressions: {
    unit: "decimal",
    definition: "Zomato ads impressions.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Ads", "Ads impressions") },
    decimals: 4,
    check: sumCheck,
  },
  ads_menu_opens: {
    unit: "count",
    definition: "Zomato menu opens from ads.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Ads", "Ads menu opens") },
    check: sumCheck,
  },
  ads_ctr_pct: {
    unit: "pct",
    definition: "Zomato ads click-through rate: ads menu opens divided by ads impressions.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Ads", "Ads CTR (%)") },
    numeratorKey: "ads_menu_opens",
    denominatorKey: "ads_impressions",
    presentAs: "pct",
    decimals: 2,
    max: 100,
    check: pointsCheck,
  },
  ads_roi: {
    unit: "decimal",
    definition:
      "Zomato ads ROI from sales before the discount, divided by ads spend. Not a 0 to 100 percent.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Ads", "Ads ROI") },
    formula: "zomato_ads_roi",
    decimals: 4,
    check: ratioCheck,
  },
  cpc_sales_paise: cpc("paise", "CPC Driven Sales", "Swiggy CPC ad sales."),
  cpc_orders: cpc("count", "CPC Orders", "Swiggy orders attributed to CPC ads."),
  cpc_spend_paise: cpc("paise", "Total CPC Spends", "Swiggy CPC spend in the business export."),
  cpc_menu_opens: cpc("count", "CPC Menu Visits", "Swiggy menu visits from CPC ads."),
  cpc_roas: {
    unit: "pct",
    definition: "Swiggy CPC return: CPC sales divided by CPC spend.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("ADS_CPC", "ROAS") },
    numeratorKey: "cpc_sales_paise",
    denominatorKey: "cpc_spend_paise",
    presentAs: "pct",
    decimals: 2,
    check: ratioCheck,
  },
  cpc_ads_depth_pct: {
    unit: "pct",
    definition: "Swiggy CPC sales divided by Swiggy GMV. The monthly platform figure is excluded.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("ADS_CPC", "CPC Ads Depth") },
    numeratorKey: "cpc_sales_paise",
    denominatorKey: "swiggy_gmv_paise",
    presentAs: "pct",
    decimals: 2,
    check: cpcDepthCheck,
  },
  cba_sales_paise: cba("paise", "CBA Driven Sales", "Swiggy CBA ad sales."),
  cba_orders: cba("count", "CBA Orders", "Swiggy orders attributed to CBA ads."),
  cba_spend_paise: cba("paise", "Total CBA Spends", "Swiggy CBA spend."),
  cba_impressions: {
    ...cba("decimal", "Ad Impressions", "Swiggy CBA ad impressions."),
    decimals: 4,
  },
  cba_menu_opens: cba("count", "CBA Menu Visits", "Swiggy menu visits from CBA ads."),
  cba_ads_depth_pct: {
    unit: "pct",
    definition: "Swiggy CBA sales divided by Swiggy GMV.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("ADS_CBA", "CBA Ads Depth") },
    numeratorKey: "cba_sales_paise",
    denominatorKey: "swiggy_gmv_paise",
    presentAs: "pct",
    decimals: 2,
    check: ratioCheck,
  },
  cba_avg_cost_per_impression_paise: {
    unit: "paise",
    definition: "Swiggy CBA spend divided by CBA impressions.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("ADS_CBA", "Avg Cost Per Impressions") },
    numeratorKey: "cba_spend_paise",
    denominatorKey: "cba_impressions",
    decimals: 4,
    check: ratioCheck,
  },
  swiggy_gmv_paise: {
    unit: "paise",
    definition:
      "Swiggy gross value, restaurant discount divided by the discount GMV rate. Null when the discount is ₹0.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("DISCOUNTS", "Discount GMV %") },
    derivation: "discount_paise/(discount_gmv_pct/100)",
    check: sumCheck,
  },
  discount_gmv_pct: pctRatio(
    "Restaurant discount as a share of Swiggy GMV.",
    "DISCOUNTS",
    "Discount GMV %",
    "discount_paise",
    "swiggy_gmv_paise",
  ),
  discounted_orders: derivedCount(
    "Swiggy delivered orders that had a restaurant discount.",
    "DISCOUNTS",
    "Discounted Orders %",
    "round(discounted_orders_pct*delivered_orders/100)",
  ),
  discounted_orders_pct: pctRatio(
    "Share of delivered Swiggy orders that had a restaurant discount.",
    "DISCOUNTS",
    "Discounted Orders %",
    "discounted_orders",
    "delivered_orders",
  ),
  rdpo_paise: {
    unit: "paise",
    definition: "Restaurant discount per delivered Swiggy order, not per discounted order.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("DISCOUNTS", "Restaurant Discount Per Order(RDPO)") },
    numeratorKey: "discount_paise",
    denominatorKey: "delivered_orders",
    check: ratioCheck,
  },
  offer_gross_sales_paise: {
    unit: "paise",
    definition:
      "Zomato gross sales from offers. The file label is swapped with the orders column; the value decides.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Offers", "Orders with offers") },
    check: sumCheck,
  },
  offer_orders: {
    unit: "count",
    definition: "Zomato orders with offers. The file label is swapped with the sales column.",
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Offers", "Gross sales from offers (Rs)") },
    check: sumCheck,
  },
  offer_discount_pct: {
    unit: "pct",
    definition: "Zomato discount divided by gross sales from offers.",
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Offers", "Effective discount (%)") },
    numeratorKey: "discount_paise",
    denominatorKey: "offer_gross_sales_paise",
    presentAs: "pct",
    decimals: 2,
    check: ratioCheck,
  },
  menu_score: menuScore(
    "Menu Score(Out of 100)",
    "Swiggy menu score out of 100. A 0 is not computed.",
  ),
  menu_category_score: menuScore(
    "Category Score(Out of 100)",
    "Swiggy menu category score. A 0 is not computed.",
  ),
  menu_item_score: menuScore(
    "Item Score(Out of 100)",
    "Swiggy menu item score. A 0 is not computed.",
  ),
  menu_addon_score: menuScore(
    "Addon Score(Out of 100)",
    "Swiggy menu add-on score. A 0 is not computed.",
  ),
  menu_combo_score: menuScore(
    "Combo Score(Out of 100)",
    "Swiggy menu combo score. A 0 is not computed.",
  ),
  menu_photo_pct: menuPct("Items with Photos", "Share of Swiggy items that have a photo."),
  menu_desc_pct: menuPct(
    "Items with Descriptions",
    "Share of Swiggy items that have a description.",
  ),
  top5_items_revenue_paise: {
    unit: "paise",
    definition:
      "Gross revenue of the top 5 items in the requested window. It is not added across windows.",
    kind: "platform_only",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("MENU", "Top Selling Items (Gross Revenue)") },
    check: sumCheck,
  },
  lag_banner: {
    unit: "boolean",
    definition:
      "Whether Swiggy showed the 48-hour lag banner. The numbers on screen are still stored.",
    kind: "snapshot_latest",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: { label: "48-hour lag banner" } },
    check: sumCheck,
  },
} as const satisfies Record<string, MetricDefinition>;

function band(swiggyLabel: string, definition: string): Draft {
  return {
    unit: "count",
    definition,
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("SALES", swiggyLabel) },
    check: sumCheck,
  };
}

function derivedCount(
  definition: string,
  section: string,
  swiggyLabel: string,
  formula: string,
): Draft {
  return {
    unit: "count",
    definition,
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label(section, swiggyLabel) },
    derivation: formula,
    check: sumCheck,
  };
}

function pctRatio(
  definition: string,
  section: string,
  swiggyLabel: string,
  numeratorKey: string,
  denominatorKey: string,
): Draft {
  return {
    unit: "pct",
    definition,
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label(section, swiggyLabel) },
    numeratorKey,
    denominatorKey,
    presentAs: "pct",
    decimals: 2,
    max: 100,
    check: ratioCheck,
  };
}

function pctRatioZ(
  definition: string,
  section: string,
  zomatoLabel: string,
  numeratorKey: string,
  denominatorKey: string,
): Draft {
  return {
    unit: "pct",
    definition,
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label(section, zomatoLabel) },
    numeratorKey,
    denominatorKey,
    presentAs: "pct",
    decimals: 2,
    max: 100,
    check: ratioCheck,
  };
}

function pctRatioBoth(definition: string, numeratorKey: string, denominatorKey: string): Draft {
  return {
    unit: "pct",
    definition,
    kind: "ratio",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {},
    numeratorKey,
    denominatorKey,
    presentAs: "pct",
    decimals: 2,
    max: 100,
    check: ratioCheck,
  };
}

function countBoth(definition: string, zomato: SourceLabel, swiggy: SourceLabel): Draft {
  return {
    unit: "count",
    definition,
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: { zomato, swiggy },
    check: sumCheck,
  };
}

function complaint(zomatoTail: string, swiggyLabel: string, definition: string): Draft {
  return {
    unit: "count",
    definition,
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: both,
    sourceLabel: {
      zomato: label("Customer experience", `Total complaints - ${zomatoTail}`),
      swiggy: label("COMPLAINTS", swiggyLabel),
    },
    check: sumCheck,
  };
}

function customers(swiggyLabel: string, definition: string): Draft {
  return {
    unit: "count",
    definition,
    kind: "platform_only",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("CUSTOMERS", swiggyLabel) },
    check: sumCheck,
  };
}

function meal(zomatoLabel: string): Draft {
  return {
    unit: "count",
    definition: `Zomato ${zomatoLabel.toLowerCase()}.`,
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: zOnly,
    sourceLabel: { zomato: label("Customer segmentation", zomatoLabel) },
    check: sumCheck,
  };
}

function cpc(unit: MetricUnit, swiggyLabel: string, definition: string): Draft {
  return {
    unit,
    definition,
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("ADS_CPC", swiggyLabel) },
    check: unit === "paise" ? paiseSumCheck : sumCheck,
  };
}

function cba(unit: MetricUnit, swiggyLabel: string, definition: string): Draft {
  return {
    unit,
    definition,
    kind: "sum",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("ADS_CBA", swiggyLabel) },
    check: unit === "paise" ? paiseSumCheck : sumCheck,
  };
}

function menuScore(swiggyLabel: string, definition: string): Draft {
  return {
    unit: "decimal",
    definition,
    kind: "snapshot_latest",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("MENU", swiggyLabel) },
    skipZero: true,
    max: 100,
    decimals: 2,
    check: sumCheck,
  };
}

function menuPct(swiggyLabel: string, definition: string): Draft {
  return {
    unit: "pct",
    definition,
    kind: "snapshot_latest",
    accuracy: "exact",
    crossPlatform: false,
    platforms: sOnly,
    sourceLabel: { swiggy: label("MENU", swiggyLabel) },
    decimals: 2,
    max: 100,
    check: pointsCheck,
  };
}

export type MetricKey = keyof typeof METRIC_DEFINITIONS;

export const METRIC_KEYS = Object.keys(METRIC_DEFINITIONS) as [MetricKey, ...MetricKey[]];

/**
 * Keys whose Zomato and Swiggy values may be added. Everything else stays per platform.
 * Payout rows whose GST or discount treatment still differs stay false.
 */
export const CROSS_PLATFORM_KEYS = [
  "delivered_orders",
  "gross_sales_paise",
  "net_payout_paise",
  "platform_net_payout_paise",
  "commission_paise",
  "platform_fees_paise",
  "taxes_paise",
  "tds_paise",
  "tcs_paise",
  "cv_paise",
  "paid_amount_paise",
  "payout_orders",
] as const satisfies readonly MetricKey[];

export const RETIRED_METRIC_KEYS = {
  orders: "Use delivered_orders or payout_orders.",
  delayed_orders: "Use delayed_orders_kpt10 on Zomato and delayed_orders_gt10 on Swiggy.",
  bad_order_complaints: "Not mapped. Store bad_orders, complaints, and non_refunded_complaints.",
  mfr_eligible_orders: "Dropped. Food-ready accuracy uses delivered_orders as the denominator.",
} as const;

export const APPROX_METRIC_KEYS = [
  "kpt_minutes",
  "kpt_weighted_sum",
  "bolt_prep_minutes",
  "bolt_prep_wsum",
  "online_pct",
  "online_hours",
  "for_accuracy_pct",
  "for_accurate_est",
  "market_share_pct",
  "offline_time_hours",
] as const satisfies readonly MetricKey[];

const CROSS_PLATFORM = new Set<string>(CROSS_PLATFORM_KEYS);

export function isCrossPlatformKey(key: MetricKey): boolean {
  return CROSS_PLATFORM.has(key);
}

export function metricDefinition(key: string): MetricDefinition | undefined {
  if (!Object.hasOwn(METRIC_DEFINITIONS, key)) return undefined;
  return METRIC_DEFINITIONS[key as MetricKey] as MetricDefinition;
}

/** The definition of a known key. Indexing the const object does not keep optional fields. */
export function requireMetric(key: MetricKey): MetricDefinition {
  return METRIC_DEFINITIONS[key] as MetricDefinition;
}

/** The tolerance that applies to this comparison, or why the comparison is excluded. */
export function resolveCheck(
  key: MetricKey,
  platform: MetricPlatform,
  granularity: MetricGranularity,
): ActiveCheck | { mode: "excluded"; reason: string } {
  const definition = requireMetric(key);
  const walked = walkCheck(definition.check, platform, granularity);
  if (walked.mode === "excluded") return walked;
  if (definition.unit === "paise" && definition.kind === "sum" && walked.mode === "absolute") {
    return { mode: "absolute", amount: PAISE_SUM_TOLERANCE, relative: 0 };
  }
  return walked;
}

function walkCheck(
  rule: CheckRule,
  platform: MetricPlatform,
  granularity: MetricGranularity,
): ActiveCheck | { mode: "excluded"; reason: string } {
  if (rule.mode !== "excluded") {
    return { mode: rule.mode, amount: rule.amount ?? 0 };
  }
  const when = rule.when;
  const matches =
    !when ||
    ((when.platform === undefined || when.platform === platform) &&
      (when.granularity === undefined || when.granularity === granularity));
  if (matches) return { mode: "excluded", reason: rule.reason ?? "Excluded from platform checks." };
  if (rule.fallback) return rule.fallback;
  return { mode: "absolute", amount: 0 };
}

export function checkExclusions(): Array<{ key: MetricKey; reason: string }> {
  const found: Array<{ key: MetricKey; reason: string }> = [];
  for (const key of METRIC_KEYS) {
    const rule = METRIC_DEFINITIONS[key].check;
    if (rule.mode === "excluded" && rule.reason) found.push({ key, reason: rule.reason });
  }
  return found;
}

function sourceText(label: SourceLabel | undefined): string {
  if (!label) return "";
  return label.section ? `${label.section} / ${label.label}` : label.label;
}

/** Human-readable dictionary. The contract test checks this file stays in step with the keys. */
export function metricDictionaryMarkdown(): string {
  const lines = [
    "# Metric dictionary",
    "",
    "Machine-readable source: `packages/contracts/src/metric-dictionary.ts`.",
    "",
    "Money is integer paise. A missing figure is null, never zero. `crossPlatform` is true only for delivered orders and the payout keys that mean the same thing on both platforms.",
    "",
    "Granularity is `day`, `week_sun_sat` (Swiggy, Sunday–Saturday), `week_mon_sun` (Zomato, Monday–Sunday), `month`, or `custom`.",
    "",
    "Swiggy Daily accepts at most 7 days per file. Split a backfill into chunks of 7 days or fewer.",
    "",
  ];
  for (const key of METRIC_KEYS) {
    const item = requireMetric(key);
    lines.push(`## \`${key}\``);
    lines.push("");
    lines.push(item.definition);
    lines.push("");
    lines.push(`- unit: ${item.unit}`);
    lines.push(`- aggregation: ${item.kind}`);
    lines.push(`- accuracy: ${item.accuracy}`);
    lines.push(`- crossPlatform: ${item.crossPlatform}`);
    lines.push(`- platforms: ${item.platforms.join(", ")}`);
    const zomato = sourceText(item.sourceLabel.zomato);
    const swiggy = sourceText(item.sourceLabel.swiggy);
    if (zomato) lines.push(`- zomato source: ${zomato}`);
    if (swiggy) lines.push(`- swiggy source: ${swiggy}`);
    if (item.numeratorKey) lines.push(`- numerator: ${item.numeratorKey}`);
    if (item.denominatorKey) lines.push(`- denominator: ${item.denominatorKey}`);
    if (item.numeratorByPlatform?.zomato || item.numeratorByPlatform?.swiggy) {
      lines.push(
        `- numerator by platform: zomato ${item.numeratorByPlatform.zomato ?? "—"}, swiggy ${item.numeratorByPlatform.swiggy ?? "—"}`,
      );
    }
    if (item.weightKey) lines.push(`- weight: ${item.weightKey}`);
    if (item.valueKey) lines.push(`- value key: ${item.valueKey}`);
    if (item.derivation) lines.push(`- derivation: ${item.derivation}`);
    if (item.formula) lines.push(`- formula: ${item.formula}`);
    lines.push(`- check: ${checkText(item)}`);
    lines.push("");
  }
  lines.push("## Exclusions");
  lines.push("");
  for (const item of checkExclusions()) {
    lines.push(`- \`${item.key}\`: ${item.reason}`);
  }
  lines.push("");
  lines.push("## Retired keys");
  lines.push("");
  for (const [key, reason] of Object.entries(RETIRED_METRIC_KEYS)) {
    lines.push(`- \`${key}\`: ${reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

function checkText(item: MetricDefinition): string {
  const rule = item.check;
  if (rule.mode === "excluded") {
    const where = rule.when
      ? ` (${[rule.when.platform, rule.when.granularity].filter(Boolean).join(" ")})`
      : "";
    return `excluded${where}: ${rule.reason ?? ""}`;
  }
  if (item.unit === "paise" && item.kind === "sum" && rule.mode === "absolute") {
    return "absolute 100 paise plus relative 0";
  }
  return `${rule.mode} ${rule.amount ?? 0}`;
}
