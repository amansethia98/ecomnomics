"""blankday (15 Nov): a day the platform has not filled in yet (all zeros / rating 0.00 + 0 orders) is never stored (INR 0, offline)."""
import csv, io, os, sys, hashlib
from datetime import datetime, timedelta, timezone
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import blankday, run_night, recipes, identity, convert
from test_held_and_mismatch import FakeLog, OUTLET
from test_t1 import IMG, FX, SWG

IST = timezone(timedelta(hours=5, minutes=30))
TODAY = datetime.now(IST).date()

def zomato_csv(start, blank_cols=(), mutate=None):
    """The repo's Zomato daily fixture, relabelled to 7 days from `start`, with chosen columns zeroed like 14 Nov."""
    t = list(csv.reader(io.StringIO(open(f'{FX}/metrics/zomato_daily_sample.csv').read())))
    days = [start + timedelta(days=i) for i in range(7)]
    t[0] = t[0][:6] + [d.strftime('%d %b, %Y') for d in days]
    for r in t[1:]:
        for c in blank_cols:
            if len(r) > 6 + c: r[6 + c] = '0.00' if 'rating' in r[5].lower() else '0'
        if mutate: mutate(r)
    b = io.StringIO(); csv.writer(b, lineterminator='\n').writerows(t); return b.getvalue(), days

def ident(csv_text, days):
    return identity.check(IMG, 'business', 'zomato', 'daily', days[0].isoformat(), (days[-1] + timedelta(days=1)).isoformat(),
                          '900002', 'Test Kitchen', 'Testcity', csv_text=csv_text)

def test_trailing_blank_day_found_and_cut_and_server_sees_a_gap():
    text, days = zomato_csv(TODAY - timedelta(days=7), blank_cols=(6,))
    blanks = blankday.find_blank_days(text, TODAY)
    assert blanks == [{'col': 6, 'date': days[6].isoformat(), 'rule': 'all_zero'}]
    posted, b = blankday.guard(text, TODAY)
    assert posted is not None and b == blanks and blankday.date_columns(posted) == 6
    hdr = next(csv.reader(io.StringIO(posted)))
    assert days[6].strftime('%d %b, %Y') not in hdr and days[5].strftime('%d %b, %Y') in hdr
    chk = ident(posted, days)                       # the repo's own server-side code: accepted, the cut day is a gap
    assert chk['ok'], chk
    assert [p['start'] for p in chk['periods']] == [d.isoformat() for d in days[:6]] and chk['rows'] > 0

def test_middle_blank_day_cut_rest_kept():
    text, days = zomato_csv(TODAY - timedelta(days=6), blank_cols=(4,))   # day 4 = 2 days ago
    posted, b = blankday.guard(text, TODAY)
    assert [x['date'] for x in b] == [days[4].isoformat()]
    chk = ident(posted, days)
    assert chk['ok'] and days[4].isoformat() not in [p['start'] for p in chk['periods']] and len(chk['periods']) == 6

def test_rating_zero_with_zero_orders_is_blank_even_if_online_is_not():
    def m(r):
        if r[5] == 'Online %': r[12] = '80'
    text, days = zomato_csv(TODAY - timedelta(days=7), blank_cols=(6,), mutate=m)
    assert blankday.find_blank_days(text, TODAY)[0]['rule'] == 'rating0_orders0'

def test_real_quiet_day_is_kept():
    # zero orders but a real rating and online time: not blank
    def m(r):
        if r[5] == 'Average rating': r[12] = '4.2'
        if r[5] == 'Online %': r[12] = '91'
    text, _ = zomato_csv(TODAY - timedelta(days=7), blank_cols=(6,), mutate=m)
    assert blankday.find_blank_days(text, TODAY) == []
    # one delivered order: not blank
    def m2(r):
        if r[5] == 'Delivered orders': r[12] = '1'
    text, _ = zomato_csv(TODAY - timedelta(days=7), blank_cols=(6,), mutate=m2)
    assert blankday.find_blank_days(text, TODAY) == []

def test_normal_file_untouched_byte_for_byte():
    text, _ = zomato_csv(TODAY - timedelta(days=7))
    posted, b = blankday.guard(text, TODAY)
    assert b == [] and posted is text

def test_old_all_zero_day_is_a_real_closed_day():
    text, days = zomato_csv(TODAY - timedelta(days=12), blank_cols=(0, 1))   # 12 and 11 days old
    assert blankday.find_blank_days(text, TODAY) == []
    assert blankday.find_blank_days(text, TODAY, lag_days=20)                  # the lag window is the only reason

def test_every_day_blank_posts_nothing():
    from datetime import date
    text, _ = zomato_csv(date(2026, 11, 8), blank_cols=range(7))
    posted, b = blankday.guard(text, date(2026, 11, 15), lag_days=10)
    assert posted is None and len(b) == 7
    one, _ = zomato_csv(TODAY - timedelta(days=1), blank_cols=range(7))
    t = list(csv.reader(io.StringIO(one))); t = [r[:7] for r in t]
    b2 = io.StringIO(); csv.writer(b2, lineterminator='\n').writerows(t)
    posted, b = blankday.guard(b2.getvalue(), TODAY)
    assert posted is None and len(b) == 1

