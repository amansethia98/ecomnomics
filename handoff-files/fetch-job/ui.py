"""Scripted UI steps: find a control by its exact visible text in a fresh snapshot, click it, check the state."""
import json, re, subprocess, time
from pb import PB

ICON = re.compile(r'[\ue000-\uf8ff]')
def norm(s):
    return re.sub(r'\s+', ' ', ICON.sub(' ', s or '')).strip()

class UiChanged(Exception):
    def __init__(self, step): super().__init__(step); self.step = step

class Page:
    def __init__(self, pb: PB, log=None):
        self.pb, self.log = pb, (log or (lambda **k: None))
        self.last = None
        self.trail = None   # when a list: every click/fill is recorded as {op, role, text, nth, count, value?} (AI fallback learning)

    def _record(self, op, ref, value=None):
        if self.trail is None: return
        cs = (self.last or {}).get('controls') or []
        c = next((x for x in cs if x['ref'] == ref), None)
        if not c: self.trail.append({'op': op, 'ref_unknown': True}); return
        same = [x for x in cs if x['role'] == c['role'] and x['ntext'] == c['ntext']]
        rec = {'op': op, 'role': c['role'], 'text': c['ntext'], 'nth': same.index(c), 'count': len(same)}
        if value is not None: rec['value'] = value
        self.trail.append(rec)

    def snap(self):
        r = self.pb._exec(['/opt/rakazo-fetch/rakazo-fetch-snap'], timeout=60)
        try: d = json.loads(r.stdout.decode().strip().splitlines()[-1])
        except Exception: d = {'ok': False, 'error': 'snap failed'}
        if not d.get('ok'): raise UiChanged('snapshot_failed')
        for c in d['controls']: c['ntext'] = norm(c['text'])
        self.last = d
        return d

    def icons(self, refs):
        """{ref: start of its first SVG path} (icon shape only, never page text)."""
        r = self.pb._exec(['/opt/rakazo-fetch/rakazo-fetch-snap', '--icons', *refs], timeout=60)
        try: d = json.loads(r.stdout.decode().strip().splitlines()[-1])
        except Exception: d = {'ok': False}
        if not d.get('ok'): raise UiChanged('icons_failed')
        return d['icons']

    def url(self):
        return (self.last or self.snap())['url']

    def find_all(self, text, role=None, snap=None, prefix=False, contains=False):
        d = snap or self.snap()
        want = norm(text)
        def ok(c):
            if role and c['role'] not in (role if isinstance(role, (list, tuple)) else [role]): return False
            t = c['ntext']
            return t == want or (prefix and t.startswith(want)) or (contains and want in t)
        return [c for c in d['controls'] if ok(c)]

    def find(self, text, role=None, step=None, snap=None, prefix=False, contains=False, pick='innermost'):
        found = self.find_all(text, role, snap, prefix, contains)
        if not found: raise UiChanged(step or ('not_found:' + text))
        if pick == 'innermost':  # nested generics share text; the last in document order is the innermost
            return found[-1]
        if pick == 'only' and len(found) != 1: raise UiChanged((step or text) + ':ambiguous')
        return found[0]

    def click_ref(self, ref, downloads=None, step=''):
        self._record('click', ref)
        r = self.pb.act([{'kind': 'click', 'ref': ref}], downloads=downloads)
        if not r.get('ok') and 'download' not in str(r.get('note', '')).lower():
            raise UiChanged(step + ':click_failed')
        return r

    def click(self, text, role=None, step=None, downloads=None, settle=1.5, **kw):
        c = self.find(text, role, step, **kw)
        self.log(step=step or text, matched=norm(text), role=c['role'])
        r = self.click_ref(c['ref'], downloads, step or text)
        time.sleep(settle)
        return r

    def fill(self, ref, text, step=''):
        self._record('fill', ref, text)
        r = self.pb.act([{'kind': 'fill', 'ref': ref, 'text': text}])
        if not r.get('ok'): raise UiChanged(step + ':fill_failed')
        return r

    def page_lines(self):
        """Visible page text lines, in memory only (never logged)."""
        t = self.pb.snapshot().get('tree', '')
        return [norm(l) for l in t.split('\n') if l.strip() and not l.lstrip().startswith('- ')]

    def wait_text(self, text, timeout=20, step=None):
        end = time.time() + timeout
        want = norm(text)
        while time.time() < end:
            if want in self.page_lines(): return True
            time.sleep(1.5)
        raise UiChanged(step or ('timeout:' + text))

    def wait_for(self, text, role=None, timeout=30, step=None, **kw):
        end = time.time() + timeout
        while time.time() < end:
            try:
                d = self.snap()
                f = self.find_all(text, role, d, **kw)
                if f: return f[-1]
            except UiChanged: pass
            time.sleep(1.5)
        raise UiChanged(step or ('timeout:' + text))
