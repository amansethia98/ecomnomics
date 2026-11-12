# Metric dictionary

Machine-readable source: `packages/contracts/src/metric-dictionary.ts`.

Money is integer paise. A missing figure is null, never zero. `crossPlatform` is true only for delivered orders and the payout keys that mean the same thing on both platforms.

Granularity is `day`, `week_sun_sat` (Swiggy, Sunday–Saturday), `week_mon_sun` (Zomato, Monday–Sunday), `month`, or `custom`.

Swiggy Daily accepts at most 7 days per file. Split a backfill into chunks of 7 days or fewer.

## `gross_sales_paise`

Item total plus packaging (ST+PC), before GST and before restaurant-funded discounts.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: Subtotal (items total) + Packaging charge
- swiggy source: Item Total + Packaging Charges
- check: absolute 100 paise plus relative 0

## `net_payout_paise`

Owner Net Payout: commissionable value minus ads minus commission, other fees, and GST on fees.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: CV − Ads − Comm.+PG+GST
- swiggy source: CV − Ads − Swiggy fees, GST on fees outside this row
- check: absolute 100 paise plus relative 0

## `platform_net_payout_paise`

The platform's own net payout figure, before comparing it to the bank.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: I Net Payout
- swiggy source: G Net Payout
- check: absolute 100 paise plus relative 0

## `commission_paise`

Platform commission or base service fee only, not long-distance, payment-gateway, or GST on fees.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: Base service fee
- swiggy source: Commission
- check: absolute 100 paise plus relative 0

## `platform_fees_paise`

Other platform fees besides commission, excluding GST on fees.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: Long distance and payment mechanism fee
- swiggy source: Swiggy fees minus Commission
- check: absolute 100 paise plus relative 0

## `taxes_paise`

18% GST on platform fees only. Not customer GST, and not TDS or TCS.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: Taxes on service and payment mechanism fees
- swiggy source: GST on Service Fee @18%
- check: absolute 100 paise plus relative 0

## `tds_paise`

Tax deducted at source and withheld from the payout. A tax credit, not a cost.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: TDS 194O amount
- swiggy source: TDS
- check: absolute 100 paise plus relative 0

## `tcs_paise`

Tax collected at source, including TCS IGST where it is present.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: TCS
- swiggy source: TCS
- check: absolute 100 paise plus relative 0

## `cv_paise`

Commissionable value: item total plus packaging, minus the restaurant-funded discount.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: ST+PC − merchant discount
- swiggy source: ST+PC − merchant discount
- check: absolute 100 paise plus relative 0

## `paid_amount_paise`

Amount the bank paid. Per order when the file has a settled amount, otherwise the summary total.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: Summary Amount Settled
- swiggy source: Summary total payout
- check: absolute 100 paise plus relative 0

## `payout_orders`

Payout-file orders: delivered plus cancelled or rejected, for the payout period.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: Number of Orders
- swiggy source: Orders
- check: absolute 0

## `commission_pg_gst_paise`

The payout calculator's Comm.+PG+GST row as printed. Swiggy's row excludes GST on fees.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Service fee + payment fee + GST on those fees
- swiggy source: B Swiggy Fees
- check: absolute 100 paise plus relative 0

## `gst_collected_paise`

GST collected from customers. Not restaurant revenue on delivery orders.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Total GST collected from customers
- swiggy source: GST Collected
- check: absolute 100 paise plus relative 0

## `complaints_cancellation_charges_paise`

Complaint refunds and cancellation charges deducted from the payout.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Other order level deductions
- swiggy source: Customer Complaints and Cancellation Charges
- check: absolute 100 paise plus relative 0

## `discount_paise`

Discounts the restaurant pays for. Zomato's business-report Discount given is not confirmed as the same figure.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Offers / Discount given (Rs)
- swiggy source: DISCOUNTS / Discount Given by Restaurant(RDGMV)
- check: absolute 100 paise plus relative 0

## `ad_spend_paise`

