"""AI fallback + learn for the nightly fetch job (16 Nov 2026). See AI-FALLBACK-EDGE-CASES.md.

Per report window: scripted stages (up to 3 tries, fresh page each) -> promoted learned recipe for the failing stage (no model)
-> the AI (x-ai/grok-4.7, never Gemini) acts on the page from the start of the failing stage, one action per model call.
Safety checks are code only: before the submit click the page must show this outlet and exactly the plan's date range; after
download run_night's identity check (restaurant id + period columns) and the server's checks still decide. A learned recipe is
promoted only after all of them passed and the rows were stored. Generic: learned files are per platform+report, texts are
templates ({range_dmy}, {outlet_name}, ...), never restaurant-specific.
Never logs page text, codes or credentials: transcripts keep action, role and templated control text only (through scrub)."""
import hashlib, json, os, re, time
from datetime import date, datetime, timedelta, timezone
import requests
from ui import UiChanged, norm
import recipes
from scrub import scrub, scrub_obj

HERE = os.path.dirname(os.path.abspath(__file__))
IST = timezone(timedelta(hours=5, minutes=30))
OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
PRICE_USD = {'prompt': 2e-6, 'completion': 6e-6}   # x-ai/grok-4.7 per token (fallback when the reply has no cost field)

def env_f(name, default): 
    try: return float(os.environ.get(name, default))
    except ValueError: return float(default)
def model(): return os.environ.get('ECOM_AI_MODEL', 'x-ai/grok-4.7')
def cap_inr(): return env_f('ECOM_AI_CAP_INR', 60)
def night_cap_inr(): return env_f('ECOM_AI_NIGHT_CAP_INR', 150)
def max_steps(): return int(env_f('ECOM_AI_MAX_STEPS', 15))
def scripted_tries(): return max(1, int(env_f('ECOM_UI_TRIES', 3)))
def usd_inr(): return env_f('ECOM_USD_INR', 85)
def unscripted_on(): return os.environ.get('ECOM_AI_UNSCRIPTED') == '1'
def learned_dir(): return os.environ.get('ECOM_LEARNED_DIR', os.path.join(HERE, 'learned'))
def logs_dir(): return os.environ.get('ECOM_FETCH_LOGS', os.path.join(HERE, 'logs'))

SUBMIT_RX = re.compile(r'(?i)^(generate( report)?|download( report)?|raise a request|export( report)?)$')
DISMISS_RX = re.compile(r'(?i)^(close|dismiss|got it|skip|not now|later|maybe later|ok|okay|no thanks|cancel|×|x|✕)$')
NO_AI_STEPS = re.compile(r'_over_\d+_days')            # plan limits, not page changes: no retry, no AI
UNSCRIPTED = re.compile(r'not_scripted')
REFUSED_ROLES = {'link', 'Iframe', 'iframe'}           # links leave the page; frames hold business numbers
MONTHS = recipes.MONTHS
MON_RX = r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
DATEY = re.compile(r'(?i)\b\d{1,2}(st|nd|rd|th)?\s*' + MON_RX + r'|' + MON_RX + r'\w*\s+\d{1,2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b20\d\d\b|\bweek\s+\d')

class AiFailed(UiChanged):
    def __init__(self, reason, **info):
        super().__init__('ai_failed:' + reason); self.reason = reason; self.info = info
class AiNotAvailable(AiFailed):
    def __init__(self, **info): super().__init__('ai_not_available', **info)

# ---------------- dates as the pages write them ----------------
def window_days(ps, pe):
    a, b = date.fromisoformat(ps), date.fromisoformat(pe) - timedelta(1)
    return a, b

def range_dmy(a, b):
    if (a.year, a.month) == (b.year, b.month): return f"{a.day} - {b.day} {b:%b} {b.year}"
    if a.year == b.year: return f"{a.day} {a:%b} - {b.day} {b:%b} {b.year}"
    return f"{a.day} {a:%b} {a.year} - {b.day} {b:%b} {b.year}"

