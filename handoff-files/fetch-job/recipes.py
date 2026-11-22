"""Z1 / S1 scripted recipes. Every click is on a control found in a fresh snapshot by its exact visible text.
Guards: never click email/SMS/share/phone-number controls, the Online toggle, settings, ads or feedback."""
import json, os, re, time
from datetime import date, timedelta
from ui import Page, UiChanged, norm

FORBIDDEN = re.compile(r'(?i)\b(e-?mail|sms|share|send|phone numbers?|online|offline|settings|feedback|log ?out|sign ?out|resend|otp)\b')
ZOMATO_REPORT_URL = 'https://www.zomato.com/partners/onlineordering/reporting/'
SWIGGY_REPORT_URL = 'https://partner.swiggy.com/food/business-metrics'
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

class SignedOut(Exception): pass

def wait_file(p, folder, pattern, t0, timeout=120):
    """The newest complete file saved after t0: first in our folder, else anywhere in this bot's folder tree
    (a download hold left by an earlier call may point Chromium elsewhere). Accepted later by its content only."""
    import fnmatch
    w = p.pb.wait_download('/home/rakazo/' + folder, pattern, t0, timeout)
    if w.get('ok'): return w['path']
    root = '/home/rakazo/' + folder.split('/fetch-job/')[0]
    r = p.pb._exec(['python3', '-c', """import os,sys,json,fnmatch
root,pat,t0=sys.argv[1],sys.argv[2],float(sys.argv[3]);best=None
for d,_,fs in os.walk(root):
  for n in fs:
    q=os.path.join(d,n)
    if fnmatch.fnmatch(n,pat) and not n.endswith('.crdownload') and os.path.getmtime(q)>=t0 and (best is None or os.path.getmtime(q)>os.path.getmtime(best)): best=q
print(json.dumps(best))""", root, pattern, str(t0)])
    try: found = json.loads(r.stdout or b'null')
    except Exception: found = None
    if not found: return None
    dest = '/home/rakazo/' + folder + '/' + os.path.basename(found)
    p.pb._exec(['mv', '-f', '--', found, dest])
    return dest
class NotAvailable(Exception):
    def __init__(self, step='not_available_yet'):
        super().__init__(step); self.step = step

class HistoryUnavailable(NotAvailable):
    """The calendar has no enabled day in this window (too old for the app's history). Never use the AI."""

def guard(text):
    if FORBIDDEN.search(text or ''): raise UiChanged('guard_refused:' + re.sub(r'\W+', '_', text)[:40])

def gclick(p: Page, text, role=None, step=None, **kw):
    guard(text)
    return p.click(text, role=role, step=step, **kw)

def ordinal(n):
    return f"{n}{'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"

def days(ps, pe):
    a, b = date.fromisoformat(ps), date.fromisoformat(pe)
    return [a + timedelta(i) for i in range((b - a).days)]

# ---------------- Zomato ----------------
def zomato_probe(p: Page):
    p.pb.navigate(ZOMATO_REPORT_URL)
    for _ in range(10):
        time.sleep(2)
        d = p.snap()
        u = d['url']
        if 'partners/onlineordering' not in u or re.search(r'/login|/auth|accounts\.zomato', u): raise SignedOut()
        if p.find_all('Business reports', snap=d): return True
    raise UiChanged('z1_probe:no_business_reports')

def first_enabled(days, peek):
    """First date in `days` for which peek(d) is true. A false peek means that day is disabled."""
    for d in days:
        if peek(d):
            return d
    return None

def zomato_find_day(p: Page, d: date, step):
    """Inside the open Custom range calendar: set month/year and return the day button."""
    snap = p.snap()
    combos = [c for c in snap['controls'] if c['role'] == 'combobox']
    if len(combos) < 2: raise UiChanged(step + ':month_select_missing')
    p.fill(combos[0]['ref'], MONTHS[d.month - 1], step + ':month'); time.sleep(1)
    p.fill(combos[1]['ref'], str(d.year), step + ':year'); time.sleep(1)
    snap = p.snap()
    btns = [c for c in snap['controls'] if c['role'] == 'button' and re.fullmatch(r'\d{1,2}', c['ntext'])]
    first = next((i for i, c in enumerate(btns) if c['ntext'] == '1'), None)
    if first is None: raise UiChanged(step + ':days_missing')
    month = btns[first:first + 31]
    hit = next((c for c in month if c['ntext'] == str(d.day)), None)
    if not hit: raise UiChanged(step + ':day_unavailable')
    return hit