Ads charged to the restaurant for that period, counted once. Swiggy's export spend is not this payout figure.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Ads / Ads spend (Rs)
- swiggy source: Growth Investment In Ads
- check: absolute 100 paise plus relative 0

## `delivered_orders`

Orders delivered. This is the ops orders figure, and the denominator of most rates.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: true
- platforms: zomato, swiggy
- zomato source: Sales / Delivered orders
- swiggy source: SALES / Delivered Orders
- check: absolute 0

## `ops_sales_paise`

Zomato business-report sales, stored apart from payout ST+PC and from Swiggy net sales.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Sales / Sales (Rs)
- check: absolute 100 paise plus relative 0

## `swiggy_net_sales_paise`

Swiggy Net Sales. Not Zomato sales and not payout ST+PC.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Net Sales
- check: absolute 100 paise plus relative 0

## `aov_paise`

Average order value rebuilt as platform sales divided by delivered orders.

- unit: paise
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Sales / Average order value
- swiggy source: SALES / Net AOV
- denominator: delivered_orders
- numerator by platform: zomato ops_sales_paise, swiggy swiggy_net_sales_paise
- check: relative 0.005

## `cancelled_orders`

All cancellations on a payout file. Swiggy's business export uses restaurant_cancelled_orders instead.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Cancelled/Rejected
- swiggy source: Payout Breakup Cancelled
- check: absolute 0

## `restaurant_cancelled_orders`

Orders the restaurant cancelled on Swiggy. Not every cancellation.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Restaurant Cancelled Orders
- check: absolute 0

## `cancelled_order_loss_paise`

Money Swiggy reports as lost to restaurant-cancelled orders.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Cancelled Order Loss
- check: absolute 100 paise plus relative 0

## `orders_band_lt250`

Delivered orders with a value below ₹250.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Number of Orders below ₹250
- check: absolute 0

## `orders_band_250_450`

Delivered orders with a value from ₹250 to ₹450.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Number of Orders between ₹250 and ₹450
- check: absolute 0

## `orders_band_450_650`

Delivered orders with a value from ₹450 to ₹650.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Number of Orders between ₹450 and ₹650
- check: absolute 0

## `orders_band_650_850`

Delivered orders with a value from ₹650 to ₹850.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Number of Orders between ₹650 and ₹850
- check: absolute 0

## `orders_band_gt850`

Delivered orders with a value above ₹850.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: SALES / Number of Orders above ₹850
- check: absolute 0

## `market_share_pct`

The platform's market-share figure. There is no market total to rebuild it from.

- unit: pct
- aggregation: platform_only
- accuracy: approx
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Sales / Market share (%)
- swiggy source: SALES / Market Share
- check: relative 0.005

## `bolt_orders`

Swiggy Bolt orders, the fast-delivery channel.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / Orders
- check: absolute 0

## `bolt_orders_pct`

Share of delivered orders that were Bolt orders.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / % of Bolt Orders
- numerator: bolt_orders
- denominator: delivered_orders
- check: relative 0.005

## `bolt_sales_paise`

Bolt sales, Bolt AOV times Bolt orders, summed after the daily product.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / AOV
- derivation: round(bolt_aov_paise*bolt_orders)
- check: absolute 100 paise plus relative 0

## `bolt_prep_wsum`

Bolt prep minutes times Bolt orders. The weight for Bolt prep time.

- unit: decimal
- aggregation: sum
- accuracy: approx
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / Avg Prep Time
- derivation: bolt_prep_minutes*bolt_orders
- check: absolute 0

## `bolt_prep_minutes`

Swiggy Bolt average prep time, weighted by Bolt orders.

- unit: minutes
- aggregation: weighted_avg
- accuracy: approx
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / Avg Prep Time
- weight: bolt_orders
- value key: bolt_prep_wsum
- check: minutes 0.05

## `bolt_fast_prep_orders`

Bolt orders with prep under 6 minutes.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / Orders with <6 min Prep time
- derivation: round(bolt_fast_prep_pct*bolt_orders/100)
- check: absolute 0