def date_tokens(ps, pe, w=None):
    a, b = window_days(ps, pe)
    iy, iw, _ = a.isocalendar()
    t = {'start_d': str(a.day), 'end_d': str(b.day), 'start_month': MONTHS[a.month - 1], 'end_month': MONTHS[b.month - 1],
         'start_mon': f'{a:%b}', 'end_mon': f'{b:%b}', 'start_year': str(a.year), 'end_year': str(b.year),
         'range_dmy': range_dmy(a, b), 'start_mdy': f"{a:%b} {a.day}, {a.year}", 'end_mdy': f"{b:%b} {b.day}, {b.year}",
         'start_long': f"{MONTHS[a.month - 1]} {a.day}, {a.year}", 'end_long': f"{MONTHS[b.month - 1]} {b.day}, {b.year}",
         'start_dmy_slash': f'{a:%d/%m/%Y}', 'end_dmy_slash': f'{b:%d/%m/%Y}', 'range_dmy_slash': f'{a:%d/%m/%Y} - {b:%d/%m/%Y}',
         'start_ord': f"{recipes.ordinal(a.day)} {a:%b}", 'end_ord': f"{recipes.ordinal(b.day)} {b:%b}",
         'iso_week': f'Week {iw}, {iy}', 'month_year': f"{MONTHS[a.month - 1]} {a.year}"}
    for k in ('outlet_name', 'platform_id', 'city', 'brand'):
        if w and w.get(k): t[k] = str(w[k])
    return t

EXACT_ONLY = {'start_d', 'end_d', 'start_month', 'end_month', 'start_mon', 'end_mon', 'start_year', 'end_year'}

def templatize(text, tokens, used=None):
    """Literal page text -> template. Returns (template, problem) where problem is None, 'empty' or 'literal_date'."""
    if not text: return None, 'empty'
    used = used if used is not None else set()
    if re.fullmatch(r'\d{1,2}', text):    # a bare calendar day: first match is the start day, a later one the end day
        for k in ('start_d', 'end_d'):
            if tokens.get(k) == text and k not in used: used.add(k); return '{' + k + '}', None
        for k in ('end_d', 'start_d'):
            if tokens.get(k) == text: return '{' + k + '}', None
        return text, 'literal_date'
    for k, v in tokens.items():
        if v and text == v: return '{' + k + '}', None
    t = text
    for k, v in sorted(tokens.items(), key=lambda kv: -len(kv[1] or '')):
        if k in EXACT_ONLY or not v or len(v) < 4: continue
        if v in t: t = t.replace(v, '{' + k + '}')
    rest = re.sub(r'\{\w+\}', ' ', t)
    if DATEY.search(rest):
        wc = wildcard(t)       # e.g. "16 - 15 Nov 2026 Current week" -> "{*} Current week" (a date tied to today, not to the window)
        return (wc, None) if wc else (t, 'literal_date')
    return t, None

MONTH_WORDS = {m.lower() for m in MONTHS} | {m[:3].lower() for m in MONTHS} | {'sept'}
def _dateish(tok):
    x = tok.strip('.,()').lower()
    return bool(x) and (x in MONTH_WORDS or x in ('-', '–', 'to') or re.fullmatch(r'\d{1,4}(st|nd|rd|th)?|\d{1,2}/\d{1,2}(/\d{2,4})?', x) is not None)

def wildcard(text):
    """Date-like runs become {*}. Only kept when a fixed label of 3+ letters remains, so the control is still identified by words."""
    out, prev = [], False
    for tok in text.split():
        if tok.startswith('{') and tok.endswith('}'): out.append(tok); prev = False; continue
        d = _dateish(tok)
        if d and not prev: out.append('{*}')
        elif not d: out.append(tok)
        prev = d
    fixed = ' '.join(x for x in out if x != '{*}' and not re.fullmatch(r'\{\w+\}', x))
    if len(re.sub(r'[^A-Za-z]', '', fixed)) < 3: return None
    return ' '.join(out)

def render(template, tokens):
    return re.sub(r'\{(\w+)\}', lambda m: tokens.get(m.group(1), m.group(0)), template or '')

# ---------------- code-only safety checks ----------------
def _has(rep, t): return re.search(r'(?<![\d\w])' + re.escape(rep) + r'(?![\d])', t) is not None

def range_check(lines, controls, ps, pe):
    """The page's own selection summary must show exactly the plan's range. Returns (ok, detail)."""
    tk = date_tokens(ps, pe)
    reps = [tk['range_dmy'], tk['range_dmy_slash'], f"{tk['start_mdy']} - {tk['end_mdy']}", f"{tk['start_long']} - {tk['end_long']}"]
    a, b = window_days(ps, pe)
    if (b - a).days == 6 and a.isoweekday() == 1: reps.append(tk['iso_week'])
    pairs = [(tk['start_ord'], tk['end_ord']), (tk['start_mdy'], tk['end_mdy']), (tk['start_dmy_slash'], tk['end_dmy_slash'])]
    def contains(t):
        return any(_has(r, t) for r in reps) or any(_has(x, t) and _has(y, t) for x, y in pairs)
    sel = [l for l in lines if re.match(r'(?i)^selected\b', l)]
    if sel:
        return (True, 'selected_line') if contains(sel[-1]) else (False, 'selected_line_other_range')
    ev = [c['value'] for c in controls if c.get('value') and c['role'] in ('textbox', 'combobox')] + \
         [c['ntext'] for c in controls if c.get('checked') and c['role'] in ('radio', 'checkbox')]
    if any(contains(e) for e in ev): return True, 'control_value'
    return False, 'range_not_shown'