def zomato_pick_day(p: Page, d: date, step):
    """Inside the open Custom range calendar: set month, click the day of that month."""
    hit = zomato_find_day(p, d, step)
    if hit['disabled']: raise UiChanged(step + ':day_unavailable')
    p.click_ref(hit['ref'], step=step); time.sleep(1)

class Recipe:
    """A business-report recipe as named stages (each a scripted function of (page, ctx)) plus a scripted submit.
    The AI fallback (aifallback.py) can take over from the start of any stage and replay learned steps there."""
    def __init__(self, platform, report, ps, pe, stages, submit, pattern, ctx=None, log=None):
        self.platform, self.report, self.ps, self.pe = platform, report, ps, pe
        self.stages, self.submit, self.pattern = stages, submit, pattern
        self.log = log
        self.ctx = ctx if ctx is not None else {}
        self.ctx.setdefault('eff_ps', ps)
        self.ctx.setdefault('eff_pe', pe)

def run_scripted(p, rc: Recipe, folder):
    """All stages then the scripted submit. A UiChanged carries .stage (the stage it failed in)."""
    for name, fn in rc.stages:
        try: fn(p, rc.ctx)
        except UiChanged as e:
            e.stage = name; raise
    try: path = rc.submit(p, rc.ctx, folder)
    except UiChanged as e:
        e.stage = 'submit'; raise
    if rc.log is not None:
        rc.log.effective_period = (rc.ctx.get('eff_ps', rc.ps), rc.ctx.get('eff_pe', rc.pe))
    return path, rc.ctx['eff_pe']

def zomato_business_recipe(report, ps, pe, log):
    ds = days(ps, pe)
    view = {'daily': 'Daily', 'weekly': 'Weekly', 'monthly': 'Monthly'}[report]
    def st_probe(p, ctx): zomato_probe(p)
    def st_open(p, ctx):
        gclick(p, 'Business reports', step='z1_business_tab', settle=2)
        p.wait_for('Generate report', step='z1_generate_report_button', timeout=30)
        gclick(p, 'Generate report', step='z1_open_generator', settle=3)
        p.wait_for('You are generating a report for', step='z1_generator_open', timeout=20)
    def st_detailed(p, ctx): gclick(p, 'Detailed report', step='z1_detailed')
    def st_view(p, ctx): gclick(p, view, step='z1_view_' + report)
    def st_range(p, ctx):
        today = date.fromisoformat(log.plan_date)
        preset = None
        if report == 'daily' and ds[-1] == today - timedelta(1):
            preset = {7: 'Last 7 days', 14: 'Last 14 days', 30: 'Last 30 days'}.get(len(ds))
        if report == 'monthly':
            raise UiChanged('z1_monthly_not_scripted')
        if preset:
            gclick(p, preset, step='z1_preset'); return
        if report == 'daily' and len(ds) > 30: raise UiChanged('z1_window_over_30_days')
        gclick(p, 'Custom', step='z1_custom', settle=2)
        gclick(p, 'Select date range', step='z1_open_calendar', settle=2)
        def z_enabled(d):
            try:
                hit = zomato_find_day(p, d, 'z1_start_day')
            except UiChanged as e:
                if str(e).endswith('day_unavailable'):
                    return False
                raise
            return not hit['disabled']
        start = first_enabled(ds, z_enabled)
        if start is None:
            raise HistoryUnavailable('z1_start_day:history_unavailable')
        if start != ds[0]:
            ctx['eff_ps'] = start.isoformat()
            log.step('z1_clamp', result='clamped', periodStart=ps, effectivePeriodStart=ctx['eff_ps'])
        zomato_pick_day(p, start, 'z1_start_day')
        zomato_pick_day(p, ds[-1], 'z1_end_day')
        fmt = lambda x: f"{x.strftime('%b')} {x.day}, {x.year}"
        boxes = [c for c in p.snap()['controls'] if c['role'] == 'textbox' and c['value']][:2]
        shown = [b['value'] for b in boxes]
        if shown != [fmt(start), fmt(ds[-1])]:
            log.step('z1_range_check', result='mismatch', shown=shown, want=[fmt(start), fmt(ds[-1])])
            raise UiChanged('z1_range_check')
        log.step('z1_range_check', result='ok', matched=' - '.join(shown))
        gclick(p, 'Apply', step='z1_apply_range', settle=2)
        sel = [l for l in p.page_lines() if l.startswith('Selected:')]
        want = f"{ordinal(start.day)} {start.strftime('%b')}"
        if not sel or want not in sel[-1] or f"{ordinal(ds[-1].day)} {ds[-1].strftime('%b')}" not in sel[-1]:
            log.step('z1_applied_check', result='mismatch', shown=(sel[-1] if sel else None))
            raise UiChanged('z1_applied_check')
    def submit(p, ctx, folder):
        t0 = p.pb.now()
        p.pb.act([{'kind': 'click', 'ref': p.find('Generate', step='z1_generate')['ref']}], downloads=folder)
        log.step('z1_generate', matched='Generate')
        path = wait_file(p, folder, 'business_report_*.csv', t0, 120)
        if not path: raise DownloadFailed('z1_download_timeout')
        return path
    return Recipe('zomato', report, ps, pe, [('z1_probe', st_probe), ('z1_open_generator', st_open), ('z1_detailed', st_detailed),
                  ('z1_view', st_view), ('z1_range', st_range)], submit, 'business_report_*.csv', log=log)

