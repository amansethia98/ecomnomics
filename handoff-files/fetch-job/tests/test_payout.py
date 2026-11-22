"""Payout recipes (Z2 / S2) and the payout window, offline (INR 0): cycle labels, icon picking (never the mail icon),
not-paid / not-listed / wrong-outlet guards, sha-check skip, upload body, 422 identity status, file deletion."""
import base64, hashlib, os, sys
import pytest
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import run_night, recipes, identity
from ui import UiChanged, norm

# ---------- labels ----------
def test_zomato_cycle_label():
    assert recipes.zomato_cycle_labels('2026-11-02', '2026-11-09') == ["02 Nov - 08 Nov'26"]
    assert recipes.zomato_cycle_labels('2026-12-28', '2027-01-04')[0] == "28 Dec'26 - 03 Jan'27"

def test_swiggy_cycle_label_and_month_split():
    assert recipes.swiggy_cycle_label('2026-11-01', '2026-11-08')[0] == '31st Oct-7th Nov'
    assert recipes.swiggy_cycle_label('2026-10-25', '2026-11-01')[0] == '24th Oct-31st Oct'
    assert recipes.swiggy_cycle_label('2026-10-01', '2026-10-04')[0] == '30th Sep-3rd Oct'
    assert recipes.swiggy_cycle_label('2026-09-27', '2026-10-01')[0] == '26th Sep-30th Sep'
    lab, a, b = recipes.swiggy_cycle_label('2026-11-01', '2026-11-08')
    assert (a.isoformat(), b.isoformat()) == ('2026-10-31', '2026-11-07')   # the detail URL's from/to

def test_is_zip():
    assert recipes.is_zip(b'PK\x03\x04rest') and not recipes.is_zip(b'%PDF-1.4')

# ---------- fake page ----------
class FakePB:
    def __init__(self, page): self.page = page; self.acts = []; self.removed = []
    def navigate(self, url, downloads=None): self.page.nav.append(url); return {'ok': True}
    def act(self, actions, downloads=None): self.acts.append((actions[0]['ref'], downloads)); self.page.on_click(actions[0]['ref']); return {'ok': True}
    def now(self): return 0.0
    def read_file(self, p): return b'PK\x03\x04fake'
    def remove(self, p): self.removed.append(p); return True

class FakePage:
    def __init__(self, controls, url, icons=None, lines=(), after_click=None):
        self.controls, self._url, self._icons, self.lines = controls, url, icons or {}, list(lines)
        self.nav = []; self.after_click = after_click or {}
        self.pb = FakePB(self)
    def on_click(self, ref):
        if ref in self.after_click: self._url, self.controls = self.after_click[ref]
    def snap(self):
        for c in self.controls: c.setdefault('ntext', norm(c['text'])); c.setdefault('checked', None); c.setdefault('disabled', False); c.setdefault('value', None)
        return {'ok': True, 'url': self._url, 'controls': self.controls}
    def icons(self, refs): return {r: self._icons.get(r) for r in refs}
    def page_lines(self): return self.lines
    def find_all(self, text, role=None, snap=None, **k):
        d = snap or self.snap(); return [c for c in d['controls'] if c['ntext'] == norm(text) and (not role or c['role'] == role)]
    def find(self, text, role=None, step=None, snap=None, **k):
        f = self.find_all(text, role, snap)
        if not f: raise UiChanged(step or text)
        return f[-1]
    def click_ref(self, ref, downloads=None, step=''): self.pb.act([{'kind': 'click', 'ref': ref}]); return {'ok': True}
    def click(self, text, role=None, step=None, settle=0, **k): return self.click_ref(self.find(text, role, step)['ref'])

class Log:
    plan_date = '2026-11-12'; ctx = {}
    def __init__(self): self.steps = []
    def step(self, s, **k): self.steps.append((s, k))

@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(recipes.time, 'sleep', lambda s: None)
    monkeypatch.setattr(recipes, 'wait_file', lambda p, folder, pattern, t0, timeout=120: f'/home/rakazo/{folder}/got.xlsx')

