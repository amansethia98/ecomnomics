"""AI fallback + learn (16 Nov 2026): one test per edge case in AI-FALLBACK-EDGE-CASES.md. Offline, INR 0 (the model is faked)."""
import json, os, re, sys, time, types
import pytest
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import aifallback as af, recipes, run_night, identity, retryq, scrub
from ui import Page, UiChanged

PS, PE = '2026-11-09', '2026-11-16'
OUT = {'outletId': 'o1', 'name': 'Test Outlet', 'city': 'Testcity'}
WIN = {'report': 'weekly', 'periodStart': PS, 'periodEnd': PE, 'reasons': ['scheduled']}
ZURL = 'https://www.zomato.com/partners/onlineordering/reporting/'

# ---------------- a fake Zomato weekly page (new week-list picker) ----------------
class Machine:
    def __init__(self, picker='weeks', popup=False, outlet='Test Outlet', other_outlet=None, never_file=False, wrong_file=False):
        self.picker, self.popup0, self.outlet, self.other, self.never_file, self.wrong_file = picker, popup, outlet, other_outlet, never_file, wrong_file
        self.url = ZURL; self.generated = None; self.clicks = []; self.reset()
    def reset(self):
        self.custom = self.dropdown = False; self.selected = None; self.popup = self.popup0; self.shown_outlet = self.outlet
    def controls(self):
        c = [('generic', 'Business reports'), ('generic', 'Generate report'), ('generic', 'You are generating a report for'),
             ('generic', self.shown_outlet), ('generic', 'Detailed report'), ('generic', 'Daily'), ('generic', 'Weekly'), ('generic', 'Monthly'),
             ('generic', 'Last 4 weeks'), ('generic', 'Custom'), ('generic', 'Custom'), ('link', 'Help centre'), ('generic', 'Share feedback'), ('generic', 'Online')]
        if self.other: c.append(('generic', 'Switch outlet: ' + self.other))
        if self.custom:
            c += [('generic', 'Select weeks')] if self.picker == 'weeks' else [('generic', 'Select date range')]
        if self.dropdown:
            c += [('generic', '16 - 15 Nov 2026 Current week'), ('generic', '9 - 15 Nov 2026'), ('generic', '2 - 8 Nov 2026')]
        if self.popup: c += [('dialog', 'New: weekly reports'), ('button', 'Got it')]
        c.append(('generic', 'Generate'))
        return c
    def lines(self):
        L = [t for r, t in self.controls() if r != 'dialog']
        L.insert(3, 'You are generating a report for ' + self.shown_outlet)
        if self.selected: L.append('Selected: ' + self.selected)
        return L
    def click(self, role, text, downloads=None):
        self.clicks.append(text)
        if self.popup and text != 'Got it': return
        if text == 'Got it': self.popup = False
        elif text == 'Custom': self.custom = True
        elif text == 'Select weeks' and self.custom: self.dropdown = True
        elif self.dropdown and re.match(r'^\d', text): self.selected = text.replace(' Current week', ''); self.dropdown = False
        elif text.startswith('Switch outlet: '): self.shown_outlet = text.split(': ', 1)[1]
        elif text == 'Generate' and self.selected and not self.never_file: self.generated = self.selected
        elif text == 'Help centre': self.url = 'https://www.zomato.com/help'

class FakePB:
    def __init__(self, m): self.m = m; self.gen = 0; self.refs = {}; self.removed = []
    def bump(self):
        self.gen += 1; self.refs = {f'g{self.gen}_{i}': c for i, c in enumerate(self.m.controls())}
        return self.refs
    def navigate(self, url, downloads=None): self.m.url = url; self.m.reset(); return {'ok': True}
    def snapshot(self, query=None): self.bump(); return {'ok': True, 'tree': '\n'.join(self.m.lines())}   # renumbers refs, like the real one
    def act(self, actions, downloads=None):
        for a in actions:
            c = self.refs.get(a['ref'])
            if not c: return {'ok': False, 'note': 'stale ref'}
            if a['kind'] == 'click': self.m.click(*c, downloads=downloads)
        return {'ok': True}
    def now(self): return 0.0
    def wait_download(self, folder, pattern, since, timeout=120):
        return {'ok': True, 'path': '/home/rakazo/' + folder + '/business_report_1.csv'} if self.m.generated else {'ok': False}
    def _exec(self, argv, **k): return types.SimpleNamespace(stdout=b'null', returncode=0)
    def read_file(self, p): return ('Restaurant ID,x\n' + ('999' if self.m.wrong_file else '900002') + ',2\n').encode()
    def remove(self, p): self.removed.append(p); return True

