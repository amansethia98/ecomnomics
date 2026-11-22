"""T5-style offline drills: 423 fetch_held stops without retry; 3 local mismatches stop the window and are logged."""
import sys, types
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import run_night, recipes, identity

class FakePB:
    def __init__(self): self.removed = []
    def read_file(self, p): return b'Restaurant ID,x\n1,2\n'
    def remove(self, p): self.removed.append(p); return True
class FakeLog:
    plan_date = '2026-11-14'; ctx = {}
    def __init__(self): self.steps = []
    def step(self, s, **k): self.steps.append((s, k.get('result')))
class FakeApi:
    def __init__(self, upload_code): self.calls = []; self.upload_code = upload_code
    def post(self, path, body, tries=3):
        self.calls.append((path, body.get('status')))
        if path == '/agent/v1/fetches/check': return 200, {'files': [{'stored': False}]}
        if path == '/agent/v1/metric-reports': return self.upload_code, ({'code': 'fetch_held'} if self.upload_code == 423 else {'status': 'stored', 'fetchId': 'f1', 'written': 3})
        return 201, {}
OUTLET = {'outletId': 'o1', 'name': 'Test', 'city': 'Testcity'}
W = {'report': 'daily', 'periodStart': '2026-11-07', 'periodEnd': '2026-11-14', 'reasons': ['scheduled']}

def setup(mp, monkey_ok=True):
    mp.setattr(recipes, 'zomato_business', lambda *a, **k: ('/home/rakazo/x.csv', '2026-11-14'))
    mp.setattr(identity, 'check', lambda *a, **k: ({'ok': True, 'rows': 3, 'warnings': []} if monkey_ok else {'ok': False, 'reject': 'The file is for restaurant 999002, not 900002.', 'restaurantId': '999002'}))

def test_423_is_not_retried(monkeypatch):
    setup(monkeypatch); api = FakeApi(423); pb = FakePB(); log = FakeLog()
    res = run_night.do_window(api, None, pb, log, 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', W)
    assert res['status'] == 'fetch_held' and res['attempts'] == 1
    assert sum(1 for p, _ in api.calls if p == '/agent/v1/metric-reports') == 1 and pb.removed

def test_three_local_mismatches_logged_and_stop(monkeypatch):
    setup(monkeypatch, False); api = FakeApi(200); pb = FakePB(); log = FakeLog()
    res = run_night.do_window(api, None, pb, log, 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', W)
    assert res['mismatches'] == 3
    assert [s for p, s in api.calls if p == '/agent/v1/fetches'] == ['local_mismatch'] * 3
    assert not any(p == '/agent/v1/metric-reports' for p, _ in api.calls)   # another outlet's file is never uploaded
    assert len(pb.removed) == 3

def test_budget_limits_attempts_after_earlier_mismatches(monkeypatch):
    setup(monkeypatch, False); api = FakeApi(200); pb = FakePB(); log = FakeLog()
    res = run_night.do_window(api, None, pb, log, 'img', 'run', 'f', {'name': 'R'}, OUTLET, 'zomato', '900002', W, budget=1)
    assert res['mismatches'] == 1