ZURL = 'https://www.zomato.com/partners/onlineordering/finance/payouts'
def zrow(ref, label, status='PAID', dl='i1', mail='i2'):
    return [{'ref': ref, 'role': 'row', 'text': f"{label} 11 Nov'26 {status} 260 ₹1 UTR"},
            {'ref': ref + 'v', 'role': 'generic', 'text': ''}, {'ref': dl, 'role': 'image', 'text': ''}, {'ref': mail, 'role': 'image', 'text': ''}]
ICONS = {'i1': recipes.Z2_DOWNLOAD_ICON + 'xx', 'i2': recipes.Z2_MAIL_ICON + 'yy', 'j1': recipes.Z2_DOWNLOAD_ICON, 'j2': recipes.Z2_MAIL_ICON}
LINES = ['View transactions', 'Download report', 'Send report to mail']

def test_z2_clicks_the_download_icon_of_the_right_row_only():
    p = FakePage(zrow('r1', "02 Nov - 08 Nov'26", dl='i1', mail='i2') + zrow('r2', "26 Oct - 01 Nov'26", dl='j1', mail='j2'), ZURL, ICONS, LINES)
    path = recipes.zomato_payout(p, '2026-10-26', '2026-11-02', 'inbox', Log())
    assert p.pb.acts == [('j1', 'inbox')] and path.endswith('got.xlsx')

def test_z2_never_clicks_mail_when_download_icon_missing():
    p = FakePage(zrow('r1', "02 Nov - 08 Nov'26", dl='m1', mail='i2'), ZURL, {'m1': 'M0 0', 'i2': recipes.Z2_MAIL_ICON}, LINES)
    with pytest.raises(UiChanged): recipes.zomato_payout(p, '2026-11-02', '2026-11-09', 'inbox', Log())
    assert p.pb.acts == []

def test_z2_unpaid_and_unlisted_cycles():
    p = FakePage(zrow('r1', "02 Nov - 08 Nov'26", status='PENDING'), ZURL, ICONS, LINES)
    with pytest.raises(recipes.NotAvailable): recipes.zomato_payout(p, '2026-11-02', '2026-11-09', 'inbox', Log())
    with pytest.raises(recipes.NotListed): recipes.zomato_payout(p, '2026-10-05', '2026-10-12', 'inbox', Log())
    assert p.pb.acts == []

def test_z2_signed_out():
    p = FakePage([], 'https://www.zomato.com/partners/login', ICONS, LINES)
    with pytest.raises(recipes.SignedOut): recipes.zomato_payout(p, '2026-11-02', '2026-11-09', 'inbox', Log())

SURL = 'https://partner.swiggy.com/food/finance'
def scards(rid='900001'):
    return [{'ref': 'h', 'role': 'generic', 'text': f'Test Kitchen, Area, Testcity ({rid})'},
            {'ref': 'c0', 'role': 'button', 'text': 'FINAL PAYOUT ₹1 Pending Payout period 7th Nov-14th Nov Expected Payout date Payment on 18 November See details'},
            {'ref': 'c1', 'role': 'button', 'text': 'FINAL PAYOUT ₹1 Paid Payout period 31st Oct-7th Nov Payout date On 11 November See details'},
            {'ref': 'c2', 'role': 'button', 'text': 'FINAL PAYOUT ₹1 Paid Payout period 24th Oct-31st Oct Payout date On 04 November See details'}]
def details(rid, frm, to):
    return (f'https://partner.swiggy.com/food/finance/past-payout/{rid}/payout/1?from={frm}&to={to}',
            [{'ref': 'pa', 'role': 'generic', 'text': 'Payout Annexures'}, {'ref': 'ti', 'role': 'generic', 'text': 'Tax invoices'}])

def test_s2_opens_the_right_card_and_clicks_annexures():
    p = FakePage(scards(), SURL, after_click={'c1': details('900001', '2026-10-31', '2026-11-07')})
    path = recipes.swiggy_payout(p, '2026-11-01', '2026-11-08', 'inbox', Log(), '900001')
    assert [r for r, _ in p.pb.acts] == ['c1', 'pa'] and p.pb.acts[1][1] == 'inbox' and path.endswith('got.xlsx')

