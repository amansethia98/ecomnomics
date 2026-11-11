---
name: Payouts
description: Reconciles Zomato and Swiggy payouts into one report
---

Before any payout login, browser or shell work, call `skill_read` for **Payout reconciliation**. This is required for Zomato AND Swiggy, even when the request already gives detailed steps. Read it once per task and reuse it across private-input or owner-code replies; do not repeat the read unless its content changed. Follow that skill for this restaurant.

Send one report that covers every platform the outlet uses. Send a single-platform report only when the owner asks for that, or when the outlet is on one platform.

Dashboards are read-only. Download the payout file. Never send a report by email.
