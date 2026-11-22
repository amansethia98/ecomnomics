#!/usr/bin/env python3
"""Nightly report-download job (orchestrator, no model). See /workspace/ops-skill/FETCH-JOB-DESIGN.md.

  run_night.py --restaurant restaurants/<slug>.json [--date YYYY-MM-DD] [--reasons scheduled,backfill,pending,lag_banner]
               [--platforms zomato,swiggy] [--reports daily,weekly,monthly,payout] [--probe-only]
               [--from YYYY-MM-DD --to YYYY-MM-DD]   # owner-started daily backfill, chunked per app

Generic: everything restaurant-specific comes from the restaurant file and GET /agent/v1/restaurant.
Never logs page text, file contents, codes, passwords or phone numbers (every line goes through scrub()).
"""
import argparse, base64, hashlib, json, os, re, subprocess, sys, time, uuid
from datetime import date, datetime, timezone, timedelta
import requests
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from pb import PB
from ui import Page, UiChanged
import recipes, identity, convert, auto_login, blankday, aifallback, retryq, backfill
from scrub import scrub, scrub_obj

VERSION = 'nightly-fetch/0.1'
API = os.environ.get('ECOM_API', 'http://127.0.0.1:3320')
ORIGIN = 'http://127.0.0.1:5523'
IST = timezone(timedelta(hours=5, minutes=30))
MISMATCH_LIMIT = 3
UI_STOP_STREAK = 3   # stop a platform after 3 windows in a row fail on the UI
UI_BACKOFF_S = 60
PACE_S = 20
IDENTITY_STATUSES = {'rejected_mismatch', 'needs_owner', 'local_mismatch'}
RUN_CTX = {'slug': None, 'retry_mode': False, 'day': None}   # set by main(); tests leave slug None (no retry-list writes)

def defer(res, oid, platform, report, ps_, pe, run_id, reason):
    """A window that still failed after scripted tries, learned steps and the AI: 05:30 -> 08:00 retry list, no alert yet;
    in the 08:00 run (--retry-queue) -> alert now."""
    if RUN_CTX.get('retry_mode'):
        res['alert'] = 'now'; return
    res['alert'] = 'deferred_to_0800'; res['retry'] = '08:00'
    if RUN_CTX.get('slug'):
        retryq.add(RUN_CTX.get('day') or retryq.today(), RUN_CTX['slug'], oid, platform, report, ps_, pe, reason, run_id)

def note_prov(res, prov):
    if not prov: return
    res['via'] = prov.get('mode')
    for k in ('scripted_tries', 'failed_stage', 'learned_version', 'learned_stale', 'ai_calls', 'ai_transcript'):
        if prov.get(k) is not None: res[k] = prov[k]
    if prov.get('ai_cost_inr'): res['ai_cost_inr'] = round(prov['ai_cost_inr'], 2)

class Log:
    def __init__(self, path, run_id, plan_date):
        self.path, self.run_id, self.plan_date = path, run_id, plan_date
        self.ctx = {}
        os.makedirs(os.path.dirname(path), exist_ok=True)
    def step(self, step, **kw):
        rec = {'t': datetime.now(IST).isoformat(timespec='seconds'), 'run': self.run_id, **self.ctx, 'step': step, **kw}
        line = json.dumps(scrub_obj(rec), ensure_ascii=False, default=str)
        with open(self.path, 'a') as f: f.write(line + '\n')
        print(line, flush=True)

class Api:
    def __init__(self, token, cookies):
        self.h = {'Authorization': 'Bearer ' + token}; self.cookies = cookies
    def get(self, path, **params):
        r = requests.get(API + path, headers=self.h, params=params, timeout=30); r.raise_for_status(); return r.json()
    def post(self, path, body, tries=3):
        for i, wait in enumerate([10, 30, 90][:tries]):
            try:
                r = requests.post(API + path, headers=self.h, json=body, timeout=120)
                if r.status_code >= 500: raise requests.HTTPError(f'{r.status_code}')
                return r.status_code, (r.json() if r.content else {})
            except (requests.ConnectionError, requests.Timeout, requests.HTTPError):
                if i == tries - 1: raise
                time.sleep(wait)
    def rpc(self, path, body):
        r = requests.post(API + '/rpc/' + path, headers={'Origin': ORIGIN}, cookies=self.cookies, json={'json': body}, timeout=300)
        r.raise_for_status(); d = r.json(); return d.get('json', d)

def sh(*a, **k): return subprocess.run(list(a), capture_output=True, text=True, **k)

def key_usage():
    k = os.environ.get('OPENROUTER_API_KEY')
    if not k: return None
    try: return requests.get('https://openrouter.ai/api/v1/key', headers={'Authorization': 'Bearer ' + k}, timeout=10).json()['data']['usage']
    except Exception: return None

def find_container(team_home):
    out = sh('sudo', '-n', 'docker', 'ps', '--format', '{{.Names}}').stdout.split()
    name = 'rakazo-bot-' + team_home
    return name if name in out else None

