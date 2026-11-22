# Every metric we actually get, by platform

Built 15 Nov 2026 (IST) from two sources:
- the metric dictionary (`packages/contracts/src/metric-dictionary.ts`, parser 2026-11-12.1);
- what is really stored in the local DB (`restaurant_metric_values`, `payout_cycles`, `payout_orders`) for Pawan Putra: 90–91 days of daily data, 1 outlet.

Every metric is stored **per outlet**.

**How to read the columns**
- **Platform label:** the report section and column name as the platform shows it.
- **Arrives:** **Daily** = the daily Business report download (Swiggy is normally one day behind). **Weekly** = the payout statement for each cycle (Zomato Mon–Sun, Swiggy Sun–Sat), fetched Thursdays.
- **Add up?** How to combine days or outlets:
  - "Add up" = a plain sum across days and outlets.
  - "Recompute" = never add or average the %; add the two parts, then divide.
  - "Weighted average" = weight each day by the named count.
  - "Platform's figure only" = valid only for the exact window the platform printed.
- **Across apps:** whether Zomato and Swiggy figures can be added together.
- **Platform calculates?** Whether the number is the platform's own calculated figure, a raw count it reports, or something we derive.
- **(approx):** the dictionary marks it approximate.

Internal key names are in the second column for engineers.


## Zomato


### Daily (Business report)