class FakePage(Page):
    def snap(self):
        refs = self.pb.bump()
        if self.pb.m.url is None: raise UiChanged('snapshot_failed')
        d = {'ok': True, 'url': self.pb.m.url, 'controls': [{'ref': r, 'role': ro, 'text': t, 'ntext': t, 'value': None, 'checked': None, 'disabled': False} for r, (ro, t) in refs.items()]}
        self.last = d; return d

class Log:
    plan_date = '2026-11-16'; ctx = {}
    def __init__(self): self.steps = []
    def step(self, s, **k): self.steps.append((s, k))
    def results(self, s): return [k.get('result') for n, k in self.steps if n == s]

# ---------------- fake model policies ----------------
def parse_controls(user):
    return [(m.group(1), m.group(2), m.group(3)) for m in re.finditer(r'^(g\d+_\d+) (\S+) "(.*?)"', user, re.M)]
def ref_of(user, text, role=None):
    hits = [r for r, ro, t in parse_controls(user) if t == text and (role is None or ro == role)]
    return hits[-1] if hits else None
def week_policy(target='9 - 15 Nov 2026'):
    def pol(user):
        sel = re.search(r'^Selected: (.*)$', user, re.M)
        if ref_of(user, 'Got it'): return {'action': 'click', 'ref': ref_of(user, 'Got it')}
        if sel and sel.group(1) == target.replace(' Current week', ''): return {'action': 'ready', 'ref': ref_of(user, 'Generate')}
        if ref_of(user, target): return {'action': 'click', 'ref': ref_of(user, target)}
        if ref_of(user, 'Select weeks'): return {'action': 'click', 'ref': ref_of(user, 'Select weeks')}
        return {'action': 'click', 'ref': ref_of(user, 'Custom')}
    return pol
def install_model(mp, policy, inr=0.5):
    calls = []
    def fake(messages, max_tokens=700):
        user = messages[-1]['content']; calls.append(user)
        o = policy(user)
        return (o, inr)
    mp.setattr(af, 'call_model', fake)
    return calls

@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    monkeypatch.setenv('ECOM_LEARNED_DIR', str(tmp_path / 'learned'))
    monkeypatch.setenv('ECOM_FETCH_LOGS', str(tmp_path / 'logs'))
    monkeypatch.setattr(time, 'sleep', lambda s: None)
    monkeypatch.setattr(run_night, 'RUN_CTX', {'slug': None, 'retry_mode': False, 'day': '2026-11-16'})
    yield

W = {'run_id': 'r1', 'outlet_name': 'Test Outlet', 'platform_id': '900002', 'city': 'Testcity', 'brand': 'Test', 'other_outlets': []}
def setup_page(**k):
    m = Machine(**k); pb = FakePB(m); return m, pb, FakePage(pb)
def obtain(page, log, prov=None, w=W, scripted=None):
    prov = {} if prov is None else prov
    sf = scripted or (lambda: recipes.zomato_business(page, 'weekly', PS, PE, 'f', log))
    rf = lambda: recipes.business_recipe('zomato', 'weekly', PS, PE, log)
    return af.obtain(page, sf, rf, 'f', log, w, prov), prov

class Api:
    def __init__(self, status='stored'): self.calls = []; self.status = status
    def post(self, path, body, tries=3):
        self.calls.append((path, body.get('status'), body.get('reason')))
        if path == '/agent/v1/fetches/check': return 200, {'files': [{'stored': False}]}
        if path == '/agent/v1/metric-reports': return 200, {'status': self.status, 'fetchId': 'f1', 'written': 50}
        return 201, {}