def our_names(w):
    """Names the page may show for this outlet: the outlet label, the restaurant (brand) name, and both together."""
    o, b = (w.get('outlet_name') or '').strip(), (w.get('brand') or '').strip()
    return [x for x in dict.fromkeys([o, b, f'{b} {o}'.strip(), f'{b} - {o}'.strip(' -'), f'{b}, {o}'.strip(' ,')]) if x]

def outlet_check(lines, controls, name, platform_id, others=()):
    """Pre-submit: the page shows one of our names (or the platform id) and no other outlet of this restaurant.
    For accounts where every outlet shows the same brand name, the downloaded file's restaurant id is the hard check."""
    texts = list(lines) + [c['ntext'] for c in controls]
    low = [t.lower() for t in texts]
    names = [name] if isinstance(name, str) else list(name or [])
    mine = any(n and any(n.lower() in t for t in low) for n in names)
    if platform_id and any(re.search(r'(?<!\d)' + re.escape(str(platform_id)) + r'(?!\d)', t) for t in texts): mine = True
    bad = []
    for o in others or ():
        if not o or any(n and o.lower() in n.lower() for n in names): continue      # a name inside ours can't be told apart: the file id decides
        if any(o.lower() in t and re.search(r'(?i)report for|selected|outlet|rid', t) for t in low): bad.append('other_outlet')
    if bad: return False, 'other_outlet_shown'
    return (True, 'ok') if mine else (False, 'outlet_not_shown')

def presubmit(page, rc, w):
    snap = page.snap(); lines = visible_lines(page)
    ok_r, why_r = range_check(lines, snap['controls'], rc.ps, rc.pe)
    ok_o, why_o = outlet_check(lines, snap['controls'], our_names(w), w.get('platform_id'), w.get('other_outlets') or ())
    failed = [x for x, ok in (('range:' + why_r, ok_r), ('outlet:' + why_o, ok_o)) if not ok]
    return not failed, failed

def visible_lines(page, limit=140):
    out = []
    for l in page.page_lines():
        if l.startswith('[frame') : break          # frame content = business numbers: never needed, never sent
        if l.startswith('['): continue
        out.append(l[:100])
        if len(out) >= limit: break
    return out