| Platform label | Key | What it means | Unit | Arrives | Add up? | Across apps | Platform calculates? |
|---|---|---|---|---|---|---|---|
| Ads › Ads orders | `ad_orders` | Zomato orders attributed to ads. Swiggy CPC orders are cpc_orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Ads › Ads spend (Rs) | `ad_spend_paise` | Money spent on ads, counted once. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| Ads › Ads CTR (%) | `ads_ctr_pct` | Zomato ads click-through rate: ads menu opens divided by ads impressions. | % | Daily | Recompute: ads_menu_opens ÷ ads_impressions | No | Yes: the platform's own % or average (we also rebuild it) |
| Ads › Ads impressions | `ads_impressions` | Zomato ads impressions. | number | Daily | Add up | No | Platform reports it as a raw number |
| Ads › Ads menu opens | `ads_menu_opens` | Zomato menu opens from ads. | count | Daily | Add up | No | Platform reports it as a raw number |
| Ads › Ads ROI | `ads_roi` | Zomato ads return: ad sales (before discount) ÷ ad spend. A multiple, not a %. | number | Daily | Recompute: part ÷ base | No | Yes: the platform's own % or average (we also rebuild it) |
| Ads › Sales from ads (Rs) | `ads_sales_paise` | Zomato sales from ads. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Bad orders | `bad_orders` | Zomato's own count of bad orders (rejected + delayed + poor-rated + complaints, de-duplicated by Zomato). | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Total complaints | `complaints` | Complaints. Zomato's total, or Swiggy's non-refunded plus refunded. Not added across platforms. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Total complaints - Missing items | `complaints_missing` | Complaints about missing items. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Total complaints - Poor packaging | `complaints_packaging` | Complaints about packaging. Swiggy's label also includes spillage. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Total complaints - Poor quality | `complaints_quality` | Complaints about food quality. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Total complaints - Wrong order | `complaints_wrong` | Complaints about a wrong item. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › KPT+10 delayed orders | `delayed_orders_kpt10` | Orders that were ready more than 10 minutes after Zomato's expected kitchen time. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › FOR accuracy (%) | `for_accuracy_pct` | Zomato's food-order-ready accuracy (how often "ready" was pressed at the right moment). (approx) | % | Daily | Weighted average by delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| Customer experience › FOR accuracy (%) | `for_accurate_est` | Helper: FOR accuracy × delivered orders, used to average it correctly. (approx) | number | Daily | Add up | No | No: we derive it from the platform % × orders |
| Customer experience › KPT (in minutes) | `kpt_minutes` | Kitchen preparation time: minutes from accepting the order to food ready. (approx) | minutes | Daily | Weighted average by delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| Customer experience › KPT (in minutes) | `kpt_weighted_sum` | Prep minutes × delivered orders. A helper used to average prep time correctly over many days. (approx) | number | Daily | Add up | No | No: we derive it from the platform % × orders |
| Customer experience › Lost sales (Rs) | `lost_sales_paise` | Sales Zomato says were lost, for example from being offline or rejecting orders. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Non-refunded complaints | `non_refunded_complaints` | Complaints that were not refunded. This is not the slice inside Zomato bad orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Offline time (in hours) | `offline_time_hours` | Hours the outlet was offline in that window. The rounded daily hours don't add up to a week. (approx) | hours | Daily | Platform's figure for that exact window only; can't add | No | Platform reports it as a raw number |
| Customer experience › Online % | `online_pct` | Share of the outlet's open hours it was actually online and taking orders. (approx) | % | Daily | Weighted average by scheduled_hours | No | Yes: the platform's own % or average (we also rebuild it) |
| Customer experience › Poor rated orders | `poor_rated_orders` | Orders with a poor customer rating. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Rated orders | `rated_orders` | Orders that received a rating. The same label is not confirmed to mean the same thing. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Average rating | `rating` | Zomato's star rating for the outlet that day (the platform's figure, Aman's rule). A month = the average of the daily figures. | number | Daily | Average of the daily figures | No | Yes: the platform's own % or average (we also rebuild it) |
| Customer experience › Average rating | `rating_snapshot_days` | Helper: number of days that had a rating, used to average a rating over a range. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Average rating | `rating_snapshot_sum` | Helper: daily ratings added up, used to average a rating over a range. | number | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Rejected orders | `rejected_orders` | Orders the restaurant rejected (part of Zomato's bad orders). | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer experience › Self logs other ors | `self_logged_ors` | Zomato self-logged other order issues. Not part of the bad-order count. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer funnel › Cart builds | `cart_builds` | How many times customers added items to a cart. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer funnel › Cart to orders (%) | `cart_to_orders_pct` | Orders ÷ cart builds. | % | Daily | Recompute: zomato: placed_orders / swiggy: swiggy_funnel_orders ÷ cart_builds | No | Yes: the platform's own % or average (we also rebuild it) |
| Customer funnel › Impressions | `impressions` | How many times the outlet was shown to customers in the app. | number | Daily | Add up | No | Platform reports it as a raw number |
| Customer funnel › Impressions to menu (%) | `impressions_to_menu_pct` | Menu opens ÷ impressions. | % | Daily | Recompute: menu_opens ÷ impressions | No | Yes: the platform's own % or average (we also rebuild it) |
| Customer funnel › Menu opens | `menu_opens` | How many times customers opened the menu. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer funnel › Menu to cart (%) | `menu_to_cart_pct` | Cart builds ÷ menu opens. | % | Daily | Recompute: cart_builds ÷ menu_opens | No | Yes: the platform's own % or average (we also rebuild it) |
| Customer funnel › Placed Orders | `placed_orders` | Orders customers placed, including ones that weren't delivered later. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › Breakfast orders | `breakfast_orders` | Zomato breakfast orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › Dinner orders | `dinner_orders` | Zomato dinner orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › Lapsed user orders | `lapsed_user_orders` | Zomato orders from lapsed users. Not Swiggy's dormant orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › Late night orders | `late_night_orders` | Zomato late night orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › Lunch orders | `lunch_orders` | Zomato lunch orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › New user orders | `new_user_orders` | Zomato orders from new users. Together with repeat and lapsed, these match placed orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › Repeat user orders | `repeat_user_orders` | Zomato orders from repeat users. | count | Daily | Add up | No | Platform reports it as a raw number |
| Customer segmentation › Snacks orders | `snacks_orders` | Zomato snacks orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| Offers › Discount given (Rs) | `discount_paise` | Discounts the restaurant paid for (not platform-funded offers). | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| Offers › Effective discount (%) | `offer_discount_pct` | Zomato discount divided by gross sales from offers. | % | Daily | Recompute: discount_paise ÷ offer_gross_sales_paise | No | Yes: the platform's own % or average (we also rebuild it) |
| Offers › Orders with offers | `offer_gross_sales_paise` | Zomato gross sales from offers. The file label is swapped with the orders column; the value decides. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| Offers › Gross sales from offers (Rs) | `offer_orders` | Zomato orders with offers. The file label is swapped with the sales column. | count | Daily | Add up | No | Platform reports it as a raw number |
| Sales › Delivered orders | `delivered_orders` | Orders actually delivered. The base for most percentages. | count | Daily | Add up | Yes | Platform reports it as a raw number |
| Sales › Market share (%) | `market_share_pct` | The platform's estimate of the outlet's share of its local market. (approx) | % | Daily | Platform's figure for that exact window only; can't add | No | Platform reports it as a raw number |
| Sales › Sales (Rs) | `ops_sales_paise` | Zomato's daily sales figure in the Business report, after the restaurant's own discounts. It's the Zomato half of our "net sales". | ₹ | Daily | Add up | No | Platform reports it as a raw number |

### Weekly (payout cycle)

| Platform label | Key | What it means | Unit | Arrives | Add up? | Across apps | Platform calculates? |
|---|---|---|---|---|---|---|---|
| Ads › Ads spend (Rs) | `ad_spend_paise` | Money spent on ads, counted once. | ₹ | Weekly | Add up | No | Platform reports it as a raw number |
| Offers › Discount given (Rs) | `discount_paise` | Discounts the restaurant paid for (not platform-funded offers). | ₹ | Weekly | Add up | No | Platform reports it as a raw number |
| Service fee + payment fee + GST on those fees | `commission_pg_gst_paise` | Commission + payment-gateway fee + GST on those fees, as printed on the payout calculator (Swiggy's row leaves out GST on fees). | ₹ | Weekly | Add up | No | Platform reports it as a raw number |
| ST+PC − merchant discount | `cv_paise` | Commissionable value: item total + packaging − restaurant-funded discount. Commission is charged on this. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| Subtotal (items total) + Packaging charge | `gross_sales_paise` | Gross Sales: item total + packaging, before discounts, GST and fees (Q14: Zomato's payout "Total Sales"). | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| CV − Ads − Comm.+PG+GST | `net_payout_paise` | What the owner should receive: commissionable value − ads − commission and fees (incl. GST on fees). Our rebuild. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| Amount Settled | `paid_amount_paise` | What actually reached the bank for the cycle. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| Number of Orders | `payout_orders` | Orders in the payout file: delivered plus cancelled or rejected. | count | Weekly | Add up | Yes | Platform reports it as a raw number |
| I Net Payout | `platform_net_payout_paise` | The platform's own printed net payout for the cycle. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |

## Swiggy


### Daily (Business report)

| Platform label | Key | What it means | Unit | Arrives | Add up? | Across apps | Platform calculates? |
|---|---|---|---|---|---|---|---|
| ADS_CBA › CBA Ads Depth | `cba_ads_depth_pct` | Swiggy CBA sales divided by Swiggy GMV. | % | Daily | Recompute: cba_sales_paise ÷ swiggy_gmv_paise | No | Yes: the platform's own % or average (we also rebuild it) |
| ADS_CBA › Avg Cost Per Impressions | `cba_avg_cost_per_impression_paise` | Swiggy CBA spend divided by CBA impressions. | ₹ | Daily | Recompute: cba_spend_paise ÷ cba_impressions | No | Yes: the platform's own % or average (we also rebuild it) |
| ADS_CBA › Ad Impressions | `cba_impressions` | Swiggy CBA ad impressions. | number | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CBA › CBA Menu Visits | `cba_menu_opens` | Swiggy menu visits from CBA ads. | count | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CBA › CBA Orders | `cba_orders` | Swiggy orders attributed to CBA ads. | count | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CBA › CBA Driven Sales | `cba_sales_paise` | Swiggy CBA ad sales. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CBA › Total CBA Spends | `cba_spend_paise` | Swiggy CBA spend. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CPC › CPC Ads Depth | `cpc_ads_depth_pct` | Swiggy CPC sales divided by Swiggy GMV. The monthly platform figure is excluded. | % | Daily | Recompute: cpc_sales_paise ÷ swiggy_gmv_paise | No | Yes: the platform's own % or average (we also rebuild it) |
| ADS_CPC › CPC Menu Visits | `cpc_menu_opens` | Swiggy menu visits from CPC ads. | count | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CPC › CPC Orders | `cpc_orders` | Swiggy orders attributed to CPC ads. | count | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CPC › ROAS | `cpc_roas` | Swiggy CPC ads return: CPC sales ÷ CPC spend. | % | Daily | Recompute: cpc_sales_paise ÷ cpc_spend_paise | No | Yes: the platform's own % or average (we also rebuild it) |
| ADS_CPC › CPC Driven Sales | `cpc_sales_paise` | Swiggy CPC ad sales. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| ADS_CPC › Total CPC Spends | `cpc_spend_paise` | Swiggy CPC spend in the business export. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| BOLT › Delayed Orders (>5 mins) | `bolt_delayed_orders_gt5` | Bolt orders delayed by more than 5 minutes. | count | Daily | Add up | No | Platform reports it as a raw number |
| BOLT › Orders with <6 min Prep time | `bolt_fast_prep_orders` | Bolt orders with prep under 6 minutes. | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| BOLT › Orders with <6 min Prep time | `bolt_fast_prep_pct` | Share of Bolt orders prepared in under 6 minutes. | % | Daily | Recompute: bolt_fast_prep_orders ÷ bolt_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| BOLT › Orders | `bolt_orders` | Swiggy Bolt orders, the fast-delivery channel. | count | Daily | Add up | No | Platform reports it as a raw number |
| BOLT › % of Bolt Orders | `bolt_orders_pct` | Share of delivered orders that were Bolt orders. | % | Daily | Recompute: bolt_orders ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| BOLT › Avg Prep Time | `bolt_prep_minutes` | Swiggy Bolt average prep time, weighted by Bolt orders. (approx) | minutes | Daily | Weighted average by bolt_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| BOLT › Avg Prep Time | `bolt_prep_wsum` | Bolt prep minutes times Bolt orders. The weight for Bolt prep time. (approx) | number | Daily | Add up | No | No: we derive it from the platform % × orders |
| BOLT › AOV | `bolt_sales_paise` | Bolt sales, Bolt AOV times Bolt orders, summed after the daily product. | ₹ | Daily | Add up | No | No: we derive it from the platform % × orders |
| COMPLAINTS › % Orders with Complaints | `complaint_orders` | Swiggy orders that had a complaint. One order can carry more than one complaint. | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| COMPLAINTS › % Orders with Complaints | `complaint_orders_pct` | Share of delivered Swiggy orders that had a complaint. | % | Daily | Recompute: complaint_orders ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| COMPLAINTS › Non-refunded Complaints | `complaints` | Complaints. Zomato's total, or Swiggy's non-refunded plus refunded. Not added across platforms. | count | Daily | Add up | No | Platform reports it as a raw number |
| COMPLAINTS › Missing Items | `complaints_missing` | Complaints about missing items. | count | Daily | Add up | No | Platform reports it as a raw number |
| COMPLAINTS › Packaging & Spillage | `complaints_packaging` | Complaints about packaging. Swiggy's label also includes spillage. | count | Daily | Add up | No | Platform reports it as a raw number |
| COMPLAINTS › Quality Issues | `complaints_quality` | Complaints about food quality. | count | Daily | Add up | No | Platform reports it as a raw number |
| COMPLAINTS › Quantity Issues | `complaints_quantity` | Swiggy complaints about quantity. | count | Daily | Add up | No | Platform reports it as a raw number |
| COMPLAINTS › Wrong Items | `complaints_wrong` | Complaints about a wrong item. | count | Daily | Add up | No | Platform reports it as a raw number |
| COMPLAINTS › Non-refunded Complaints | `non_refunded_complaints` | Complaints that were not refunded. This is not the slice inside Zomato bad orders. | count | Daily | Add up | No | Platform reports it as a raw number |
| COMPLAINTS › Customer Refunded Complaints | `refunded_complaints` | Swiggy complaints the customer was refunded for. | count | Daily | Add up | No | Platform reports it as a raw number |
| CONVERSION_FUNNEL › Carts Builds | `cart_builds` | How many times customers added items to a cart. | count | Daily | Add up | No | Platform reports it as a raw number |
| CONVERSION_FUNNEL › Cart to Order | `cart_to_orders_pct` | Orders ÷ cart builds. | % | Daily | Recompute: zomato: placed_orders / swiggy: swiggy_funnel_orders ÷ cart_builds | No | Yes: the platform's own % or average (we also rebuild it) |
| CONVERSION_FUNNEL › Impressions | `impressions` | How many times the outlet was shown to customers in the app. | number | Daily | Add up | No | Platform reports it as a raw number |
| CONVERSION_FUNNEL › Impressions to Menu | `impressions_to_menu_pct` | Menu opens ÷ impressions. | % | Daily | Recompute: menu_opens ÷ impressions | No | Yes: the platform's own % or average (we also rebuild it) |
| CONVERSION_FUNNEL › Menu Opens | `menu_opens` | How many times customers opened the menu. | count | Daily | Add up | No | Platform reports it as a raw number |
| CONVERSION_FUNNEL › Menu to Cart | `menu_to_cart_pct` | Cart builds ÷ menu opens. | % | Daily | Recompute: cart_builds ÷ menu_opens | No | Yes: the platform's own % or average (we also rebuild it) |
| CONVERSION_FUNNEL › Orders Placed | `swiggy_funnel_orders` | "Orders Placed" at the end of Swiggy's funnel. Used only for funnel rates. | count | Daily | Add up | No | Platform reports it as a raw number |
| CUSTOMERS › Dormant Customer Order % | `dormant_customer_pct` | Share of delivered Swiggy orders from dormant customers. | % | Daily | Recompute: dormant_user_orders ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| CUSTOMERS › Dormant Customer Order % | `dormant_user_orders` | Swiggy delivered orders from dormant customers. Not Zomato lapsed orders. | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| CUSTOMERS › Dormant Customers | `swiggy_dormant_customers` | Distinct dormant customers in one Swiggy window. | count | Daily | Platform's figure for that exact window only; can't add | No | Platform reports it as a raw number |
| CUSTOMERS › New Customer Order % | `swiggy_new_customer_orders` | Swiggy delivered orders from new customers. | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| CUSTOMERS › New Customer Order % | `swiggy_new_customer_pct` | Share of delivered Swiggy orders from new customers. | % | Daily | Recompute: swiggy_new_customer_orders ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| CUSTOMERS › New Customers | `swiggy_new_customers` | Distinct new customers in one Swiggy window. | count | Daily | Platform's figure for that exact window only; can't add | No | Platform reports it as a raw number |
| CUSTOMERS › Repeat Customer Order % | `swiggy_repeat_customer_orders` | Swiggy delivered orders from repeat customers. | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| CUSTOMERS › Repeat Customer Order % | `swiggy_repeat_customer_pct` | Share of delivered Swiggy orders from repeat customers. | % | Daily | Recompute: swiggy_repeat_customer_orders ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| CUSTOMERS › Repeat Customers | `swiggy_repeat_customers` | Distinct repeat customers in one Swiggy window. | count | Daily | Platform's figure for that exact window only; can't add | No | Platform reports it as a raw number |
| DISCOUNTS › Discount GMV % | `discount_gmv_pct` | Restaurant discount as a share of Swiggy GMV. | % | Daily | Recompute: discount_paise ÷ swiggy_gmv_paise | No | Yes: the platform's own % or average (we also rebuild it) |
| DISCOUNTS › Discount Given by Restaurant(RDGMV) | `discount_paise` | Discounts the restaurant paid for (not platform-funded offers). | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| DISCOUNTS › Discounted Orders % | `discounted_orders` | Swiggy delivered orders that had a restaurant discount. | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| DISCOUNTS › Discounted Orders % | `discounted_orders_pct` | Share of delivered Swiggy orders that had a restaurant discount. | % | Daily | Recompute: discounted_orders ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| DISCOUNTS › Restaurant Discount Per Order(RDPO) | `rdpo_paise` | Restaurant discount per delivered Swiggy order, not per discounted order. | ₹ | Daily | Recompute: discount_paise ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| DISCOUNTS › Discount GMV % | `swiggy_gmv_paise` | Swiggy gross order value, worked out from discount ÷ discount-GMV %. Blank when there's no discount. | ₹ | Daily | Add up | No | No: we derive it from the platform % × orders |
| MENU › Addon Score(Out of 100) | `menu_addon_score` | Swiggy menu add-on score. A 0 is not computed. | number | Daily | Latest value only | No | Platform reports it as a raw number |
| MENU › Category Score(Out of 100) | `menu_category_score` | Swiggy menu category score. A 0 is not computed. | number | Daily | Latest value only | No | Platform reports it as a raw number |
| MENU › Combo Score(Out of 100) | `menu_combo_score` | Swiggy menu combo score. A 0 is not computed. | number | Daily | Latest value only | No | Platform reports it as a raw number |
| MENU › Items with Descriptions | `menu_desc_pct` | Share of Swiggy items that have a description. | % | Daily | Latest value only | No | Platform reports it as a raw number |
| MENU › Item Score(Out of 100) | `menu_item_score` | Swiggy menu item score. A 0 is not computed. | number | Daily | Latest value only | No | Platform reports it as a raw number |
| MENU › Items with Photos | `menu_photo_pct` | Share of Swiggy items that have a photo. | % | Daily | Latest value only | No | Platform reports it as a raw number |
| MENU › Menu Score(Out of 100) | `menu_score` | Swiggy menu score out of 100. A 0 is not computed. | number | Daily | Latest value only | No | Platform reports it as a raw number |
| MENU › Top Selling Items (Gross Revenue) | `top5_items_revenue_paise` | Gross revenue of the top 5 dishes in that window. The only dish-level data we have. | ₹ | Daily | Platform's figure for that exact window only; can't add | No | Platform reports it as a raw number |
| OPERATIONS › Delayed Orders (> 10 mins) | `delayed_orders_gt10` | Orders delayed by more than 10 minutes. | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| OPERATIONS › Delayed Orders (> 10 mins) | `delayed_orders_gt10_pct` | Share of delivered orders delayed by more than 10 minutes. | % | Daily | Recompute: delayed_orders_gt10 ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| OPERATIONS › Food Ready Accuracy (MFR) | `food_ready_accuracy_pct` | Share of orders where "food ready" was marked at the right time (MFR). | % | Daily | Recompute: mfr_accurate_orders ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| OPERATIONS › Kitchen Prep Time | `kpt_minutes` | Kitchen preparation time: minutes from accepting the order to food ready. (approx) | minutes | Daily | Weighted average by delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| OPERATIONS › Kitchen Prep Time | `kpt_weighted_sum` | Prep minutes × delivered orders. A helper used to average prep time correctly over many days. (approx) | number | Daily | Add up | No | No: we derive it from the platform % × orders |
| OPERATIONS › Food Ready Accuracy (MFR) | `mfr_accurate_orders` | Number of orders with "food ready" marked on time (from the % × delivered orders). | count | Daily | Add up | No | No: we derive it from the platform % × orders |
| OPERATIONS › Online Availability % | `online_pct` | Share of the outlet's open hours it was actually online and taking orders. (approx) | % | Daily | Weighted average by scheduled_hours | No | Yes: the platform's own % or average (we also rebuild it) |
| RATINGS › Poor Rated Orders | `poor_rated_orders` | Orders with a poor customer rating. | count | Daily | Add up | No | Platform reports it as a raw number |
| RATINGS › total rated orders | `rated_orders` | Orders that received a rating. The same label is not confirmed to mean the same thing. | count | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Net AOV | `aov_paise` | Average order value = sales ÷ delivered orders. Swiggy's "Net AOV" is after discounts (Q18). | ₹ | Daily | Recompute: zomato: ops_sales_paise / swiggy: swiggy_net_sales_paise ÷ delivered_orders | No | Yes: the platform's own % or average (we also rebuild it) |
| SALES › Cancelled Order Loss | `cancelled_order_loss_paise` | Money Swiggy says was lost to orders the restaurant cancelled. | ₹ | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Delivered Orders | `delivered_orders` | Orders actually delivered. The base for most percentages. | count | Daily | Add up | Yes | Platform reports it as a raw number |
| SALES › Market Share | `market_share_pct` | The platform's estimate of the outlet's share of its local market. (approx) | % | Daily | Platform's figure for that exact window only; can't add | No | Platform reports it as a raw number |
| SALES › Number of Orders between ₹250 and ₹450 | `orders_band_250_450` | Delivered orders with a value from ₹250 to ₹450. | count | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Number of Orders between ₹450 and ₹650 | `orders_band_450_650` | Delivered orders with a value from ₹450 to ₹650. | count | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Number of Orders between ₹650 and ₹850 | `orders_band_650_850` | Delivered orders with a value from ₹650 to ₹850. | count | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Number of Orders above ₹850 | `orders_band_gt850` | Delivered orders with a value above ₹850. | count | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Number of Orders below ₹250 | `orders_band_lt250` | Delivered orders with a value below ₹250. | count | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Restaurant Cancelled Orders | `restaurant_cancelled_orders` | Orders the restaurant cancelled on Swiggy (not customer or Swiggy cancellations). | count | Daily | Add up | No | Platform reports it as a raw number |
| SALES › Net Sales | `swiggy_net_sales_paise` | Item total plus packaging, minus restaurant-funded discounts, before GST and before Swiggy's commission, fees and ads (Q15). The Swiggy half of our "net sales". | ₹ | Daily | Add up | No | Platform reports it as a raw number |

### Weekly (payout cycle)

| Platform label | Key | What it means | Unit | Arrives | Add up? | Across apps | Platform calculates? |
|---|---|---|---|---|---|---|---|
| DISCOUNTS › Discount Given by Restaurant(RDGMV) | `discount_paise` | Discounts the restaurant paid for (not platform-funded offers). | ₹ | Weekly | Add up | No | Platform reports it as a raw number |
| Growth Investment In Ads | `ad_spend_paise` | Money spent on ads, counted once. | ₹ | Weekly | Add up | No | Platform reports it as a raw number |
| B Swiggy Fees | `commission_pg_gst_paise` | Commission + payment-gateway fee + GST on those fees, as printed on the payout calculator (Swiggy's row leaves out GST on fees). | ₹ | Weekly | Add up | No | Platform reports it as a raw number |
| ST+PC − merchant discount | `cv_paise` | Commissionable value: item total + packaging − restaurant-funded discount. Commission is charged on this. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| Item Total + Packaging Charges | `gross_sales_paise` | Gross Sales: item total + packaging, before discounts, GST and fees (Q14: Zomato's payout "Total Sales"). | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| CV − Ads − Swiggy fees, GST on fees outside this row | `net_payout_paise` | What the owner should receive: commissionable value − ads − commission and fees (incl. GST on fees). Our rebuild. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| Summary total payout | `paid_amount_paise` | What actually reached the bank for the cycle. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |
| Orders | `payout_orders` | Orders in the payout file: delivered plus cancelled or rejected. | count | Weekly | Add up | Yes | Platform reports it as a raw number |
| G Net Payout | `platform_net_payout_paise` | The platform's own printed net payout for the cycle. | ₹ | Weekly | Add up | Yes | Platform reports it as a raw number |

## Payout details stored per order and per cycle (both apps)

These come from the payout statement, in `payout_orders` (3,718 rows) and `payout_cycles` (24 rows). They arrive **weekly** with the payout fetch, per outlet. Each is a ₹ amount that **adds up** across orders and cycles. Where noted, it can also be added across apps.

| Zomato label | Swiggy label | Key | What it means | Across apps |
|---|---|---|---|---|
| Base service fee | Commission | `commission_paise` | Platform commission only | Yes |
| Long distance and payment mechanism fee | Swiggy fees minus Commission | `platform_fees_paise` | Other platform fees, excluding GST | Yes |
| Taxes on service and payment mechanism fees | GST on Service Fee @18% | `taxes_paise` | 18% GST on platform fees only (Q21) | Yes |
| TDS 194O amount | TDS | `tds_paise` | Tax withheld at source: a tax credit, not a cost | Yes |
| TCS | TCS | `tcs_paise` | Tax collected at source | Yes |
| Total GST collected from customers | GST Collected | `gst_collected_paise` | Customer GST: not restaurant revenue | No |
| Other order level deductions | Customer Complaints and Cancellation Charges | `complaints_cancellation_charges_paise` | Complaint refunds and cancellation charges deducted from the payout | No |
| Cancelled/Rejected | Payout Breakup Cancelled | `cancelled_orders` | All cancellations in the payout file | No |
| — | MFR marked / accurate (per order) | `mfr_marked`, `mfr_accurate` | Whether "food ready" was marked, and on time, per order (Swiggy) | — |
| salted customer id | — | `unique_customers` | Distinct customers (Zomato, from hashed ids). Count distinct; never add | — |

Per-order rows also carry the order date, status, who cancelled, settlement status and date, the UTR's last 4 digits, and gross sales, discount, commissionable value and net payout for each order. Adjustments (`payout_adjustments`, 96 rows) hold invoices and charges booked into a cycle.

## In the dictionary but not stored yet

- `bad_orders_pct` (Zomato Bad orders %): its parts are stored, so it's recomputed from bad orders ÷ delivered.
- `online_hours` and `scheduled_hours`: empty until scheduled hours are known.
- `menu_conversion_pct`: legacy.
- `lag_banner` (Swiggy "data may change" banner): **never stored**, see `BRIEF-EDGE-CASES.md` §0.

## Not available at all today

- Item-level sales and dish costs. Only Swiggy's top-5 dish revenue exists.
- Swiggy star rating, Swiggy offline time and Swiggy rejected orders (Q13, still open).
- Review text.
- Customer-level funnel by time of day.