def window(page, pb, log, api=None, rest=None):
    return run_night.do_window(api or Api(), page, pb, log, 'img', 'r1', 'f', rest or {'name': 'Test'}, OUT, 'zomato', '900002', WIN)
def ok_identity(mp):
    mp.setattr(identity, 'check', lambda *a, **k: {'ok': True, 'rows': 50, 'warnings': []} if b'900002' in (k.get('csv_text') or '').encode() else {'ok': False, 'reject': 'The file is for restaurant 999, not 900002.'})

# ---------------- tests ----------------
def test_e01_scripted_retry_then_ok(monkeypatch):
    n = {'k': 0}
    def flaky():
        n['k'] += 1
        if n['k'] < 3: e = UiChanged('z1_open_calendar'); e.stage = 'z1_range'; raise e
        return '/p.csv', PE
    calls = install_model(monkeypatch, lambda u: pytest.fail('no AI when a retry works'))
    m, pb, page = setup_page(); log = Log()
    (path, pe), prov = obtain(page, log, scripted=flaky)
    assert path == '/p.csv' and prov['mode'] == 'scripted' and prov['scripted_tries'] == 3 and not calls

def test_e02_ai_solves_and_learns(monkeypatch):
    ok_identity(monkeypatch); calls = install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(); log = Log()
    res = window(page, pb, log)
    assert res['status'] == 'stored' and res['via'] == 'ai' and res['scripted_tries'] == 3 and res['failed_stage'] == 'z1_range'
    assert m.generated == '9 - 15 Nov 2026' and res['ai_cost_inr'] == round(0.5 * len(calls), 2)
    cur = af.LearnedStore('zomato', 'weekly').current()
    assert cur and cur['anchor'] == 'z1_range' and cur['status'] == 'promoted' and cur['version'] == 1
    assert [s['text'] for s in cur['steps']] == ['Custom', 'Select weeks', '{range_dmy}'] and cur['submit']['text'] == 'Generate'
    assert cur['evidence']['identity'] == 'ok' and cur['evidence']['upload'] == 'stored'
    assert os.path.exists(os.path.join(os.environ['ECOM_LEARNED_DIR'], 'zomato_weekly.md'))

def test_e03_learned_used_before_ai(monkeypatch):
    ok_identity(monkeypatch); install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(); window(page, pb, Log())
    calls = install_model(monkeypatch, lambda u: pytest.fail('no AI when the learned recipe works'))
    m2, pb2, page2 = setup_page(); log = Log()
    res = window(page2, pb2, log)
    assert res['status'] == 'stored' and res['via'] == 'learned' and res['scripted_tries'] == 1 and not calls
    assert af.LearnedStore('zomato', 'weekly').current()['uses'] == 1

def test_e04_stale_learned_then_ai_new_version(monkeypatch):
    ok_identity(monkeypatch); install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(); window(page, pb, Log())
    d = af.LearnedStore('zomato', 'weekly'); data = d.load(); data['current']['steps'][1]['text'] = 'Pick weeks'; d.save(data)
    calls = install_model(monkeypatch, week_policy())
    m2, pb2, page2 = setup_page(); log = Log()
    res = window(page2, pb2, log)
    assert res['status'] == 'stored' and res['via'] == 'ai' and res['learned_stale'].startswith('learned_step_2') and calls
    data = d.load()
    assert data['current']['version'] == 2 and data['current']['status'] == 'promoted' and data['history'][-1]['status'] == 'stale'

def test_e05_optional_dismiss_step_skipped(monkeypatch):
    log = Log(); m, pb, page = setup_page()
    steps = [{'op': 'click', 'role': 'button', 'text': 'Got it', 'nth': 0, 'count': 1}, {'op': 'click', 'role': 'generic', 'text': 'Custom', 'nth': 1, 'count': 2}]
    af.replay(page, steps, af.date_tokens(PS, PE, W), log, timeout=0)
    assert log.results('learned_step') == ['skipped_optional', 'ok'] and m.custom

def test_e06_ai_can_dismiss_popup(monkeypatch):
    ok_identity(monkeypatch); install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(popup=True); log = Log()
    res = window(page, pb, log)
    assert res['status'] == 'stored' and m.clicks.count('Got it') >= 1