def bot_display(container, bot_id):
    key = hashlib.sha256(bot_id.encode()).hexdigest()[:32]
    r = sh('sudo', '-n', 'docker', 'exec', container, 'sh', '-c', 'for f in /tmp/rakazo/browser-profile-*; do [ -f "$f" ] && echo "${f##*-} $(cat $f)"; done')
    for line in r.stdout.splitlines():
        n, path = line.split(' ', 1)
        if path.endswith('chromium-bot-' + key): return ':' + n
    return None

def install_helper(container):
    src = os.path.join(HERE, 'rakazo-fetch-snap')
    with open(src, 'rb') as f:
        r = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-u', 'root', container, 'sh', '-c',
                            'mkdir -p /opt/rakazo-fetch && cat > /opt/rakazo-fetch/rakazo-fetch-snap && chmod 755 /opt/rakazo-fetch/rakazo-fetch-snap'], stdin=f, capture_output=True)
    return r.returncode == 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--restaurant', required=True); ap.add_argument('--date')
    ap.add_argument('--reasons', default='scheduled,pending,lag_banner,backfill')
    ap.add_argument('--platforms', default='zomato,swiggy'); ap.add_argument('--reports', default='daily,weekly,monthly,payout')
    ap.add_argument('--probe-only', action='store_true'); ap.add_argument('--max-windows', type=int, default=50)
    ap.add_argument('--tag', default='')
    ap.add_argument('--no-login', action='store_true', help='never start the bounded login run on signed_out')
    ap.add_argument('--login-any-time', action='store_true', help='owner-started: allow the login run outside 05:30-07:30 IST')
    ap.add_argument('--retry-queue', action='store_true', help='08:00 run: only the windows on today\'s retry list; alert the ones that fail again')
    ap.add_argument('--from', dest='from_date', help='inclusive start date (YYYY-MM-DD); requires --to; daily backfill chunks')
    ap.add_argument('--to', dest='to_date', help='inclusive end date (YYYY-MM-DD); clamped to yesterday; requires --from')
    a = ap.parse_args()
    if bool(a.from_date) != bool(a.to_date):
        ap.error('--from and --to must be used together')
    if a.retry_queue and a.from_date:
        ap.error('--from/--to cannot be combined with --retry-queue')
    bf_range = None
    if a.from_date:
        try:
            today = date.fromisoformat(a.date) if a.date else datetime.now(IST).date()
            bf_range = backfill.parse_range(a.from_date, a.to_date, today)
        except backfill.BackfillError as e:
            ap.error(str(e))
    cfg = json.load(open(a.restaurant))
    token = open(cfg['token_env']).read().split('=', 1)[1].strip()
    cookies = json.load(open(cfg['session_file']))
    api = Api(token, cookies)
    now = datetime.now(IST)
    run_id = f"nightly-{now:%Y%m%d-%H%M}-{uuid.uuid4().hex[:6]}{('-' + a.tag) if a.tag else ''}"
    log = Log(os.path.join(HERE, 'logs', f'{now:%Y-%m-%d}.jsonl'), run_id, a.date or now.date().isoformat())
    summary = {'runId': run_id, 'started': now.isoformat(timespec='seconds'), 'restaurant': cfg['slug'], 'results': [], 'platforms': {}}
    k0 = key_usage(); t_start = time.time()
    RUN_CTX.update(slug=cfg['slug'], retry_mode=a.retry_queue, day=now.date().isoformat())
    pend = {}
    if a.retry_queue:
        pend = {e['key']: e for e in retryq.pending(RUN_CTX['day'], cfg['slug'])}
        summary['retry_queue'] = {'pending': len(pend)}
        if not pend:
            log.step('retry_queue', result='empty'); summary['status'] = 'retry_queue_empty'; return finish(summary, log, k0, t_start)
        log.step('retry_queue', result='pending', windows=len(pend))
    # ---- preflight ----
    try:
        assert requests.get(API + '/health', timeout=5).ok
        img = sh('sudo', '-n', 'docker', 'inspect', 'ecomnomics-agentv1-api-1', '--format', '{{.Config.Image}}').stdout.strip()
        summary['image'] = img
        log.step('preflight', result='ok', image=img)
    except Exception as e:
        log.step('preflight', result='stack_down'); summary['status'] = 'stack_down'; return finish(summary, log, k0, t_start)
    rest = api.get('/agent/v1/restaurant')
    bot = cfg['fetch_bot_id']
    st = api.rpc('computer/status', {'botId': bot})
    if st.get('busyBotName') or st.get('controlHolder') == 'user' or st.get('takeoverRequested'):
        log.step('computer_status', result='busy_skip'); summary['status'] = 'computer_busy'; return finish(summary, log, k0, t_start)
    api.rpc('computer/boot', {'botId': bot})
    api.rpc('computer/screenUrl', {'botId': bot})       # brings up this bot's own screen and browser profile
    container = None; display = None
    for _ in range(30):
        container = find_container(cfg['team_home'])
        display = container and bot_display(container, bot)
        if display: break
        time.sleep(2)
    if not display:
        log.step('computer_boot', result='stack_down'); summary['status'] = 'computer_not_ready'; return finish(summary, log, k0, t_start)
    if not install_helper(container):
        log.step('install_helper', result='failed'); summary['status'] = 'helper_install_failed'; return finish(summary, log, k0, t_start)
    log.step('computer_boot', result='ok', display=display)
    pb = PB(container, display); page = Page(pb, log=lambda **k: log.step('click:' + str(k.pop('step')), **k))
    folder = f"bots/{bot}/fetch-job/inbox"   # one stable folder per bot, so download holds never compete
    pb.sh(f'mkdir -p /home/rakazo/{folder} && rm -f /home/rakazo/{folder}/*')
    image = summary['image']
    try:
        for outlet in rest['outlets']:
            if not outlet.get('active'): continue
            oid = outlet['outletId']
            plan = api.get('/agent/v1/fetch-plan', outletId=oid, **({'date': a.date} if a.date else {}))
            log.plan_date = plan['date']
            since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec='seconds').replace('+00:00', 'Z')
            recent = api.get('/agent/v1/fetches', outletId=oid, since=since, limit='200')['fetches']
            for pl in plan['platforms']:
                platform = pl['platform']
                if platform not in a.platforms.split(','): continue
                log.ctx = {'outlet': oid, 'platform': platform}
                ps = summary['platforms'].setdefault(f'{oid}:{platform}', {'session': None, 'mismatches_24h': 0})
                mism = sum(1 for f in recent if f['platform'] == platform and (f['status'] in IDENTITY_STATUSES))
                ps['mismatches_24h'] = mism
                if any(f['platform'] == platform and f['status'] == 'needs_owner' for f in recent) or mism >= MISMATCH_LIMIT:
                    log.step('platform_hold', result='needs_owner_hold', mismatches=mism); ps['session'] = 'held'; continue
                if pl.get('held'):   # server-side hold (PR #17): 3 identity mismatches in 24 h; an admin clears it
                    log.step('platform_hold', result='fetch_held', source='fetch-plan'); ps['session'] = 'held'; ps['held'] = True; continue
                if pl['reason'] == 'missing_platform_id':
                    log.step('plan', result='missing_platform_id'); ps['session'] = 'missing_platform_id'; continue
                if bf_range:
                    wins = backfill.windows(platform, bf_range[0], bf_range[1])[:a.max_windows]
                    log.step('backfill_plan', result='ok', from_=bf_range[0].isoformat(), to=bf_range[1].isoformat(),
                             windows=len(wins), chunk=backfill.chunk_days(platform))
                else:
                    wins = [w for w in pl['windows'] if set(w['reasons']) & set(a.reasons.split(',')) and w['report'] in a.reports.split(',')][:a.max_windows]
                if a.retry_queue:   # only today's retry-list windows for this outlet+platform; ones no longer planned are done
                    mine = {k: e for k, e in pend.items() if e['outlet'] == oid and e['platform'] == platform}
                    wins = [w for w in pl['windows'] if retryq.key(oid, platform, w['report'], w['periodStart'], w['periodEnd']) in mine]
                    planned = {retryq.key(oid, platform, w['report'], w['periodStart'], w['periodEnd']) for w in wins}
                    for k in set(mine) - planned:
                        retryq.close(RUN_CTX['day'], cfg['slug'], k, 'resolved', run_id, 'no_longer_planned'); pend.pop(k, None)
                    if not wins: continue
                # session probe; on signed_out, one bounded password login (Swiggy) then one re-probe
                probe = recipes.zomato_probe if platform == 'zomato' else recipes.swiggy_probe
                try:
                    probe(page)
                    ps['session'] = 'reused'; log.step('session_probe', result='ok')
                except recipes.SignedOut:
                    log.step('session_probe', result='signed_out')
                    relogged = False
                    if not a.no_login and platform in auto_login.SUPPORTED:
                        lg = auto_login.attempt(platform, cfg, run_id, log, allow_any_time=a.login_any_time)
                        ps['login'] = lg; summary['login_cost_inr'] = round(summary.get('login_cost_inr', 0) + lg.get('cost_inr', 0), 2)
                        log.step('login', result=lg['result'], cost_inr=lg.get('cost_inr'), secs=lg.get('secs'), guard=lg.get('guard'), stop=lg.get('stop_reason'))
                        if lg['result'] in auto_login.OK_RESULTS:
                            try:
                                assert requests.get(API + '/health', timeout=5).ok
                                probe(page); relogged = True
                                ps['session'] = 'relogged'; log.step('session_probe', result='ok', after='login')
                            except recipes.SignedOut:
                                log.step('session_probe', result='signed_out', after='login')
                            except UiChanged as e:
                                log.step('session_probe', result='ui_changed:' + e.step, after='login')
                            except Exception as e:  # noqa: BLE001
                                log.step('session_probe', result='error:' + type(e).__name__, after='login')
                    else:
                        ps['login'] = {'attempted': False, 'result': 'no_login' if a.no_login else 'not_supported'}
                    if not relogged:
                        ps['session'] = 'signed_out'
                        try:
                            for w in wins:
                                api.post('/agent/v1/fetches', {'outletId': oid, 'platform': platform, 'report': w['report'], 'periodStart': w['periodStart'],
                                         'periodEnd': w['periodEnd'], 'runId': run_id, 'status': 'signed_out', 'reason': 'signed_out'})
                        except Exception as e:  # noqa: BLE001  e.g. the login guard stopped the API
                            log.step('log_signed_out', result='api_error:' + type(e).__name__)
                        continue
                except UiChanged as e:
                    ps['session'] = 'unknown'; log.step('session_probe', result='ui_changed:' + e.step); continue
                if a.probe_only: continue
                ui_streak = 0
                for wi, w in enumerate(wins):
                    spent = round((summary.get('ai_cost_inr') or 0) + (summary.get('login_cost_inr') or 0), 2)
                    if bf_range and backfill.cap_reached(spent, aifallback.night_cap_inr()):
                        log.step('platform_stop', result='cost_cap', spent_inr=spent); ps['stopped'] = 'cost cap'; break
                    if ui_streak >= UI_STOP_STREAK:
                        log.step('platform_stop', result='ui_changed_streak', streak=ui_streak); ps['stopped'] = f'{ui_streak} UI failures in a row'; break
                    if ui_streak:
                        time.sleep(UI_BACKOFF_S * ui_streak)   # portal throttling/slow render: back off before the next window
                    if mism >= MISMATCH_LIMIT:
                        log.step('platform_stop', result='needs_owner_hold', mismatches=mism); ps['stopped'] = 'third identity mismatch'; break
                    try:
                        res = do_window(api, page, pb, log, image, run_id, folder, rest, outlet, platform, pl['platformId'], w, MISMATCH_LIMIT - mism)
                    except Exception as e:  # noqa: BLE001  a bug: log the type only, carry on with the next window
                        log.step('window_error', result='error', error=type(e).__name__)
                        res = {'platform': platform, 'report': w['report'], 'periodStart': w['periodStart'], 'periodEnd': w['periodEnd'], 'status': 'error', 'error': type(e).__name__}
                    if res.get('status') == 'signed_out' and not ps.get('mid_relogin_tried'):
                        # the session ended during the steps: the normal re-login path once, then this window once more
                        ps['mid_relogin_tried'] = True; relogged = False
                        log.step('session_lost', result='signed_out_mid_window')
                        if not a.no_login and platform in auto_login.SUPPORTED:
                            lg = auto_login.attempt(platform, cfg, run_id, log, allow_any_time=a.login_any_time)
                            ps['login_mid'] = lg; summary['login_cost_inr'] = round(summary.get('login_cost_inr', 0) + lg.get('cost_inr', 0), 2)
                            log.step('login', result=lg['result'], cost_inr=lg.get('cost_inr'), when='mid_window')
                            if lg['result'] in auto_login.OK_RESULTS:
                                try: probe(page); relogged = True
                                except Exception as e:  # noqa: BLE001
                                    log.step('session_probe', result='failed_after_login', error=type(e).__name__)
                        if relogged:
                            try: res = do_window(api, page, pb, log, image, run_id, folder, rest, outlet, platform, pl['platformId'], w, MISMATCH_LIMIT - mism)
                            except Exception as e:  # noqa: BLE001
                                res = {'platform': platform, 'report': w['report'], 'periodStart': w['periodStart'], 'periodEnd': w['periodEnd'], 'status': 'error', 'error': type(e).__name__}
                    if res.get('status') == 'signed_out':
                        ps['session'] = 'signed_out'
                        for w2 in wins[wi:]:
                            try:
                                api.post('/agent/v1/fetches', {'outletId': oid, 'platform': platform, 'report': w2['report'], 'periodStart': w2['periodStart'],
                                         'periodEnd': w2['periodEnd'], 'runId': run_id, 'status': 'signed_out', 'reason': 'signed_out'})
                            except Exception: pass
                        summary['results'].append(res); break
                    summary['results'].append(res)
                    if res.get('ai_cost_inr'): summary['ai_cost_inr'] = round(summary.get('ai_cost_inr', 0) + res['ai_cost_inr'], 2)
                    brief = {k: res.get(k) for k in ('platform', 'report', 'periodStart', 'periodEnd', 'status', 'reason')}
                    if a.retry_queue:
                        k = retryq.key(oid, platform, w['report'], w['periodStart'], w['periodEnd'])
                        if res.get('status') in ('stored', 'skipped'): retryq.close(RUN_CTX['day'], cfg['slug'], k, 'resolved', run_id)
                        else:
                            retryq.close(RUN_CTX['day'], cfg['slug'], k, 'failed_after_retry', run_id, res.get('reason') or res.get('status'))
                            summary.setdefault('alerts', []).append(brief)
                        pend.pop(k, None)
                    elif res.get('alert') == 'deferred_to_0800':
                        summary.setdefault('alerts_deferred', []).append(brief)
                    mism += res.get('mismatches', 0)
                    ui_streak = ui_streak + 1 if (res.get('status') == 'ui_changed' and res.get('reason') != 'payout_recipe_not_scripted') else (ui_streak if res.get('reason') == 'payout_recipe_not_scripted' else 0)
                    if res.get('status') == 'fetch_held':
                        log.step('platform_stop', result='fetch_held', source='423'); ps['held'] = True; ps['stopped'] = 'server hold (423 fetch_held)'; break
                    time.sleep(PACE_S)
    finally:
        pb.sh(f'rm -f /home/rakazo/{folder}/*')
        left = pb.list_files(f'/home/rakazo/{folder}')
        log.ctx = {}; log.step('cleanup', result='ok' if not left else 'files_left', files_left=len(left))
    if a.retry_queue:   # retry-list windows never reached (signed out, held, probe failed): they fail now and are alerted
        for k, e in list(pend.items()):
            retryq.close(RUN_CTX['day'], cfg['slug'], k, 'failed_after_retry', run_id, 'not_retried')
            summary.setdefault('alerts', []).append({'platform': e['platform'], 'report': e['report'], 'periodStart': e['periodStart'],
                                                     'periodEnd': e['periodEnd'], 'status': 'not_retried', 'reason': e.get('reason')})
    summary['status'] = 'done'
    return finish(summary, log, k0, t_start)