def zomato_business(p: Page, report, ps, pe, folder, log):
    """Returns (path, effective periodEnd)."""
    return run_scripted(p, zomato_business_recipe(report, ps, pe, log), folder)

# ---------------- Swiggy ----------------
class DownloadFailed(Exception):
    def __init__(self, step): super().__init__(step); self.step = step

def swiggy_probe(p: Page):
    # Swiggy's report page sometimes renders slowly or blank after several requests in a row:
    # wait longer, then reload once before calling it a UI change.
    for attempt in range(2):
        p.pb.navigate(SWIGGY_REPORT_URL)
        for _ in range(15):
            time.sleep(2)
            d = p.snap()
            if '/food/login' in d['url'] or '/login' in d['url']: raise SignedOut()
            if p.find_all('Download Report', role='button', snap=d): return True
    raise UiChanged('s1_probe:no_download_report')

def pick_generic(p, pattern, step):
    d = p.snap()
    g = [c for c in d['controls'] if c['role'] == 'generic' and re.fullmatch(pattern, c['ntext'])]
    if not g: raise UiChanged(step)
    guard(g[-1]['ntext'])
    p.click_ref(g[-1]['ref'], step=step); time.sleep(1.2)
    d = p.snap()
    cb = [c for c in d['controls'] if c['role'] == 'checkbox' and re.fullmatch(pattern, c['ntext'])]
    if not cb or not cb[-1]['checked']: raise UiChanged(step + ':not_ticked')

def radio_after(p, text, step):
    d = p.snap(); cs = d['controls']
    idx = [i for i, c in enumerate(cs) if c['role'] == 'generic' and c['ntext'] == text]
    if not idx: raise UiChanged(step)
    i = idx[-1]
    nxt = next((c for c in cs[i + 1:i + 3] if c['role'] == 'radio'), None)
    return cs[i], nxt

