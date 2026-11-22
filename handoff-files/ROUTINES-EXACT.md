> **Note (Aman, 22 Nov 23:58 IST, confirmed 23:59 IST).** The 05:30 nightly downloads, the 07:00 backup, and the 08:00 retry are a temporary bridge. They run as Grok routines on the box only because hosting (step 4) is not done yet and the fetch-job code is not in the repo yet. At step 4: move fetch-job into the repo by PR (with Aman's yes), schedule 05:30 / 07:00 / 08:00 IST exactly on the hosted server via the Ecomnomics app's own agent, verify a live run, then switch off these three Grok routines. Aman confirmed at 23:59 IST: keep the three jobs as Grok routines until the Hostinger server is ready, and only then move them to the app's agent. Make no change before that. The 11 PM summary stays with the Grok bot. The prompt bodies below are unchanged.

# Appendix R: exact saved routine prompts (copied verbatim from the old account, 22 Nov 2026)

Recreate each as a routine on the new account with the same schedule and timing. Box paths refer to the old box; adjust them once the stack is restored on the new computer.

## R1. Ecomnomics nightly report downloads, daily 05:30 IST, timing EXACT (CRON_TZ=Asia/Calcutta 30 5 * * *)
Run the Ecomnomics nightly report download job for every restaurant on the local stack. Aman approved nightly runs on 14 Nov 2026. The design is /workspace/ops-skill/FETCH-JOB-DESIGN.md, and the runner is /workspace/live-agentv1/fetch-job/ (run_night.py, recipes.py, auto_login.py, blankday.py, learned/, logs/). Follow how the 14 Nov runs t8/t9 were done and fetch-job/README.md, which includes the 15 Nov notes on auto re-login and the 16 Nov AI fallback (AI-FALLBACK-EDGE-CASES.md); logs and summaries are in logs/.

1. Check that the disk has enough free space and inodes. If the inodes are above about 90%, prune unused Docker build cache and dangling images first, but never the current main images or the old 246c11b rakazo-benchmark stack.
2. Start the stack with `WITH_MODEL=1 /workspace/live-agentv1/rebuild.sh` at the current ecomnomics main commit, so the automatic re-login and AI fallback can run if needed. Use the existing data and never create an empty database. Make sure SWIGGY_USERNAME, SWIGGY_PASSWORD and OPENROUTER_API_KEY are available to the job (never print them).
3. Run the scripted runner over the full fetch-plan for each restaurant, one at a time, before 07:30 IST (auto re-login only works in the 05:30 to 07:30 window). Respect held: true and 423 fetch_held: skip that platform and don't retry. Aman's rule (16 Nov): a bot never just stops when a page step fails. The runner retries the scripted steps up to 3 times, then tries saved learned steps, then hands that page to the AI (x-ai/grok-4.7 only, never Gemini; at most 15 AI actions, ₹60 per report, ₹150 per night). Outlet and date checks and Generate/Download stay in code. Anything still failing goes to the retry queue for the 08:00 retry.
4. If a saved login has expired, run_night.py's auto re-login makes one capped attempt per platform (x-ai/grok-4.7 only, never Gemini, about ₹60 per login, and the whole night including AI fallback stays within ₹150). Zomato's code comes from Aman's Gmail (amansethia07). Swiggy uses "Login with Password" only; never request or resend a Swiggy OTP. If the login needs Aman or fails, stop that platform and tell him.
5. Stop the stack afterwards with rebuild.sh --stop, and leave dockerd running.
6. Write a short run summary to the logs folder. Include rows stored, duplicates skipped, failures by type, anything in alerts_deferred (listed as "retrying at 8 AM", not as an alert), whether the AI fallback ran and what it fixed or learned (ai_cost_inr), blank days found and re-queued, whether the saved logins were reused or a re-login ran (with login_cost_inr), and the total cost in ₹.
7. Data fill-in timing log (Aman asked on 16 Nov to learn when Zomato and Swiggy really finalise each day's numbers). For each platform, outlet and business date in tonight's downloads, compare the downloaded daily figures (orders, sales, rating, online %, etc.) with what earlier nights downloaded for that same date, using the saved raw files and run logs. Append one row per platform, outlet and date to /workspace/live-agentv1/fetch-job/logs/FILL-IN-TIMING.csv with these columns: platform, outlet, business_date, fetch_date, days_after (fetch_date minus business_date), state (blank/partial/changed/unchanged), metrics_changed, and swiggy_48h_banner (yes/no if known). A date counts as settled once two nights in a row show no change. Keep a short rolling summary at the top of logs/FILL-IN-TIMING.md, showing for each platform the typical days until a day first has data and until it settles. Include it in the run summary. No model cost; derive it from files only.

Never print or log OTPs, passwords, phone numbers or report contents beyond the numeric figures needed for the timing log. Never change the ecomnomics repo, merge anything, or spend beyond the caps.

Who gets the result: Aman, in the 1:1 chat. Message him only when something needs him: a login he must help with, a held outlet, a re-login that ran (with its cost), the AI fallback learning a new fix (one line: what broke, that it was fixed, cost), or a disk or stack problem. Items that are retrying at 8 AM are not alerts; the 08:00 retry routine reports them if they still fail. Send any message after 8:00 AM IST, as one short plain-words message tied to step 1. If everything ran cleanly, send nothing; the 11 PM summary covers it, including the fill-in timing findings.

## R2. Ecomnomics 8 AM report retry, daily 08:00 IST, timing EXACT (CRON_TZ=Asia/Calcutta 0 8 * * *)
Retry any Ecomnomics report downloads that failed in this morning's 05:30 run (Aman's rule, 16 Nov: bots retry and use AI before alerting). Runner: /workspace/live-agentv1/fetch-job/ (see README.md and AI-FALLBACK-EDGE-CASES.md).

For each restaurant file in fetch-job/restaurants/, check fetch-job/logs/retry-queue/<today>-<restaurant>.json. If no restaurant has an entry with "status": "pending", do nothing and stay silent: don't start the stack and don't message anyone.

If there are pending entries: check disk space, start the stack with `WITH_MODEL=1 /workspace/live-agentv1/rebuild.sh` (existing data, never an empty database; keep SWIGGY_USERNAME, SWIGGY_PASSWORD and OPENROUTER_API_KEY available, never printed), then run `python3 run_night.py --restaurant restaurants/<restaurant>.json --retry-queue --tag retry0800` for each restaurant with pending entries, one at a time. The runner does scripted steps, then learned steps, then the AI fallback (x-ai/grok-4.7 only, never Gemini; ₹60 per report, ₹150 per night including the 05:30 run's spend). Outlet and date checks stay in code. Never request or resend a Swiggy OTP. Afterwards stop the stack with `rebuild.sh --stop` and leave dockerd running. Append a short note to that day's run summary in logs/.

Never print OTPs, passwords, phone numbers or report contents. Never change the ecomnomics repo or merge anything.

Who gets the result: Aman, in the 1:1 chat. Message him only if something in the summary's alerts list still failed after this retry, or the AI fixed something new (with cost), as one short plain-words message tied to step 1. If everything succeeded on retry with no AI cost, or nothing was pending, send nothing; the 11 PM summary covers it.

## R3. Ecomnomics nightly backup, daily ~07:00 IST, flexible ±15 min (CRON_TZ=Asia/Calcutta 0 7 * * *)
Back up the Ecomnomics test stack on the box and copy it to Aman's Google Drive.

1. Run /workspace/live-agentv1/backup.sh. It encrypts the archive with the owner password from the ECOMNOMICS_BACKUP_PASS environment variable; never print that value. If the box was reset and Docker or the stack is missing, run /workspace/live-agentv1/rebuild.sh first. It refuses to create an empty database, so if it refuses, stop and report instead of forcing it.
2. Upload the newest archive in /workspace/backups/nightly/ to Aman's Google Drive folder "Ecomnomics backups" (folder id 1ZfuKiLNVitrByCJJBNYMByY9DET8gqQi).
3. In that Drive folder, move to trash any ecomnomics-*.tar.gpg backups older than 14 days. Never touch other files.
4. Don't start any Zomato or Swiggy logins, and don't spend on models.

Who hears about it: Aman in the 1:1 chat, and only when something failed, in one short plain-words line saying what failed. When the backup and upload succeed, send nothing.

## R4. Ecomnomics end-of-day summary, daily 23:00 IST, flexible 0 early / 15 late (CRON_TZ=Asia/Calcutta 0 23 * * *)
Send Aman the end-of-day Ecomnomics summary, covering both halves of the build. The web app is Engineer - SaaS's part, who sends their day's progress before 11 PM IST. The AI Chief of Staff and bots are my part. Aman only talks to me; Engineer - SaaS reports to me, not to him.

Gather:
- Engineer - SaaS's progress update from today. If none arrived, read their recent transcript for today's work.
- My own day: bot tests and their cost per run, skills, PRs I own, the metric dictionary, and the OpenRouter balance if known.
- The state of PRs and CI in github.com/amansethia98/ecomnomics.
- Which of Raghav's questions have been answered in the Google Doc "Ecomnomics: questions for Raghav" (id 1HmRqEp7m27_z84k-LmLYfI5i7rRAGKfi9IkYZrdmV8w).

Write it in plain, non-technical words with four short sections: what's done today, what's in progress (with status against the milestones to 31 Jan 2027), blockers and dependencies (what's waiting on whom, including Aman or Raghav), and next steps for tomorrow. Put anything that needs Aman's yes clearly at the top. Give costs in rupees. Keep it short and skimmable; Aman gets overwhelmed by too many messages.

Send it to Aman as one message in the 1:1 chat. Don't post it in any group chat. If neither side did anything today, send one line saying it was a quiet day and what's next. Stop after 31 Jan 2027, and delete this routine if it runs after that date.

## R5. (paused, one-off, done) Ecomnomics payout re-check after PR #21, 15 Nov 06:45 IST. Do not recreate.
