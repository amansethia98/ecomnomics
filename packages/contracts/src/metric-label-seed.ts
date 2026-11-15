import type {
  LabelAlias,
  LabelBook,
  LabelMatchMode,
  LabelPlatform,
  LabelReportKind,
  LabelSlot,
} from "./metric-label.js";
import { normaliseLabel } from "./metric-label.js";

type ValueType =
  | "money"
  | "count"
  | "decimal"
  | "pct"
  | "minutes"
  | "hours"
  | "score_100"
  | "rating_5"
  | "ratio"
  | "date"
  | "text_id"
  | "flag";

interface SlotInput {
  platform: LabelPlatform;
  reportKind: LabelReportKind;
  section: string;
  slotKey: string;
  valueType: ValueType;
  summable: boolean;
  allowAutoApply?: boolean;
  collect?: "first" | "all";
}

interface AliasInput {
  label: string;
  matchMode?: LabelMatchMode;
  includeTokens?: string[];
  excludeTokens?: string[];
  group?: number;
  role?: "read" | "item_pattern";
}

const slots: LabelSlot[] = [];
const aliases: LabelAlias[] = [];

function add(slot: SlotInput, rules: AliasInput[]): string {
  const id = `${slot.platform}.${slot.reportKind}.${slot.section}.${slot.slotKey}`;
  slots.push({
    id,
    platform: slot.platform,
    reportKind: slot.reportKind,
    slotKey: slot.slotKey,
    section: slot.section,
    valueType: slot.valueType,
    summable: slot.summable,
    allowAutoApply: slot.allowAutoApply ?? true,
    collect: slot.collect ?? "first",
  });
  rules.forEach((rule, index) => {
    const group = rule.group ?? 0;
    aliases.push({
      id: `${id}#${group}#${index}`,
      slotId: id,
      platform: slot.platform,
      reportKind: slot.reportKind,
      label: rule.label,
      normLabel: normaliseLabel(rule.label),
      matchMode: rule.matchMode ?? "tokens",
      includeTokens: rule.includeTokens ?? [],
      excludeTokens: rule.excludeTokens ?? [],
      group,
      role: rule.role ?? "read",
      source: "seed",
      createdBy: null,
    });
  });
  return id;
}

function business(
  platform: LabelPlatform,
  section: string,
  slotKey: string,
  label: string,
  valueType: ValueType,
  summable: boolean,
): void {
  add({ platform, reportKind: "business", section, slotKey, valueType, summable }, [
    { label, matchMode: "exact", includeTokens: [label.toLowerCase()] },
  ]);
}

