# Gaps in the weekly ops review skill

These are places where the skill is silent or the two apps do not show the same thing. The calculator records n/a rather than guessing. Live tests have not been run yet, so some of this may also be “we have not seen the latest screen”.

1. **Offline time and FOR accuracy are n/a on Zomato.** The skill already says they are not on the Business reports screen. The card notes that; it does not invent a value.

2. **Swiggy has no star rating, offline time or rejected count** on the business-metrics reports screen the skill points to. Rating flags are therefore Zomato-only. Swiggy cancelled orders are not treated as Zomato rejected orders.

3. **Swiggy’s 48-hour lag banner** is noted, and the numbers on screen are still used. The skill does not say whether to wait two days or skip an unfinished latest week. See THRESHOLDS.md item 5.

4. **Zomato bad-orders breakdown** (Rejected, Delayed, Poor rated, Complaints) is shown on the card, but the skill does not say whether those expand to counts or percentages. The calculator accepts integers as counts. If the live screen shows percentages, the readings JSON should say so rather than forcing a count.

5. **Average order value** is collected because the skill says to read it, but it does not appear on the owner card. It is stored in the JSON only.

6. **Cancelled order loss** (Swiggy) is read and shown next to the cancelled count when present. The skill’s card outline only says “cancelled”.

7. **Many-outlet attachment.** The skill says to attach the full set as a file and summarise 🔴 outlets in chat. The calculator writes `ops-review-cards.md` for that. The exact file name and whether a table image is also wanted are not specified. For one or two outlets the chat message alone is enough.

8. **Week-label mismatch.** Zomato uses weekly labels such as “Week 45 / 2 - 8 Nov”. Swiggy needs a Custom Monday–Sunday range. If a label and the calendar dates disagree, the calculator uses the dates in the readings JSON and notes a week that is not Monday–Sunday, but it cannot resolve a platform typo on its own.

9. **Sales, delayed-orders and food-ready thresholds** that were vague are listed in THRESHOLDS.md and need a yes before we treat them as final.

10. **Live screen layout** may have changed since the skill was written. The installed guide is goal-level for that reason: find the report, set the outlet and the week, read what is there. The first approved live run should record any extra or missing tiles so the guide can be updated.