def test_s2_refuses_other_outlet_pending_and_wrong_details():
    p = FakePage(scards(rid='999001'), SURL)
    with pytest.raises(UiChanged): recipes.swiggy_payout(p, '2026-11-01', '2026-11-08', 'inbox', Log(), '900001')
    p = FakePage(scards(), SURL)
    with pytest.raises(recipes.NotAvailable): recipes.swiggy_payout(p, '2026-11-08', '2026-11-15', 'inbox', Log(), '900001')
    p = FakePage(scards(), SURL, after_click={'c1': details('999001', '2026-10-31', '2026-11-07')})
    with pytest.raises(UiChanged): recipes.swiggy_payout(p, '2026-11-01', '2026-11-08', 'inbox', Log(), '900001')
    assert [r for r, _ in p.pb.acts] == ['c1']     # never clicked Payout Annexures on another outlet's page
    p = FakePage(scards(), SURL)
    with pytest.raises(recipes.NotListed): recipes.swiggy_payout(p, '2026-10-04', '2026-10-11', 'inbox', Log(), '900001')

# ---------- the payout window ----------
class Api:
    def __init__(self, stored=False, code=200, body=None):
        self.calls = []; self.stored = stored; self.code = code; self.body = body or {'status': 'stored', 'fetchId': 'f1', 'orders': 30, 'adjustments': 2, 'superseded': 0, 'checks': [{'pass': True}]}
    def post(self, path, body, tries=3):
        self.calls.append((path, body))
        if path == '/agent/v1/fetches/check': return 200, {'files': [{'stored': self.stored, 'fetchId': 'old'}]}
        if path == '/agent/v1/payout-reports': return self.code, self.body
        return 201, {}
class PB:
    def __init__(self, raw=b'PK\x03\x04payload'): self.raw = raw; self.removed = []
    def read_file(self, p): return self.raw
    def remove(self, p): self.removed.append(p); return True
OUT = {'outletId': 'o1', 'name': 'Test Kitchen', 'city': 'Testcity'}
WIN = {'report': 'payout', 'periodStart': '2026-11-02', 'periodEnd': '2026-11-09', 'reasons': ['scheduled']}
def run(mp, api, pb, ident=None, recipe=None):
    mp.setattr(recipes, 'zomato_payout', recipe or (lambda *a, **k: '/home/rakazo/inbox/z.xlsx'))
    mp.setattr(identity, 'check', lambda *a, **k: ident or {'ok': True, 'warnings': [], 'cycle': ['2026-11-02', '2026-11-09'], 'parserVersion': 'pv-test', 'orders': 30})
    res = {'platform': 'zomato', 'report': 'payout', 'periodStart': WIN['periodStart'], 'periodEnd': WIN['periodEnd'], 'attempts': 0, 'mismatches': 0}
    return run_night.do_payout_window(api, None, pb, Log(), 'img', 'run1', 'inbox', OUT, 'zomato', '900002', WIN, res)

def test_payout_stored_posts_xlsx_with_raw_sha_and_deletes(monkeypatch):
    api, pb = Api(), PB()
    r = run(monkeypatch, api, pb)
    assert r['status'] == 'stored' and r['rowsWritten'] == 30
    chk = [b for p, b in api.calls if p == '/agent/v1/fetches/check'][0]['files'][0]
    assert chk['parserVersion'] == 'pv-test' and chk['report'] == 'payout'
    up = [b for p, b in api.calls if p == '/agent/v1/payout-reports'][0]
    assert base64.b64decode(up['fileBase64']) == pb.raw and up['rawSha256'] == hashlib.sha256(pb.raw).hexdigest()
    assert 'csv' not in up and 'report' not in up       # payout-reports is strict: no business fields
    assert pb.removed == ['/home/rakazo/inbox/z.xlsx']