def do_window(api, page, pb, log, image, run_id, folder, rest, outlet, platform, platform_id, w, budget=MISMATCH_LIMIT):
    oid = outlet['outletId']; report = w['report']; ps_, pe = w['periodStart'], w['periodEnd']
    log.ctx = {'outlet': oid, 'platform': platform, 'report': report, 'window': f'{ps_}..{pe}', 'reasons': w['reasons']}
    res = {'platform': platform, 'report': report, 'periodStart': ps_, 'periodEnd': pe, 'reasons': w['reasons'], 'attempts': 0, 'mismatches': 0}
    if report == 'payout':
        return do_payout_window(api, page, pb, log, image, run_id, folder, outlet, platform, platform_id, w, res, budget)
    wctx = {'run_id': run_id, 'outlet_name': outlet.get('name'), 'platform_id': platform_id, 'city': outlet.get('city'), 'brand': rest.get('name'),
            'other_outlets': [o.get('name') for o in (rest.get('outlets') or []) if o.get('outletId') != oid]}
    prov = {}
    for attempt in range(1, MISMATCH_LIMIT + 2):
        if res['mismatches'] >= min(MISMATCH_LIMIT, budget): break
        res['attempts'] = attempt; t0 = time.time(); path = None; prov = {}
        try:
            # scripted (3 tries) -> learned steps -> AI; see aifallback.py
            if platform == 'zomato':
                scripted = lambda: recipes.zomato_business(page, report, ps_, pe, folder, log)
            else:
                scripted = lambda: recipes.swiggy_business(page, report, ps_, pe, folder, log, rest['name'], outlet['city'], platform_id)
            rfn = lambda: recipes.business_recipe(platform, report, ps_, pe, log, rest.get('name'), outlet.get('city'), platform_id)
            path, eff_pe = aifallback.obtain(page, scripted, rfn, folder, log, wctx, prov)
            note_prov(res, prov)
            eff_ps = ps_
            ep = getattr(log, 'effective_period', None)
            if isinstance(ep, (tuple, list)) and len(ep) >= 1 and ep[0]:
                eff_ps = ep[0]
            if eff_ps != ps_:
                res['effectivePeriodStart'] = eff_ps
            evidence = lambda st, fid: {'window': f'{ps_}..{pe}', 'presubmit': 'ok', 'identity': 'ok', 'upload': st, 'fetchId': fid,
                                        'raw_sha12': raw_sha[:12], 'ai_cost_inr': round(prov.get('ai_cost_inr') or 0, 2), 'ai_calls': prov.get('ai_calls')}
            raw = pb.read_file(path)
            raw_sha = hashlib.sha256(raw).hexdigest()
            if platform == 'swiggy':
                csv_text = convert.swiggy_xlsx_to_csv(raw)
            else:
                csv_text = raw.decode('utf-8-sig')
            log.step('downloaded', result='ok', size=len(raw), raw_sha12=raw_sha[:12], secs=round(time.time() - t0, 1), effectivePeriodEnd=eff_pe)
            blanks = []
            if report == 'daily':   # blank-day guard: a day the platform has not filled in yet is never stored as zeros
                posted, blanks = blankday.guard(csv_text, datetime.now(IST).date())
                if blanks:
                    res['blankDays'] = [b['date'] for b in blanks]
                    log.step('blank_day', result='not_in_yet', days=res['blankDays'], rules=sorted({b['rule'] for b in blanks}),
                             posted='none' if posted is None else 'rest_of_window')
                if posted is None:   # every day in the file is blank: nothing is posted; the next night fetches it again
                    res.update(status='not_in_yet', reason='blank_day', effectivePeriodEnd=eff_pe); return res
                csv_text = posted
            chk = identity.check(image, 'business', platform, report, eff_ps, eff_pe, platform_id, outlet['name'], outlet['city'], csv_text=csv_text)
            if not chk.get('ok') and chk.get('layout'):
                # whole-layout change: not an identity mismatch (never local_mismatch), no retry tonight
                log.step('local_identity', result='layout_changed')
                log_fetch(api, oid, platform, report, eff_ps, eff_pe, run_id, 'layout_changed', 'layout_changed')
                pb.remove(path); path = None
                res.update(status='layout_changed', reason='layout_changed', effectivePeriodEnd=eff_pe); return res
            if not chk.get('ok'):
                reason = 'outlet' if 'restaurant' in (chk.get('reject') or '') else ('period' if re.search(r'Column|periods', chk.get('reject') or '') else 'unreadable')
                log.step('local_identity', result='mismatch:' + reason, observed_id_ok=(chk.get('restaurantId') in (platform_id, platform_id + '.0')))
                api.post('/agent/v1/fetches', {'outletId': oid, 'platform': platform, 'report': report, 'periodStart': eff_ps, 'periodEnd': eff_pe,
                         'runId': run_id, 'status': 'local_mismatch', 'reason': 'local_mismatch_' + reason})
                res['mismatches'] += 1; pb.remove(path); path = None
                if prov.get('mode') in ('ai', 'learned'):   # never re-run the AI on a wrong file; a learned recipe that gave one is stale
                    aifallback.learned_failed(prov, platform, report, 'identity_mismatch_' + reason, run_id)
                    log.step('ai_file', result='discarded', via=prov.get('mode'))
                    res.update(status='local_mismatch', reason='local_mismatch_' + reason, alert='now'); return res
                continue
            log.step('local_identity', result='ok', rows=chk.get('rows'), warnings=len(chk.get('warnings') or []))
            content_sha = hashlib.sha256(csv_text.encode()).hexdigest()
            # a trimmed file is not the raw file: match it by content only, and don't record the raw hash for it
            raw_ref = {} if blanks else {'rawSha256': raw_sha}
            _, c = api.post('/agent/v1/fetches/check', {'outletId': oid, 'platform': platform, 'files': [{'sha256': content_sha, **raw_ref,
                            'report': report, 'periodStart': eff_ps, 'periodEnd': eff_pe, 'parserVersion': cfg_parser_version()}]})
            if c.get('files') and c['files'][0].get('stored'):
                log.step('sha_check', result='skipped', fetchId=c['files'][0]['fetchId'])
                res.update(status='skipped', fetchId=c['files'][0]['fetchId'], effectivePeriodEnd=eff_pe, rowsWritten=0)
                aifallback.learn(prov, wctx, platform, report, evidence('skipped', c['files'][0]['fetchId']), log)
                pb.remove(path); return res
            code, r = api.post('/agent/v1/metric-reports', {'outletId': oid, 'platform': platform, 'report': report, 'periodStart': eff_ps, 'periodEnd': eff_pe,
                               'csv': csv_text, **raw_ref, 'runId': run_id, 'source': VERSION,
                               'capturedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')})
            if code == 423 or r.get('code') == 'fetch_held':
                log.step('upload', result='fetch_held', http=code)
                pb.remove(path); path = None
                res.update(status='fetch_held'); return res      # no retry: the platform is held until an admin clears it
            st = r.get('status') if (code < 400 or r.get('status')) else ('http_' + str(code))   # 422 file_identity carries its status
            if r.get('code') == 'layout_changed': st = 'layout_changed'   # server logged parse_failed/layout_changed; no retry
            log.step('upload', result=st, http=code, fetchId=r.get('fetchId'), written=r.get('written'), superseded=r.get('superseded'), checks=r.get('checks'),
                     errCode=r.get('code'))
            res.update(status=st, fetchId=r.get('fetchId'), rowsWritten=r.get('written'), superseded=r.get('superseded'), checks=r.get('checks'), effectivePeriodEnd=eff_pe)
            if st in ('stored', 'skipped'):
                aifallback.learn(prov, wctx, platform, report, evidence(st, r.get('fetchId')), log)
                pb.remove(path); return res
            pb.remove(path); path = None
            if st in ('rejected_mismatch', 'needs_owner'):
                res['mismatches'] += 1
                if st == 'needs_owner': return res
                if prov.get('mode') in ('ai', 'learned'):
                    aifallback.learned_failed(prov, platform, report, 'server_' + st, run_id)
                    res['alert'] = 'now'; return res
                continue
            return res   # 4xx: a bug, alert admin
        except recipes.SignedOut:
            note_prov(res, prov)
            res.update(status='signed_out'); return res
        except recipes.HistoryUnavailable as e:
            note_prov(res, prov)
            log.step('window', result='history_unavailable', at=getattr(e, 'step', None))
            res.update(status='not_available', reason='history_unavailable'); return res
        except recipes.NotAvailable as e:
            note_prov(res, prov)
            log.step('window', result='not_available_yet')
            res.update(status='download_failed', reason='not_available_yet'); return res
        except recipes.DownloadFailed as e:
            note_prov(res, prov)
            log.step('download', result='download_failed', at=e.step)
            api.post('/agent/v1/fetches', {'outletId': oid, 'platform': platform, 'report': report, 'periodStart': ps_, 'periodEnd': pe, 'runId': run_id, 'status': 'download_failed', 'reason': re.sub(r'\W', '_', e.step)[:60]})
            res.update(status='download_failed', reason=e.step)
            defer(res, oid, platform, report, ps_, pe, run_id, e.step); return res
        except UiChanged as e:   # scripted tries, learned steps and the AI all failed (or the step is not AI-eligible)
            note_prov(res, prov)
            log.step('ui', result='ui_changed_final:' + e.step, via=prov.get('mode'))
            api.post('/agent/v1/fetches', {'outletId': oid, 'platform': platform, 'report': report, 'periodStart': ps_, 'periodEnd': pe, 'runId': run_id, 'status': 'ui_changed', 'reason': re.sub(r'[^a-z0-9_]', '_', e.step.lower())[:60]})
            res.update(status='ui_changed', reason=e.step)
            defer(res, oid, platform, report, ps_, pe, run_id, e.step); return res
        finally:
            if path: pb.remove(path)
    res.setdefault('status', 'local_mismatch')
    return res

