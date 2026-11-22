# Flag rules — choices that need a yes from Aman or his co-founder

The skill already gives some clear rules. A few were vague, so the calculator uses the precise definitions below. Nothing here has been used on a live dashboard yet. Please say if any of these should change before the live tests.

Clear rules, applied as written:

- **Sales down by more than 15%.** A drop of exactly 15% is not a flag. This is measured on **combined Zomato + Swiggy sales** for that outlet, not on each app on its own. If Zomato has a big drop but Swiggy goes up enough that the total stays within 15%, there is no sales flag. (A single-app outlet uses that one app’s sales.)
- **Zomato bad orders above 8% and rising.** Both must be true. “Rising” means this week’s percentage is strictly higher than last week’s. If last week’s figure is missing, this flag is not raised.
- **Kitchen preparation time above 16 minutes and rising.** Same idea, and it is checked **on each app separately**. A problem on only one app still flags. If both apps slip, that is two flags but only one suggested fix, because it is the same kitchen.
- **Online percentage below 90% and falling.** Also checked on each app separately. “Falling” means this week is strictly lower than last week. If last week is missing, this flag is not raised.
- **Rating below 4.0, or falling.** This is Zomato only (Swiggy has no star rating on this screen). Either condition is enough: a rating of 3.9 flags even if it improved from 3.7; a fall from 4.2 to 4.1 flags even though it is still above 4.0. “Falling” means any drop once the rating is rounded to two decimal places (so 4.20 to 4.19 counts). If last week is missing, only a rating below 4.0 can flag.
- **Status.** Three or more flags, or zero orders this week after a week that had orders, is 🔴 Act now. One or two flags is 🟡 Needs attention. None is 🟢 Good. “Zero orders” means the total delivered orders across the apps we actually have figures for, and only when none of those order counts are missing.

Choices that were not spelled out in the skill — please confirm or correct:

1. **Swiggy delayed orders “high and rising”.** Swiggy shows a *count* of orders delayed by more than 10 minutes, not a percentage. The calculator treats this as high when delayed orders are **more than 8% of that week’s delivered orders**, and rising when that *rate* (not the raw count) is higher than last week. The 8% bar matches the Zomato bad-orders line, so a busy week with more orders is not punished just because the count went up. If you would rather use 10%, or a fixed count, say so.

2. **Food-ready accuracy “low”.** This is Swiggy only (Zomato FOR accuracy is not on the screen). The calculator treats accuracy **below 90%** as low. It does *not* also have to be falling — the skill only said “low”. If you want 95%, or “low and falling”, say so.

3. **Sales drop is on the combined total only**, as above. We can also flag a single app that drops more than 15% even when the total does not. That would catch a hidden slide on one platform, but it can also add flags and push a mostly-stable week into yellow or red. Current choice: combined total only.

4. **Kitchen time and online % are flagged per app**, as above. That can produce two flags for the same kind of issue. If you would rather have one shared flag, say so.

5. **Latest Swiggy week may still be moving.** The skill says to note the 48-hour lag banner and still read the numbers. The calculator does that. It does not skip the latest week or wait two days. If you would rather wait until Swiggy has settled, say so.