## `bolt_fast_prep_pct`

Share of Bolt orders prepared in under 6 minutes.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / Orders with <6 min Prep time
- numerator: bolt_fast_prep_orders
- denominator: bolt_orders
- check: relative 0.005

## `bolt_delayed_orders_gt5`

Bolt orders delayed by more than 5 minutes.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: BOLT / Delayed Orders (>5 mins)
- check: absolute 0

## `rated_orders`

Orders that received a rating. The same label is not confirmed to mean the same thing.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Rated orders
- swiggy source: RATINGS / total rated orders
- check: absolute 0

## `poor_rated_orders`

Orders with a poor customer rating.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Poor rated orders
- swiggy source: RATINGS / Poor Rated Orders
- check: absolute 0

## `rating_snapshot_sum`

Zomato's daily platform rating. A range is the sum of these snapshots.

- unit: decimal
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Average rating
- check: absolute 0

## `rating_snapshot_days`

One for each day that has a Zomato platform rating snapshot.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Average rating
- check: absolute 0

## `rating`

Zomato platform rating: the sum of daily snapshots divided by days with a snapshot.

- unit: decimal
- aggregation: snapshot_mean
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Average rating
- weight: rating_snapshot_days
- value key: rating_snapshot_sum
- check: relative 0.005

## `bad_orders`

Zomato's bad-order count. It is the platform's own count, not the sum of its slices.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Bad orders
- check: absolute 0

## `bad_orders_pct`

Share of delivered orders Zomato treats as bad.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Bad orders %
- numerator: bad_orders
- denominator: delivered_orders
- check: relative 0.005

## `rejected_orders`

Rejected orders in Zomato's bad-orders breakdown.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Rejected orders
- check: absolute 0

## `delayed_orders_kpt10`

Zomato orders delayed by KPT plus 10 minutes.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / KPT+10 delayed orders
- check: absolute 0

## `delayed_orders_gt10`

Swiggy orders delayed by more than 10 minutes.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: OPERATIONS / Delayed Orders (> 10 mins)
- derivation: round(delayed_gt10_pct*delivered_orders/100)
- check: absolute 0

## `delayed_orders_gt10_pct`

Share of delivered Swiggy orders delayed by more than 10 minutes.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: OPERATIONS / Delayed Orders (> 10 mins)
- numerator: delayed_orders_gt10
- denominator: delivered_orders
- check: relative 0.005

## `complaints`

Complaints. Zomato's total, or Swiggy's non-refunded plus refunded. Not added across platforms.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Total complaints
- swiggy source: COMPLAINTS / Non-refunded Complaints
- check: absolute 0

## `non_refunded_complaints`

Complaints that were not refunded. This is not the slice inside Zomato bad orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Non-refunded complaints
- swiggy source: COMPLAINTS / Non-refunded Complaints
- check: absolute 0

## `refunded_complaints`

Swiggy complaints the customer was refunded for.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: COMPLAINTS / Customer Refunded Complaints
- check: absolute 0

## `complaints_missing`

Complaints about missing items.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Total complaints - Missing items
- swiggy source: COMPLAINTS / Missing Items
- check: absolute 0

## `complaints_quality`

Complaints about food quality.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Total complaints - Poor quality
- swiggy source: COMPLAINTS / Quality Issues
- check: absolute 0

## `complaints_wrong`

Complaints about a wrong item.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Total complaints - Wrong order
- swiggy source: COMPLAINTS / Wrong Items
- check: absolute 0

## `complaints_packaging`

Complaints about packaging. Swiggy's label also includes spillage.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Total complaints - Poor packaging
- swiggy source: COMPLAINTS / Packaging & Spillage
- check: absolute 0

## `complaints_quantity`

Swiggy complaints about quantity.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: COMPLAINTS / Quantity Issues
- check: absolute 0

## `complaint_orders`

