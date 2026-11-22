"""--from/--to backfill: chunk sizes, range clamps, overlap/cap behaviour (offline, INR 0)."""
import sys
from datetime import date, timedelta
import pytest
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import backfill, recipes, run_night, identity
from test_held_and_mismatch import FakePB, FakeLog, FakeApi, OUTLET, setup

TODAY = date(2026, 11, 16)
START = date(2026, 8, 24)
END = date(2026, 11, 15)   # 12 weeks inclusive = 84 days


def days_in(windows):
    n = 0
    for w in windows:
        n += (date.fromisoformat(w['periodEnd']) - date.fromisoformat(w['periodStart'])).days
    return n


def test_12_weeks_is_chunked_to_app_limits():
    z = backfill.windows('zomato', START, END)
    s = backfill.windows('swiggy', START, END)
    assert [(w['periodStart'], w['periodEnd']) for w in z] == [
        ('2026-08-24', '2026-09-23'),
        ('2026-09-23', '2026-10-23'),
        ('2026-10-23', '2026-11-16'),
    ]
    assert days_in(z) == 84 and days_in(s) == 84
    assert len(s) == 12
    assert s[0] == {'report': 'daily', 'reasons': ['backfill'], 'periodStart': '2026-08-24', 'periodEnd': '2026-08-31'}
    assert s[-1]['periodStart'] == '2026-11-09' and s[-1]['periodEnd'] == '2026-11-16'
    assert all((date.fromisoformat(w['periodEnd']) - date.fromisoformat(w['periodStart'])).days <= 30 for w in z)
    assert all((date.fromisoformat(w['periodEnd']) - date.fromisoformat(w['periodStart'])).days <= 7 for w in s)
    # last Swiggy chunk overlaps the already-stored 9-15 Nov week; the sha/supersede path handles that
    assert s[-1]['periodStart'] <= '2026-11-09' < s[-1]['periodEnd']


def test_exact_and_over_chunk_split():
    assert len(backfill.windows('zomato', date(2026, 10, 1), date(2026, 10, 30))) == 1
    z = backfill.windows('zomato', date(2026, 10, 1), date(2026, 10, 31))
    assert [(w['periodStart'], w['periodEnd']) for w in z] == [('2026-10-01', '2026-10-31'), ('2026-10-31', '2026-11-01')]
    assert len(backfill.windows('swiggy', date(2026, 11, 1), date(2026, 11, 7))) == 1
    assert len(backfill.windows('swiggy', date(2026, 11, 1), date(2026, 11, 8))) == 2


def test_single_day_and_empty():
    w = backfill.windows('zomato', date(2026, 11, 1), date(2026, 11, 1))
    assert w == [{'report': 'daily', 'reasons': ['backfill'], 'periodStart': '2026-11-01', 'periodEnd': '2026-11-02'}]
    assert backfill.windows('swiggy', date(2026, 11, 2), date(2026, 11, 1)) == []


def test_parse_range_clamps_to_yesterday_and_rejects_bad_input():
    assert backfill.parse_range('2026-08-24', '2026-11-15', TODAY) == (START, END)
    # today and later are clamped to yesterday
    assert backfill.parse_range('2026-08-24', '2026-11-16', TODAY) == (START, date(2026, 11, 15))
    assert backfill.parse_range('2026-08-24', '2026-12-01', TODAY) == (START, date(2026, 11, 15))
    with pytest.raises(backfill.BackfillError, match='together'):
        backfill.parse_range('2026-08-24', None, TODAY)
    with pytest.raises(backfill.BackfillError, match='before'):
        backfill.parse_range('2026-11-15', '2026-08-24', TODAY)
    with pytest.raises(backfill.BackfillError, match='YYYY-MM-DD'):
        backfill.parse_range('24-08-2026', '2026-11-15', TODAY)
    with pytest.raises(backfill.BackfillError, match='yesterday'):
        backfill.parse_range('2026-11-16', '2026-11-20', TODAY)
    with pytest.raises(backfill.BackfillError, match='unknown platform'):
        backfill.chunk_days('uber')