def test_e07_signed_out_mid_ai(monkeypatch):
    def pol(u):
        pb.m.url = 'https://www.zomato.com/partners/login'; return {'action': 'click', 'ref': ref_of(u, 'Custom')}
    install_model(monkeypatch, pol)
    m, pb, page = setup_page(); log = Log()
    res = window(page, pb, log)
    assert res['status'] == 'signed_out' and res['via'] == 'ai'

def test_e07_relogin_mid_window(monkeypatch, tmp_path):
    # main(): a window that comes back signed_out runs the normal login path once and redoes the window once
    import inspect
    src = inspect.getsource(run_night.main)
    assert "session_lost" in src and "auto_login.attempt(platform, cfg, run_id, log, allow_any_time=a.login_any_time)" in src
    assert src.count("do_window(api, page, pb, log, image, run_id, folder, rest, outlet, platform, pl['platformId'], w, MISMATCH_LIMIT - mism)") == 2

def test_e08_wrong_range_blocked(monkeypatch):
    ok_identity(monkeypatch); install_model(monkeypatch, week_policy('16 - 15 Nov 2026 Current week'))
    m, pb, page = setup_page(); log = Log()
    res = window(page, pb, log)
    assert res['status'] == 'ui_changed' and 'presubmit_check_failed' in res['reason'] and m.generated is None
    assert 'failed' in log.results('ai_presubmit')
    lines = ['Selected: 2 - 8 Nov 2026']; assert not af.range_check(lines, [], PS, PE)[0]
    assert af.range_check(['Selected: 9 - 15 Nov 2026'], [], PS, PE)[0]
    assert not af.range_check(['Selected: 19 - 15 Nov 2026'], [], PS, PE)[0]

def test_e09_wrong_outlet_blocked(monkeypatch):
    ok_identity(monkeypatch)
    def pol(u):
        if ref_of(u, 'Switch outlet: Other Place'): return {'action': 'click', 'ref': ref_of(u, 'Switch outlet: Other Place')}
        return week_policy()(u)
    install_model(monkeypatch, pol)
    m, pb, page = setup_page(other_outlet='Other Place'); log = Log()
    res = window(page, pb, log, rest={'name': 'Test', 'outlets': [OUT, {'outletId': 'o2', 'name': 'Other Place'}]})
    assert res['status'] == 'ui_changed' and m.generated is None
    assert af.outlet_check(['You are generating a report for Other Place'], [], 'Test Outlet', '900002', ['Other Place']) == (False, 'other_outlet_shown')

def test_e09_ai_identity_mismatch_no_rerun(monkeypatch):
    ok_identity(monkeypatch); calls = install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(wrong_file=True); log = Log(); api = Api()
    res = window(page, pb, log, api)
    n = len(calls)
    assert res['status'] == 'local_mismatch' and res['mismatches'] == 1 and res['alert'] == 'now'
    assert [s for p, s, _ in api.calls if p == '/agent/v1/fetches'] == ['local_mismatch'] and not any(p == '/agent/v1/metric-reports' for p, *_ in api.calls)
    assert af.LearnedStore('zomato', 'weekly').current() is None and pb.removed and n < 10

def test_e10_loop_detected(monkeypatch):
    install_model(monkeypatch, lambda u: {'action': 'click', 'ref': ref_of(u, 'Daily')})
    m, pb, page = setup_page(); log = Log()
    res = window(page, pb, log)
    assert res['status'] == 'ui_changed' and res['reason'] == 'ai_failed:ai_loop'

def test_e11_step_cap(monkeypatch):
    monkeypatch.setenv('ECOM_AI_MAX_STEPS', '2')
    install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:ai_step_cap' and res['ai_calls'] == 2

def test_e12_cost_caps(monkeypatch):
    monkeypatch.setenv('ECOM_AI_CAP_INR', '3')
    calls = install_model(monkeypatch, lambda u: {'action': 'wait'}, inr=1.0)
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:ai_cost_cap' and res['ai_cost_inr'] <= 3
    monkeypatch.setenv('ECOM_AI_CAP_INR', '60'); monkeypatch.setenv('ECOM_AI_NIGHT_CAP_INR', '4')
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:ai_night_cap' and af.Spend().spent() <= 4

