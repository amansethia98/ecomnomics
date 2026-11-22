# Ecomnomics hosting pick (step 4)

Prepared 15 Nov 2026, 5:30 PM IST. Prices were fetched today from public pages, at ₹94.26 per US$ (market rate, 13–15 Nov 2026). Everything below is a recommendation only: nothing was signed up for, bought or created.

## The pick, in one line

**Hostinger KVM 4 VPS in the Mumbai data centre (4 vCPU, 16 GB RAM, 200 GB NVMe), on a 24-month term. Use the free domain that comes with it for `getecomnomics.com`.** It costs about **₹1,300 a month including GST** (₹31,124 paid upfront for 2 years). One server runs the website, the database, the jobs, and every restaurant's computer at night.

Why this one:
- **Data in India.** The Mumbai data centre gives an Indian IP address for Zomato and Swiggy logins, which is the same as today: the box already egresses from India.
- **16 GB fits the real workload with room to spare.** The numbers are measured below. Every other India option at 16 GB costs 5–8x more.
- **Indian billing.** Pay in rupees by UPI, card or netbanking, and get a GST invoice. That means no forex fee and no reverse-charge paperwork.
- **Simple.** It's one Linux server running Docker, exactly like the box today, so the same `compose.yml` and `rebuild.sh` move over almost unchanged.
- **It grows in place.** The plan upgrades to KVM 8 (32 GB) from the control panel, and at about 100 restaurants we add a second server.
- **Safety net.** There's a 30-day money-back guarantee and free weekly server backups, on top of our own daily encrypted backup to Google Drive.
- It's well within the ₹3,000–3,500 a month Aman okayed on 11 Nov.

## What we actually need (measured today on the box)

| Item | Measured | Source |
|---|---|---|
| Restaurant computer, idle (desktop, no browser) | 136 MiB RAM | `docker run` of `ecomnomics/main-computer:4306ae5bf`, 2 CPU / 3 GB cap |
| Restaurant computer, Chromium with the Swiggy and Zomato partner login pages open | 399 MiB RAM, peak CPU under 1 core | same probe, throwaway container, removed after |
| Limit we give each computer | 3 GB RAM, 2 CPU | `compose.yml` (`RAKAZO_COMPUTER_MEMORY: 3g`, `CPUS: '2'`) |
| Nightly download time per restaurant (daily reports, both apps) | 145–300 s (about 2.5–5 min) | `fetch-job/logs/summary-*.json` (06:00 run 144.8 s, t2 runs 157–300 s) |
| Payout re-runs (several weeks of statements) | 6–13 min | pay8 390 s, pay9 354 s, pay11b 779 s |
| Database size (Pawan Putra, all data so far) | 93 MB | `du pgdata` |
| One restaurant's saved browser profile (home) | 159 MB | `du data/homes/team-…` |
| One encrypted daily backup (database + profiles + config) | about 50 MB | `/workspace/backups/nightly/*.tar.gpg` |
| Docker images for one version (app 2.8 GB + computer 2.4 GB + supervisor 1.4 GB + postgres 0.7 GB) | about 7.3 GB | `docker images` |

**Not measured live:** the RAM used by the website, API, worker and database. The stack is stopped right now, and I didn't restart it because restarts have been dropping the Swiggy session before tonight's run. From the images it should be about 2–3 GB, but measure it on day 1 on the new server.

**Sizing:**
- Website, database and jobs: about 3 GB.
- Each computer while it runs: up to 3 GB.
- Operating system: about 1 GB.
- Total: 16 GB runs the app plus **2 computers at once** comfortably. 8 GB would only fit one, with no headroom.
- Disk: 2 image versions (about 15 GB), plus about 160 MB of profile per restaurant, plus the database. 200 GB lasts past 100 restaurants.

## How the night scales

| Restaurants | Running at once | Daily download window (05:30 start) | Thursday payouts |
|---|---|---|---|
| 1 | 1 | about 5 min | about 10 min |
| 20 | 2 | about 50 min, done by about 06:20 | about 100 min if all run Thursday. Better to spread them across the week |
| 100 | 4 (second server) | about 2 h, done by about 07:30, before the 08:30 brief | spread across 7 nights (about 15 a night) |

