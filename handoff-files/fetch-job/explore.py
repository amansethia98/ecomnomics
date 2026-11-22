"""Dev helper: show url/title and control role+name only (no page text; long digit runs masked)."""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pb import PB, controls, mask
container = os.environ.get('FETCH_COMPUTER_CONTAINER')
if not container:
    raise SystemExit('set FETCH_COMPUTER_CONTAINER (do not hard-code a live computer id)')
p = PB(container)
cmd = sys.argv[1]
if cmd == 'nav': r = p.navigate(sys.argv[2])
elif cmd == 'snap': r = p.snapshot(sys.argv[2] if len(sys.argv) > 2 else None)
elif cmd == 'act': r = p.act(json.loads(sys.argv[2]))
print('ok', r.get('ok'), 'url', mask(r.get('url', '')).split('?')[0], 'title', mask(r.get('title', '')), 'err', mask(str(r.get('error', '')))[:200], 'note', mask(str(r.get('note','')))[:200], 'loading', r.get('loading'))
if r.get('downloads'): print('downloads', [ {k:v for k,v in d.items() if k in ('name','size','ok','error')} for d in r['downloads']])
for ref, role, name, val in controls(r):
    print(ref, role, json.dumps(mask(name)[:90]), mask(str(val))[:30] if val is not None else '')