def test_plan_builds_daily_only():
    p = backfill.plan(['zomato', 'swiggy'], START, END, reports=('daily', 'weekly', 'payout'))
    assert set(p) == {'zomato', 'swiggy'}
    assert all(w['report'] == 'daily' for w in p['zomato'] + p['swiggy'])
    assert backfill.plan(['zomato'], START, END, reports=('weekly',))['zomato'] == []


def test_first_enabled_walks_forward():
    days = [START + timedelta(i) for i in range(10)]
    assert recipes.first_enabled(days, lambda d: d >= date(2026, 8, 27)) == date(2026, 8, 27)
    assert recipes.first_enabled(days, lambda d: True) == START
    assert recipes.first_enabled(days, lambda d: False) is None


def test_history_unavailable_is_not_deferred_and_not_uploaded(monkeypatch):
    def boom(*a, **k):
        raise recipes.HistoryUnavailable('z1_start_day:history_unavailable')
    monkeypatch.setattr(recipes, 'zomato_business', boom)
    monkeypatch.setattr(identity, 'check', lambda *a, **k: {'ok': True, 'rows': 0, 'warnings': []})
    api, pb, log = FakeApi(200), FakePB(), FakeLog()
    w = {'report': 'daily', 'periodStart': '2026-08-24', 'periodEnd': '2026-09-23', 'reasons': ['backfill']}
    res = run_night.do_window(api, None, pb, log, 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', w)
    assert res['status'] == 'not_available' and res['reason'] == 'history_unavailable'
    assert res.get('retry') != '08:00' and res.get('alert') != 'deferred_to_0800'
    assert not any(path == '/agent/v1/metric-reports' for path, _ in api.calls)


def test_clamped_start_body(monkeypatch):
    """If the calendar started later than the plan, identity and upload use the effective start."""
    bodies = []
    class Api(FakeApi):
        def post(self, path, body, tries=3):
            bodies.append((path, body))
            return super().post(path, body, tries)
    setup(monkeypatch)
    monkeypatch.setattr(recipes, 'zomato_business', lambda *a, **k: ('/home/rakazo/x.csv', '2026-09-23'))
    api, pb, log = Api(200), FakePB(), FakeLog()
    log.effective_period = ('2026-09-01', '2026-09-23')
    w = {'report': 'daily', 'periodStart': '2026-08-24', 'periodEnd': '2026-09-23', 'reasons': ['backfill']}
    res = run_night.do_window(api, None, pb, log, 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', w)
    assert res['status'] == 'stored'
    uploaded = [b for p, b in bodies if p == '/agent/v1/metric-reports']
    assert uploaded and uploaded[0]['periodStart'] == '2026-09-01' and uploaded[0]['periodEnd'] == '2026-09-23'
    ident = [b for p, b in bodies if p == '/agent/v1/fetches/check']
    assert ident and ident[0]['files'][0]['periodStart'] == '2026-09-01'


def test_sha_skip_on_already_stored_file_is_not_written_again(monkeypatch):
    """Overlap with a day already stored: the sha check skips, no second write."""
    setup(monkeypatch)
    class Api(FakeApi):
        def post(self, path, body, tries=3):
            self.calls.append((path, body))
            if path == '/agent/v1/fetches/check':
                return 200, {'files': [{'stored': True, 'fetchId': 'already'}]}
            return super().post(path, body, tries)
    api, pb, log = Api(200), FakePB(), FakeLog()
    w = {'report': 'daily', 'periodStart': '2026-11-09', 'periodEnd': '2026-11-16', 'reasons': ['backfill']}
    res = run_night.do_window(api, None, pb, log, 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', w)
    assert res['status'] == 'skipped' and res['fetchId'] == 'already' and res['rowsWritten'] == 0
    assert not any(p == '/agent/v1/metric-reports' for p, _ in api.calls)


def test_cap_reached():
    assert backfill.cap_reached(150, 150) and backfill.cap_reached(150.01, 150)
    assert not backfill.cap_reached(149.99, 150) and not backfill.cap_reached(0, 150)
