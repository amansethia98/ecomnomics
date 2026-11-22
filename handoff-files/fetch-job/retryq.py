"""08:00 retry list (16 Nov 2026). A window that still fails at 05:30 after scripted tries, learned steps and the AI is written here
instead of alerting. The routine runs `run_night.py --retry-queue` around 08:00; only windows that fail again are alerted.
File: logs/retry-queue/<IST date>-<slug>.json  {"entries": [{key, outlet, platform, report, periodStart, periodEnd, reason, status, ...}]}
status: pending -> resolved | failed_after_retry."""
import json, os
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__))
IST = timezone(timedelta(hours=5, minutes=30))
STATUSES_QUEUED = ('ui_changed', 'download_failed')

def _dir(): 
    d = os.path.join(os.environ.get('ECOM_FETCH_LOGS', os.path.join(HERE, 'logs')), 'retry-queue'); os.makedirs(d, exist_ok=True); return d
def path(day, slug): return os.path.join(_dir(), f'{day}-{slug}.json')
def today(): return datetime.now(IST).date().isoformat()
def key(outlet, platform, report, ps, pe): return f'{outlet}|{platform}|{report}|{ps}|{pe}'

def load(day, slug):
    try: return json.load(open(path(day, slug)))
    except Exception: return {'entries': []}

def save(day, slug, d):
    p = path(day, slug); tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(d, f, indent=1)
    os.replace(tmp, p)

def add(day, slug, outlet, platform, report, ps, pe, reason, run_id, detail=None):
    d = load(day, slug); k = key(outlet, platform, report, ps, pe)
    e = next((x for x in d['entries'] if x['key'] == k), None)
    now = datetime.now(IST).isoformat(timespec='seconds')
    if e is None:
        e = {'key': k, 'outlet': outlet, 'platform': platform, 'report': report, 'periodStart': ps, 'periodEnd': pe, 'first_run': run_id, 'added': now, 'tries': 0}
        d['entries'].append(e)
    if e.get('status') in (None, 'resolved', 'pending'): e['status'] = 'pending'
    e.update(reason=reason, last_run=run_id, updated=now, detail=detail)
    save(day, slug, d); return e

def pending(day, slug): return [e for e in load(day, slug)['entries'] if e.get('status') == 'pending']

def close(day, slug, k, status, run_id, reason=None):
    d = load(day, slug)
    for e in d['entries']:
        if e['key'] == k:
            e.update(status=status, closed_run=run_id, closed=datetime.now(IST).isoformat(timespec='seconds'), tries=e.get('tries', 0) + 1)
            if reason: e['final_reason'] = reason
    save(day, slug, d)