# ---------------- learned recipes (per platform + report) ----------------
class LearnedStore:
    def __init__(self, platform, report, d=None):
        self.platform, self.report = platform, report
        self.dir = d or learned_dir(); os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, f'{platform}_{report}.json')
    def load(self):
        if not os.path.exists(self.path): return {'schema': 1, 'platform': self.platform, 'report': self.report, 'current': None, 'candidates': [], 'history': []}
        try:
            d = json.load(open(self.path)); assert d.get('schema') == 1 and d['platform'] == self.platform
            return d
        except Exception:
            os.replace(self.path, self.path + f'.corrupt-{int(time.time())}')
            return {'schema': 1, 'platform': self.platform, 'report': self.report, 'current': None, 'candidates': [], 'history': [], 'corrupt_moved': True}
    def save(self, d):
        tmp = self.path + '.tmp'
        with open(tmp, 'w') as f: json.dump(d, f, indent=2)
        os.replace(tmp, self.path); self.write_note(d)
    def current(self):
        c = self.load().get('current')
        return c if c and c.get('status') == 'promoted' else None
    def _versions(self, d):
        vs = [x.get('version', 0) for x in ([d.get('current')] if d.get('current') else []) + d.get('history', []) + d.get('candidates', [])]
        return max(vs or [0])
    def promote(self, cand, evidence):
        d = self.load(); now = datetime.now(IST).isoformat(timespec='seconds')
        entry = dict(cand, version=self._versions(d) + 1, learned_at=now, evidence=evidence, uses=0, fails=0)
        if cand.get('problem'):
            entry['status'] = 'candidate_' + cand['problem']
            d['candidates'] = (d.get('candidates', []) + [entry])[-5:]
        else:
            entry['status'] = 'promoted'
            if d.get('current'): d['history'] = (d.get('history', []) + [d['current']])[-10:]
            d['current'] = entry
        self.save(d); return entry
    def mark_stale(self, reason, run_id):
        d = self.load(); c = d.get('current')
        if not c: return
        c['status'] = 'stale'; c['fails'] = c.get('fails', 0) + 1; c['stale_reason'] = reason; c['stale_at'] = datetime.now(IST).isoformat(timespec='seconds'); c['stale_run'] = run_id
        self.save(d)
    def note_use(self, run_id):
        d = self.load(); c = d.get('current')
        if not c: return
        c['uses'] = c.get('uses', 0) + 1; c['last_used'] = datetime.now(IST).isoformat(timespec='seconds'); c['last_run'] = run_id
        self.save(d)
    def write_note(self, d):
        c = d.get('current')
        L = [f"# Learned recipe: {self.platform} {self.report} business report", '',
             'Written by aifallback.py. Used by the scripted runner (no model) when the scripted stage named in `anchor` fails.', '']
        if not c: L.append('No current recipe.')
        else:
            L += [f"- Version {c['version']}, status **{c['status']}**, learned {c.get('learned_at')} (run {c.get('run_id')}).",
                  f"- Takes over at stage `{c['anchor']}`; then the code checks outlet + date range and clicks the submit button.",
                  f"- Evidence: {json.dumps(c.get('evidence'))}", f"- Used {c.get('uses', 0)} times; last {c.get('last_used')}; fails {c.get('fails', 0)}"
                  + (f"; stale because {c.get('stale_reason')}" if c.get('stale_reason') else ''), '', 'Steps (templates are filled in per window/outlet):']
            for i, s in enumerate(c['steps'], 1):
                L.append(f"{i}. {s['op']} {s['role']} \"{s['text']}\"" + (f" with \"{s['value']}\"" if s.get('value') else '') + ('  (optional popup close)' if DISMISS_RX.match(s['text'] or '') else ''))
            L.append(f"{len(c['steps']) + 1}. submit: {c['submit']['role']} \"{c['submit']['text']}\" (code checks first)")
        L += ['', f"History: {len(d.get('history', []))} older versions; candidates not promoted: {len(d.get('candidates', []))}."]
        open(os.path.join(self.dir, f'{self.platform}_{self.report}.md'), 'w').write('\n'.join(L) + '\n')

# ---------------- spend ledger (one IST night, shared by the 05:30 and 08:00 runs) ----------------
class Spend:
    def __init__(self, day=None):
        d = os.path.join(logs_dir(), 'ai-spend'); os.makedirs(d, exist_ok=True)
        self.path = os.path.join(d, f"{day or datetime.now(IST).date().isoformat()}.json")
    def load(self):
        try: return json.load(open(self.path))
        except Exception: return {'spent_inr': 0.0, 'calls': 0, 'entries': []}
    def spent(self): return float(self.load().get('spent_inr', 0))
    def add(self, inr, run_id, what):
        d = self.load(); d['spent_inr'] = round(d['spent_inr'] + inr, 4); d['calls'] += 1
        d['entries'] = (d['entries'] + [{'t': datetime.now(IST).isoformat(timespec='seconds'), 'run': run_id, 'what': what, 'inr': round(inr, 4)}])[-500:]
        with open(self.path, 'w') as f: json.dump(d, f, indent=1)

# ---------------- model ----------------
class ModelError(Exception): pass

def call_model(messages, max_tokens=4000):
    """One chat call. Returns (parsed_json_or_None, cost_inr). Raises ModelError after one retry."""
    m = model()
    if 'gemini' in m.lower(): raise AiFailed('model_not_allowed')
    key = os.environ.get('OPENROUTER_API_KEY')
    if not key: raise AiFailed('no_model_key')
    body = {'model': m, 'messages': messages, 'temperature': 0, 'max_tokens': max_tokens, 'usage': {'include': True},
            'response_format': {'type': 'json_object'}}
    last = None
    for i in range(2):
        try:
            r = requests.post(OPENROUTER_URL, headers={'Authorization': 'Bearer ' + key}, json=body, timeout=120)
            if r.status_code >= 500 or r.status_code == 429: raise ModelError(f'http_{r.status_code}')
            if r.status_code >= 400: raise ModelError(f'http_{r.status_code}')
            j = r.json(); break
        except (requests.RequestException, ValueError, ModelError) as e:
            last = e
            if i == 1: raise ModelError(str(last)[:40])
            time.sleep(5)
    u = j.get('usage') or {}
    usd = u.get('cost')
    if usd is None: usd = (u.get('prompt_tokens') or 0) * PRICE_USD['prompt'] + (u.get('completion_tokens') or 0) * PRICE_USD['completion']
    content = ((j.get('choices') or [{}])[0].get('message') or {}).get('content') or ''
    return parse_reply(content), float(usd) * usd_inr()

