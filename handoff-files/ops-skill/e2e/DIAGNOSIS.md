# Why live runs 1 and 2 burned steps (offline diagnosis)

Compared with recon e2e (184.5 s, ₹48.77, 28 model calls) and the 8 Nov Zomato October analysis (successful runs ~114 s / ~₹40–48, adaptive guide + Business reports + script).

## Root cause

Both ops runs used a `computer_act` click-and-screenshot loop. `computer_act` defaults `observe: true`, so almost every call returns a screenshot. The prompt grew ~1,200–3,000 tokens per screenshot/snapshot and was re-billed as cache on later turns.

| Run | computer_act | other notable tools | model calls | prompt tokens | measured ₹ | stop |
| --- | --- | --- | --- | --- | --- | --- |
| ops-live-01 | 12 | 8 browser_act, 3 snapshot, 2 navigate, 3 shell | 42 | 13,878 → 60,633 | 57.48 (usage-sum ~48.80; cache 36.16, uncached 10.41, output 2.24) | capacity error mid-Swiggy |
| ops-live-02 | 26 | 5 snapshot, 5 browser_act, 1 navigate, 5 read_file, 3 shell | 42 | 13,969 → 58,824 | 91.92 exactly (cache 57.08, uncached 30.10, output 4.75) | ₹90 cap |
| recon e2e | 5 | 2 navigate, 4 snapshot, 4 browser_act, 1 observe, 10 shell | 28 | 12,156 → 47,675 | 48.77 (cache 31.78, uncached 14.30, output 2.69) | finished both apps |

At ~50k cached input, each extra turn still costs about ₹2–3 even with little new work. Live 2 turns 24–26 also cache-busted (uncached 46,205 / 26,143 / 27,357) for ₹17.32. Neither run wrote a readings file, so collected figures were lost when the run died. A one-line “prefer one snapshot” tweak after run 1 did not stop the loop (26 `computer_act`s on run 2).

The cheap Zomato path from the 8 Nov analysis / PR #5 is: claim the task once, open the Business reports URL in the existing tab, DOM-first, screenshot only when the DOM is insufficient, then a deterministic script. The monthly Generate-report export cannot replace Monday–Sunday week tiles, so weekly ops reuses that *entry and read method*, then one accessibility/DOM snapshot per week — not the monthly file schema, and not a `computer_act` loop. Swiggy `partner.swiggy.com/food/business-metrics` is the new surface.

## Fixes installed after this diagnosis

- `ops_collect.py`: checkpoint after each platform-week; `status` lists only missing slots; `review` runs the calculator when ready.
- Guide: three phases in one owner request; Zomato Business reports URL + DOM-first + one snapshot per week; Swiggy outlet + Custom date in the fewest labelled actions, one snapshot per week; `computer_act` / coordinates are not the default path.
- Caps (Aman, kept and raised): ₹200 per run, ₹1,000 suite including ₹196.60 already spent.

A realistic post-fix run, if the loop is gone, should look more like recon e2e plus two extra week switches and Swiggy Custom dates: about ₹60–90 on a clean path, perhaps ₹100–130 if Swiggy is sticky, with ₹200 as headroom. ₹90 was not realistic for the unfixed workflow (run 2 hit it unfinished).