def test_e13_forbidden_refused(monkeypatch):
    seq = iter(['Share feedback', 'Online', 'Help centre'])
    install_model(monkeypatch, lambda u: {'action': 'click', 'ref': ref_of(u, next(seq))})
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:ai_refused_3x' and not any(c in m.clicks for c in ('Share feedback', 'Online', 'Help centre'))

def test_e14_left_site(monkeypatch):
    def pol(u):
        pb.m.url = 'https://example.com/'; return {'action': 'wait'}
    install_model(monkeypatch, pol)
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:ai_left_site'

def test_e15_bad_submit_refused(monkeypatch):
    install_model(monkeypatch, lambda u: {'action': 'ready', 'ref': ref_of(u, 'Weekly')})
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:ai_refused_3x' and m.generated is None

def test_e16_no_file(monkeypatch):
    ok_identity(monkeypatch); install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(never_file=True); log = Log(); api = Api()
    res = window(page, pb, log, api)
    assert res['status'] == 'download_failed' and res['reason'] == 'ai_download_timeout' and af.LearnedStore('zomato', 'weekly').current() is None

def test_e17_learned_mismatch_marks_stale(monkeypatch):
    ok_identity(monkeypatch); install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(); window(page, pb, Log())
    install_model(monkeypatch, lambda u: pytest.fail('no AI after a wrong file'))
    m2, pb2, page2 = setup_page(wrong_file=True)
    res = window(page2, pb2, Log())
    assert res['status'] == 'local_mismatch' and res['via'] == 'learned'
    assert af.LearnedStore('zomato', 'weekly').load()['current']['status'] == 'stale'

def test_e18_literal_date_not_promoted(monkeypatch):
    tk = af.date_tokens(PS, PE, W)
    assert af.templatize('2 - 8 Nov 2026', tk) == ('2 - 8 Nov 2026', 'literal_date')
    st = af.LearnedStore('zomato', 'weekly')
    e = st.promote({'anchor': 'z1_range', 'steps': [], 'submit': {}, 'problem': 'literal_date'}, {})
    assert e['status'] == 'candidate_literal_date' and st.current() is None

def test_e19_templates_generic():
    tk = af.date_tokens(PS, PE, W)
    assert af.templatize('9 - 15 Nov 2026', tk) == ('{range_dmy}', None)
    assert af.templatize('You are generating a report for Test Outlet', tk) == ('You are generating a report for {outlet_name}', None)
    assert af.templatize('Week 46, 2026', tk) == ('{iso_week}', None)
    used = set(); assert [af.templatize(x, tk, used)[0] for x in ('9', '15')] == ['{start_d}', '{end_d}']
    tk2 = af.date_tokens('2026-10-26', '2026-11-02', dict(W, outlet_name='Another Kitchen'))
    assert af.render('{range_dmy}', tk2) == '26 Oct - 1 Nov 2026' and af.render('{outlet_name}', tk2) == 'Another Kitchen'
    assert af.render('{range_dmy}', af.date_tokens('2026-12-28', '2027-01-04')) == '28 Dec 2026 - 3 Jan 2027'

def test_e20_platform_rules():
    z, s = recipes.PLATFORM_RULES['zomato'], recipes.PLATFORM_RULES['swiggy']
    assert z['site'].search(ZURL) and not s['site'].search(ZURL) and s['site'].search('https://partner.swiggy.com/food/business-metrics')
    assert s['signed_out'].search('https://partner.swiggy.com/food/login') and z['signed_out'].search('https://www.zomato.com/partners/login')
    rc = recipes.business_recipe('swiggy', 'daily', PS, PE, Log(), 'Test', 'Testcity', '900001')
    assert [n for n, _ in rc.stages] == ['s1_probe', 's1_open', 's1_outlet', 's1_view', 's1_range'] and rc.pattern == '*.xlsx'
    assert af.LearnedStore('swiggy', 'daily').path.endswith('swiggy_daily.json')
    assert af.range_check([], [{'role': 'radio', 'ntext': 'Custom 09/11/2026 - 15/11/2026', 'checked': True}], PS, PE)[0]

