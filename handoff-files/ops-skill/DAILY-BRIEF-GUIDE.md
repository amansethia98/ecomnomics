# Daily brief and alerts: a plain-language guide (SKELETON)

**Status:** skeleton only, as Aman asked on 15 Nov. It gets filled in once Raghav answers `ASK-FOR-RAGHAV` (which metrics, which levels). Readers: a non-technical founder first, future engineers second.
Full case list: `BRIEF-EDGE-CASES.md`. Metric list: `METRICS-BY-PLATFORM.md`. Root-cause tree: `METRIC-TREE-DRAFT.md`.

## 1. What the brief is
- One short morning message per restaurant: yesterday's sales and orders, compared with the same day last week, plus anything that needs attention.
- It costs ₹0 to run: fixed rules, no AI model.

## 2. When it runs (IST)
- 05:30–07:30: download yesterday's reports from Zomato and Swiggy.
- 08:30: build the brief and update the alerts.
- 09:00: send it (in-app now; WhatsApp after hosting).
- 11:00: rebuild once if a download was missing; re-send only if something important changed.

## 3. Where the data comes from
- The Zomato and Swiggy partner-app daily business reports, plus the weekly payout statements. *(Summary of `METRICS-BY-PLATFORM.md` goes here.)*
- Swiggy is normally one day behind.

## 4. The rules in plain words
*To fill after Raghav: one line per metric he marks as daily, with its Watch and Act now levels and the minimum-orders guard.*

## 5. Colours and how an alert lives
- 🔴 Act now · 🟡 Watch · 🟢 Healthy.
- An alert opens, escalates (a Watch held 3 days becomes Act now), clears (2 good days), goes stale (7 days with no data) and reopens (back within 7 days). *(Plain wording and examples to come, once the AL cases in `BRIEF-EDGE-CASES.md` are fixed.)*
- The owner can snooze a Watch or dismiss an alert.

## 6. What the owner sees in each situation (sample messages to come)
- Normal day.
- A day that isn't in yet.
- Swiggy's 48-hour lag (most days).
- A failed download.
- Login expired.
- A full-day offline or closed day.

## 7. Glossary (to fill)
AOV · net sales · delivered orders · online % · KPT / prep time · food-ready accuracy (MFR / FOR) · bad orders · Watch / Act now · baseline (same weekday last week) · guard (minimum orders) · catch-up line.