function swiggyBusiness(): void {
  const rows: Array<[string, string, string, ValueType, boolean]> = [
    ["SALES", "net_sales", "Net Sales", "money", true],
    ["SALES", "delivered_orders", "Delivered Orders", "count", true],
    ["SALES", "restaurant_cancelled_orders", "Restaurant Cancelled Orders", "count", true],
    ["SALES", "cancelled_order_loss", "Cancelled Order Loss", "money", true],
    ["SALES", "orders_band_lt250", "Number of Orders below ₹250", "count", true],
    ["SALES", "orders_band_250_450", "Number of Orders between ₹250 and ₹450", "count", true],
    ["SALES", "orders_band_450_650", "Number of Orders between ₹450 and ₹650", "count", true],
    ["SALES", "orders_band_650_850", "Number of Orders between ₹650 and ₹850", "count", true],
    ["SALES", "orders_band_gt850", "Number of Orders above ₹850", "count", true],
    ["SALES", "market_share", "Market Share", "pct", false],
    ["SALES", "net_aov", "Net AOV", "money", false],
    ["BOLT", "orders", "Orders", "count", true],
    ["BOLT", "delayed_orders_gt5", "Delayed Orders (>5 mins)", "count", true],
    ["BOLT", "bolt_orders_pct", "% of Bolt Orders", "pct", false],
    ["BOLT", "aov", "AOV", "money", false],
    ["BOLT", "avg_prep_time", "Avg Prep Time", "minutes", false],
    ["BOLT", "fast_prep_pct", "Orders with <6 min Prep time", "pct", false],
    ["RATINGS", "rated_orders", "total rated orders", "count", true],
    ["RATINGS", "poor_rated_orders", "Poor Rated Orders", "count", true],
    ["CONVERSION_FUNNEL", "impressions", "Impressions", "decimal", true],
    ["CONVERSION_FUNNEL", "menu_opens", "Menu Opens", "count", true],
    ["CONVERSION_FUNNEL", "cart_builds", "Carts Builds", "count", true],
    ["CONVERSION_FUNNEL", "orders_placed", "Orders Placed", "count", true],
    ["CONVERSION_FUNNEL", "impressions_to_menu", "Impressions to Menu", "pct", false],
    ["CONVERSION_FUNNEL", "menu_to_cart", "Menu to Cart", "pct", false],
    ["CONVERSION_FUNNEL", "cart_to_order", "Cart to Order", "pct", false],
    ["CUSTOMERS", "new_customers", "New Customers", "count", true],
    ["CUSTOMERS", "repeat_customers", "Repeat Customers", "count", true],
    ["CUSTOMERS", "dormant_customers", "Dormant Customers", "count", true],
    ["CUSTOMERS", "new_customer_order_pct", "New Customer Order %", "pct", false],
    ["CUSTOMERS", "repeat_customer_order_pct", "Repeat Customer Order %", "pct", false],
    ["CUSTOMERS", "dormant_customer_order_pct", "Dormant Customer Order %", "pct", false],
    ["ADS_CPC", "cpc_sales", "CPC Driven Sales", "money", true],
    ["ADS_CPC", "cpc_orders", "CPC Orders", "count", true],
    ["ADS_CPC", "cpc_spend", "Total CPC Spends", "money", true],
    ["ADS_CPC", "cpc_menu_opens", "CPC Menu Visits", "count", true],
    ["ADS_CPC", "roas", "ROAS", "ratio", false],
    ["ADS_CPC", "ads_depth", "CPC Ads Depth", "pct", false],
    ["ADS_CBA", "cba_sales", "CBA Driven Sales", "money", true],
    ["ADS_CBA", "cba_orders", "CBA Orders", "count", true],
    ["ADS_CBA", "cba_spend", "Total CBA Spends", "money", true],
    ["ADS_CBA", "impressions", "Ad Impressions", "decimal", true],
    ["ADS_CBA", "menu_opens", "CBA Menu Visits", "count", true],
    ["ADS_CBA", "ads_depth", "CBA Ads Depth", "pct", false],
    ["ADS_CBA", "avg_cost_per_impression", "Avg Cost Per Impressions", "money", false],
    ["DISCOUNTS", "discount", "Discount Given by Restaurant(RDGMV)", "money", true],
    ["DISCOUNTS", "discount_gmv", "Discount GMV %", "pct", false],
    ["DISCOUNTS", "discounted_orders_pct", "Discounted Orders %", "pct", false],
    ["DISCOUNTS", "rdpo", "Restaurant Discount Per Order(RDPO)", "money", false],
    ["OPERATIONS", "online", "Online Availability %", "pct", false],
    ["OPERATIONS", "kpt", "Kitchen Prep Time", "minutes", false],
    ["OPERATIONS", "food_ready", "Food Ready Accuracy (MFR)", "pct", false],
    ["OPERATIONS", "delayed_gt10", "Delayed Orders (> 10 mins)", "pct", false],
    ["COMPLAINTS", "non_refunded", "Non-refunded Complaints", "count", true],
    ["COMPLAINTS", "refunded", "Customer Refunded Complaints", "count", true],
    ["COMPLAINTS", "missing", "Missing Items", "count", true],
    ["COMPLAINTS", "quality", "Quality Issues", "count", true],
    ["COMPLAINTS", "quantity", "Quantity Issues", "count", true],
    ["COMPLAINTS", "wrong", "Wrong Items", "count", true],
    ["COMPLAINTS", "packaging", "Packaging & Spillage", "count", true],
    ["COMPLAINTS", "complaint_orders_pct", "% Orders with Complaints", "pct", false],
    ["MENU", "top5_items", "Top Selling Items (Gross Revenue)", "money", true],
    ["MENU", "menu_score", "Menu Score(Out of 100)", "score_100", false],
    ["MENU", "category_score", "Category Score(Out of 100)", "score_100", false],
    ["MENU", "item_score", "Item Score(Out of 100)", "score_100", false],
    ["MENU", "addon_score", "Addon Score(Out of 100)", "score_100", false],
    ["MENU", "combo_score", "Combo Score(Out of 100)", "score_100", false],
    ["MENU", "items_with_photos", "Items with Photos", "pct", false],
    ["MENU", "items_with_descriptions", "Items with Descriptions", "pct", false],
  ];
  for (const [section, slotKey, label, valueType, summable] of rows) {
    business("swiggy", section, slotKey, label, valueType, summable);
  }
  add(
    {
      platform: "swiggy",
      reportKind: "business",
      section: "MENU",
      slotKey: "item_revenue_pct",
      valueType: "pct",
      summable: false,
    },
    [{ label: "{item} Revenue %", role: "item_pattern", matchMode: "exact" }],
  );
}