Swiggy orders that had a complaint. One order can carry more than one complaint.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: COMPLAINTS / % Orders with Complaints
- derivation: round(complaint_orders_pct*delivered_orders/100)
- check: absolute 0

## `complaint_orders_pct`

Share of delivered Swiggy orders that had a complaint.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: COMPLAINTS / % Orders with Complaints
- numerator: complaint_orders
- denominator: delivered_orders
- check: relative 0.005

## `self_logged_ors`

Zomato self-logged other order issues. Not part of the bad-order count.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Self logs other ors
- check: absolute 0

## `lost_sales_paise`

Sales Zomato reports as lost, for example from being offline or rejecting.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Lost sales (Rs)
- check: absolute 100 paise plus relative 0

## `online_hours`

Hours the outlet was online. Empty until scheduled hours are stored.

- unit: hours
- aggregation: sum
- accuracy: approx
- crossPlatform: false
- platforms: zomato, swiggy
- check: absolute 0

## `scheduled_hours`

Hours the outlet was scheduled to be open. The weight for online percentage.

- unit: hours
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- check: absolute 0

## `online_pct`

Share of time the outlet was online. Days with scheduled hours are weighted by those hours. A day without scheduled hours counts as one day, and that result stays approximate.

- unit: pct
- aggregation: weighted_avg
- accuracy: approx
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / Online %
- swiggy source: OPERATIONS / Online Availability %
- weight: scheduled_hours
- value key: online_hours
- check: relative 0.005

## `offline_time_hours`

Zomato's offline time for one platform window. The rounded daily hours do not add up.

- unit: hours
- aggregation: platform_only
- accuracy: approx
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / Offline time (in hours)
- check: excluded: Zomato rounds offline hours to whole hours a day, so the days do not add up.

## `kpt_weighted_sum`

Kitchen prep minutes times delivered orders.

- unit: decimal
- aggregation: sum
- accuracy: approx
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / KPT (in minutes)
- swiggy source: OPERATIONS / Kitchen Prep Time
- derivation: kpt_minutes*delivered_orders
- check: absolute 0

## `kpt_minutes`

Kitchen preparation time, weighted by delivered orders. An approximation.

- unit: minutes
- aggregation: weighted_avg
- accuracy: approx
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer experience / KPT (in minutes)
- swiggy source: OPERATIONS / Kitchen Prep Time
- weight: delivered_orders
- value key: kpt_weighted_sum
- check: minutes 0.05

## `for_accurate_est`

Zomato FOR accuracy times delivered orders. The daily percentage is rounded.

- unit: decimal
- aggregation: sum
- accuracy: approx
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / FOR accuracy (%)
- derivation: for_pct/100*delivered_orders
- check: absolute 0

## `for_accuracy_pct`

Zomato food-order-ready accuracy, weighted by delivered orders.

- unit: pct
- aggregation: weighted_avg
- accuracy: approx
- crossPlatform: false
- platforms: zomato
- zomato source: Customer experience / FOR accuracy (%)
- weight: delivered_orders
- value key: for_accurate_est
- check: points 0.05

## `mfr_accurate_orders`

Swiggy orders marked food-ready on time. The denominator is delivered orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: OPERATIONS / Food Ready Accuracy (MFR)
- derivation: round(mfr_pct*delivered_orders/100)
- check: absolute 0

## `food_ready_accuracy_pct`

Swiggy food-ready accuracy: accurate orders divided by delivered orders.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: OPERATIONS / Food Ready Accuracy (MFR)
- numerator: mfr_accurate_orders
- denominator: delivered_orders
- check: relative 0.005

## `impressions`

Menu impressions. Swiggy's figures keep their decimals.

- unit: decimal
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer funnel / Impressions
- swiggy source: CONVERSION_FUNNEL / Impressions
- check: absolute 0

## `menu_opens`

Menu opens.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer funnel / Menu opens
- swiggy source: CONVERSION_FUNNEL / Menu Opens
- check: absolute 0

## `cart_builds`