def parse_reply(content):
    t = (content or '').strip()
    t = re.sub(r'^```(?:json)?\s*|\s*```$', '', t)
    m = re.search(r'\{.*\}', t, re.S)
    if not m: return None
    try:
        o = json.loads(m.group(0))
        return o if isinstance(o, dict) and o.get('action') else None
    except ValueError: return None

SYSTEM = """You operate a restaurant partner dashboard in a browser for a read-only reporting job. One action per reply.
You see the page's controls (ref, role, text, value/state) and its visible text. Your job: set up the report form exactly as the goal says,
then reply "ready" with the ref of the button that generates or downloads the report. You never click that button yourself; code checks
the outlet and dates first and clicks it.
Rules: never click anything about e-mail, SMS, share, phone numbers, the Online/Offline toggle, settings, logout, OTP, ads or feedback.
Never open links or leave this page. Never select more than one outlet. Pick exactly the goal's dates; a "Current week" or partial
period is wrong unless it is exactly the goal's dates. Close a popup that blocks the page if needed. If the dates you need are greyed out
or not offered, reply fail with kind "not_available". If you are stuck, reply fail.
Reply with JSON only, one of:
{"action":"click","ref":"e12","why":"..."}
{"action":"fill","ref":"e12","text":"...","why":"..."}
{"action":"wait","why":"..."}
{"action":"ready","ref":"<generate/download button ref>","why":"..."}
{"action":"fail","kind":"stuck|not_available","why":"..."}"""

def goal_text(rc, w, tk):
    rep = {'daily': 'Daily', 'weekly': 'Weekly', 'monthly': 'Monthly'}[rc.report]
    a, b = window_days(rc.ps, rc.pe)
    span = f"{a:%d %b %Y} to {b:%d %b %Y} inclusive"
    extra = ''
    if rc.report == 'weekly': extra = f" That is exactly one {'Monday-Sunday' if rc.platform == 'zomato' else 'Sunday-Saturday'} week; a week list may write it as \"{tk['range_dmy']}\"."
    plat = recipes.PLATFORM_RULES[rc.platform]['site_name']
    return (f"On the {plat}, generate the {rep} business (detailed) report for restaurant \"{w.get('brand')}\", outlet \"{w.get('outlet_name')}\" (platform id {w.get('platform_id')}), "
            f"view {rep}, covering {span}.{extra} The page is already on the report screen; the scripted bot stopped at stage \"{w.get('stage')}\".")

def compact_controls(snap, limit=220):
    out = []
    for c in snap['controls']:
        if c['role'] in ('Iframe', 'iframe'): continue
        t = c['ntext'][:80]
        if not t and c['role'] == 'generic': continue
        flags = (' checked' if c.get('checked') else '') + (' disabled' if c.get('disabled') else '') + (f" value=\"{c['value'][:40]}\"" if c.get('value') else '')
        out.append(f"{c['ref']} {c['role']} \"{t}\"{flags}")
        if len(out) >= limit: break
    return out

def _snap(page):
    try: return page.snap()
    except UiChanged:
        time.sleep(3)
        try: return page.snap()
        except UiChanged: raise AiFailed('snapshot_failed')