function zomatoBusiness(): void {
  const rows: Array<[string, string, string, ValueType, boolean]> = [
    ["Sales", "delivered_orders", "Delivered orders", "count", true],
    ["Sales", "sales", "Sales (Rs)", "money", true],
    ["Sales", "market_share", "Market share (%)", "pct", false],
    ["Customer experience", "rated_orders", "Rated orders", "count", true],
    ["Customer experience", "bad_orders", "Bad orders", "count", true],
    ["Customer experience", "rejected_orders", "Rejected orders", "count", true],
    ["Customer experience", "delayed_orders_kpt10", "KPT+10 delayed orders", "count", true],
    ["Customer experience", "poor_rated_orders", "Poor rated orders", "count", true],
    ["Customer experience", "complaints", "Total complaints", "count", true],
    ["Customer experience", "non_refunded", "Non-refunded complaints", "count", true],
    ["Customer experience", "packaging", "Total complaints - Poor packaging", "count", true],
    ["Customer experience", "quality", "Total complaints - Poor quality", "count", true],
    ["Customer experience", "wrong", "Total complaints - Wrong order", "count", true],
    ["Customer experience", "missing", "Total complaints - Missing items", "count", true],
    ["Customer experience", "self_logged_ors", "Self logs other ors", "count", true],
    ["Customer experience", "lost_sales", "Lost sales (Rs)", "money", true],
    ["Customer experience", "rating", "Average rating", "rating_5", false],
    ["Customer experience", "offline_time", "Offline time (in hours)", "hours", false],
    ["Customer experience", "online", "Online %", "pct", false],
    ["Customer experience", "kpt", "KPT (in minutes)", "minutes", false],
    ["Customer experience", "for_accuracy", "FOR accuracy (%)", "pct", false],
    ["Customer funnel", "impressions", "Impressions", "decimal", true],
    ["Customer funnel", "menu_opens", "Menu opens", "count", true],
    ["Customer funnel", "cart_builds", "Cart builds", "count", true],
    ["Customer funnel", "placed_orders", "Placed Orders", "count", true],
    ["Customer funnel", "impressions_to_menu", "Impressions to menu (%)", "pct", false],
    ["Customer funnel", "menu_to_cart", "Menu to cart (%)", "pct", false],
    ["Customer funnel", "cart_to_orders", "Cart to orders (%)", "pct", false],
    ["Customer segmentation", "new_user_orders", "New user orders", "count", true],
    ["Customer segmentation", "repeat_user_orders", "Repeat user orders", "count", true],
    ["Customer segmentation", "lapsed_user_orders", "Lapsed user orders", "count", true],
    ["Customer segmentation", "breakfast_orders", "Breakfast orders", "count", true],
    ["Customer segmentation", "lunch_orders", "Lunch orders", "count", true],
    ["Customer segmentation", "snacks_orders", "Snacks orders", "count", true],
    ["Customer segmentation", "dinner_orders", "Dinner orders", "count", true],
    ["Customer segmentation", "late_night_orders", "Late night orders", "count", true],
    ["Ads", "ads_sales", "Sales from ads (Rs)", "money", true],
    ["Ads", "ads_impressions", "Ads impressions", "decimal", true],
    ["Ads", "ads_menu_opens", "Ads menu opens", "count", true],
    ["Ads", "ad_orders", "Ads orders", "count", true],
    ["Ads", "ad_spend", "Ads spend (Rs)", "money", true],
    ["Ads", "ads_ctr", "Ads CTR (%)", "pct", false],
    ["Ads", "ads_roi", "Ads ROI", "ratio", false],
    ["Offers", "discount", "Discount given (Rs)", "money", true],
    ["Offers", "orders_with_offers", "Orders with offers", "count", true],
    ["Offers", "offer_gross_sales", "Gross sales from offers (Rs)", "money", true],
    ["Offers", "effective_discount", "Effective discount (%)", "pct", false],
  ];
  for (const [section, slotKey, label, valueType, summable] of rows) {
    business("zomato", section, slotKey, label, valueType, summable);
  }
}