def swiggy_business_recipe(report, ps, pe, log, brand, city, rid):
    ds = days(ps, pe)
    view = {'daily': 'Daily', 'weekly': 'Weekly', 'monthly': 'Monthly'}[report]
    def st_probe(p, ctx): swiggy_probe(p)
    def st_open(p, ctx): gclick(p, 'Download Report', role='button', step='s1_download_report', settle=3)
    def st_outlet(p, ctx):
        pick_generic(p, re.escape(brand) + r' \d+ Cit(y|ies)', 's1_brand')
        gclick(p, 'CONTINUE', role='button', step='s1_brand_continue', settle=3)
        pick_generic(p, re.escape(city) + r' \d+ Outlets?', 's1_city')
        gclick(p, 'CONTINUE', role='button', step='s1_city_continue', settle=3)
        pick_generic(p, r'.* RID: ' + re.escape(rid), 's1_outlet')
        d = p.snap()
        ticked = [c for c in d['controls'] if c['role'] == 'checkbox' and c['checked']]
        if len(ticked) != 1 or not re.search(r'RID: %s$' % re.escape(rid), ticked[0]['ntext']): raise UiChanged('s1_outlet:not_exactly_one')
        log.step('s1_outlet', result='ok', matched='RID: ' + rid)
        gclick(p, 'CONTINUE', role='button', step='s1_outlet_continue', settle=3)
        p.wait_text('1 Outlet Selected', step='s1_one_outlet_selected', timeout=15)
    def st_view(p, ctx):
        lab, rad = radio_after(p, view, 's1_view')
        if not (rad and rad['checked']):
            p.click_ref(lab['ref'], step='s1_view'); time.sleep(1)
            lab, rad = radio_after(p, view, 's1_view')
            if not (rad and rad['checked']): raise UiChanged('s1_view:not_selected')
    def st_range(p, ctx):
        if report != 'daily': raise UiChanged('s1_weekly_monthly_not_scripted')
        if len(ds) > 7: raise UiChanged('s1_daily_over_7_days')
        lab, rad = radio_after(p, 'Custom', 's1_custom')
        p.click_ref(lab['ref'], step='s1_custom'); time.sleep(2)
        # calendar: buttons named like "November 7, 2026"; header button "November 2026"; ‹ › to move months
        def day_btn(dd):
            return f"{MONTHS[dd.month - 1]} {dd.day}, {dd.year}"
        def goto_month(dd):
            for _ in range(14):
                snap = p.snap()
                hdr = [c for c in snap['controls'] if c['role'] == 'button' and re.fullmatch(r'(%s) \d{4}' % '|'.join(MONTHS), c['ntext'])]
                if not hdr: raise UiChanged('s1_calendar_header')
                m, y = hdr[0]['ntext'].split()
                cur = (int(y), MONTHS.index(m) + 1)
                if cur == (dd.year, dd.month): return snap
                p.click('‹' if cur > (dd.year, dd.month) else '›', role='button', step='s1_calendar_nav', settle=1)
            raise UiChanged('s1_calendar_nav')
        def day_enabled(dd):
            snap = goto_month(dd)
            b = next((c for c in snap['controls'] if c['role'] == 'button' and c['ntext'] == day_btn(dd)), None)
            return bool(b) and not b['disabled']
        start = first_enabled(ds, day_enabled)
        if start is None:
            raise HistoryUnavailable('s1_start_day:history_unavailable')
        if start != ds[0]:
            ctx['eff_ps'] = start.isoformat()
            log.step('s1_clamp', result='clamped', periodStart=ps, effectivePeriodStart=ctx['eff_ps'])
        # clamp the end to the last day Swiggy offers (its data lags about 48 h)
        end = ds[-1]
        snap = goto_month(end)
        while True:
            b = next((c for c in snap['controls'] if c['role'] == 'button' and c['ntext'] == day_btn(end)), None)
            if b and not b['disabled']: break
            end -= timedelta(1)
            if end < start: raise NotAvailable('no day in window available yet')
            if end.month != (ds[-1].month): snap = goto_month(end)
        eff_pe = (end + timedelta(1)).isoformat()
        if eff_pe != pe: log.step('s1_clamp', result='clamped', periodEnd=pe, effectivePeriodEnd=eff_pe)
        ctx['eff_pe'] = eff_pe
        snap = goto_month(start)
        p.click(day_btn(start), role='button', step='s1_start_day', settle=1)
        snap = goto_month(end)
        p.click(day_btn(end), role='button', step='s1_end_day', settle=1)
        gclick(p, 'Confirm', step='s1_confirm', settle=2)
        want = f"Custom {start.strftime('%d/%m/%Y')} - {end.strftime('%d/%m/%Y')}"
        lab, rad = radio_after(p, want, 's1_range_check')
        if not (rad and rad['checked']): raise UiChanged('s1_range_check')
        log.step('s1_range_check', result='ok', matched=want)
    def submit(p, ctx, folder):
        t0 = p.pb.now()
        btn = p.find('Raise a Request', role='button', step='s1_raise_request')
        p.pb.act([{'kind': 'click', 'ref': btn['ref']}], downloads=folder)   # the page's own download; the file arrives here
        log.step('s1_raise_request', matched='Raise a Request')
        path = wait_file(p, folder, '*.xlsx', t0, 120)
        if not path: raise DownloadFailed('s1_download_timeout')
        return path
    return Recipe('swiggy', report, ps, pe, [('s1_probe', st_probe), ('s1_open', st_open), ('s1_outlet', st_outlet), ('s1_view', st_view),
                  ('s1_range', st_range)], submit, '*.xlsx', log=log)

