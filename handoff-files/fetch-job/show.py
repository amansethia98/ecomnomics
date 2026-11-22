import json, sys
for l in open(sys.argv[1]):
    try: d = json.loads(l)
    except Exception: print(l[:200]); continue
    if d['step'].startswith('click:'): continue
    print(d['t'][11:19], d.get('platform', ''), d.get('window', ''), d['step'], d.get('result', ''), {k: v for k, v in d.items() if k in ('orders', 'adjustments', 'checks', 'checks_failed', 'raw_sha12', 'size', 'at', 'matched', 'http', 'errCode', 'cycle', 'warnings', 'error', 'rows', 'written', 'fetchId', 'model_cost_inr')})