def test_payout_duplicate_skipped_by_sha_without_upload(monkeypatch):
    api, pb = Api(stored=True), PB()
    r = run(monkeypatch, api, pb)
    assert r['status'] == 'skipped' and not any(p == '/agent/v1/payout-reports' for p, _ in api.calls) and pb.removed

def test_payout_local_mismatch_never_uploads(monkeypatch):
    api, pb = Api(), PB()
    r = run(monkeypatch, api, pb, ident={'ok': False, 'reject': 'The file is for restaurant 999002, not 900002.', 'restaurantId': '999002'})
    assert r['mismatches'] == 3 and not any(p == '/agent/v1/payout-reports' for p, _ in api.calls)
    assert [b['status'] for p, b in api.calls if p == '/agent/v1/fetches'] == ['local_mismatch'] * 3 and len(pb.removed) == 3

def test_payout_server_422_rejected_counts_as_mismatch(monkeypatch):
    api, pb = Api(code=422, body={'code': 'file_identity', 'status': 'rejected_mismatch', 'fetchId': 'f9'}), PB()
    r = run(monkeypatch, api, pb)
    assert r['status'] == 'rejected_mismatch' and r['mismatches'] == 3

def test_payout_423_held_and_not_listed_logged(monkeypatch):
    api, pb = Api(code=423, body={'code': 'fetch_held'}), PB()
    assert run(monkeypatch, api, pb)['status'] == 'fetch_held' and pb.removed
    def nl(*a, **k): raise recipes.NotListed('z2_cycle_not_listed')
    api = Api(); r = run(monkeypatch, api, PB(), recipe=nl)
    assert r['status'] == 'download_failed' and [(b['status'], b['reason']) for p, b in api.calls if p == '/agent/v1/fetches'] == [('download_failed', 'z2_cycle_not_listed')]

def test_payout_pdf_is_refused(monkeypatch):
    api, pb = Api(), PB(raw=b'%PDF-1.7')
    r = run(monkeypatch, api, pb)
    assert r['status'] == 'download_failed' and not any(p == '/agent/v1/payout-reports' for p, _ in api.calls) and pb.removed

# ---------- the repo's own parser, on the step-3 fixtures ----------
FX = os.environ.get('ECOM_FIXTURES', '/workspace/ecomnomics/packages/contracts/fixtures')
IMG = os.environ.get('APP_IMAGE') or (os.popen("sudo -n docker inspect ecomnomics-agentv1-api-1 --format '{{.Config.Image}}' 2>/dev/null").read().strip() or 'ecomnomics/main-app:9b9ef0343')
def test_fixture_payouts_pass_with_parser_version_and_wrong_period_rejects():
    for plat, rid, ps, pe in [('swiggy', '900001', '2026-10-25', '2026-11-01'), ('zomato', '900002', '2026-10-26', '2026-11-02')]:
        data = open(f'{FX}/payouts/{plat}-{rid}.xlsx', 'rb').read()
        ok = identity.check(IMG, 'payout', plat, 'payout', ps, pe, rid, 'Test Kitchen', 'Testcity', data=data)
        assert ok['ok'] and ok['parserVersion'] and ok['cycle'] == [ps, pe], (plat, ok)
        shifted = identity.check(IMG, 'payout', plat, 'payout', '2026-11-01', '2026-11-08', rid, 'Test Kitchen', 'Testcity', data=data)
        assert not shifted['ok']

def test_payout_server_5xx_is_logged_and_file_deleted(monkeypatch):
    import requests
    class Api5(Api):
        def post(self, path, body, tries=3):
            if path == '/agent/v1/payout-reports': self.calls.append((path, body)); raise requests.HTTPError('500')
            return super().post(path, body, tries)
    api, pb = Api5(), PB()
    r = run(monkeypatch, api, pb)
    assert r['status'] == 'server_error' and pb.removed
    assert [(b['status'], b['reason']) for p, b in api.calls if p == '/agent/v1/fetches'] == [('download_failed', 'upload_server_error_500')]
