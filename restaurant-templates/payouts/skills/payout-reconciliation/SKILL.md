---
name: Payout reconciliation
description: Read first for Zomato or Swiggy payouts/reconciliation. Read-only.
---

## Fast, verified execution (both platforms)

Read this skill before acting, including separately authorized login tasks. Reuse the loaded skill across credential/code replies for this same task; do not load the Zomato-only recipe for a Swiggy-only task.

Before opening a login or finance page, run `/usr/local/bin/payout-preflight --platform zomato` or `--platform swiggy` once. If it reports an absent/inaccessible installed library, stop and report that the computer image needs rebuilding. Do not spend time on login, dependency installation, permission workarounds, helper discovery or source inspection. The installed commands and private-file paths are listed below; use them directly.

After sign-in, use the page returned by `browser_act`: it already contains a fresh snapshot. Do not immediately request another full snapshot unless relevant refs are missing, navigation has not settled, or the page changed. When available, use a focused snapshot query for the outlet ID or period. For an outlet switch, use the visible selector's search once with the outlet ID from this restaurant's settings, verify the selected ID/name against those settings, then continue. Never guess URLs, bypass verification, or change the separately authorized login method to save time.

For every platform, determine payment scope from this restaurant's actual export and live dashboard. Do not assume a particular tab exists, that an export combines brands/components, or that a tab named All is appropriate. Select only a dashboard view covering the same components, configured outlet, period and payment reference as the export; record the observed scope in the screen JSON. If no matching view exists, or the calculator does not support that export scope, stop and explain the mismatch. Keep component-only discrepancies separate; never call them rounding or silently allocate them elsewhere. Capture the verified scope/period/payment once, download one fresh file, run the installed calculator, and stop browser exploration once required checks are complete.

Do not use desktop screenshots/clicks for routine navigation when the structured page works. Use one shell call for independent path/existence checks if needed, not a sequence of exploratory `which`, `ls`, package reads and retries. A failed installed calculator is a blocker, not permission to invent the table.

## Default output — ALWAYS ONE CONSOLIDATED REPORT

Every payout/reconciliation request defaults to ONE consolidated owner report across all connected platforms: Zomato + Swiggy and future platforms. Never send separate per-app reports unless the owner EXPLICITLY requests them, or the outlet operates on only one platform. Even "did Zomato pay me" gets the consolidated report, with the Zomato line highlighted. Part A/B remain INTERNAL per-app collection/calculation steps; Part C is the owner-facing consolidated output. Preserve separate platform periods, source checks and bank checks inside that single report. This rule overrides older per-app-only output/scope wording below. Keep owner notes short/plain; full technical bridges only in the Excel outlet sheet.

## Installed commands on this computer

The calculators own the numbers. Do not add a row, average a percentage, or type a figure a command did not print.

This restaurant's private files live only on its computer, in `~/.local/share/payout-reconciliation/`. They are not part of the product. If a file is missing, copy the shape from `/usr/local/share/payout-reconciliation/` and stop to ask the owner for the real outlet id, name, locality, and city. Do not invent them. Do not turn a placeholder into a confirmed mapping.

- `zomato-settings.json` has `outlet_id`, `locality`, `city`, and `outlets.<id>.onboarding_rate_percent`. Leave the rate `null` until the owner gives the onboarding rate. A null rate is labelled "assumed rate X% (onboarding rate not yet provided)".
- `swiggy-settings.json` has `outlet_id`, `outlet_name`, `locality`, `city`, and the same per-outlet rate.
- `owner-confirmed-outlet-map.csv` has the columns `outlet,locality,zomato_id,swiggy_rid`. The shipped file is the header only. Copy that header if the private file is missing. Add a row only after the owner confirms that pair.

Before reading any figure, the outlet selected on the page must match the configured name and id. A different outlet that was already selected is not authority. Stop if the outlet, the period, or the paid status is wrong or ambiguous.

Save a fresh screen file for this task only. Zomato `payout-screen.json` and Swiggy `swiggy-payout-screen.json` hold the period as two ISO dates, `status` of `paid`, `paid_amount` as a decimal string, `paid_date` as an ISO date, and `utr_last4` as exactly four characters. Swiggy also stores `outlet_id`, `outlet_name`, and `job_label`. Never store a full payment reference, a customer field, a password, or a one-time code.

Zomato, after the fresh settlement workbook is on disk:

`/usr/local/bin/payout-owner-reconcile <workbook> --config ~/.local/share/payout-reconciliation/zomato-settings.json --screen <payout-screen.json>`

Swiggy, after the fresh annexure is on disk. Write `~/.local/share/payout-reconciliation/job.json` first, as `{"label":"<this task id>","issued_epoch":<seconds>}`. The screen file's `job_label` is that same label. The annexure must be newer than `issued_epoch`.

`/usr/local/bin/payout-swiggy-reconcile <annexure> --settings ~/.local/share/payout-reconciliation/swiggy-settings.json --screen <swiggy-payout-screen.json>`

Then once for that outlet pair:

`/usr/local/bin/payout-combined --zomato <zomato json> --swiggy <swiggy json> --zscreen <payout-screen.json> --sscreen <swiggy-payout-screen.json> --outlet-map ~/.local/share/payout-reconciliation/owner-confirmed-outlet-map.csv --out <this task's folder>`

Give the owner the short chat the command prints, `combined-table.png`, and `Outlet-Payout-Report.xlsx`. Nothing else. The per-app json and markdown stay on the computer.

One command covers one outlet pair. Run it again for another confirmed pair. Do not add those reports together yourself. A single workbook for every outlet is not available yet.

If the outlet is on one platform only, or the owner explicitly asks for that platform alone, that platform's table may be the whole report. Otherwise send the consolidated report, including when the question names only one platform. The first sentence of the chat then names the platform they asked about. The table still has both columns.

Do not install packages. If a command is not found, the computer image is older than this skill and needs a rebuild.

Move from what the live page shows. Do not use fixed click positions, a shell script that clicks, a private API, or saved cookies.

Dashboards are read-only. Never click "send report to mail", an envelope, or any email or share action. If a direct file download cannot be told apart from one of those, stop.

Keep the browser profile. If a login or one-time-code page appears during reconciliation, stop. Do not request or resend a code.

The six-box code method at the end of this skill is only for a separate sign-in the owner explicitly asked for. It is not part of reconciliation.

An absolute gap strictly below ₹1 passes with a rounding note. A gap of ₹1 or more fails. An exact zero stays an exact match. Never invent an adjustment so the bridge hits the paid amount.

# Payment reconciliation – Zomato + Swiggy (standard guide for any restaurant owner)

This file stands on its own. You need no other file or earlier conversation.
It describes **goals and checks**, not button clicks, because both partner dashboards change. If a menu or label below
is not where it says, look for the item with the **same meaning** (see "Finding rows when labels change") and carry on.
Never guess a number: every figure comes from a payout screen, a downloaded payout file, or a statement you actually read.

**The core of this job is the owner's two format tables – one for Zomato (A0), one for Swiggy (B0).** Every number the
owner sees is one of those 11 rows. Everything else (TDS, TCS, refunds, penalties, cancellations, adjustments,
GST on fees) goes **only in the notes or the bank bridge, never as a new row**.

Placeholders: `<Restaurant Name>`, `<Locality>`, `<City>`, `<ZOMATO_RES_ID>`, `<SWIGGY_RID>`, `<Owner Name>`,
`<Account Manager>`, `<Invoice No>`, `<Order ID>`, `UTR …<last 4>`. Real values go only into the owner's own report.

Lines starting with **UNSURE:** mark something not verified from real files; follow the instruction in that line.

---

## 0. Golden rules (every section)

1. **Dashboards are read-only.** View and download only. Never change a setting, menu, price, offer, ad campaign,
   outlet status or bank detail. Never click Accept / Confirm / Agree / Opt-in / Pay / Raise dispute / Raise ticket.