Cart builds.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer funnel / Cart builds
- swiggy source: CONVERSION_FUNNEL / Carts Builds
- check: absolute 0

## `placed_orders`

Zomato placed orders. This is above delivered, and it is not Swiggy's funnel count.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer funnel / Placed Orders
- check: absolute 0

## `swiggy_funnel_orders`

Swiggy Orders Placed. It stays below delivered orders, so it is a funnel count only.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CONVERSION_FUNNEL / Orders Placed
- check: absolute 0

## `impressions_to_menu_pct`

Share of impressions that became menu opens.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer funnel / Impressions to menu (%)
- swiggy source: CONVERSION_FUNNEL / Impressions to Menu
- numerator: menu_opens
- denominator: impressions
- check: points 0.05

## `menu_to_cart_pct`

Share of menu opens that became cart builds.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer funnel / Menu to cart (%)
- swiggy source: CONVERSION_FUNNEL / Menu to Cart
- numerator: cart_builds
- denominator: menu_opens
- check: points 0.05

## `cart_to_orders_pct`

Share of cart builds that became funnel orders. The numerator differs by platform.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- zomato source: Customer funnel / Cart to orders (%)
- swiggy source: CONVERSION_FUNNEL / Cart to Order
- denominator: cart_builds
- numerator by platform: zomato placed_orders, swiggy swiggy_funnel_orders
- check: points 0.05

## `menu_conversion_pct`

Legacy single funnel rate. It is not rolled up. Use the three funnel rates instead.

- unit: pct
- aggregation: platform_only
- accuracy: exact
- crossPlatform: false
- platforms: zomato, swiggy
- check: points 0.05

## `new_user_orders`

Zomato orders from new users. Together with repeat and lapsed, these match placed orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / New user orders
- check: absolute 0

## `repeat_user_orders`

Zomato orders from repeat users.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / Repeat user orders
- check: absolute 0

## `lapsed_user_orders`

Zomato orders from lapsed users. Not Swiggy's dormant orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / Lapsed user orders
- check: absolute 0

## `swiggy_new_customer_orders`

Swiggy delivered orders from new customers.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / New Customer Order %
- derivation: round(new_customer_pct*delivered_orders/100)
- check: absolute 0

## `swiggy_new_customer_pct`

Share of delivered Swiggy orders from new customers.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / New Customer Order %
- numerator: swiggy_new_customer_orders
- denominator: delivered_orders
- check: relative 0.005

## `swiggy_repeat_customer_orders`

Swiggy delivered orders from repeat customers.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / Repeat Customer Order %
- derivation: round(repeat_customer_pct*delivered_orders/100)
- check: absolute 0

## `swiggy_repeat_customer_pct`

Share of delivered Swiggy orders from repeat customers.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / Repeat Customer Order %
- numerator: swiggy_repeat_customer_orders
- denominator: delivered_orders
- check: relative 0.005

## `dormant_user_orders`

Swiggy delivered orders from dormant customers. Not Zomato lapsed orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / Dormant Customer Order %
- derivation: round(dormant_customer_pct*delivered_orders/100)
- check: absolute 0

## `dormant_customer_pct`

Share of delivered Swiggy orders from dormant customers.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / Dormant Customer Order %
- numerator: dormant_user_orders
- denominator: delivered_orders
- check: relative 0.005

## `swiggy_new_customers`

Distinct new customers in one Swiggy window.

- unit: count
- aggregation: platform_only
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / New Customers
- check: absolute 0

## `swiggy_repeat_customers`

Distinct repeat customers in one Swiggy window.

- unit: count
- aggregation: platform_only
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / Repeat Customers
- check: absolute 0

## `swiggy_dormant_customers`

Distinct dormant customers in one Swiggy window.

- unit: count
- aggregation: platform_only
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: CUSTOMERS / Dormant Customers
- check: absolute 0

## `unique_customers`

Distinct Zomato customers in the range, from salted payout hashes.

- unit: count
- aggregation: distinct
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: salted customer id
- check: absolute 0