## Monthly cost (₹, including 18% GST)

The Hostinger figures use the 24-month prepaid price. The renewal price applies after 2 years, or if the sale price is gone when we buy.

| | 1 restaurant (now) | 20 restaurants | 100 restaurants |
|---|---|---|---|
| Server(s) | KVM 4: ₹1,297 (renews ₹2,831) | same KVM 4: ₹1,297 (renews ₹2,831) | KVM 4 for the app plus KVM 8 for the computers: ₹1,297 + ₹2,595 = ₹3,892 (renews ₹8,022) |
| Domain (.com) | ₹0 in year 1, then about ₹125/mo (₹1,499/yr) | ₹125 | ₹125 |
| Off-server backups (Google Drive, 14 days kept) | ₹0 (fits free 15 GB) | ₹130 (Google One 100 GB) | ₹210 (Google One 200 GB; about 5 GB a day × 14) |
| **Total per month** | **about ₹1,300** (₹2,950 after renewal) | **about ₹1,550** (₹3,090) | **about ₹4,230** (₹8,360) |
| **Per restaurant** | ₹1,300 | **about ₹78** (₹155) | **about ₹42** (₹84) |

What this does not include: AI model spend through OpenRouter, such as the analyst at about ₹4.5 a question and its ₹500 cap. It also excludes one-off re-logins when we move servers, about ₹21.50 per Swiggy password login.

## Options compared (prices fetched 15 Nov 2026)

The comparison is for a 16 GB server, which is what we need for 1–20 restaurants.

| Option | Plan for 1–20 | Monthly, incl. GST | 100 restaurants (app + computers) | India data | Billing | Notes |
|---|---|---|---|---|---|---|
| **Hostinger, Mumbai (pick)** | KVM 4: 4 vCPU / 16 GB / 200 GB NVMe | **₹1,297** (24-mo prepaid ₹31,124); renews ₹2,831 | KVM 4 + KVM 8 (8 vCPU / 32 GB / 400 GB): about ₹3,892 | Yes (Mumbai) | INR, UPI, GST invoice | Weekly backups free, 30-day refund, upfront term, renewal about 2x |
| E2E Networks (Indian company), Delhi/Mumbai | C3.16GB: 8 vCPU / 16 GB / 150 GB, $70.13 ≈ ₹6,610 + GST | about ₹7,800 | C3.8GB + C3.32GB: about ₹19,700 | Yes | INR, hourly, no lock-in | Strongest "Indian cloud" choice. The 8 GB plan (₹3,960) is too tight for us |
| DigitalOcean, Bangalore | Basic 8 vCPU / 16 GB / 320 GB, $96 ≈ ₹9,050 + GST | about ₹10,680 | 16 GB + 32 GB General Purpose ($96 + $252): about ₹38,700 | Yes (BLR1) | USD card, forex fee | Easiest dashboard. Managed Postgres available. Pricey for us |
| AWS Lightsail, Mumbai | 4 vCPU / 16 GB / 320 GB, $84 ≈ ₹7,920 + GST | about ₹9,340 | 16 GB + 32 GB bundles: about ₹27,600 | Yes | USD card | Mumbai bundles get half the data allowance (fine for us) |
| Hetzner | CX/AX servers are very cheap | — | — | **No India region** (Germany/Finland/US/Singapore) | EUR | Out: data and logins would leave India |
| Railway / Render | — | — | — | **No India region** (nearest Singapore) | USD | Out. They also can't run our Docker-in-Docker restaurant computers |
| Contabo | Cloud VPS from €4.40 | — | — | India location not checked this turn | EUR | Not considered further: euro billing, weaker support reputation |

