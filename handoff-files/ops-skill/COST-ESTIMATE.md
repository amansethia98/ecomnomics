# Cost estimate for later live tests — not a request to spend

These figures are in rupees, using the same ₹85 per US dollar conversion as the payout-reconciliation tests. They are not an INR card charge. The first paragraph below is the pre-test estimate. Actual setup and live runs 1–2, and the post-fix estimate, are in the last section.

## What the reconciliation tests actually cost

| Kind of run | What it did | Actual average / result |
|---|---|---|
| Zomato live run (mean of 5) | One app, one week, including a settlement download | **₹17.45** (about 1 min 27 sec) |
| Swiggy live run (mean of 5) | One app, one week, including an annexure download | **₹20.77** (about 1 min 48 sec) |
| Combined end-to-end | Both apps, one week each, plus the owner message | **₹48.77** (about 3 min 5 sec) |
| Zomato earlier blocked/setup attempt | Before the five paid-week tests | ₹22.83 |
| Swiggy setup + verification | Dry run ₹29.24 + verification ₹11.49 | **₹40.73** |

The gap between ₹17.45 + ₹20.77 = ₹38.22 and the combined end-to-end ₹48.77 is about **₹10.55** of extra combined-run work (both apps in one go, plus the final message).

## How a weekly ops review run compares

Each live ops-review run, and the end-to-end run, has to open **both** Zomato and Swiggy and read **two weeks** on each (last week and the week before). Swiggy also needs a Custom date range twice, not a one-click “Last Week” preset. There is usually no large settlement download, which may save a little versus reconciliation.

Using the real recon costs as the base:

- Zomato slice, two weeks instead of one: about ₹17.45 × 1.5 ≈ **₹26**
- Swiggy slice, two custom weeks: about ₹20.77 × 1.5 ≈ **₹31**
- Combined-message overhead, as seen on the recon end-to-end: about **₹11**

**Expected cost per live run, or per end-to-end run: about ₹64 to ₹75.**

A hopeful case (closer to the one-week combined run, because there is no big file to download) is about **₹49**. A cautious case (extra retries on Swiggy’s custom dates, or a lag-banner re-read) is about **₹80 to ₹90**.

Setup the first time (install the guide, confirm the report pages and the outlet, no owner card yet) should be budgeted like the Swiggy recon setup, about **₹30 to ₹45**.

## 5 live runs + 1 end-to-end run

All six of those runs do the same kind of work (both apps, both weeks). The end-to-end run is the one where the bot is asked only “give me the weekly ops review”.

| Item | Hopeful | Expected | Cautious |
|---|---:|---:|---:|
| Setup / dry run (once) | ₹30 | ₹40 | ₹45 |
| 5 live runs | ₹245 | ₹340 | ₹450 |
| 1 end-to-end run | ₹49 | ₹68 | ₹90 |
| **Total** | **₹324** | **₹448** | **₹585** |

Original recommended starting point was a suite cap around ₹500 and a per-run cap around ₹90. After the first live runs, Aman kept the caps but raised them to **₹200 per run** and **₹1,000 for the suite**, including spend already incurred. Still stop if a run needs a login until he has approved the OTP, and ping after each run.

These estimates can move if a login is needed, if Swiggy’s custom date filter takes more back-and-forth than the payout screens did, or if the first run has to hunt for the report pages.


## What the first live tests actually cost, and the post-fix estimate

| Kind of run | Result | Actual |
|---|---|---|
| Setup / dry run (`ops-setup`) | Incomplete (cheap cap); sessions stayed logged in | ₹47.20 in 229.7 s |
| Live run 1 (`ops-live-01`) | Failed mid-Swiggy on provider capacity | ₹57.48 in 432.5 s |
| Live run 2 (`ops-live-02`) | Failed, hit the old ₹90 cap unfinished | ₹91.92 in 350.1 s |
| Suite so far | Counts toward the raised ₹1,000 cap | **₹196.60** (₹803.40 remaining) |

Those two live runs used a `computer_act` click-and-screenshot loop (12 and 26 calls) and never wrote a checkpoint, so figures were lost when the run died. See `e2e/DIAGNOSIS.md`.

After the collect-helper and guide fixes (Business reports DOM-first, one snapshot per week, Swiggy outlet + Custom dates in few labelled actions, checkpoint after each platform-week):

- A clean run should look more like recon e2e plus two extra week switches: about **₹60–90**.
- If Swiggy’s Custom date filter is sticky: about **₹100–130**.
- The **₹200** per-run cap is headroom, not the expected spend. The unfixed workflow was not realistic at ₹90 (run 2 hit it unfinished).
