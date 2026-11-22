# Ecomnomics owner dashboard — snapshot 22 Nov 2026

This branch is a snapshot of everything built so far for the restaurant owner dashboard, so you can clone it and work on another version. It is not merged into `main`.

**Branch:** `snapshot/dashboard-2026-11-22`

It includes the stacked dashboard work (GitHub PRs #28–#33, as of this snapshot) plus a small preview fix: after you sign in, `/`, `/sign-in`, `/forgot-password`, and `/app` send you to `/restaurants` (the owner dashboard), not the old chat screen. Sign-in text and the home-screen title already say Ecomnomics.

The Apache-2.0 `LICENSE` and `NOTICE` files must stay as they are. This snapshot has **no real restaurant data**, passwords, or live database. You will need your own Postgres and your own login.

## What is in it

Owner screens under `/restaurants/:restaurantId?/:screen?`:

- **Home** — what needs the owner today
- **Dashboard** — 7-day, 4-week, and 12-week views
- **Payments** — payout weeks and breakdown
- **Menu** — coming-soon facts already stored
- **Chief of staff** — in-app chat and daily brief
- **Marketing** — actions log
- **Documents** — licence and file list
- **Settings**
- **Ratings** — coming-soon facts already stored

There is also a read-only **platform admin** screen at `/platform-admin`.

## How to run it locally

You need Node.js 24.15.0+ (24.x) or Node.js 26+, pnpm 12, and Docker. Node.js 25 is not supported. Commands are the same as in the repo `README.md`:

```bash
git clone -b snapshot/dashboard-2026-11-22 https://github.com/amansethia98/ecomnomics.git
cd ecomnomics
cp .env.example .env
```

Set your own `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` (for example from `openssl rand -hex 16`), put them in `DATABASE_MIGRATION_URL` and `DATABASE_URL`, and set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to long random values. Do not copy anyone else's `.env`.

```bash
pnpm install
pnpm sandbox:build
pnpm dev
```

`pnpm dev` uses the Postgres in `DATABASE_URL` when that database accepts a connection. Otherwise it starts a local Postgres container with Docker, applies migrations, and prints the URL (default http://127.0.0.1:5173). Create your own account. This checkout does not include live restaurant reports.

Useful checks: `pnpm --filter @rakazo/web build`, `pnpm check`, `pnpm test`.

## Known issues

These were found on the preview with real walkthroughs and should be fixed in a follow-up, not treated as finished work:

- Charts look poor and are not interactive. Hover and click on a chart do nothing.
- The 7D, 4W, and 12W range chips work, and so do the Both / Zomato / Swiggy platform chips.
- The Custom chip only changes the URL (`from` / `to`) and does not open a picker. The view stays on the previous range.
- When a custom range is loaded from the URL, the To box shows one day earlier than the URL `to=` value (the exclusive end is shown off by one). A custom 14-day range is labelled "last 2 weeks" but the chart only has 2 points.
- Tile sparklines, "When you sell", and "How customers find you" do not change when the range changes.
- On a 390px phone, Dashboard and Chief of staff are wider than the screen, so bottom tab items (Payments, More) can be unreachable.
- Text is clipped on Chief of staff, and some text overlaps on Ratings.
- The More pop-up stays open after you pick something.
- Dashboard can show "Loading" for 3–8 seconds.
- The Payments week dropdown mixes Zomato and Swiggy weeks (they alternate), and the header can mix two weeks. The week picker is missing 15–21 Nov.
- Zomato payout weeks show dashes in the breakdown, except Ads and Expected.
- On Home, the "Sat 21 Nov" chip looks like a control but does nothing.

## Recommended next steps

**Charts.** Today the owner dashboard charts are Observable Plot, drawn as static SVG through `PlotFigure`. There are no tooltips, hover states, or tap targets, which is why they look like rough sketches.

Recommended replacement: **shadcn charts on Recharts v3.11+** (MIT licence). Copy `ChartContainer` and `ChartTooltip` into `packages/ui-web`. Use a tooltip that opens on click on a phone, and a `Brush` on the 12-week chart so you can scrub the range. For the heatmap, use a CSS or SVG grid rather than a heavy chart library.

Visual reference only (do not adopt a new app shell): https://ui.shadcn.com/charts and https://shadcn-admin.netlify.app/

Do not use Highcharts or ApexCharts (commercial licensing). If Recharts is a poor fit, the backup is Apache ECharts.

**Date picker.** The Custom range today uses a native `input type="date"`, and the 7D / 4W / 12W range chips only show on Dashboard.

Replace it with a **shadcn Calendar** (`react-day-picker`, MIT) in a popover, with 7D / 4W / 12W presets. Wire the picker through the existing `customRange` / `rangeThrough` / `ownerRangeBounds` helpers, and audit `parseOwnerView`: it should not silently fall back to 12W, and the `to` date should stay exclusive so the selected days match what the cards show.