2. **Never type into a chat box, help widget or AI assistant panel** inside a dashboard.
3. **Nothing goes to a platform, account manager or anyone else without the owner's explicit yes** (section 10).
4. **No secrets:** no passwords, OTPs, phone numbers, email addresses, bank account numbers, full UTRs or customer data
   (customer IDs, names, addresses) in this file, notes, file names or messages. Show a UTR as `UTR …<last 4>` only.
   The owner signs in or gives a one-time code; use it once, never store or repeat it.
5. **Times** in the owner's zone (India: IST, UTC+5:30), using the actual date, time and zone label.
6. **Money** to two decimals while calculating; Indian grouping for the owner (₹<amount>). Percentages to two
   decimals. Totals and percentages are recomputed from sums, never averaged.
7. **Outlet-wise.** One table per outlet (Zomato restaurant ID / Swiggy RID), then a combined view.
8. **Source order:** take numbers from the dashboard **Finance / Payouts** screens or their downloadable payout files
   (Zomato: Payout Breakup of the settlement report; Swiggy: Payout Breakup of the invoice annexure). Use the
   order-level sheets **only to verify**, or when a summary is blank (Zomato's summary sheets often are – see A3).
9. **Fixed rows.** Exactly the 11 rows of A0 / B0, in that order, with those labels. Never add a row.
10. **Commission check** against the outlet's onboarding commission rate (A2 step 9 / B2 step 9).
11. **Bank check:** Net Payout ("total amount in bank account") is checked against the **paid amount and UTR on the
    payout page**; any difference is explained by a **bridge in the notes** (A2 step 10 / B2 step 10).

### Finding rows when labels change (both apps)

Find each row by its **meaning**, not its exact label:

- **Orders** – "Total Orders", "Number of orders", "Orders (Delivered + Cancelled)".
- **Sales (ST+PC)** – item total / sub total / food value **plus** packaging / packing charge (before GST).
- **Merchant Discount Burn** – discounts **the restaurant pays for**: "Restaurant discount", "merchant-funded discount",
  "restaurant share", "promo", "flat off", "freebies", "BOGO", "trade discount", "coupon (restaurant)". Not
  platform-funded discounts.
- **Ads** – see each platform's "Finding Ads when labels change".
- **Comm.+PG+GST** – platform fees: commission / service fee / base service fee, long-distance / fulfilment fee,
  payment gateway / payment mechanism / payment collection fee, other platform fees, and the GST on them where the
  owner's table says so.
  If a row's meaning cannot be found, leave the cell blank, say so in the notes, and ask the owner. Never guess.

---

# PART A – ZOMATO DELIVERY

## A0. The owner's Zomato format (core table – copy exactly)

Source: from the dashboard, **Finance > Payouts** (and its downloadable settlement report).

| Terms                  | What it means                 | Where to find it                                                                               |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Orders                 | Total number of orders        | Total Orders                                                                                   |
| ST+PC                  | Total Sales                   | Sub Total + Packaging Charges                                                                  |
| Merchant Discount Burn | Discounts given by restaurant | Rest flat offs + promos                                                                        |
| Effective Discount %   | discount %                    | Merchant discount / ST PC                                                                      |
| CV                     | commissionable value          | Sales - discount                                                                               |
| Ads                    | ads spent                     | Investment in growth                                                                           |
| Ads %                  | ads spent against total sales | Ads / STPC                                                                                     |
| Comm.+PG+GST           | commission + pg + gst         | Order level deductions [Base service fees + long distance fees + payment mechanism fees + GST] |
| Net Payout             | total amount in bank account  | CV - Ads - Comm+PG+Gst                                                                         |
| Payout %               | % of sales in bank account    | Net Payout / ST+PC                                                                             |
| Burn %                 | % of burn                     | 1 - Payout %                                                                                   |

## A1. Inputs (Zomato)

| #   | Input                                                                                             | Used for                                                                          | Where (general)                                                                                              | Date range                                                                                                                    | Format                  |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Z1  | **Settlement report** `Zomato_Settlement_Report_<ZOMATO_RES_ID>_<DD Mon YYYY>_<DD Mon YYYY>.xlsx` | All 11 rows (sheet `Payout Breakup`; `Order Level` to verify) and the bank bridge | Finance > Payouts → select the outlet → the week (or custom range) → download the settlement / payout report | Use the actual service-period bounds requested by the owner and shown in the export/dashboard; verify any week or month split | `.xlsx`, one per outlet |
| Z2  | **Payouts screen** for the week                                                                   | Paid amount, paid date, UTR, paid/pending status (bank check)                     | Finance > Payouts → the week's payout row / details                                                          | Same week                                                                                                                     | Screen (read and note)  |
| Z3  | Ads / growth invoices                                                                             | Confirm the Ads row                                                               | Finance > Invoices (or the week's payout details)                                                            | Same week                                                                                                                     | PDF                     |
| Z4  | **Onboarding record** of the outlet                                                               | Agreed commission % and any cap (commission check)                                | The restaurant's onboarding sheet / record kept by the onboarding process                                    | Current agreement                                                                                                             | Sheet / document        |
| Z5  | Bank statement (optional, if the owner gives it)                                                  | Tie each UTR to its bank line                                                     | Owner supplies it                                                                                            | Payout dates + a few days                                                                                                     | CSV / XLSX / PDF        |
| Z6  | Outlet list (ID, name, locality, city)                                                            | Cross-app matching, coverage                                                      | Outlet picker at the top of the dashboard                                                                    | –                                                                                                                             | Your own TSV/CSV        |

UNSURE: the labels on the Zomato Finance > Payouts _screen_ itself were not checked line by line for this guide (only the
downloaded settlement report was). If the screen and the file differ, use the file and note the difference.

What the Zomato settlement report contains (verified on real files): sheets `Summary`, `Payout Breakup`,
`Order Level`, `Addition Deductions Details`, `Discounts Summary`, `Glossary`, `HSummary`, `HDiscount`
(some outlets: `Distance Based Summary`).

- `Payout Breakup` rows (Delivered | Cancelled/Rejected | Total): `Number of Orders`; `A Net order value`;
  `1 Subtotal (items total)`; `2 Packaging charge`; `3 Delivery charge for restaurants on self logistics`;
  `4 Restaurant discount [Promo]`; `5 Restaurant Discount [BOGO, Freebies, Gold, Brand pack & others]`;
  `6 Brand pack subscription fee`; `7 Delivery charge discount / Relisting discount`; `8 Total GST collected from customers`;
  `9 Commissionable value`; `B Service fees & payment mechanism fees (10 Service fee + 11 Payment mechanism fee)`;
  `C Government charges (12 Taxes on service & payment mechanism fees, 13 TCS, 14 TDS 194O amount, 15 GST paid by Zomato u/s 9(5))`;
  `D Other order level deductions` (customer compensation/recoupment, rejection penalty, delivery charges recovery,
  credit/debit note, promo recovery, extra inventory ads, loyalty redemption, express order fee, cash received,
  adjustments from previous weeks); `E Investment in growth services (19 Total Ads (inc. 18% GST), 20 Total Dining Ads
  (inc. 18% GST), 21 Miscellaneous services)`; `F Investment in Hyperpure`; `G Other Deductions`;
  `H Total Additions (24 Cancellation refund, 25 Tip for kitchen staff, 26 TDS 194H and other Res id level additions,
  27 Restaurant-level service fees rebate)`; `I Net Payout (A − B − C − D − E − F − G + H)`; settlement breakdown
  (amount settled / pending).
- `HSummary`: period, restaurant ID, name, address, pay-out cycle (use the actual header, never an example weekday), UTR list.
- `Order Level`: one row per order with the same items per order plus `Order status`, `Settlement status`,
  `Settlement date`, `Bank UTR`. It also holds `Customer ID` – **customer data, never copy it**.
- `Addition Deductions Details`: restaurant-level lines – additions (e.g. type `ADS` credit, `TDS_194H`, `TDS_194O`)
  and deductions `A) Investments in growth services` (one `ADS` row per ads invoice with period, Total / Adjusted /
  Outstanding), `B) Hyperpure`, `C) Other deductions`, `D) Adjustments from previous weeks`.

## A2. Step-by-step logic (Zomato) – fill the 11 rows, then check

**Step 1 – Period and files.** Read the service period and settlement date from the current export and dashboard. Do not infer payout dates from a fixed weekday offset. Download Z1 for each configured outlet in scope; read Z2 when its payout is actually marked paid.

**Step 2 – Orders** = `Total Orders` (Payout Breakup `Number of Orders`, Total column = delivered + cancelled/rejected).
Verify: count of rows in `Order Level`.

**Step 3 – ST+PC** = `Subtotal (items total)` + `Packaging charge` (Total column).

**Step 4 – Merchant Discount Burn** = "Rest flat offs + promos" = `Restaurant discount [Promo]` +
`Restaurant Discount [BOGO, Freebies, Gold, Brand pack & others]` (older label `[Flat offs, Freebies, Gold & others]`).
UNSURE: whether `Delivery charge discount / Relisting discount` belongs in Merchant Discount Burn – the owner's table
names only flat offs + promos. Keep it out of the row; if it is non-zero, put the amount in the notes and ask the owner.

**Step 5 – Effective Discount %** = Merchant Discount Burn ÷ ST+PC.

**Step 6 – CV** = ST+PC − Merchant Discount Burn. Verify against the file's `Commissionable value` (row 9); they are
equal for normal delivery orders. If not equal (brand pack fee, self-delivery charge), keep the formula value in the
row and note the file value.

**Step 7 – Ads** = "Investment in growth" = Payout Breakup **`E Investment in growth services`** (Total Ads +
Dining Ads + Miscellaneous services), i.e. the `A) Investments in growth services` lines of the week in
`Addition Deductions Details`. Also add any other line found under "Finding Ads when labels change" (e.g.
`Extra Inventory Ads … (order level deduction)`). Count by the ads invoice's deduction period: an invoice belongs to the
week its period starts in. Ads row = ads for the week **whether or not already deducted** (Outstanding > 0 means it
will be taken from a later payout – say so in the notes and in the bridge).

#### Finding Ads when labels change (Zomato)

- Ads = the amount on **any line, column, row type or heading** that mentions ads or a synonym: **Ads, Ad, Advertisement,
  Advertising, Ad spend, Investment in growth, Growth investment(s), Growth Investments in Ads, Promoted listing(s), CPC,
  Sponsored, Marketing / Ad campaigns**. When the word is in a **heading**, every line under that heading is Ads.
  "Investment in growth" is today's Zomato label, not a fixed rule.
- **Sum every ads line found**, but never count the same money twice: if a total and its sub-lines both appear
  (e.g. `E Investment in growth services` and its rows 19–21, or "Total Ads & miscellaneous services" and the invoice
  rows), take **either** the total **or** the sub-lines.
- Add a note naming the label(s) used, e.g. "Ads = 'Investment in growth services' (7 ADS invoices)".
- Ads **credits / refunds** under an ads label (e.g. an `ADS` line under Additions) are not netted into the Ads row;
  they go in the notes and the bank bridge as "Ads credit".
- If **no ads-like label** is found but money is deducted under a label you do not recognise, **flag it to the owner**
  (label + amount) rather than guessing whether it is ads. Lines that clearly are not ads (Hyperpure, TDS, carry-forwards)
  go to the notes/bridge as adjustments.

**Step 8 – Ads %** = Ads ÷ ST+PC.

**Step 8b – Comm.+PG+GST** = order-level deductions [Base service fees + long distance fees + payment mechanism fees + GST]
= Payout Breakup `B Service fees & payment mechanism fees` (service fee / base service fee, long distance or fulfilment
fee net of its discount and any "30% capping" discount, payment mechanism fee) **+** `12 Taxes on service & payment
mechanism fees` (the 18% GST on B). Take both from the payout file; do not re-derive rates. Verify with the
`Order Level` column sums.

**Step 9 – Commission check (onboarding rate).** From Z4 take the outlet's agreed commission % and any cap. For every
order compare `Service fees %` / `Base service fee %` (and the service fee amount) with it. Flag each order that differs
(order ID, onboarding %, charged %, ₹ difference) – **do not guess why**. If no onboarding rate is found, write
**"assumed rate X% (onboarding rate not yet provided)"**, using the most common charged rate, and flag all differing-rate chargeable orders. Ask the owner for the actual rate. The row value stays what the
platform charged; the check result goes in the notes.

**Step 9b – Net Payout** = CV − Ads − Comm.+PG+GST. **Payout %** = Net Payout ÷ ST+PC. **Burn %** = 1 − Payout %.
If ST+PC is 0, all % are 0.

**Step 10 – Bank check and bridge.** Read the **paid amount, paid date and UTR** for the week on the Payouts screen (Z2)
(the file's `HSummary` / `Bank UTR` show the same UTRs). Then write the bridge in the notes:

```
Net Payout (format)
 − TDS 194O                                      (Payout Breakup row 14)
 − TCS (+ TCS IGST)                              (row 13)
 ± GST collected − GST paid by Zomato u/s 9(5)   (row 8 − row 15; usually a few paise)
 − other order-level deductions (D)              (penalties, recoupments, promo recovery, previous-week adjustments)
 − Hyperpure (F) − other deductions (G)
 + additions (H)                                 (cancellation refunds, tips, TDS 194H / other additions, Ads credit)
 + ads not yet deducted (Outstanding)            (if the ads were not taken from this payout)
 = Zomato's own Net Payout (I)  → compare with the amount paid under the UTR
```

- One UTR can cover several outlets or several weeks: group payouts by UTR and compare the **sum** under that UTR.
- If the owner gives a bank statement, find each UTR on it and check amount and date.
- Before payout day everything shows `pending` and no UTR – the bank check waits; say "not paid yet".

## A3. Known traps (Zomato)

- **Summary sheets read blank**: `Summary` and `Payout Breakup` are formula sheets; read by a script (or opened without
  recalculation) they show 0 / `#REF!`. Then compute the rows from `Order Level` (same column names) and
  `Addition Deductions Details` – that is the allowed "summary is blank" case.
- **Three template versions** of `Order Level` (square vs round brackets; "Service fees %" vs "Base service fee %";
  extra distance/fulfilment columns). Match by meaning/header text, never by column position.
- **Ads are restaurant-level and may be deducted later** (Outstanding > 0); an invoice can span two weeks. Count it once,
  in the week its period starts; show the outstanding part in the bridge.
- **Ads credits** (e.g. ₹<amount> `ADS` addition in a week with ₹<amount> of ads) – notes and bridge, not the Ads row.
- **TDS is withheld but is a tax credit**, not a cost – bridge only (e.g. ₹<amount> for a week).
- **Customer GST is not the restaurant's money** on delivery orders (u/s 9(5) Zomato pays it); a few paise between
  collected and paid is normal.
- **Cancelled/rejected orders** count in Orders; they carry no commission and their refund is an addition (bridge).
- **Month-end**: a service period that crosses a month boundary is split between month reports; the last week of a
  month report is usually still pending on the 1st–2nd.
- Comm.+PG+GST summed from rounded columns can differ by a paisa from the unrounded total – normal.
- Payment mechanism fee can be 0 for an outlet – take it as shown.
- Duplicate downloads (`… (1).xlsx`) – use one copy per outlet and period.

## A4. What correct looks like (Zomato)

- [ ] One report per outlet; outlets in the picker = files + outlets with no orders (listed).
- [ ] All 11 rows filled from the payout file, labels exactly as A0; nothing extra as a row.
- [ ] CV = file `Commissionable value` (or the difference explained); Comm.+PG+GST = Σ order-level B + GST on B (±₹0.05).
- [ ] Ads lines found by meaning, summed once, label named in the notes; unknown deductions flagged.
- [ ] Commission check done (OK / orders flagged / "assumed rate X% (onboarding rate not yet provided)").
- [ ] Bridge from Net Payout to Zomato's Net Payout (I) closes with an **absolute difference strictly below ₹1 per outlet per week**, and I = amount paid
  under the UTR on the Payouts screen with an absolute difference strictly below ₹1 (sum all outlets/weeks under one UTR).

## A5. Escalation (Zomato) – only after the owner says yes

- Amount paid under a UTR ≠ bridged Net Payout by ₹1 or more and the file does not explain it; UTR missing after
  payout Wednesday + 2 working days; UTR not on the owner's bank statement.
- Commission % different from the onboarding rate (flagged orders).
- Ads invoices the owner did not approve, or one invoice deducted twice.
- Penalties / recoupments / promo recoveries the owner disputes; missing cancellation refunds.

```
Subject: Payout discrepancy – <Restaurant Name>, <Locality> (Res ID <ZOMATO_RES_ID>) – week <DD Mon> – <DD Mon YYYY>

Hi <Account Manager>,

For <Restaurant Name>, <Locality> (Res ID <ZOMATO_RES_ID>), week <DD Mon> – <DD Mon YYYY>:
- Net payout as per your settlement report: ₹<expected>
- Amount paid (UTR …<last 4>, <DD Mon YYYY>): ₹<actual>
- Difference: ₹<difference>

Items to explain / correct:
1. <Order ID or Invoice No> – <charge> – ₹<amount> – <why we think it is wrong>
2. ...

Please confirm the correction and when the difference will be paid.

Regards,
<Owner Name>, <Restaurant Name>
```

---

# PART B – SWIGGY DELIVERY

## B0. The owner's Swiggy format (core table – copy exactly)

Source: from the dashboard (**Payouts / payout breakup**, and the downloadable invoice annexure).

| Terms                  | What it means                 | Where to find it                 |
| ---------------------- | ----------------------------- | -------------------------------- |
| Orders                 | Total number of orders        | Total Orders                     |
| ST+PC                  | Total Sales                   | Item total + Packaging charge    |
| Merchant Discount Burn | Discounts given by restaurant | Restaurant Discount              |
| Effective Discount %   | discount %                    | Merchant discount / ST PC        |
| CV                     | commisionable value           | Sales - discount                 |
| Ads                    | ads spend                     | Other Charges in payout break up |
| Ads %                  | ads spent against total sales | Ads / ST+PC                      |
| Comm.+PG+GST           | commission + pg + gst         | Total fees                       |
| Net Payout             | total amount in bank account  | CV - Ads - Comm+PG+GST           |
| Payout %               | % of sales in bank account    | Net Payout / ST+PC               |
| Burn %                 | % of burn                     | 1 - Payout %                     |

## B1. Inputs (Swiggy)

| #   | Input                                                                            | Used for                                                                              | Where (general)                                                                            | Date range                                                                                   | Format                            |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------- |
| S1  | **Invoice annexure** `invoice_Annexure_<SWIGGY_RID>_<DDMMYYYY>_<13 digits>.xlsx` | All 11 rows (sheet `Payout Breakup`, Total column) and the bridge                     | Finance → Payouts (past payouts) → select outlet → the cycle → download invoice / annexure | The actual payout cycle shown in the current export/dashboard, including any month-end split | `.xlsx`, one per outlet per cycle |
| S2  | **Payouts screen / payout breakup** for the cycle                                | Paid amount, date, UTR, status; numbers for cycles with no annexure yet ("estimated") | Finance → Payouts → the cycle → details (expand every row)                                 | Same cycle                                                                                   | Screen                            |
| S3  | Ads invoices                                                                     | Confirm the Ads row                                                                   | Finance → Invoices                                                                         | Same cycle                                                                                   | PDF                               |
| S4  | **Onboarding record** of the outlet                                              | Agreed commission % and cap                                                           | Restaurant's onboarding sheet / record                                                     | Current agreement                                                                            | Sheet / document                  |
| S5  | Bank statement (optional)                                                        | Tie each UTR to its bank line                                                         | Owner supplies it                                                                          | Settlement dates + a few days                                                                | CSV / XLSX / PDF                  |
| S6  | Outlet list (RID, name, locality, city)                                          | Matching, coverage                                                                    | Outlet selector; first lines of the annexure `Summary`                                     | –                                                                                            | Your own TSV/CSV                  |

What the Swiggy annexure contains (verified on real files): sheets `Summary`, `Payout Breakup`, `Order Level`,
(`Item Level`), `Unresolved Customer Complaints`, `Growth Investments and Other De…`, `Discount Summary`, `Glossary`.

- `Summary`: outlet name / locality / city above `Rest. ID - <SWIGGY_RID>`, `Payout Period`, `Payout Settlement Date`,
  `Total Payout`, `Total Orders (Delivered + Cancelled)`, `Bank UTR`.
- `Payout Breakup` (Delivered | Cancelled | **Total** – always use Total; deductions are negative): `Orders`;
  `A Total Customer Paid` (`1 Item Total`, `2 Packaging Charges`, `3 Restaurant Discounts (Coupon based)`,
  `4 Restaurant Discounts (Trade Discounts, Freebies and others)`, `5 GST Collected`); `B Swiggy Fees` (= **Total fees**:
  commission, long distance, payment collection, Pocket Hero, Swiggy One, restaurant cancellation, call centre,
  delivery fee sponsored, Bolt, no-fees-week cashback); `C Customer Complaints & Cancellation Charges`;
  `D Growth Investment In Ads` (sub-lines such as Cost Per Click - Ads, Ads Offers, HyperBoost, Unlimited Ads,
  Top Picks - Ads, Brandverse Social Media Marketing, Co-branded Partnership, Display Ads/Topicals);
  `E Other Charges and Refunds` (sub-lines seen: ads lines, Packaging Material, Onboarding Fees, TDS (Refund),
  Previous week outstanding); `F Total Taxes` (`GST Deduction (paid by Swiggy on behalf of the restaurant)`,
  `GST on Service Fee @18%`, `TCS`, `TDS`); `G Net Payout [A+B+C+D+E+F]` = Swiggy's paid amount.
- `Order Level`: one row per order (verification only); also has customer-linked fields – never copy them.

## B2. Step-by-step logic (Swiggy) – fill the 11 rows, then check

**Step 1 – Period and files.** Read the actual cycle, settlement date and month-end splits from the current annexure and dashboard. Never derive them from a fixed weekday offset or a filename date. For a weekly owner report, use the requested reporting window and disclose each platform's actual service period. If a cycle is "processing" (no annexure), copy the payout-breakup screen (S2) and mark the
outlet **estimated**; replace it when the annexure appears.

**Step 2 – Orders** = `Total Orders` (Payout Breakup `Orders`, Total column; = Summary `Total Orders (Delivered + Cancelled)`).

**Step 3 – ST+PC** = `Item Total` + `Packaging Charges` (Total column).

**Step 4 – Merchant Discount Burn** = "Restaurant Discount" = `Restaurant Discounts (Coupon based)` +
`Restaurant Discounts (Trade Discounts, Freebies and others)` (Total column, as positive numbers). These are already the
restaurant's share only (the `Discount Summary` shows the restaurant share % per coupon); platform-funded parts are not in them.

**Step 5 – Effective Discount %** = Merchant Discount Burn ÷ ST+PC.

**Step 6 – CV** = ST+PC − Merchant Discount Burn (= Σ `Net Bill Value (before taxes)` in Order Level – verify).

**Step 7 – Ads** = "Other Charges in payout break up" **when the Other Charges lines are ads**. When Other Charges is 0
or is not ads, use the line whose heading contains "Ads" (today: `D Growth Investment In Ads`). Both can hold ads:
sum every ads line found (Ads lines in E **plus** D), once each.

#### Finding Ads when labels change (Swiggy)

- Ads = the amount on **any line, column or heading** that mentions ads or a synonym: **Ads, Ad, Advertisement,
  Advertising, Ad spend, Investment in growth, Growth investment(s), Growth Investments in Ads, Promoted listing(s), CPC,
  Sponsored, Marketing / Ad campaigns**. When the word is in a **heading**, every sub-line under it is Ads (e.g.
  HyperBoost, Top Picks, Brandverse under "Growth Investment In Ads"). "Other Charges" and "Growth Investment In Ads"
  are today's Swiggy labels, not fixed rules.
- **Sum every ads line found**, never twice: when a section total and its sub-lines both appear (e.g. `D` and
  "Cost Per Click - Ads"; "Total Ads Investments" in the Growth sheet and its rows), take **either** the total **or**
  the sub-lines.
- Other Charges lines that are **not** ads (Packaging Material, Onboarding Fees, TDS (Refund), previous-week
  outstanding) are adjustments → notes and bridge, not the Ads row.
- Add a note naming the label(s) used, e.g. "Ads = 'Growth Investment In Ads' (Cost Per Click - Ads); Other Charges ₹<amount>".
- If **no ads-like label** is found but money is deducted under an unknown label, **flag it to the owner** (label +
  amount) rather than guessing.
- A negative Ads total (refund larger than spend) can push Payout % above 100% – keep it, flag it, list the sub-lines.

**Step 8 – Ads %** = Ads ÷ ST+PC.

**Step 8b – Comm.+PG+GST** = **"Total fees"** = Payout Breakup `B Swiggy Fees` (Total column, positive), taken **as given**
– do not re-derive fee rates. `GST on Service Fee @18%` is **not** inside it (it sits under Taxes) – it goes in the
bridge. (Order Level "Total Swiggy Fees" includes that GST – do not use it for this row.)

**Step 9 – Commission check (onboarding rate).** From S4 take the outlet's agreed commission % and any cap. For every order
compare `Service Fees %` and `Commission` (on `Commission charged on`) with it. Flag each order that differs (order ID,
onboarding %, charged %, ₹ difference) – **do not guess why**. No onboarding rate → **"assumed rate X% (onboarding rate not yet provided)"**, using the most common charged rate; flag all differing-rate chargeable orders and ask the owner for the actual rate. The row stays what Swiggy charged.

**Step 9b – Net Payout** = CV − Ads − Comm.+PG+GST. **Payout %** = Net Payout ÷ ST+PC. **Burn %** = 1 − Payout %.

**Step 10 – Bank check and bridge.** Read the **paid amount, settlement date and UTR** on the Payouts screen / annexure
`Summary` (`Total Payout`, `Bank UTR`). Bridge in the notes:

```
Net Payout (format)
 − GST on Service Fee @18%                         (F row "GST on Service Fee @18%")
 − TDS − TCS                                       (F rows)
 ± GST Collected − GST Deduction                   (row 5 − F row "GST Deduction"; usually a few paise)
 − Customer Complaints & Cancellation Charges (C)
 ± Other Charges that are not ads (adjustments in E)
 = Swiggy Net Payout (G) → compare with the amount paid under the UTR
```

- One UTR can cover several outlets or cycles: sum the payouts under that UTR before comparing.
- If the owner gives a bank statement, tie each UTR to its line (amount and date).

## B3. Known traps (Swiggy)

- **Use the Total column**: ads and other charges appear only there; the Delivered column of G is not the payout.
- **Total fees excludes GST on fees**; Order Level "Total Swiggy Fees" includes it – don't double count.
- **Other Charges can be ads, non-ads or a mix**, and can be positive (refunds). Split by meaning (Step 7).
- **Two dates**: annexure settlement date (Sat + 3) vs file code / order settlement date (Sat + 4) – not an error.
- **Month-split cycles**: a week or month can contain two cycles – sum them per outlet.
- **Rounding**: the bridge built from rounded breakup lines can differ from G by a few paise (show the actual computed gap);
  Σ order-level payouts − ads matched G exactly.
- **Processing cycles**: no annexure until paid; on-screen numbers are "estimated".
- Re-downloads (`(1).xlsx`) – keep one per RID and cycle.
- Previous-week outstanding / unsettled deductions move money between cycles – bridge items, check over 2–3 cycles.

## B4. What correct looks like (Swiggy)

- [ ] One annexure per outlet per cycle (or a listed reason / estimated from screen).
- [ ] All 11 rows from the Payout Breakup Total column, labels exactly as B0; nothing extra as a row.
- [ ] CV = Σ order-level Net Bill Value (±₹0.05); Total fees = Σ order-level fees excl. GST (±₹0.10).
- [ ] Ads lines found by meaning, summed once, label named; non-ad Other Charges in the bridge; unknown deductions flagged.
- [ ] Commission check done (OK / orders flagged / "assumed rate X% (onboarding rate not yet provided)").
- [ ] Bridge from Net Payout to G closes with an **absolute difference strictly below ₹1 per outlet per cycle**; G = Summary `Total Payout` = amount paid
  under the UTR on the payout page (sum per UTR).

## B5. Escalation (Swiggy) – only after the owner says yes

- Amount paid under a UTR ≠ G (or ≠ bridged Net Payout) by ₹1 or more; no UTR 2 working days after the settlement date;
  UTR not on the owner's bank statement.
- Commission % different from the onboarding rate (flagged orders).
- Ads lines or invoices the owner did not approve, or one invoice in two cycles; Other Charges the owner does not recognise.
- Complaint refunds / cancellation charges the owner disputes; restaurant share % on a coupon higher than agreed.

```
Subject: Payout discrepancy – <Restaurant Name>, <Locality> (RID <SWIGGY_RID>) – cycle <DD Mon> – <DD Mon YYYY>

Hi <Account Manager>,

For <Restaurant Name>, <Locality> (RID <SWIGGY_RID>), payout cycle <DD Mon> – <DD Mon YYYY>:
- Net payout as per the invoice annexure: ₹<G>
- Amount paid (UTR …<last 4>, <DD Mon YYYY>): ₹<actual>
- Difference: ₹<difference>

Items to explain / correct:
1. <Order ID / Invoice No / charge name> – ₹<amount> – <reason>
2. ...

Please confirm the correction and when the difference will be paid.

Regards,
<Owner Name>, <Restaurant Name>
```

---

# PART C – SHARED SECTIONS

## 6. Purpose

Reconciliation in the owner's format proves, per outlet and per app:

1. **How much of sales reaches the bank** (Net Payout, Payout %) and **where the rest goes** (discounts, ads,
   commission + PG + GST → Burn %), in the same 11 rows every week so outlets and weeks compare directly.
2. **That the platform paid what its own statement says** – Net Payout bridged to the amount paid under each UTR.
3. **That commission matches the onboarding agreement**, and every ads line was one the owner approved.
   Small errors (an unapproved ads invoice, a wrong commission %, a missing refund) repeat every week across outlets; this
   catches them and tells the owner where to cut discounts or ads.

## 7. Differences (Zomato vs Swiggy, in format terms)

| Row / topic            | Zomato                                                                                                                       | Swiggy                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Source                 | Finance > Payouts; settlement report `Payout Breakup` (often blank → `Order Level`)                                          | Payouts / payout breakup; annexure `Payout Breakup` (Total column)                      |
| Period / paid          | Week Mon–Sun; paid following Wednesday                                                                                       | Cycle Sun–Sat (split at month end); paid Saturday + 3 (file code Sat + 4)               |
| ST+PC                  | Sub Total + Packaging Charges                                                                                                | Item total + Packaging charge                                                           |
| Merchant Discount Burn | Rest flat offs + promos (`[Promo]` + `[BOGO, Freebies, Gold, Brand pack & others]`)                                          | Restaurant Discount (coupon based + trade/freebies)                                     |
| Ads (today's label)    | Investment in growth (services)                                                                                              | Other Charges when ads; else "Growth Investment In Ads"                                 |
| Comm.+PG+GST           | Base service fee + long distance + payment mechanism fee + GST on them                                                       | Total fees (`B Swiggy Fees`); GST @18% on fees is outside → bridge                      |
| Typical bridge items   | TDS 194O, TCS, GST 9(5) paise, additions (cancellation refunds, Ads credit, TDS 194H), ads outstanding, penalties, Hyperpure | GST @18% on fees, TDS, TCS, GST paise, complaints & cancellations, non-ad Other Charges |
| Paid amount / UTR      | Payouts screen; `HSummary` / `Bank UTR` per order                                                                            | Payouts screen; annexure `Summary` `Total Payout` / `Bank UTR`                          |

## 8. Combined view

Read the restaurant’s `owner-confirmed-outlet-map.csv` first (columns: outlet, locality, zomato_id, swiggy_rid). An owner-confirmed ID pair is a confirmed match: do not label it uncertain. Use the fallback matching rules below only when no confirmed mapping exists or evidence conflicts.

1. **Match outlets across apps by restaurant NAME** (IDs differ); **locality + city as tiebreaker**. Normalise names
   (lower case, "&" → "and", no punctuation, drop "The"). Same name + same locality → pair; same name, locality unclear →
   pair and mark "match uncertain – please confirm"; same brand in different localities or several candidates → do not
   pair, ask the owner; different cities never pair. Keep an owner-confirmed map `outlet,locality,zomato_id,swiggy_rid`.
2. Put the Zomato week beside the Swiggy cycle(s) ending inside it; state both periods in the title.
3. Columns **Terms | What it means | Zomato (ID) | Swiggy (RID) | Total**, same 11 rows. Total = sum of Orders and money
   rows; Effective Discount %, Ads %, Payout %, Burn % recomputed from the totals.
4. Notes under the table: Zomato notes, Swiggy notes (labels used for Ads, commission check, bridge to paid amount).
5. After all outlets: one overall summary (Net, ST+PC, Payout % per app and combined; outlets on both / one app;
   bank-check mismatches).

## 9. Output (exact format the owner gets)

Title per outlet: `<Restaurant Name> (<Locality>, <City>) | Payout Report | Zomato <DD Mon> – <DD Mon YYYY> · Swiggy <DD>–<DD Mon YYYY>`.
Rows and labels exactly as A0 / B0. Money `₹#,##,##0.00`, percentages `0.00%`, missing app `—`. Net Payout and
Payout % in bold. Notes below the table: source and period, Ads label(s) used, commission check, bank bridge.

### 9.1 Zomato example (<ZOMATO_PERIOD>, placeholder-only template)

`<Restaurant Name> (<Locality>, <City>)` – Zomato Delivery, ID `<ZOMATO_RES_ID>`

| Terms                  | What it means                 | Zomato (ID <ZOMATO_RES_ID>) |
| ---------------------- | ----------------------------- | --------------------------: |
| Orders                 | Total number of orders        |                    <orders> | <orders> | <orders> |
| ST+PC                  | Total Sales                   |                   ₹<amount> |
| Merchant Discount Burn | Discounts given by restaurant |                   ₹<amount> |
| Effective Discount %   | discount %                    |                     <rate>% |
| CV                     | commissionable value          |                   ₹<amount> |
| Ads                    | ads spent                     |                   ₹<amount> |
| Ads %                  | ads spent against total sales |                     <rate>% |
| Comm.+PG+GST           | commission + pg + gst         |                   ₹<amount> |
| **Net Payout**         | total amount in bank account  |               **₹<amount>** |
| **Payout %**           | % of sales in bank account    |                 **<rate>%** |
| Burn %                 | % of burn                     |                     <rate>% |

Notes:

- Source: Zomato settlement report for <ZOMATO_PERIOD> (summary sheet blank → rows computed from Order Level and
  Addition Deductions Details). <example-count> orders; report the actual delivered/cancelled split.
- ST+PC = Sub Total ₹<amount> + Packaging ₹<amount>. Discount = promos ₹<amount> + flat offs/BOGO/freebies ₹<amount>.
- Ads label used: "Investment in growth services" – <example-count> ADS invoices ₹<amount> (incl. <rate>% GST per the heading), still
  outstanding at download (to be deducted from the payout).
- Comm.+PG+GST = base service fee ₹<amount> (<rate>%) + long distance ₹<amount> + payment mechanism fee ₹<amount> + GST ₹<amount>.
- Commission check: charged <rate>% on all <example-count> orders → compare with the onboarding rate (OK / flagged orders / "assumed rate X% (onboarding rate not yet provided)").
- Bank bridge: Net ₹<amount> − TDS ₹<amount> − TCS ₹<amount> − GST 9(5) paise ₹<amount> + Ads credit ₹<amount> = **₹<amount>**
  = Zomato's Net Payout for the week; compare with the amount paid under `UTR …<last 4>` on the Payouts screen (actual payout date <PAID_DATE>).
  UNSURE: if the actual paid amount and reference have not been read from the live payout screen, stop the bank check at the platform figure and label it unverified; do not copy values from this template.

### 9.2 Swiggy example (<SWIGGY_PERIOD>, placeholder-only template)

`<Restaurant Name> (<Locality>, <City>)` – Swiggy Delivery, RID `<SWIGGY_RID>`

| Terms                  | What it means                 | Swiggy (RID <SWIGGY_RID>) |
| ---------------------- | ----------------------------- | ------------------------: |
| Orders                 | Total number of orders        |                  <orders> | <orders> | <orders> |
| ST+PC                  | Total Sales                   |                 ₹<amount> |
| Merchant Discount Burn | Discounts given by restaurant |                 ₹<amount> |
| Effective Discount %   | discount %                    |                   <rate>% |
| CV                     | commisionable value           |                 ₹<amount> |
| Ads                    | ads spend                     |                 ₹<amount> |
| Ads %                  | ads spent against total sales |                   <rate>% |
| Comm.+PG+GST           | commission + pg + gst         |                 ₹<amount> |
| **Net Payout**         | total amount in bank account  |             **₹<amount>** |
| **Payout %**           | % of sales in bank account    |               **<rate>%** |
| Burn %                 | % of burn                     |                   <rate>% |

Notes:

- Source: Swiggy invoice annexure, payout period <SWIGGY_PERIOD> (file date <EXPORT_DATE_CODE>), Payout Breakup Total column.
  <example-count> orders (<delivered-count> delivered + <cancelled-count> cancelled).
- ST+PC = Item total ₹<amount> + Packaging ₹<amount>. Restaurant Discount = coupon ₹<amount> + trade/freebies ₹<amount>.
- Ads label used: Other Charges was ₹<amount> so Ads = "Growth Investment In Ads" (Cost Per Click - Ads) ₹<amount>.
- Comm.+PG+GST = Total fees ₹<amount> (as given).
- Commission check: compare each order's Service Fees % with the onboarding rate; flag orders that differ (if the actual file
  contains varying charged percentages) or write "assumed rate X% (onboarding rate not yet provided)".
- Bank bridge: Net ₹<amount> − GST @<rate>% on fees ₹<amount> − TDS ₹<amount> − TCS ₹<amount> − complaints ₹<amount> = ₹<amount>
  vs paid **₹<amount>** on <PAID_DATE> under `UTR …<last 4>` → <ACTUAL_MATCH_OR_MISMATCH_AND_GAP>.

### 9.3 Combined example (owner's standard layout)

`<Restaurant Name> (<Locality>, <City>) | Payout Report | Zomato <ZOMATO_PERIOD> · Swiggy <SWIGGY_PERIOD>`

| Terms                  | What it means                 | Zomato (ID <ZOMATO_RES_ID>) | Swiggy (RID <SWIGGY_RID>) |         Total |
| ---------------------- | ----------------------------- | --------------------------: | ------------------------: | ------------: |
| Orders                 | Total number of orders        |                    <orders> |                  <orders> |      <orders> |
| ST+PC                  | Total Sales                   |                   ₹<amount> |                 ₹<amount> |     ₹<amount> |
| Merchant Discount Burn | Discounts given by restaurant |                   ₹<amount> |                 ₹<amount> |     ₹<amount> |
| Effective Discount %   | discount %                    |                     <rate>% |                   <rate>% |       <rate>% |
| CV                     | commissionable value          |                   ₹<amount> |                 ₹<amount> |     ₹<amount> |
| Ads                    | ads spent                     |                   ₹<amount> |                 ₹<amount> |     ₹<amount> |
| Ads %                  | ads spent against total sales |                     <rate>% |                   <rate>% |       <rate>% |
| Comm.+PG+GST           | commission + pg + gst         |                   ₹<amount> |                 ₹<amount> |     ₹<amount> |
| **Net Payout**         | total amount in bank account  |               **₹<amount>** |             **₹<amount>** | **₹<amount>** |
| **Payout %**           | % of sales in bank account    |                 **<rate>%** |               **<rate>%** |   **<rate>%** |
| Burn %                 | % of burn                     |                     <rate>% |                   <rate>% |       <rate>% |

Notes: Zomato notes as in 9.1; Swiggy notes as in 9.2; outlet matched by name + locality.

Short chat message (sent with the table image):

```
*<Restaurant Name> (<Locality>, <City>) – Weekly Payouts <ZOMATO_PERIOD>*
Zomato <ZOMATO_PERIOD> · Swiggy <SWIGGY_PERIOD>

| Term | Zomato | Swiggy | Total |
|---|---:|---:|---:|
| Orders | <orders> | <orders> | <orders> |
| ST+PC | ₹<amount> | ₹<amount> | ₹<amount> |
| Effective Discount % | <rate>% | <rate>% | <rate>% |
| Ads % | <rate>% | <rate>% | <rate>% |
| Net Payout | ₹<amount> | ₹<amount> | ₹<amount> |
| Payout % | <rate>% | <rate>% | <rate>% |
| Burn % | <rate>% | <rate>% | <rate>% |

_Swiggy paid ₹<amount> = Net − GST @<rate>% on fees ₹<amount> − TDS ₹<amount> (₹<amount> rounding). Zomato payout <PAID_DATE>:
₹<amount> = Net − TDS ₹<amount> + Ads credit ₹<amount> (− ₹<amount> GST paise)._
```

Overall summary after all outlets:

```
*Payout reconciliation – Zomato <DD Mon> – <DD Mon YYYY> · Swiggy <DD>–<DD Mon YYYY>*
<N> outlets: <a> on both apps, <b> Zomato only, <c> Swiggy only.
| | Zomato | Swiggy | Combined |
| Net Payout | ₹… | ₹… | ₹… |
| ST+PC | ₹… | ₹… | ₹… |
| Payout % | …% | …% | …% |
Bank check: <x> outlets match the paid amount (±₹<amount>), <y> differences (listed), <z> not paid yet.
Commission check: <p> outlets OK, <q> with flagged orders, <r> "assumed rate X% (onboarding rate not yet provided)".
Flagged for you: <unknown deductions / unapproved ads / uncertain outlet matches>.
Workbook attached – Summary sheet first, then one sheet per outlet.
```
Excel: sheet `Summary` (Outlet | Locality | Zomato ID | Swiggy RID | Zomato Net Payout | Zomato Payout % | Zomato Burn % |
Swiggy Net Payout | Swiggy Payout % | Swiggy Burn % | Total Net Payout | Total Payout % | Total Burn % | Bank check |
Commission check), then one sheet per outlet with the 9.3 table and its notes.

## 10. Approval points (need the owner's explicit yes first)

- **Any message to a platform, account manager, support or anyone other than the owner** – dispute emails, tickets,
  chats, help forms. Show the full draft (to, subject, body, attachments) first.
- **Raising or escalating a dispute**, or accepting / rejecting a platform's resolution.
- **Any change on a dashboard** (settings, menu, prices, offers, ads campaigns or budgets, outlet status, bank or tax
  details, programme opt-ins). Default: never – dashboards are read-only.
- Treating an **uncertain outlet match** as final; treating an **unknown deduction** as ads or not ads.
- Treating an assumed rate as contractually agreed, or changing the configured actual onboarding rate without owner confirmation.
- Adding a row, changing a row's source, or moving a bridge item into a row.
- Sending corrections that replace an earlier report (say "this replaces the earlier message").
- Sharing reports with anyone else (accountant, staff) or uploading them outside the owner's chat.

Never needs approval: downloading reports, reading screens, calculating, building the workbook, and sending the report
to the owner in the chat where they asked for it.

OWNER-FACING PRESENTATION RULE: Chat, image and owner Markdown notes must be short and plain: one bank-check line per app (paid amount/date/UTR last4, matches or mismatch, actual rounding gap); one commission line with assumed rate X% (onboarding rate not yet provided) and per-app flag counts; one ads-labels line. Keep "match uncertain – please confirm" unless the owner confirms the mapping. Full technical bridges, source inconsistencies and flagged-order detail belong ONLY in the Excel outlet sheet, never chat/image. Any ≥₹1 unexplained gap must still be shown plainly as a mismatch.

# Installed platform guides

These guides are part of this skill. The installed commands above are the ones to run.

# Default output: ONE consolidated payout report

Every payout/reconciliation request defaults to one consolidated report across all connected platforms (Zomato + Swiggy, with future platforms added through adapters). Never send separate per-app reports unless explicitly requested or the outlet operates on only one platform. Even “did Zomato pay me” gets the consolidated report, highlighting the Zomato line. Part A/B are INTERNAL collection/calculation steps; Part C is owner output.

No hardcoded outlet, week, paid amount or commission contract. Read the restaurant's private configuration at runtime; none is shipped here.

## Safety and retained sessions

- View/download only. Never change menus, prices, ads, offers, bank/account settings or outlet status; never accept programmes, raise disputes/tickets or type into platform chat/help/AI panels.
- NEVER email/send-to-mail/send-report/envelope actions, even icons resembling downloads. If a direct-file control cannot be distinguished safely, stop.
- Retain the browser profile; if either platform needs login/OTP, stop and report. No OTP requests/resends during reconciliation. No cookies, tokens, private APIs, CDP or shell-driven browsing. The separately documented OTP method is only for an explicitly authorized onboarding/sign-in task.
- No passwords, OTPs, contacts, customer fields, bank-account numbers or full payment references in output. Only the last four UTR characters may appear.
- Use an enforced per-task budget and stop reserve. Never start another run automatically.

## Adaptive workflow

1. Read configured outlet scope and `owner-confirmed-outlet-map.csv`. Verify selected name/ID BEFORE reading payout figures on each app; a preselected different outlet is not authority. Fail closed on a wrong outlet, conflicting IDs or ambiguous selection.
2. On Zomato Finance/Payouts, find the latest FULLY PAID service period within the requested reporting window, skipping processing/unpaid periods. On Swiggy Finance/Past Payouts (`https://partner.swiggy.com/food/finance`), take fully paid cycle(s) ending inside that same reporting window. Discover dates from live evidence, not example dates or stale downloads. State both service periods.
3. Directly download fresh correct-outlet settlement/annexure files. Read same-period status, amount paid, paid date and UTR last four from the live payout screen; do not call estimates paid. Keep source files private.
4. Save minimal screen JSON per per-app guide and call the installed deterministic calculators once for each fresh source. Compare source outlet/period and current logical job; do not reuse an older screen JSON or cached report from another task.
5. Call `payout-combined` with the actual freshly generated per-app JSON files, screen JSON files and owner-confirmed map. Sum Orders/money; recompute percentages from summed sales (never average percentages). Configurable onboarding rate overrides modal-rate assumption. Unknown contracts: “assumed rate X% (onboarding rate not yet provided)”, with differing-rate order counts.
6. Give the owner Part C 9.3 short chat message (title, both periods, seven-row Term/Zomato/Swiggy/Total table, italic paid lines), the full eleven-row combined PNG, and ONE workbook with Summary then outlet sheet(s). Bold Net Payout and Payout %. Missing app: em dash; no fabricated zero report.

## Plain owner notes; technical Excel only

One short bank-check line per app: “<Platform> paid <amount> on <date> (UTR …<last4>) – matches, <amount> rounding”. One commission-flags line and one ads-labels line. Do not show bridge equations, source residual jargon or every order flag in chat/image. Full bridge, source inconsistencies, source labels and individual flags belong ONLY in the Excel outlet sheet. Never hide a real mismatch.

Absolute bank gap <₹1 is accepted with “rounding difference ₹X” or a plain “₹X rounding” paid line. Exactly ₹1 and larger fail. Zero is an exact match. Never invent an adjustment to hit the paid amount. No bank statement checked means no claim that funds were independently received.

Owner-confirmed map wins over name/locality inference. Store only owner-confirmed rows, never guesses. When no confirmed mapping exists, same normalized name with unclear locality remains “match uncertain – please confirm”; different cities/localities or multiple candidates are not paired. Never silently label an unknown mapping confirmed.

# Zomato internal reconciliation adapter

The consolidated-default and safety rules in installed-combined-instructions.md always apply. A platform-specific question does not authorize a separate owner report.

Read configured restaurant scope; verify selected outlet name/ID before figures. Navigate by meaning/live DOM to Finance/Payouts. Select the most recent FULLY PAID Mon–Sun week, not merely the most recently completed but unpaid week. Download the correct settlement directly; an Actions/envelope/send-report/send-to-mail control is forbidden. Stop when ambiguous or logged out; no OTP request.

Save `payout-screen.json` with only period [ISO start,end], status paid, paid_amount decimal string, paid_date ISO and utr_last4 exactly four characters. Never record full UTR/customer fields. Read these from the same-period payout screen, not previous files. Match configured source outlet and requested/selected period.

Run `payout-owner-reconcile <fresh-workbook> --config <private-runtime-settings> --screen <fresh-screen-json>`. Payout Breakup primary; blank formula summary permits Order Level + Addition Deductions Details fallback. Exactly eleven rows, with ads allocated once by invoice period; include outstanding ads correctly in bridge. Fees include service/long-distance/payment fees and GST on fees. TDS/TCS, GST differences, cancellations/rejections, additions/refunds, outstanding ads and non-ad deductions are bridge-only.

Commission contract is a per-outlet setting. When absent, assume the modal charged service-fee percentage, label the assumption and flag every different charged percentage. Do not claim contractual correctness. Keep actual fee money unchanged.

The calculator's per-app technical JSON/Markdown is INTERNAL input to the combined builder, not another owner attachment. Output only the consolidated short chat + combined PNG + workbook. Short owner notes; full bridge/flags Excel-only. Absolute paid/bridge gap <₹1 accepted with a rounding note; ≥₹1 fails.

# Swiggy internal reconciliation adapter

The consolidated-default and safety rules in installed-combined-instructions.md always apply. No per-app owner attachment unless explicitly requested or single-platform outlet.

Use retained session at https://partner.swiggy.com/food/finance and navigate by current page meaning/live DOM. Before reading figures verify the configured restaurant NAME and RID; never read whatever other outlet happens to be selected. On Past Payouts select fully paid cycle(s) ending in the chosen Zomato week. Skip newer processing/estimated cycles. If login/OTP appears STOP; no OTP request/resend. No email/envelope/send-to-mail/report-to-mail actions or settings changes.

Direct download: the actual annexure/report file, never a mail-generation control. Read the same-cycle paid amount/date/UTR last four and source service period. If UI navigation boundary differs from annexure period, preserve the actual annexure service period and put the discrepancy in Excel technical notes.

Save `swiggy-payout-screen.json`: outlet_id, outlet_name, period ISO pair, status paid, paid_amount string, paid_date ISO, utr_last4 exactly four, job_label copied from current job.json. Verify source freshness/logical job. Run `payout-swiggy-reconcile <fresh-annexure> --settings <private-runtime-settings> --screen <fresh-screen-json>` once.

Payout Breakup TOTAL column is primary. Comm.+PG+GST = B Total fees EXCLUDING GST-on-service-fees; the separate GST moves to the bridge. Ads = all genuine advertising E Other Charges lines plus D Growth Investment In Ads, each once. Non-ad E lines/refunds are bridge-only. Keep source-derived residuals distinct; never plug the paid amount into an unexplained adjustment.

Assume the modal charged commission percentage only when the per-outlet onboarding rate is unknown; label “assumed rate X% (onboarding rate not yet provided)” and flag every different charged-rate order. Contractual overcharge is not established by an assumption.

Pass bank rounding only for absolute gap <₹1; exactly ₹1 and more fail. Retain exact-zero diagnostic separately. Owner paid lines are plain/short; full technical bridge, GST detail and all flags ONLY in combined Excel outlet sheet. Hand generated per-app JSON to payout-combined; owner receives one consolidated message, image and workbook.

# Swiggy split-box OTP entry — onboarding only

Never initiate/request/resend an OTP during reconciliation. If logged out, stop. This method is only for a separate, explicitly authorized owner sign-in task.

Observed widget failure: typing a full string with a browser action bound to box one can stop after its first character because focus auto-advances. Direct empty-value assignments can be undone by React re-renders. Do not assume prior rejected codes were caused by this without evidence.

Secure method for other sites, only when separately authorized (not the Zomato compatibility flow below):

1. After the OTP screen is actually visible, take a fresh structured snapshot and identify the first input of exactly one code group. Do not reuse a pre-OTP ref or target the email/phone field, wrapper, or button. Never read back or screenshot a code.
2. Obtain the code through `request_secret oneTimeCode` for the exact HTTPS sign-in origin. The code stays private and run-scoped; never put it in chat, files, logs, or a native keyboard string.
3. Call `browser_act` once with `fill_code` and that fresh first-input ref. The host captures a value-free structural DOM snapshot before entry: selected ref, frame origin, shadow-root status, input attributes/marker flags and wrapper paths. Retain `code_layout_before_fill` (or the successful Code layout note) as a diagnostic JSON artifact; never save outerHTML, text, names/IDs, field values or a code screenshot. The secure host adapter validates the group and origin, masks all boxes, and fills one character per box. Never call it separately for each box or use ordinary `fill`, `type`, clipboard, shell, or desktop typing for a private code.
4. Check only the non-secret fill outcome. If entry is partial/uncertain or the group is ambiguous, stop for human takeover; never replay the code or request/resend another one. Click Continue once only with explicit authorization after a successful fill; if rejected/expired, stop and respect any lockout/countdown.

Dummy-only diagnostics can test distribution/autofocus; clear all dummy values before completion and never submit them. No real phone number, masked suffix, OTP or session is included here.

# Zomato sign-in — restored pre-sync flow

Only for a separate owner-authorized sign-in, never a routine reconciliation that is already signed in. Use the restaurant email and request one emailed code from the visible login page; no password, Google sign-in, resend or second login. Ask the owner for the code and wait for a normal owner reply. An explicitly authorized coordinator can obtain that reply from the newest sign-in email for this attempt.

This is the historical owner-reply flow: **do not use `request_secret oneTimeCode` or `fill_code` for Zomato**. The code is supplied in the conversation, as before the sync. Take a fresh `browser_snapshot` of the six empty boxes and use **one batch of six ordinary `browser_act` `type` actions**, one character per fresh box ref in order. Do not type the whole code into the first maxlength=2 box. Do not use `fill`, a clipboard, shell, or a replacement private typer. The complete frozen pre-sync native browser handles the login page, including its own typing and checks. Then click the visible Continue control once as a separate action if it has not already signed in, and verify the signed-in page. If rejected, expired, partial or uncertain, stop without replay or resend.

Never repeat the code in narration or output or save it in a file. This rollback restores the old model-visible owner reply; it does not use the newer masked, run-held code-card contract. Retain the signed-in browser profile. The upstream browser remains in use outside the login page, and the payout calculations and read/download-only rules above are unchanged.