def ai_solve(page, rc, w, log, spend, meter, tlog=lambda **k: None):
    """Drive the page to a ready form. Returns the submit control (dict). meter['inr'] accumulates cost (also on failure)."""
    rules = recipes.PLATFORM_RULES[rc.platform]
    tk = date_tokens(rc.ps, rc.pe, w); goal = goal_text(rc, w, tk)
    hist, sigs = [], {}
    last_fp, same_fp, refusals, bad, checkfails = None, 0, 0, 0, 0
    est = 1.0
    for i in range(max_steps()):
        lines = visible_lines(page)          # text first: the control snapshot below must be the last one before any click (fresh refs)
        snap = _snap(page); url = snap.get('url') or ''
        if rules['signed_out'].search(url): raise recipes.SignedOut()
        if not rules['site'].search(url): raise AiFailed('ai_left_site')
        fp = hashlib.sha1(json.dumps([(c['role'], c['ntext'], c.get('checked'), c.get('value')) for c in snap['controls']]).encode()).hexdigest()
        same_fp = same_fp + 1 if (fp == last_fp and hist) else 0
        last_fp = fp
        if same_fp >= 4: raise AiFailed('ai_loop', why='page_unchanged')
        if meter['inr'] + est > cap_inr(): raise AiFailed('ai_cost_cap')
        if spend.spent() + est > night_cap_inr(): raise AiFailed('ai_night_cap')
        user = (f"GOAL: {goal}\n\nACTIONS SO FAR:\n" + ('\n'.join(hist[-12:]) or '(none)') +
                f"\n\nPAGE URL: {url.split('?')[0]}\nCONTROLS:\n" + '\n'.join(compact_controls(snap)) + "\n\nVISIBLE TEXT:\n" + '\n'.join(lines) +
                f"\n\nStep {i + 1} of at most {max_steps()}. Reply with one JSON action.")
        try: obj, inr = call_model([{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': user}])
        except ModelError: raise AiFailed('model_error')
        meter['inr'] += inr; meter['calls'] = meter.get('calls', 0) + 1; est = max(est, inr * 1.5)
        spend.add(inr, w.get('run_id'), f"{rc.platform}:{rc.report}:{rc.ps}")
        if obj is None:
            bad += 1; hist.append(f"{i + 1}. (your reply was not valid JSON)")
            tlog(i=i + 1, action='bad_reply', inr=round(inr, 3))
            if bad >= 3: raise AiFailed('ai_bad_reply')
            continue
        act = obj.get('action'); ref = obj.get('ref')
        ctrl = next((c for c in snap['controls'] if c['ref'] == ref), None) if ref else None
        ttext = templatize(ctrl['ntext'], tk)[0] if ctrl else None
        tlog(i=i + 1, action=act, role=(ctrl or {}).get('role'), text=ttext, kind=obj.get('kind'), inr=round(inr, 3))
        if act == 'fail':
            if obj.get('kind') == 'not_available': raise AiNotAvailable()
            raise AiFailed('ai_gave_up')
        if act == 'wait':
            hist.append(f"{i + 1}. wait"); time.sleep(3); continue
        def refuse(why):
            nonlocal refusals
            refusals += 1; hist.append(f"{i + 1}. {act} {ref}: REFUSED ({why})")
            if refusals >= 3: raise AiFailed('ai_refused_3x', last=why)
        if act not in ('click', 'fill', 'ready'): refuse('unknown action'); continue
        if not ctrl: refuse('no control with that ref on the current page'); continue
        if ctrl['role'] in REFUSED_ROLES: refuse('links/frames are not allowed'); continue
        if recipes.FORBIDDEN.search(ctrl['ntext'] or '') or (act == 'fill' and recipes.FORBIDDEN.search(str(obj.get('text') or ''))):
            refuse('forbidden control'); continue
        if act == 'ready':
            if not SUBMIT_RX.match(ctrl['ntext'] or ''): refuse('that is not a generate/download button'); continue
            ok, failed = presubmit(page, rc, w)
            log.step('ai_presubmit', result='ok' if ok else 'failed', failed=failed)
            if ok:
                same = [c for c in snap['controls'] if c['role'] == ctrl['role'] and c['ntext'] == ctrl['ntext']]
                k = same.index(ctrl)
                fresh = [c for c in page.snap()['controls'] if c['role'] == ctrl['role'] and c['ntext'] == ctrl['ntext']]
                if len(fresh) != len(same): raise AiFailed('submit_control_moved')
                return fresh[k]
            checkfails += 1
            hist.append(f"{i + 1}. ready: CODE CHECK FAILED ({', '.join(failed)}). The page must show this restaurant/outlet and exactly the goal's dates as selected.")
            if checkfails > 2: raise AiFailed('presubmit_check_failed', failed=failed)
            continue
        sig = (act, ctrl['role'], ctrl['ntext'], str(obj.get('text')) if act == 'fill' else None)
        sigs[sig] = sigs.get(sig, 0) + 1
        if sigs[sig] >= 3: raise AiFailed('ai_loop', why='same_action_3x')
        try:
            if act == 'click': page.click_ref(ref, step='ai_click'); time.sleep(2)
            else: page.fill(ref, str(obj.get('text') or '')[:60], step='ai_fill'); time.sleep(1.5)
            hist.append(f"{i + 1}. {act} {ctrl['role']} \"{ctrl['ntext'][:60]}\"" + (f" with \"{obj.get('text')}\"" if act == 'fill' else '') + ' -> done')
        except UiChanged:
            if page.trail: page.trail.pop()
            refuse('the click/fill did not work')
    raise AiFailed('ai_step_cap')

# ---------------- replay of a learned recipe ----------------
def find_recorded(page, st, tokens, timeout=12):
    text = render(st['text'], tokens)
    end = time.time() + timeout
    while True:
        snap = page.snap()
        if '{*}' in text:
            rx = re.compile('^' + re.escape(text).replace(re.escape('{*}'), r'.+?') + '$')
            m = [c for c in snap['controls'] if c['role'] == st['role'] and rx.match(c['ntext'])]
        else:
            m = [c for c in snap['controls'] if c['role'] == st['role'] and c['ntext'] == text]
        if m: return (m[st['nth']] if len(m) == st.get('count') and st.get('nth', 0) < len(m) else m[-1]), text
        if time.time() >= end: return None, text
        time.sleep(1.5)

def replay(page, steps, tokens, log, timeout=12):
    for i, st in enumerate(steps):
        c, text = find_recorded(page, st, tokens, timeout)
        recipes.guard(text)
        if not c:
            if DISMISS_RX.match(st['text'] or ''):
                log.step('learned_step', result='skipped_optional', i=i + 1); continue
            raise UiChanged(f'learned_step_{i + 1}:not_found')
        if st['op'] == 'click': page.click_ref(c['ref'], step=f'learned_step_{i + 1}')
        else: page.fill(c['ref'], render(st.get('value'), tokens), step=f'learned_step_{i + 1}')
        log.step('learned_step', result='ok', i=i + 1, op=st['op'], role=st['role'], text=st['text'])
        time.sleep(2)

# ---------------- engine ----------------
def run_to(page, rc, anchor):
    """Scripted stages before `anchor`; then the page is where the anchor stage starts."""
    names = [n for n, _ in rc.stages]
    if anchor != 'submit' and anchor not in names: raise UiChanged('unknown_anchor:' + str(anchor))
    if anchor == names[0]:
        page.pb.navigate(recipes.PLATFORM_RULES[rc.platform]['start_url']); time.sleep(5)
        return
    for n, f in rc.stages:
        if n == anchor: break
        try: f(page, rc.ctx)
        except UiChanged as e:
            e.stage = n; raise

def submit_click(page, rc, ctrl, folder, log, mode):
    recipes.guard(ctrl['ntext'])
    if not SUBMIT_RX.match(ctrl['ntext'] or ''): raise UiChanged(mode + '_submit_not_allowed')
    t0 = page.pb.now()
    page.pb.act([{'kind': 'click', 'ref': ctrl['ref']}], downloads=folder)
    log.step(mode + '_submit', matched=ctrl['ntext'])
    path = recipes.wait_file(page, folder, rc.pattern, t0, 150)
    if not path: raise recipes.DownloadFailed(mode + '_download_timeout')
    return path

def make_candidate(trail, submit_ctrl, anchor, tokens, page):
    used = set(); steps = []; problem = None
    for t in trail:
        if t.get('ref_unknown'): problem = problem or 'unreplayable'; continue
        tt, pr = templatize(t['text'], tokens, used)
        if pr == 'empty': problem = problem or 'unreplayable'
        elif pr: problem = problem or pr
        st = {'op': t['op'], 'role': t['role'], 'text': tt, 'nth': t['nth'], 'count': t['count']}
        if t['op'] == 'fill':
            v, pr2 = templatize(t.get('value') or '', tokens, used)
            if pr2 == 'literal_date': problem = problem or pr2
            st['value'] = v
        steps.append(st)
    cs = (page.last or {}).get('controls') or []
    same = [x for x in cs if x['role'] == submit_ctrl['role'] and x['ntext'] == submit_ctrl['ntext']]
    sub = {'role': submit_ctrl['role'], 'text': templatize(submit_ctrl['ntext'], tokens)[0],
           'nth': same.index(submit_ctrl) if submit_ctrl in same else len(same) - 1, 'count': len(same)}
    return {'anchor': anchor, 'steps': steps, 'submit': sub, 'problem': problem}

def retemplate(cand, tokens):
    """Re-run templatize on a stored candidate's literal steps (used once when the wildcard rule was added)."""
    out = json.loads(json.dumps(cand)); problem = None
    for st in out['steps']:
        if '{' in (st['text'] or '') and '{*}' not in st['text']: continue
        t, pr = templatize(st['text'], tokens)
        st['text'] = t; problem = problem or pr
    out['problem'] = problem
    return out

def eligible(e):
    if NO_AI_STEPS.search(e.step or ''): return False
    if UNSCRIPTED.search(e.step or '') and not unscripted_on(): return False
    return True

def transcript(w, rc):
    d = os.path.join(logs_dir(), 'ai-runs'); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f"{w.get('run_id')}-{rc.platform}-{rc.report}-{rc.ps}.jsonl")
    def tlog(**k):
        rec = scrub_obj({'t': datetime.now(IST).isoformat(timespec='seconds'), **k})
        line = json.dumps(rec, ensure_ascii=False)
        for k in ('brand', 'outlet_name'):
            if w.get(k) and len(w[k]) >= 3: line = line.replace(w[k], '{' + k + '}')
        with open(p, 'a') as f: f.write(line + '\n')
    return tlog, p

def obtain(page, scripted_fn, recipe_fn, folder, log, w, prov):
    """Scripted -> learned -> AI. Returns (path, effective_pe). `prov` (dict) is filled in as it goes, also on failure:
    mode, scripted_tries, failed_stage, learned_version, ai_cost_inr, ai_calls, candidate."""
    prov.update(mode='scripted', scripted_tries=0, ai_cost_inr=0.0)
    last, stage = None, None
    store = None
    for i in range(scripted_tries()):
        prov['scripted_tries'] = i + 1
        try:
            return scripted_fn()
        except UiChanged as e:
            last, stage = e, getattr(e, 'stage', None)
            log.step('ui', result='ui_changed:' + e.step, stage=stage, scripted_try=i + 1)
            if not eligible(e) or page is None: raise
            rc0 = recipe_fn(); store = LearnedStore(rc0.platform, rc0.report)
            cur = store.current()
            if cur and cur['anchor'] == stage: break
    prov['failed_stage'] = stage
    if not stage: raise last
    rc = recipe_fn(); store = store or LearnedStore(rc.platform, rc.report)
    tk = date_tokens(rc.ps, rc.pe, w)
    w = dict(w, stage=stage)
    cur = store.current()
    if cur and cur['anchor'] == stage:
        prov.update(mode='learned', learned_version=cur['version'])
        try:
            page.trail = None
            run_to(page, rc, stage)
            replay(page, cur['steps'], tk, log)
            ok, failed = presubmit(page, rc, w)
            log.step('learned_presubmit', result='ok' if ok else 'failed', failed=failed, version=cur['version'])
            if not ok: raise UiChanged('learned_presubmit:' + ','.join(failed))
            c, _ = find_recorded(page, cur['submit'], tk)
            if not c: raise UiChanged('learned_submit:not_found')
            path = submit_click(page, rc, c, folder, log, 'learned')
            return path, rc.ctx['eff_pe']
        except (recipes.SignedOut, recipes.NotAvailable): raise
        except (UiChanged, recipes.DownloadFailed) as e:
            why = getattr(e, 'step', str(e))
            log.step('learned', result='stale', at=why, version=cur['version'])
            store.mark_stale(why, w.get('run_id')); prov['learned_stale'] = why
            rc = recipe_fn()
    # ---- AI ----
    prov.update(mode='ai')
    meter = {'inr': 0.0, 'calls': 0}
    tlog, tpath = transcript(w, rc); prov['ai_transcript'] = os.path.basename(tpath)
    spend = Spend()
    log.step('ai_start', result='started', stage=stage, model=model(), cap_inr=cap_inr(), night_spent_inr=round(spend.spent(), 2))
    try:
        page.trail = None
        run_to(page, rc, stage)
        page.trail = []
        ctrl = ai_solve(page, rc, w, log, spend, meter, tlog)
        trail = list(page.trail); page.trail = None
        cand = make_candidate(trail, ctrl, stage, tk, page)
        path = submit_click(page, rc, ctrl, folder, log, 'ai')
        prov['candidate'] = cand
        log.step('ai_done', result='file', steps=len(trail), cost_inr=round(meter['inr'], 2), calls=meter['calls'], learnable=not cand['problem'], problem=cand['problem'])
        return path, rc.ctx['eff_pe']
    except AiFailed as e:
        log.step('ai_done', result='failed:' + e.reason, cost_inr=round(meter['inr'], 2), calls=meter['calls'])
        raise
    finally:
        page.trail = None
        prov['ai_cost_inr'] = round(meter['inr'], 4); prov['ai_calls'] = meter['calls']

def learn(prov, w, rc_platform, report, evidence, log):
    """After every check passed and the rows are stored: promote the AI's candidate (or note a learned use)."""
    st = LearnedStore(rc_platform, report)
    if prov.get('mode') == 'learned':
        st.note_use(w.get('run_id')); return None
    cand = prov.get('candidate')
    if prov.get('mode') != 'ai' or not cand: return None
    e = st.promote(dict(cand, run_id=w.get('run_id'), window=evidence.get('window')), evidence)
    log.step('learned_saved', result=e['status'], version=e['version'], file=os.path.basename(st.path))
    return e

def learned_failed(prov, rc_platform, report, why, run_id):
    if prov.get('mode') == 'learned': LearnedStore(rc_platform, report).mark_stale(why, run_id)
