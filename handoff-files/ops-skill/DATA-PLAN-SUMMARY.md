# Data plan: summary to approve

**1. What we fetch**
- **Nightly:** Zomato and Swiggy business reports, re-downloading the last 7 days (Zomato updates recent days).
- **Weekly:** payouts, covering the last 4 payout weeks.
- **Later:** reviews and menu.

**2. Any period (day, week, month, your own dates)**
- Orders and ₹ are added up.
- Percentages and averages (rating, prep time, accuracy, ads return) are recalculated from the raw numbers, never averaged.
- Four numbers only the platform calculates appear only when your period matches the platform's.

**3. Checked against the platforms' own October figures**
- Orders, funnel, discounts and Zomato rating match exactly.
- Sales match, except one Swiggy week was off (flagged).
- Prep time is within 3 seconds.
- Online % is approximate until we store opening hours.
- **The four platform-only numbers:** market share, Zomato offline hours, Swiggy customer counts, menu scores and top items.

**4. Safety**
- Every file's outlet and dates are checked before saving. Swiggy twice sent another restaurant's file today, so wrong files are rejected and re-fetched.
- Mismatches with platform totals are flagged, never overwritten.
- No customer personal data is stored.

**5. Your decisions (my recommendation)**
1. Default view: order date for performance, payment date for Payouts. **Yes**
2. Swiggy Toing and train orders: **show separately**
3. Keep an old value only when it changes. **Yes**
4. Download the report file nightly, not read screens. **Yes**
5. Keep report files 13 months, without GST number or address. **Yes**
6. Outlet joining mid-month: **show it, with a note**
7. Your own dates: **show everything we can calculate; platform-only numbers say "not available"**
8. Add Raghav's 5 questions to his Google Doc. **Yes**
9. Test files: **fake restaurant ids**
10. Platform rating only. **Already decided**

**6. After you approve**
1. Engineer - SaaS builds the metric list and database.
2. Then the nightly fetch, with the download step scripted first: two bot attempts on the report screens cost ₹386 today and failed.
3. Then the weekly ops review, reading only from the database.

Engineer - SaaS will confirm dates; the first milestone is 18 Nov. Today's checks cost ₹0 (files downloaded by hand).