function tokens(label: string, include: string[], exclude: string[] = [], group = 0): AliasInput {
  return { label, matchMode: "tokens", includeTokens: include, excludeTokens: exclude, group };
}

function exact(label: string, needle: string, exclude: string[] = [], group = 0): AliasInput {
  return { label, matchMode: "exact", includeTokens: [needle], excludeTokens: exclude, group };
}

function prefix(label: string, needle: string, group = 0): AliasInput {
  return { label, matchMode: "prefix", includeTokens: [needle], group };
}

function zomatoPayout(): void {
  const order = "order_level";
  const breakup = "breakup";
  const platform = "zomato" as const;
  const reportKind = "payout" as const;
  const column = (
    section: string,
    slotKey: string,
    valueType: ValueType,
    summable: boolean,
    rules: AliasInput[],
    extra?: { allowAutoApply?: boolean; collect?: "first" | "all" },
  ) =>
    add(
      {
        platform,
        reportKind,
        section,
        slotKey,
        valueType,
        summable,
        allowAutoApply: extra?.allowAutoApply,
        collect: extra?.collect,
      },
      rules,
    );

  column(order, "order_id", "text_id", false, [tokens("Order ID", ["order id"])], {
    allowAutoApply: false,
  });
  column(order, "order_status", "text_id", false, [tokens("Order status", ["order status"])]);
  column(order, "order_date", "date", false, [
    exact("Order date", "order date"),
    tokens("Order date (not settlement)", ["order date"], ["settlement"], 1),
  ]);
  column(order, "subtotal", "money", true, [tokens("Subtotal", ["subtotal"])]);
  column(order, "packaging", "money", true, [tokens("Packaging charge", ["packaging"])]);
  column(order, "promo_discount", "money", true, [
    tokens("Discount (promo)", ["discount", "promo"]),
  ]);
  column(order, "other_discount", "money", true, [
    tokens("Restaurant discount", ["restaurant discount"], ["promo"]),
  ]);
  column(order, "service_fee", "money", true, [
    tokens("Service fee", ["service fee"], ["%", "payment", "tax"]),
  ]);
  column(order, "payment_fee", "money", true, [
    tokens("Payment mechanism fee", ["payment mechanism"], ["service", "tax"]),
  ]);
  column(order, "taxes", "money", true, [tokens("Taxes on service fees", ["taxes on service"])]);
  column(order, "tds", "money", true, [tokens("TDS", ["tds"])]);
  column(
    order,
    "tcs",
    "money",
    true,
    [
      tokens("Tax collected at source", ["tax collected at source"], ["applicable"]),
      exact("TCS", "tcs", ["applicable"]),
      tokens("TCS IGST", ["tcs igst"], ["applicable"]),
    ],
    { collect: "all" },
  );
  column(order, "complaints", "money", true, [
    tokens("Compensation", ["compensation"]),
    tokens("Recoupment", ["recoupment"]),
  ]);
  column(order, "net_additions", "money", true, [tokens("Net additions", ["net additions"])]);
  column(order, "commissionable", "money", true, [
    tokens("Commissionable value", ["commissionable"]),
  ]);
  column(order, "gst_collected", "money", true, [
    tokens("Total GST collected from customers", ["gst collected"]),
  ]);
  column(order, "gst_paid_9_5", "money", true, [
    tokens("GST paid by Zomato on behalf of restaurant - under section 9(5)", ["gst", "9(5)"]),
  ]);
  column(order, "gst_restaurant_payable", "money", true, [
    tokens("GST to be paid by Restaurant partner to Govt.", ["gst", "restaurant partner"]),
    tokens("GST to be paid to Govt.", ["gst", "to be paid", "govt"]),
  ]);
  column(order, "order_level_payout", "money", true, [
    tokens("Order level payout", ["order level payout"]),
  ]);
  column(order, "settlement_date", "date", false, [tokens("Settlement date", ["settlement date"])]);
  column(order, "cancelled_by", "text_id", false, [tokens("Cancelled by", ["cancelled by"])]);
  column(order, "settlement_status", "text_id", false, [
    tokens("Settlement status", ["settlement status"]),
  ]);
  column(order, "utr", "text_id", false, [tokens("UTR", ["utr"])], { allowAutoApply: false });
  column(order, "customer_id", "text_id", false, [tokens("Customer ID", ["customer id"])], {
    allowAutoApply: false,
  });
  column(order, "paid_amount", "money", true, [
    tokens("Amount settled", ["amount settled"], ["unsettled"]),
    tokens("Settled amount", ["settled amount"], ["unsettled"]),
    tokens("Amount paid", ["amount paid"], ["unsettled"]),
    exact("Paid amount", "paid amount", ["unsettled"]),
  ]);
  column(breakup, "order_count", "count", true, [tokens("Number of orders", ["number of orders"])]);
  column(breakup, "tcs", "money", true, [
    tokens("Breakup tax collected at source", ["tax collected at source"]),
    tokens("Breakup TCS IGST", ["tcs", "igst"]),
  ]);
  column(breakup, "net_payout", "money", true, [tokens("Net payout", ["net payout"])]);
  column(breakup, "ad_spend", "money", true, [tokens("Total ads", ["total ads"])]);
  column(breakup, "paid_amount", "money", true, [
    prefix("Amount settled (breakup)", "amount settled"),
  ]);
  column(order, "adjustment_type", "text_id", false, [tokens("Adjustment type", ["type"])]);
  column(order, "adjustment_amount", "money", true, [
    tokens("Adjusted amount", ["adjusted"]),
    tokens("Total amount", ["total amount"], [], 1),
  ]);
  column(order, "adjustment_period", "date", false, [
    tokens("Adjustment period", ["period"]),
    tokens("Deduction period", ["deduction"], [], 1),
  ]);
  column(order, "adjustment_invoice", "text_id", false, [
    tokens("Invoice", ["invoice"]),
    tokens("Campaign", ["campaign"], [], 1),
  ]);
  column(
    "summary",
    "restaurant_id",
    "text_id",
    false,
    [
      tokens("Restaurant ID", ["restaurant id"]),
      exact("Res. ID", "res. id"),
      exact("Res ID", "res id"),
    ],
    { allowAutoApply: false },
  );
  column("summary", "restaurant_name", "text_id", false, [
    exact("Res name", "res name"),
    tokens("Restaurant name", ["name"]),
  ]);
  column("summary", "city", "text_id", false, [exact("City", "city")]);
  column("summary", "area", "text_id", false, [exact("Area", "area"), exact("Subzone", "subzone")]);
  column("summary", "address", "text_id", false, [exact("Address", "address")]);
}