def test_swiggy_converted_csv_blank_day():
    text = convert.swiggy_xlsx_to_csv(open(f'{SWG}/swiggy_daily_02nov_08nov.xlsx', 'rb').read())
    t = list(csv.reader(io.StringIO(text)))
    days = [TODAY - timedelta(days=7 - i) for i in range(len(t[0]) - 6)]
    t[0] = t[0][:6] + [f"{recipes.ordinal(d.day)} {d.strftime('%b %Y')}" for d in days]
    for r in t[1:]:
        if len(r) > 6:
            v = r[-1]; r[-1] = ('₹0' if '₹' in v else '0%' if v.endswith('%') else '0 min' if v.endswith('min') else '0')
    b = io.StringIO(); csv.writer(b, lineterminator='\n').writerows(t)
    blanks = blankday.find_blank_days(b.getvalue(), TODAY)
    assert [x['date'] for x in blanks] == [days[-1].isoformat()] and blanks[0]['rule'] == 'all_zero'
    real = blankday.find_blank_days(text.replace('2nd Nov 2026', 'x'), TODAY)
    assert real == []

def test_label_dates_and_cells():
    assert blankday.label_date('14 Nov, 2026').isoformat() == '2026-11-14'
    assert blankday.label_date('2nd Nov 2026').isoformat() == '2026-11-02'
    assert blankday.label_date('Week 45') is None
    assert [blankday.cell_value(x) for x in ['₹0', '0.00', '0%', '0 min', '', '-', 'NA', '1,234.5']] == [0, 0, 0, 0, None, None, None, 1234.5]

# ---- run_night.do_window wiring ----
class PB:
    def __init__(self, data): self.data = data; self.removed = []
    def read_file(self, p): return self.data
    def remove(self, p): self.removed.append(p); return True
class Api:
    def __init__(self): self.calls = []
    def post(self, path, body, tries=3):
        self.calls.append((path, body))
        if path == '/agent/v1/fetches/check': return 200, {'files': [{'stored': False}]}
        if path == '/agent/v1/metric-reports': return 200, {'status': 'stored', 'fetchId': 'f1', 'written': 9}
        return 201, {}

def _run(monkeypatch, text, days):
    w = {'report': 'daily', 'periodStart': days[0].isoformat(), 'periodEnd': (days[-1] + timedelta(days=1)).isoformat(), 'reasons': ['scheduled']}
    monkeypatch.setattr(recipes, 'zomato_business', lambda *a, **k: ('/home/rakazo/x.csv', w['periodEnd']))
    seen = {}
    monkeypatch.setattr(identity, 'check', lambda *a, **k: (seen.setdefault('csv', k.get('csv_text')), {'ok': True, 'rows': 3, 'warnings': []})[1])
    api = Api(); pb = PB(text.encode()); log = FakeLog()
    res = run_night.do_window(api, None, pb, log, 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', w)
    return res, api, pb, log, seen

def test_window_with_blank_day_posts_trimmed_file_without_raw_hash(monkeypatch):
    text, days = zomato_csv(TODAY - timedelta(days=7), blank_cols=(6,))
    res, api, pb, log, seen = _run(monkeypatch, text, days)
    assert res['status'] == 'stored' and res['blankDays'] == [days[6].isoformat()]
    assert ('blank_day', 'not_in_yet') in log.steps
    chk = [b for p, b in api.calls if p == '/agent/v1/fetches/check'][0]['files'][0]
    up = [b for p, b in api.calls if p == '/agent/v1/metric-reports'][0]
    assert 'rawSha256' not in chk and 'rawSha256' not in up
    assert days[6].strftime('%d %b, %Y') not in up['csv'] and blankday.date_columns(up['csv']) == 6
    assert seen['csv'] == up['csv']                     # the local identity check saw exactly what is posted
    assert chk['sha256'] == hashlib.sha256(up['csv'].encode()).hexdigest()
    assert up['periodStart'] == days[0].isoformat() and up['periodEnd'] == (days[-1] + timedelta(days=1)).isoformat()
    assert pb.removed

def test_window_all_blank_posts_nothing(monkeypatch):
    text, days = zomato_csv(TODAY - timedelta(days=1), blank_cols=range(7))
    t = [r[:7] for r in csv.reader(io.StringIO(text))]
    b = io.StringIO(); csv.writer(b, lineterminator='\n').writerows(t)
    res, api, pb, log, _ = _run(monkeypatch, b.getvalue(), days[:1])
    assert res['status'] == 'not_in_yet' and res['reason'] == 'blank_day'
    assert api.calls == [] and pb.removed                # nothing posted, no failure row, the file is deleted

def test_window_without_blank_day_unchanged(monkeypatch):
    text, days = zomato_csv(TODAY - timedelta(days=7))
    res, api, pb, log, _ = _run(monkeypatch, text, days)
    up = [b for p, b in api.calls if p == '/agent/v1/metric-reports'][0]
    chk = [b for p, b in api.calls if p == '/agent/v1/fetches/check'][0]['files'][0]
    assert up['csv'] == text and up['rawSha256'] == hashlib.sha256(text.encode()).hexdigest() and chk['rawSha256'] == up['rawSha256']
    assert 'blankDays' not in res and not any(s == 'blank_day' for s, _ in log.steps)

def test_the_14_nov_case():
    """15 Nov 01:01 run: window 08..15, Sat 14 Nov all zeros -> cut. Tonight 16 Nov 05:30: 14 Nov real, 15 Nov blank -> only 15 cut."""
    from datetime import date
    text, days = zomato_csv(date(2026, 11, 8), blank_cols=(6,))
    posted, b = blankday.guard(text, date(2026, 11, 15))
    assert [x['date'] for x in b] == ['2026-11-14'] and blankday.date_columns(posted) == 6
    text, days = zomato_csv(date(2026, 11, 9), blank_cols=(6,))
    posted, b = blankday.guard(text, date(2026, 11, 16))
    assert [x['date'] for x in b] == ['2026-11-15'] and '14 Nov, 2026' in posted.splitlines()[0]