def swiggy_business(p: Page, report, ps, pe, folder, log, brand, city, rid):
    return run_scripted(p, swiggy_business_recipe(report, ps, pe, log, brand, city, rid), folder)

# ---------------- platform rules used by the AI fallback (generic per platform, never per restaurant) ----------------
PLATFORM_RULES = {
    'zomato': {'site': re.compile(r'^https://(www\.)?zomato\.com/partners/'), 'signed_out': re.compile(r'/login|/auth|accounts\.zomato'),
               'start_url': ZOMATO_REPORT_URL, 'site_name': 'Zomato restaurant partner dashboard'},
    'swiggy': {'site': re.compile(r'^https://partner\.swiggy\.com/'), 'signed_out': re.compile(r'/login'),
               'start_url': SWIGGY_REPORT_URL, 'site_name': 'Swiggy partner dashboard'},
}

def business_recipe(platform, report, ps, pe, log, brand=None, city=None, rid=None):
    if platform == 'zomato': return zomato_business_recipe(report, ps, pe, log)
    return swiggy_business_recipe(report, ps, pe, log, brand, city, rid)

# ---------------- Payouts (Z2 / S2) ----------------
ZOMATO_PAYOUT_URL = 'https://www.zomato.com/partners/onlineordering/finance/payouts'
SWIGGY_FINANCE_URL = 'https://partner.swiggy.com/food/finance'
# Icon shapes (start of the SVG path) on Zomato's past-cycle rows. The icons carry no text of their own; their
# visible labels are hover tooltips ("Download report" / "Report is ready to download" / "Send report to mail").
Z2_DOWNLOAD_ICON = 'M480-328.46 309.23-499.23'   # Material "download" (arrow into tray)
Z2_MAIL_ICON = 'M480-457.69 160-662.31'          # Material "forward to inbox": never clicked
Z2_DOWNLOAD_LABELS = ('Download report', 'Report is ready to download')

class NotListed(Exception):
    """The cycle isn't on the platform's list (too old for the default range, or not closed yet)."""
    def __init__(self, step): super().__init__(step); self.step = step

def zomato_cycle_labels(ps, pe):
    """fetch-plan window [ps, pe) -> the past-cycle row label, e.g. "02 Nov - 08 Nov'26" (last day inclusive)."""
    a, b = date.fromisoformat(ps), date.fromisoformat(pe) - timedelta(1)
    yy = lambda d: d.strftime("%d %b'%y")
    labels = [f"{a.strftime('%d %b')} - {yy(b)}"]
    if a.year != b.year: labels.insert(0, f"{yy(a)} - {yy(b)}")
    return labels

def swiggy_cycle_label(ps, pe):
    """fetch-plan window [ps, pe) -> Swiggy's card label. Swiggy writes the cycle as the Saturday (or month end)
    before the first day through the last day: window 2026-11-01..2026-11-08 is "31st Oct-7th Nov"
    (its detail URL carries from=2026-10-31&to=2026-11-07; the annexure itself says 01-07 Nov)."""
    a, b = date.fromisoformat(ps) - timedelta(1), date.fromisoformat(pe) - timedelta(1)
    return f"{ordinal(a.day)} {a.strftime('%b')}-{ordinal(b.day)} {b.strftime('%b')}", a, b

def is_zip(raw: bytes):
    return raw[:4] == b'PK\x03\x04'