Sources: hostinger.com/in/vps-hosting (₹599 / ₹779 / ₹1,099 / ₹2,199 a month on 24 months, renews ₹999 / ₹1,199 / ₹2,399 / ₹4,399; Mumbai data centre since 2023; prices exclude 18% GST). e2enetworks.com/pricing (C3 $35.64 / $70.13 / $141.42 a month). digitalocean.com/pricing/droplets ($96 for 8 vCPU / 16 GB, BLR region). aws.amazon.com/lightsail/pricing ($84 for 16 GB / 4 vCPU; Mumbai has half the transfer). docs.railway.com/deployments/regions and render.com/docs/regions (no India region). Google One India: ₹130 for 100 GB, ₹210 for 200 GB.

## Domain

Checked today against the public registries (RDAP):

| Name | Status |
|---|---|
| ecomnomics.com | **Taken** (registered 1998, expires 26 Dec 2026, not ours) |
| ecomnomics.in | **Taken** |
| **getecomnomics.com** | Looks available |
| ecomnomics.app | Looks available |
| ecomnomics.co.in | Looks available |
| ecomnomics.ai, tryecomnomics.com, ecomnomicsapp.com, getecomnomics.in | Look available |

**Pick: `getecomnomics.com`.** A .com is trusted by owners, and the "get" prefix is a common SaaS pattern. Use `app.getecomnomics.com` for the owner app.

Price:
- Free for year 1 with the Hostinger VPS. Hostinger says VPS plans include a free domain for 1 year; which extensions qualify shows at checkout.
- After that, ₹1,499 a year at Hostinger. Cloudflare Registrar is cheaper at cost, $10.46 ≈ ₹990 a year, but bills in USD.

Optional extra: `ecomnomics.co.in` as a redirect for Indian trust, about ₹700 a year.

## Setup steps (about 5–6 working days after Aman's yes)

1. Aman buys Hostinger KVM 4 (Mumbai, Ubuntu, 24 months) and claims `getecomnomics.com`. Aman does this himself. It's his payment, and I don't create the account.
2. Lock the server down: SSH keys only, firewall open only on 80/443, automatic security updates, and Docker installed.
3. Copy over `compose.yml` and `rebuild.sh`, add HTTPS for the domain (a Caddy/nginx reverse proxy with free Let's Encrypt certificates), and change `BETTER_AUTH_URL`/`WEB_ORIGIN` to the real domain.
4. Restore the latest encrypted backup (`backup.sh` archive: database, browser profiles and `stack-secrets.json`), then **test the restore end to end**.
5. Measure the app's RAM there and set computers to run **2 at a time**.
6. Move the 05:30 IST nightly run, the 08:30 brief and the 7 AM backup to server cron/worker jobs, and upload the backup to Google Drive daily (14 kept).
7. Log in once per platform from the new server. Expect Swiggy to need a password login (about ₹21.50), and Zomato might ask for an OTP from the owner.
8. Run 3 nights in parallel with the box, compare the stored numbers, then switch over.

## Risks

- **Logins on a new IP.** Moving to a new server and IP may sign Swiggy and Zomato out once. Swiggy already drops its session after restarts (T3 finding). Budget one re-login per platform, and keep the Swiggy restart fix on the list.
- **Datacenter IP.** It's Indian, but a datacenter IP rather than a home connection. The box today is the same kind of IP and logins work. If either platform starts blocking, the fallback is an Indian residential proxy (not needed now).
- **Upfront term and renewal jump.** ₹31,124 is paid upfront for 2 years, and renewal is about 2x. It's still far cheaper than the alternatives. If Aman prefers no lock-in, E2E Networks C3.16GB (about ₹7,800 a month, hourly) is the fallback.
- **One server is a single point of failure.** It's fine for 1–20 restaurants. Daily encrypted backups are off-server plus Hostinger's weekly snapshot, so a restore onto a new server takes about 1–2 hours. At about 100 restaurants we split it into 2 servers.
- **App RAM is not yet measured live.** If it turns out higher, upgrade to KVM 8 in place (about ₹2,595 a month).
- **Restaurant isolation.** Each restaurant keeps its own sandboxed computer and its own saved browser profile, but they share one physical server. On 2 Nov Aman wanted one dedicated computer per restaurant. The sandbox meets the "own computer" need. A separate VM per restaurant would cost 10–20x more.