## `breakfast_orders`

Zomato breakfast orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / Breakfast orders
- check: absolute 0

## `lunch_orders`

Zomato lunch orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / Lunch orders
- check: absolute 0

## `snacks_orders`

Zomato snacks orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / Snacks orders
- check: absolute 0

## `dinner_orders`

Zomato dinner orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / Dinner orders
- check: absolute 0

## `late_night_orders`

Zomato late night orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Customer segmentation / Late night orders
- check: absolute 0

## `ads_sales_paise`

Zomato sales from ads.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Ads / Sales from ads (Rs)
- check: absolute 100 paise plus relative 0

## `ad_orders`

Zomato orders attributed to ads. Swiggy CPC orders are cpc_orders.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Ads / Ads orders
- check: absolute 0

## `ads_impressions`

Zomato ads impressions.

- unit: decimal
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Ads / Ads impressions
- check: absolute 0

## `ads_menu_opens`

Zomato menu opens from ads.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Ads / Ads menu opens
- check: absolute 0

## `ads_ctr_pct`

Zomato ads click-through rate: ads menu opens divided by ads impressions.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Ads / Ads CTR (%)
- numerator: ads_menu_opens
- denominator: ads_impressions
- check: points 0.05

## `ads_roi`

Zomato ads ROI from sales before the discount, divided by ads spend. Not a 0 to 100 percent.

- unit: decimal
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Ads / Ads ROI
- formula: zomato_ads_roi
- check: relative 0.005

## `cpc_sales_paise`

Swiggy CPC ad sales.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CPC / CPC Driven Sales
- check: absolute 100 paise plus relative 0

## `cpc_orders`

Swiggy orders attributed to CPC ads.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CPC / CPC Orders
- check: absolute 0

## `cpc_spend_paise`

Swiggy CPC spend in the business export.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CPC / Total CPC Spends
- check: absolute 100 paise plus relative 0

## `cpc_menu_opens`

Swiggy menu visits from CPC ads.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CPC / CPC Menu Visits
- check: absolute 0

## `cpc_roas`

Swiggy CPC return: CPC sales divided by CPC spend.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CPC / ROAS
- numerator: cpc_sales_paise
- denominator: cpc_spend_paise
- check: relative 0.005

## `cpc_ads_depth_pct`

Swiggy CPC sales divided by Swiggy GMV. The monthly platform figure is excluded.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CPC / CPC Ads Depth
- numerator: cpc_sales_paise
- denominator: swiggy_gmv_paise
- check: excluded (swiggy month): Swiggy's monthly CPC Ads Depth does not match its own parts.

## `cba_sales_paise`

Swiggy CBA ad sales.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CBA / CBA Driven Sales
- check: absolute 100 paise plus relative 0

## `cba_orders`

Swiggy orders attributed to CBA ads.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CBA / CBA Orders
- check: absolute 0

## `cba_spend_paise`

Swiggy CBA spend.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CBA / Total CBA Spends
- check: absolute 100 paise plus relative 0

## `cba_impressions`

Swiggy CBA ad impressions.

- unit: decimal
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CBA / Ad Impressions
- check: absolute 0

## `cba_menu_opens`

Swiggy menu visits from CBA ads.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CBA / CBA Menu Visits
- check: absolute 0

## `cba_ads_depth_pct`

Swiggy CBA sales divided by Swiggy GMV.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CBA / CBA Ads Depth
- numerator: cba_sales_paise
- denominator: swiggy_gmv_paise
- check: relative 0.005

## `cba_avg_cost_per_impression_paise`

Swiggy CBA spend divided by CBA impressions.

- unit: paise
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: ADS_CBA / Avg Cost Per Impressions
- numerator: cba_spend_paise
- denominator: cba_impressions
- check: relative 0.005

## `swiggy_gmv_paise`

Swiggy gross value, restaurant discount divided by the discount GMV rate. Null when the discount is ₹0.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: DISCOUNTS / Discount GMV %
- derivation: discount_paise/(discount_gmv_pct/100)
- check: absolute 100 paise plus relative 0