def test_e21_model_guards(monkeypatch):
    monkeypatch.setenv('ECOM_AI_MODEL', 'google/gemini-2.5-flash')
    with pytest.raises(af.AiFailed) as e: af.call_model([])
    assert e.value.reason == 'model_not_allowed'
    monkeypatch.setenv('ECOM_AI_MODEL', 'x-ai/grok-4.7'); monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    with pytest.raises(af.AiFailed) as e: af.call_model([])
    assert e.value.reason == 'no_model_key'
    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-not-a-key')
    class R:
        status_code = 503
        def json(self): return {}
    monkeypatch.setattr(af.requests, 'post', lambda *a, **k: R())
    with pytest.raises(af.ModelError): af.call_model([{'role': 'user', 'content': 'x'}])
    assert af.parse_reply('```json\n{"action":"click","ref":"e1"}\n```') == {'action': 'click', 'ref': 'e1'} and af.parse_reply('nope') is None
    install_model(monkeypatch, lambda u: None)
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:ai_bad_reply'

def test_e22_corrupt_learned_file():
    st = af.LearnedStore('zomato', 'weekly'); open(st.path, 'w').write('{not json')
    assert st.current() is None and any('.corrupt-' in n for n in os.listdir(st.dir))

def test_e23_ai_not_available_goes_to_retry(monkeypatch):
    run_night.RUN_CTX.update(slug='test-rest')
    install_model(monkeypatch, lambda u: {'action': 'fail', 'kind': 'not_available'})
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['status'] == 'ui_changed' and res['reason'] == 'ai_failed:ai_not_available' and res['retry'] == '08:00'
    assert retryq.pending('2026-11-16', 'test-rest')[0]['reason'] == 'ai_failed:ai_not_available'

def test_e24_retry_queue_written(monkeypatch):
    run_night.RUN_CTX.update(slug='test-rest')
    install_model(monkeypatch, lambda u: {'action': 'fail', 'kind': 'stuck'})
    m, pb, page = setup_page(); api = Api(); res = window(page, pb, Log(), api)
    assert res['alert'] == 'deferred_to_0800' and res['retry'] == '08:00'
    assert ('/agent/v1/fetches', 'ui_changed', 'ai_failed_ai_gave_up') in api.calls
    q = retryq.pending('2026-11-16', 'test-rest')
    assert len(q) == 1 and q[0]['key'] == retryq.key('o1', 'zomato', 'weekly', PS, PE)
    retryq.add('2026-11-16', 'test-rest', 'o1', 'zomato', 'weekly', PS, PE, 'again', 'r2')
    assert len(retryq.load('2026-11-16', 'test-rest')['entries']) == 1     # deduped

def test_e25_retry_mode(monkeypatch):
    run_night.RUN_CTX.update(slug='test-rest', retry_mode=True)
    install_model(monkeypatch, lambda u: {'action': 'fail', 'kind': 'stuck'})
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['alert'] == 'now' and 'retry' not in res
    k = retryq.key('o1', 'zomato', 'weekly', PS, PE)
    retryq.add('2026-11-16', 'test-rest', 'o1', 'zomato', 'weekly', PS, PE, 'x', 'r1')
    retryq.close('2026-11-16', 'test-rest', k, 'resolved', 'r2')
    assert retryq.pending('2026-11-16', 'test-rest') == [] and retryq.load('2026-11-16', 'test-rest')['entries'][0]['status'] == 'resolved'
    import inspect; src = inspect.getsource(run_night.main)
    assert "result='empty'" in src and "'no_longer_planned'" in src and "'failed_after_retry'" in src and "'not_retried'" in src
    assert src.index("result='empty'") < src.index("computer/boot")    # empty list: exits before booting the computer

