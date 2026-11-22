"""T1 (offline, INR 0): identity precheck through the repo's own code, wrong-outlet rejects, xlsx->CSV, sha logic, guards."""
import hashlib, sys, os
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import identity, convert, recipes
from ui import UiChanged
IMG = os.environ.get('APP_IMAGE') or (os.popen("sudo -n docker inspect ecomnomics-agentv1-api-1 --format '{{.Config.Image}}' 2>/dev/null").read().strip() or 'ecomnomics/main-app:9b9ef0343')
FX = os.environ.get('ECOM_FIXTURES', '/workspace/ecomnomics/packages/contracts/fixtures')
SWG = '/workspace/ops-skill/validation/swiggy'
def chk(**k): return identity.check(IMG, **k)

def test_zomato_daily_fixture_passes_and_rejects():
    csv = open(f'{FX}/metrics/zomato_daily_sample.csv').read()
    ok = chk(kind='business', platform='zomato', report='daily', period_start='2026-10-01', period_end='2026-10-08', restaurant_id='900002', name='Test Kitchen', city='Testcity', csv_text=csv)
    assert ok['ok'], ok
    wrong = chk(kind='business', platform='zomato', report='daily', period_start='2026-10-01', period_end='2026-10-08', restaurant_id='999002', name='Test Kitchen', city='Testcity', csv_text=csv)
    assert not wrong['ok'] and 'not 999002' in wrong['reject']
    dates = chk(kind='business', platform='zomato', report='daily', period_start='2026-10-02', period_end='2026-10-09', restaurant_id='900002', name='Test Kitchen', city='Testcity', csv_text=csv)
    assert not dates['ok'] and 'Column' in dates['reject']

def test_swiggy_daily_fixture_and_7_day_cap():
    csv = open(f'{FX}/metrics/swiggy_daily_sample.csv').read()
    assert chk(kind='business', platform='swiggy', report='daily', period_start='2026-11-02', period_end='2026-11-09', restaurant_id='900001', name='Test Kitchen', city='Testcity', csv_text=csv)['ok']
    wrong = chk(kind='business', platform='swiggy', report='daily', period_start='2026-11-02', period_end='2026-11-09', restaurant_id='${SWIGGY_RID}', name='x', city='y', csv_text=csv)
    assert not wrong['ok']
    cap = chk(kind='business', platform='swiggy', report='daily', period_start='2026-11-01', period_end='2026-11-09', restaurant_id='900001', name='Test Kitchen', city='Testcity', csv_text=csv)
    assert not cap['ok'] and '7 days' in cap['reject']

def test_payout_wrong_outlet_fixtures_rejected():
    for plat, good, bad, ps, pe in [('swiggy', '900001', '999001', '2026-10-25', '2026-11-01'), ('zomato', '900002', '999002', '2026-10-26', '2026-11-02')]:
        g = chk(kind='payout', platform=plat, report='payout', period_start=ps, period_end=pe, restaurant_id=good, name='Test Kitchen', city='Testcity', data=open(f'{FX}/payouts/{plat}-{good}.xlsx', 'rb').read())
        assert g['ok'], (plat, g)
        b = chk(kind='payout', platform=plat, report='payout', period_start=ps, period_end=pe, restaurant_id=good, name='Test Kitchen', city='Testcity', data=open(f'{FX}/payouts/{plat}-{bad}-wrong-outlet.xlsx', 'rb').read())
        assert not b['ok'] and bad in b['reject'], (plat, b)

def test_swiggy_xlsx_to_csv_matches_reference_cells():
    for n in ['swiggy_daily_02nov_08nov', 'swiggy_weekly_11oct_07nov', 'swiggy_monthly_may_oct']:
        got = convert.swiggy_xlsx_to_csv(open(f'{SWG}/{n}.xlsx', 'rb').read())
        ref = open(f'{SWG}/{n}.csv', newline='').read()
        assert got.splitlines() == ref.splitlines(), n

def test_raw_sha_is_stable_and_differs_from_content_sha():
    raw = open(f'{SWG}/swiggy_daily_02nov_08nov.xlsx', 'rb').read()
    a = hashlib.sha256(raw).hexdigest(); b = hashlib.sha256(convert.swiggy_xlsx_to_csv(raw).encode()).hexdigest()
    assert a == hashlib.sha256(raw).hexdigest() and a != b

def test_guards_refuse_dangerous_controls():
    for t in ['Download phone numbers', 'Send report to email', 'Share', 'Online', 'Resend OTP', 'Logout']:
        try: recipes.guard(t); assert False, t
        except UiChanged: pass
    for t in ['Download Report', 'Raise a Request', 'Generate', 'CONTINUE', 'Business reports', 'Confirm', 'Apply']:
        recipes.guard(t)

def test_ordinals():
    assert [recipes.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30)] == ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '30th']