## `discount_gmv_pct`

Restaurant discount as a share of Swiggy GMV.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: DISCOUNTS / Discount GMV %
- numerator: discount_paise
- denominator: swiggy_gmv_paise
- check: relative 0.005

## `discounted_orders`

Swiggy delivered orders that had a restaurant discount.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: DISCOUNTS / Discounted Orders %
- derivation: round(discounted_orders_pct*delivered_orders/100)
- check: absolute 0

## `discounted_orders_pct`

Share of delivered Swiggy orders that had a restaurant discount.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: DISCOUNTS / Discounted Orders %
- numerator: discounted_orders
- denominator: delivered_orders
- check: relative 0.005

## `rdpo_paise`

Restaurant discount per delivered Swiggy order, not per discounted order.

- unit: paise
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: DISCOUNTS / Restaurant Discount Per Order(RDPO)
- numerator: discount_paise
- denominator: delivered_orders
- check: relative 0.005

## `offer_gross_sales_paise`

Zomato gross sales from offers. The file label is swapped with the orders column; the value decides.

- unit: paise
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Offers / Orders with offers
- check: absolute 100 paise plus relative 0

## `offer_orders`

Zomato orders with offers. The file label is swapped with the sales column.

- unit: count
- aggregation: sum
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Offers / Gross sales from offers (Rs)
- check: absolute 0

## `offer_discount_pct`

Zomato discount divided by gross sales from offers.

- unit: pct
- aggregation: ratio
- accuracy: exact
- crossPlatform: false
- platforms: zomato
- zomato source: Offers / Effective discount (%)
- numerator: discount_paise
- denominator: offer_gross_sales_paise
- check: relative 0.005

## `menu_score`

Swiggy menu score out of 100. A 0 is not computed.

- unit: decimal
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Menu Score(Out of 100)
- check: absolute 0

## `menu_category_score`

Swiggy menu category score. A 0 is not computed.

- unit: decimal
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Category Score(Out of 100)
- check: absolute 0

## `menu_item_score`

Swiggy menu item score. A 0 is not computed.

- unit: decimal
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Item Score(Out of 100)
- check: absolute 0

## `menu_addon_score`

Swiggy menu add-on score. A 0 is not computed.

- unit: decimal
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Addon Score(Out of 100)
- check: absolute 0

## `menu_combo_score`

Swiggy menu combo score. A 0 is not computed.

- unit: decimal
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Combo Score(Out of 100)
- check: absolute 0

## `menu_photo_pct`

Share of Swiggy items that have a photo.

- unit: pct
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Items with Photos
- check: points 0.05

## `menu_desc_pct`

Share of Swiggy items that have a description.

- unit: pct
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Items with Descriptions
- check: points 0.05

## `top5_items_revenue_paise`

Gross revenue of the top 5 items in the requested window. It is not added across windows.

- unit: paise
- aggregation: platform_only
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: MENU / Top Selling Items (Gross Revenue)
- check: absolute 0

## `lag_banner`

Whether Swiggy showed the 48-hour lag banner. The numbers on screen are still stored.

- unit: boolean
- aggregation: snapshot_latest
- accuracy: exact
- crossPlatform: false
- platforms: swiggy
- swiggy source: 48-hour lag banner
- check: absolute 0

## Exclusions

- `offline_time_hours`: Zomato rounds offline hours to whole hours a day, so the days do not add up.
- `cpc_ads_depth_pct`: Swiggy's monthly CPC Ads Depth does not match its own parts.

## Retired keys

- `orders`: Use delivered_orders or payout_orders.
- `delayed_orders`: Use delayed_orders_kpt10 on Zomato and delayed_orders_gt10 on Swiggy.
- `bad_order_complaints`: Not mapped. Store bad_orders, complaints, and non_refunded_complaints.
- `mfr_eligible_orders`: Dropped. Food-ready accuracy uses delivered_orders as the denominator.