def test_e26_unscripted_off_by_default(monkeypatch):
    calls = install_model(monkeypatch, week_policy())
    def unscripted(): e = UiChanged('z1_monthly_not_scripted'); e.stage = 'z1_range'; raise e
    m, pb, page = setup_page(); log = Log()
    with pytest.raises(UiChanged): obtain(page, log, scripted=unscripted)
    assert not calls
    def over(): e = UiChanged('z1_window_over_30_days'); e.stage = 'z1_range'; raise e
    with pytest.raises(UiChanged): obtain(page, log, scripted=over)
    assert not calls and len(log.results('ui')) == 2     # no retries either: plan limits don't change on reload
    monkeypatch.setenv('ECOM_AI_UNSCRIPTED', '1')
    assert af.eligible(UiChanged('z1_monthly_not_scripted'))

def test_e27_second_window_reuses(monkeypatch):
    ok_identity(monkeypatch); calls = install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(); window(page, pb, Log())
    n = len(calls); m.reset()
    res = window(page, pb, Log())
    assert res['via'] == 'learned' and len(calls) == n

def test_e28_payout_retry_queue(monkeypatch):
    run_night.RUN_CTX.update(slug='test-rest')
    n = {'k': 0}
    def bad(*a, **k): n['k'] += 1; raise UiChanged('z2_download_icon')
    monkeypatch.setattr(recipes, 'zomato_payout', bad)
    api = Api(); res = run_night.do_window(api, None, FakePB(Machine()), Log(), 'img', 'r1', 'f', {'name': 'T'}, OUT, 'zomato', '900002', dict(WIN, report='payout'))
    assert n['k'] == 3 and res['status'] == 'ui_changed' and res['retry'] == '08:00'
    assert retryq.pending('2026-11-16', 'test-rest')[0]['report'] == 'payout'

def test_e29_snapshot_failure(monkeypatch):
    def pol(u): pb.m.url = None; return {'action': 'wait'}
    install_model(monkeypatch, pol)
    m, pb, page = setup_page(); res = window(page, pb, Log())
    assert res['reason'] == 'ai_failed:snapshot_failed'

def test_e30_ai_log_scrubbed(monkeypatch):
    ok_identity(monkeypatch); install_model(monkeypatch, week_policy())
    m, pb, page = setup_page(outlet='Test Outlet'); res = window(page, pb, Log())
    p = os.path.join(os.environ['ECOM_FETCH_LOGS'], 'ai-runs', res['ai_transcript'])
    txt = open(p).read()
    assert 'Test Outlet' not in txt and '{range_dmy}' in txt and 'Selected' not in txt
    recs = [json.loads(l) for l in txt.splitlines()]
    assert all(set(r) <= {'t', 'i', 'action', 'role', 'text', 'kind', 'inr'} for r in recs)

def test_e09b_outlet_names_brand_or_label():
    w = dict(W, outlet_name='Salt Lake', brand='Some Brand')
    assert af.our_names(w)[:3] == ['Salt Lake', 'Some Brand', 'Some Brand Salt Lake']
    assert af.outlet_check(['You are generating a report for Some Brand'], [], af.our_names(w), '900002', []) == (True, 'ok')
    assert af.outlet_check(['You are generating a report for Else'], [], af.our_names(w), '900002', []) == (False, 'outlet_not_shown')

def test_e32_today_label_wildcard():
    tk = af.date_tokens(PS, PE, W)
    assert af.templatize('16 - 15 Nov 2026 Current week', tk) == ('{*} Current week', None)
    assert af.templatize('2 - 8 Nov 2026', tk) == ('2 - 8 Nov 2026', 'literal_date')
    m, pb, page = setup_page(); m.custom = m.dropdown = True
    c, _ = af.find_recorded(page, {'role': 'generic', 'text': '{*} Current week', 'nth': 0, 'count': 1}, tk, timeout=0)
    assert c and c['ntext'] == '16 - 15 Nov 2026 Current week'
    cand = {'anchor': 'z1_range', 'steps': [{'op': 'click', 'role': 'generic', 'text': '{range_dmy}', 'nth': 0, 'count': 2},
            {'op': 'click', 'role': 'generic', 'text': '16 - 15 Nov 2026 Current week', 'nth': 0, 'count': 1}], 'submit': {}, 'problem': 'literal_date'}
    r = af.retemplate(cand, tk)
    assert r['problem'] is None and [s['text'] for s in r['steps']] == ['{range_dmy}', '{*} Current week']
