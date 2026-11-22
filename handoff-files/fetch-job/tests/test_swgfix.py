"""swgfix (15 Nov): layout_changed is logged as its own status and never retried; auto-login guards (INR 0, offline)."""
import sys, os, json
from datetime import datetime
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import run_night, recipes, identity, auto_login
from test_held_and_mismatch import FakePB, FakeLog, OUTLET, W

class Api:
    def __init__(self, upload=None): self.calls = []; self.upload = upload
    def post(self, path, body, tries=3):
        self.calls.append((path, body.get('status'), body.get('reason')))
        if path == '/agent/v1/fetches/check': return 200, {'files': [{'stored': False}]}
        if path in ('/agent/v1/metric-reports', '/agent/v1/payout-reports'): return self.upload
        return 201, {}

def test_local_layout_changed_business(monkeypatch):
    monkeypatch.setattr(recipes, 'zomato_business', lambda *a, **k: ('/home/rakazo/x.csv', '2026-11-14'))
    monkeypatch.setattr(identity, 'check', lambda *a, **k: {'ok': False, 'layout': True, 'reject': 'header changed'})
    api = Api(); pb = FakePB()
    res = run_night.do_window(api, None, pb, FakeLog(), 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', W)
    assert res['status'] == 'layout_changed' and res['attempts'] == 1 and res['mismatches'] == 0
    assert [(p, s) for p, s, _ in api.calls] == [('/agent/v1/fetches', 'layout_changed')]   # never local_mismatch, never uploaded
    assert pb.removed

def test_server_layout_changed_business_not_retried(monkeypatch):
    monkeypatch.setattr(recipes, 'zomato_business', lambda *a, **k: ('/home/rakazo/x.csv', '2026-11-14'))
    monkeypatch.setattr(identity, 'check', lambda *a, **k: {'ok': True, 'rows': 3, 'warnings': []})
    api = Api((422, {'code': 'layout_changed', 'status': 'parse_failed', 'fetchId': 'f9'}))
    res = run_night.do_window(api, None, FakePB(), FakeLog(), 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', W)
    assert res['status'] == 'layout_changed' and res['attempts'] == 1
    assert sum(1 for p, *_ in api.calls if p == '/agent/v1/metric-reports') == 1

def test_local_layout_changed_payout(monkeypatch):
    monkeypatch.setattr(recipes, 'swiggy_payout', lambda *a, **k: '/home/rakazo/p.xlsx')
    monkeypatch.setattr(recipes, 'is_zip', lambda b: True)
    monkeypatch.setattr(identity, 'check', lambda *a, **k: {'ok': False, 'parseFailed': True, 'layout': True, 'reject': 'anchor column missing'})
    api = Api(); pb = FakePB(); w = dict(W, report='payout')
    res = run_night.do_window(api, None, pb, FakeLog(), 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'swiggy', '900002', w)
    assert res['status'] == 'layout_changed' and res['attempts'] == 1
    assert [(p, s) for p, s, _ in api.calls] == [('/agent/v1/fetches', 'layout_changed')]
    assert pb.removed

CFG = {'slug': 'test-rest', 'fetch_bot_id': 'b1', 'session_file': '/dev/null'}

def test_login_not_for_zomato():
    assert auto_login.attempt('zomato', CFG, 'r', FakeLog())['result'] == 'not_supported'

def test_login_window(monkeypatch):
    from datetime import timezone, timedelta
    IST = timezone(timedelta(hours=5, minutes=30))
    assert auto_login.in_window(datetime(2026, 11, 16, 5, 30, tzinfo=IST))
    assert not auto_login.in_window(datetime(2026, 11, 16, 7, 30, tzinfo=IST))
    monkeypatch.setattr(auto_login, 'in_window', lambda now=None: False)
    assert auto_login.attempt('swiggy', CFG, 'r', FakeLog())['result'] == 'outside_login_window'

def test_login_needs_credentials(monkeypatch):
    monkeypatch.delenv('TESTREST_SWG_PASS', raising=False)
    cfg = dict(CFG, logins={'swiggy': {'username_env': 'TESTREST_SWG_USER', 'password_env': 'TESTREST_SWG_PASS'}})
    r = auto_login.attempt('swiggy', cfg, 'r', FakeLog(), allow_any_time=True)
    assert r == {'attempted': False, 'result': 'no_credentials', 'cost_inr': 0.0, 'cap_inr': auto_login.CAP_INR}

def test_login_once_per_night(monkeypatch, tmp_path):
    monkeypatch.setattr(auto_login, 'HERE', str(tmp_path))
    monkeypatch.setenv('TESTREST_SWG_USER', 'u'); monkeypatch.setenv('TESTREST_SWG_PASS', 'p'); monkeypatch.setenv('OPENROUTER_API_KEY', 'k')
    monkeypatch.setattr(auto_login, 'api_has_model_key', lambda *a: True)
    monkeypatch.setattr(auto_login, '_port_open', lambda port: False)
    cfg = dict(CFG, logins={'swiggy': {'username_env': 'TESTREST_SWG_USER', 'password_env': 'TESTREST_SWG_PASS'}})
    d = tmp_path / 'logs' / 'login-attempts'; d.mkdir(parents=True)
    night = datetime.now(auto_login.IST).date().isoformat()
    (d / f'{night}-test-rest-swiggy.json').write_text('{}')
    r = auto_login.attempt('swiggy', cfg, 'r', FakeLog(), allow_any_time=True)
    assert r['result'] == 'already_attempted_tonight' and not r['attempted']