function swiggyAnnexure(): void {
  const order = "order_level";
  const breakup = "breakup";
  const platform = "swiggy" as const;
  const reportKind = "payout_annexure" as const;
  const column = (
    section: string,
    slotKey: string,
    valueType: ValueType,
    summable: boolean,
    rules: AliasInput[],
    extra?: { allowAutoApply?: boolean; collect?: "first" | "all" },
  ) =>
    add(
      {
        platform,
        reportKind,
        section,
        slotKey,
        valueType,
        summable,
        allowAutoApply: extra?.allowAutoApply,
        collect: extra?.collect,
      },
      rules,
    );

  column(order, "order_id", "text_id", false, [tokens("Order ID", ["order id"])], {
    allowAutoApply: false,
  });
  column(order, "order_date", "date", false, [
    exact("Order date", "order date"),
    tokens("Order date (not settlement)", ["order date"], ["settlement"], 1),
  ]);
  column(order, "order_status", "text_id", false, [tokens("Order status", ["order status"])]);
  column(order, "cancelled_by", "text_id", false, [tokens("Cancelled by", ["cancelled by"])]);
  column(order, "item_total", "money", true, [tokens("Item total", ["item total"])]);
  column(order, "packaging", "money", true, [tokens("Packaging charge", ["packaging"])]);
  column(order, "discount", "money", true, [
    tokens("Discount share", ["discount share"]),
    tokens("Discount", ["discount"], [], 1),
  ]);
  column(order, "commission", "money", true, [exact("Commission", "commission")]);
  column(order, "total_fees", "money", true, [tokens("Total Swiggy fees", ["total swiggy fees"])]);
  column(order, "gst_on_fees", "money", true, [tokens("GST on service fee", ["gst on service"])]);
  column(order, "tds", "money", true, [exact("TDS", "tds")]);
  column(order, "tcs", "money", true, [exact("TCS", "tcs")]);
  column(order, "complaints", "money", true, [
    tokens("Complaint and cancellation charges", ["complaint", "cancellation"]),
    tokens("Complaint", ["complaint"], [], 1),
  ]);
  column(order, "net_bill", "money", true, [tokens("Net bill", ["net bill"])]);
  column(order, "settlement_date", "date", false, [tokens("Settlement date", ["settlement date"])]);
  column(order, "category", "text_id", false, [tokens("Category", ["category"])]);
  column(order, "settlement_status", "text_id", false, [
    tokens("Settlement status", ["settlement status"]),
  ]);
  column(order, "utr", "text_id", false, [tokens("UTR", ["utr"])], { allowAutoApply: false });
  column(order, "mfr_marked", "flag", false, [
    tokens("MFR pressed", ["mfr pressed"]),
    tokens("MFR marked", ["mfr marked"], [], 1),
  ]);
  column(order, "mfr_accurate", "flag", false, [tokens("MFR accurate", ["mfr accurate"])]);
  column(order, "gst_collected", "money", true, [tokens("GST collected", ["gst collected"])]);
  column(order, "net_payout", "money", true, [tokens("Net payout", ["net payout"])]);
  column(order, "paid_amount", "money", true, [
    tokens("Amount settled", ["amount settled"], ["unsettled"]),
    tokens("Settled amount", ["settled amount"], ["unsettled"]),
    tokens("Amount paid", ["amount paid"], ["unsettled"]),
    exact("Paid amount", "paid amount", ["unsettled"]),
  ]);
  column(breakup, "order_count", "count", true, [
    exact("Orders", "orders"),
    tokens("Number of orders", ["number of orders"]),
  ]);
  column(
    breakup,
    "restaurant_discount",
    "money",
    true,
    [tokens("Restaurant discount", ["restaurant discount"])],
    { collect: "all" },
  );
  column(breakup, "commission", "money", true, [tokens("Commission line", ["commission"])]);
  column(breakup, "swiggy_fees", "money", true, [tokens("Swiggy fees", ["swiggy fees"])]);
  column(breakup, "tds", "money", true, [tokens("TDS line", ["tds"])]);
  column(breakup, "tcs", "money", true, [tokens("TCS line", ["tcs"])]);
  column(breakup, "complaints", "money", true, [tokens("Complaint line", ["complaint"])]);
  column(breakup, "net_payout", "money", true, [
    prefix("Net payout line", "net payout"),
    exact("Payout line G", "g"),
  ]);
  column(breakup, "ad_spend", "money", true, [
    tokens("Growth investments", ["growth"]),
    tokens("Ads", ["ads"], [], 1),
  ]);
  column("summary", "restaurant_id", "text_id", false, [tokens("Rest. ID", ["rest. id"])], {
    allowAutoApply: false,
  });
  column(breakup, "period_from", "date", false, [tokens("Period from", ["period from"])]);
  column(breakup, "period_to", "date", false, [tokens("Period to", ["period to"])]);
  column(breakup, "adjustment_type", "text_id", false, [
    tokens("Adjustment type", ["adjustment type"]),
    tokens("Type", ["type"], [], 1),
  ]);
  column(breakup, "settled_amount", "money", true, [tokens("Adjustment settled", ["settled"])]);
  column(breakup, "total_amount", "money", true, [tokens("Total amount", ["total amount"])]);
  column(breakup, "invoice", "text_id", false, [tokens("Invoice number", ["invoice"])]);
}

swiggyBusiness();
zomatoBusiness();
zomatoPayout();
swiggyAnnexure();

export const METRIC_LABEL_SLOTS: readonly LabelSlot[] = slots;
export const METRIC_LABEL_ALIASES: readonly LabelAlias[] = aliases;

export function seedLabelBook(): LabelBook {
  return { slots: METRIC_LABEL_SLOTS, aliases: METRIC_LABEL_ALIASES };
}