def zomato_payout(p: Page, ps, pe, folder, log):
    """Z2: Finance > Payouts > past cycle row for [ps, pe) > its download icon. Returns the file path."""
    p.pb.navigate(ZOMATO_PAYOUT_URL)
    labels = zomato_cycle_labels(ps, pe)
    rows = []
    for _ in range(15):     # let the list load once; no reload loop
        time.sleep(2)
        d = p.snap()
        if 'partners/onlineordering' not in d['url'] or re.search(r'/login|/auth|accounts\.zomato', d['url']): raise SignedOut()
        rows = [c for c in d['controls'] if c['role'] == 'row']
        if rows: break
    if not rows: raise UiChanged('z2_no_cycle_rows')
    cs = d['controls']
    hits = [i for i, c in enumerate(cs) if c['role'] == 'row' and any(c['ntext'].startswith(l + ' ') or c['ntext'] == l for l in labels)]
    if not hits: raise NotListed('z2_cycle_not_listed')
    if len(hits) != 1: raise UiChanged('z2_cycle_row_ambiguous')
    i = hits[0]
    row = cs[i]
    if not re.search(r'\bPAID\b', row['ntext']): raise NotAvailable('cycle not paid yet')
    log.step('z2_cycle_row', result='ok', matched=next(l for l in labels if row['ntext'].startswith(l)))
    nxt = next((j for j in range(i + 1, len(cs)) if cs[j]['role'] == 'row'), len(cs))
    imgs = [c for c in cs[i + 1:nxt] if c['role'] == 'image']
    shapes = p.icons([c['ref'] for c in imgs]) if imgs else {}
    dl = [r for r, s in shapes.items() if s and s.startswith(Z2_DOWNLOAD_ICON)]
    if len(dl) != 1: raise UiChanged('z2_download_icon')
    if (shapes.get(dl[0]) or '').startswith(Z2_MAIL_ICON): raise UiChanged('guard_refused:mail_icon')
    lines = p.page_lines()
    if not any(l in Z2_DOWNLOAD_LABELS for l in lines): raise UiChanged('z2_download_label')
    t0 = p.pb.now()
    p.pb.act([{'kind': 'click', 'ref': dl[0]}], downloads=folder)   # a not-yet-built report is generated first (~30 s)
    log.step('z2_download', matched='Download report (icon)')
    path = wait_file(p, folder, 'Zomato_Settlement_Report_*.xlsx', t0, 150)
    if not path: raise DownloadFailed('z2_download_timeout')
    return path

def swiggy_payout(p: Page, ps, pe, folder, log, rid):
    """S2: Finance > Overview > the Paid cycle card for [ps, pe) > See details > Payout Annexures. Returns the file path."""
    label, a, b = swiggy_cycle_label(ps, pe)
    want = re.compile(r'Payout period ' + re.escape(label) + r' ')
    for attempt in range(2):
        p.pb.navigate(SWIGGY_FINANCE_URL)
        cards = []
        for _ in range(15):
            time.sleep(2)
            d = p.snap()
            if '/login' in d['url']: raise SignedOut()
            cards = [c for c in d['controls'] if c['role'] == 'button' and c['ntext'].startswith('FINAL PAYOUT')]
            if cards: break
        if cards: break
    if not cards: raise UiChanged('s2_no_payout_cards')
    if not any(re.search(r'\(%s\)$' % re.escape(rid), c['ntext']) for c in d['controls'] if c['role'] == 'generic'):
        raise UiChanged('s2_outlet_not_selected')   # this account is showing another outlet; never download it
    for more in range(3):
        hit = [c for c in cards if want.search(c['ntext'])]
        if hit: break
        if not p.find_all('VIEW MORE', role='button', snap=d): break
        gclick(p, 'VIEW MORE', role='button', step='s2_view_more', settle=3)
        d = p.snap(); cards = [c for c in d['controls'] if c['role'] == 'button' and c['ntext'].startswith('FINAL PAYOUT')]
    if not hit: raise NotListed('s2_cycle_not_listed')
    if len(hit) != 1: raise UiChanged('s2_cycle_card_ambiguous')
    if not re.search(r'\bPaid\b', hit[0]['ntext']): raise NotAvailable('cycle not paid yet')
    log.step('s2_cycle_card', result='ok', matched='Payout period ' + label)
    p.click_ref(hit[0]['ref'], step='s2_see_details'); time.sleep(3)
    want_url = f'/past-payout/{rid}/'
    q = f'from={a.isoformat()}&to={b.isoformat()}'
    for _ in range(10):
        d = p.snap()
        if want_url in d['url'] and q in d['url'] and p.find_all('Payout Annexures', snap=d): break
        time.sleep(1.5)
    else:
        raise UiChanged('s2_details_page')
    log.step('s2_details', result='ok', matched='past-payout/' + rid + ' ' + q)
    btn = p.find('Payout Annexures', step='s2_annexure', snap=d)
    guard(btn['ntext'])
    t0 = p.pb.now()
    p.pb.act([{'kind': 'click', 'ref': btn['ref']}], downloads=folder)
    log.step('s2_annexure', matched='Payout Annexures')
    # live2 quirk: the annexure can arrive under a random name; take the newest .xlsx and check its content later
    path = wait_file(p, folder, '*.xlsx', t0, 150)
    if not path: raise DownloadFailed('s2_download_timeout')
    time.sleep(3)   # the page stays busy for a while after a download
    return path