def log_fetch(api, oid, platform, report, ps_, pe, run_id, status, reason):
    api.post('/agent/v1/fetches', {'outletId': oid, 'platform': platform, 'report': report, 'periodStart': ps_, 'periodEnd': pe,
             'runId': run_id, 'status': status, 'reason': re.sub(r'[^a-z0-9_]', '_', reason.lower())[:60]})

def do_payout_window(api, page, pb, log, image, run_id, folder, outlet, platform, platform_id, w, res, budget=MISMATCH_LIMIT):
    """Z2 / S2: scripted download of one payout cycle, local identity check, sha check, POST /agent/v1/payout-reports
    (the raw xlsx as fileBase64; the server parses both platforms' workbooks), then delete the file."""
    oid = outlet['outletId']; ps_, pe = w['periodStart'], w['periodEnd']
    ui_retry = aifallback.scripted_tries() - 1   # payouts: 3 scripted tries, then the 08:00 retry list (no AI for payouts yet)
    for attempt in range(1, MISMATCH_LIMIT + 2):
        if res['mismatches'] >= min(MISMATCH_LIMIT, budget): break
        res['attempts'] = attempt; t0 = time.time(); path = None
        try:
            if platform == 'zomato':
                path = recipes.zomato_payout(page, ps_, pe, folder, log)
            else:
                path = recipes.swiggy_payout(page, ps_, pe, folder, log, platform_id)
            raw = pb.read_file(path)
            raw_sha = hashlib.sha256(raw).hexdigest()
            log.step('downloaded', result='ok', size=len(raw), raw_sha12=raw_sha[:12], secs=round(time.time() - t0, 1))
            if not recipes.is_zip(raw):
                log.step('local_identity', result='mismatch:not_xlsx')
                log_fetch(api, oid, platform, 'payout', ps_, pe, run_id, 'download_failed', 'payout_not_xlsx')
                res.update(status='download_failed', reason='payout_not_xlsx'); return res
            chk = identity.check(image, 'payout', platform, 'payout', ps_, pe, platform_id, outlet['name'], outlet['city'], data=raw)
            pver = chk.get('parserVersion') or payout_parser_version()
            if not chk.get('ok') and chk.get('layout'):
                log.step('local_identity', result='layout_changed')
                log_fetch(api, oid, platform, 'payout', ps_, pe, run_id, 'layout_changed', 'layout_changed')
                res.update(status='layout_changed', reason='layout_changed'); return res
            if not chk.get('ok'):
                rj = chk.get('reject') or ''
                if chk.get('parseFailed') or rj.startswith('local_check_error'):
                    # not an identity mismatch (payout parse failures don't count); the server is still asked, it is the final word
                    log.step('local_identity', result='unreadable', parse_failed=bool(chk.get('parseFailed')))
                else:
                    reason = 'outlet' if 'restaurant' in rj else ('period' if 'period' in rj else 'other')
                    log.step('local_identity', result='mismatch:' + reason, observed_id_ok=(chk.get('restaurantId') == platform_id))
                    log_fetch(api, oid, platform, 'payout', ps_, pe, run_id, 'local_mismatch', 'local_mismatch_' + reason)
                    res['mismatches'] += 1; pb.remove(path); path = None
                    continue
            else:
                log.step('local_identity', result='ok', orders=chk.get('orders'), warnings=len(chk.get('warnings') or []), cycle=chk.get('cycle'))
            _, c = api.post('/agent/v1/fetches/check', {'outletId': oid, 'platform': platform, 'files': [{'sha256': raw_sha, 'rawSha256': raw_sha,
                            'report': 'payout', 'periodStart': ps_, 'periodEnd': pe, 'parserVersion': pver}]})
            if c.get('files') and c['files'][0].get('stored'):
                log.step('sha_check', result='skipped', fetchId=c['files'][0]['fetchId'])
                res.update(status='skipped', fetchId=c['files'][0]['fetchId'], rowsWritten=0, via='sha_check')
                pb.remove(path); path = None; return res
            code, r = api.post('/agent/v1/payout-reports', {'outletId': oid, 'platform': platform, 'periodStart': ps_, 'periodEnd': pe,
                               'fileBase64': base64.b64encode(raw).decode(), 'rawSha256': raw_sha, 'runId': run_id, 'source': VERSION,
                               'capturedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')})
            pb.remove(path); path = None        # the server has answered: the raw file (PAN, UTRs, customer ids) goes now
            if code == 423 or r.get('code') == 'fetch_held':
                log.step('upload', result='fetch_held', http=code)
                res.update(status='fetch_held'); return res
            st = r.get('status') if (code < 400 or r.get('status')) else ('http_' + str(code))   # 422 file_identity carries its status
            if r.get('code') == 'layout_changed': st = 'layout_changed'   # no retry tonight
            log.step('upload', result=st, http=code, fetchId=r.get('fetchId'), orders=r.get('orders'), adjustments=r.get('adjustments'),
                     superseded=r.get('superseded'), checks_failed=sum(1 for x in (r.get('checks') or []) if not x.get('pass')),
                     checks=len(r.get('checks') or []), errCode=r.get('code'))
            res.update(status=st, fetchId=r.get('fetchId'), rowsWritten=r.get('orders'), adjustments=r.get('adjustments'), superseded=r.get('superseded'))
            if st in ('rejected_mismatch', 'needs_owner'):
                res['mismatches'] += 1
                if st == 'needs_owner': return res
                continue
            return res   # stored / skipped / parse_failed (server-logged) / 4xx
        except recipes.SignedOut:
            res.update(status='signed_out'); return res
        except requests.HTTPError as e:   # the server kept failing (5xx after retries); the file is still deleted below
            log.step('upload', result='server_error', http=str(e)[:3])
            try: log_fetch(api, oid, platform, 'payout', ps_, pe, run_id, 'download_failed', 'upload_server_error_' + str(e)[:3])
            except Exception: pass
            res.update(status='server_error', reason='upload_server_error'); return res
        except recipes.NotAvailable:
            log.step('window', result='not_available_yet')
            res.update(status='download_failed', reason='not_available_yet'); return res
        except recipes.NotListed as e:
            log.step('window', result='cycle_not_listed', at=e.step)
            log_fetch(api, oid, platform, 'payout', ps_, pe, run_id, 'download_failed', e.step)
            res.update(status='download_failed', reason=e.step); return res
        except recipes.DownloadFailed as e:
            log.step('download', result='download_failed', at=e.step)
            log_fetch(api, oid, platform, 'payout', ps_, pe, run_id, 'download_failed', e.step)
            res.update(status='download_failed', reason=e.step)
            defer(res, oid, platform, 'payout', ps_, pe, run_id, e.step); return res
        except UiChanged as e:
            log.step('ui', result='ui_changed:' + e.step)
            if ui_retry:
                ui_retry -= 1; continue
            log_fetch(api, oid, platform, 'payout', ps_, pe, run_id, 'ui_changed', e.step)
            res.update(status='ui_changed', reason=e.step)
            defer(res, oid, platform, 'payout', ps_, pe, run_id, e.step); return res
        finally:
            if path: pb.remove(path)
    res.setdefault('status', 'local_mismatch')
    return res

def payout_parser_version():
    return os.environ.get('PAYOUT_PARSER_VERSION', '2026-11-12.payout.3')

def cfg_parser_version():
    return os.environ.get('METRIC_PARSER_VERSION', '2026-11-12.1')

def finish(summary, log, k0, t0):
    k1 = key_usage()
    summary['model_cost_inr'] = round(((k1 - k0) * 85) if (k0 is not None and k1 is not None) else 0.0, 2)
    summary['key_meter'] = 'measured' if (k0 is not None and k1 is not None) else 'unavailable'
    summary['wall_s'] = round(time.time() - t0, 1)
    out = os.path.join(HERE, 'logs', f"summary-{summary['runId']}.json")
    with open(out, 'w') as f: f.write(json.dumps(scrub_obj(summary), indent=2, default=str))
    log.ctx = {}; log.step('summary', result=summary.get('status'), file=out, model_cost_inr=summary['model_cost_inr'])
    return 0

if __name__ == '__main__':
    sys.exit(main())
