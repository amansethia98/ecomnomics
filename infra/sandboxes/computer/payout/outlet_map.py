"""Load OWNER-confirmed mappings only; no owner rows are shipped or auto-created."""
import csv,re
from pathlib import Path
FIELDS=['outlet','locality','zomato_id','swiggy_rid']
def normalize(name):
 text=re.sub(r'\bthe\b','',str(name).casefold().replace('&',' and '))
 return ' '.join(re.sub(r'[^\w\s]',' ',text).split())
def load_confirmed(path):
 p=Path(path)
 if not p.exists():return []
 with p.open(newline='') as f:
  reader=csv.DictReader(f)
  if reader.fieldnames!=FIELDS:raise ValueError('Outlet-map columns must be '+','.join(FIELDS))
  rows=list(reader)
 seen_z=set();seen_s=set()
 for r in rows:
  if any(not r[k].strip() or '<' in r[k] or '>' in r[k] for k in FIELDS):raise ValueError('Owner map requires confirmed values, not placeholders')
  if r['zomato_id'] in seen_z or r['swiggy_rid'] in seen_s:raise ValueError('Ambiguous duplicate outlet mapping')
  seen_z.add(r['zomato_id']);seen_s.add(r['swiggy_rid'])
 return rows
def pair(zomato,swiggy,map_path):
 zn=normalize(zomato['outlet']);sn=normalize(swiggy['outlet'])
 if zn!=sn:raise ValueError('Different outlet names: owner confirmation required before pairing')
 rows=load_confirmed(map_path);matches=[r for r in rows if r['zomato_id']==zomato['outlet_id'] or r['swiggy_rid']==swiggy['outlet_id']]
 if matches:
  r=matches[0]
  if len(matches)!=1 or r['zomato_id']!=zomato['outlet_id'] or r['swiggy_rid']!=swiggy['outlet_id'] or normalize(r['outlet'])!=zn:raise ValueError('Source conflicts with owner-confirmed map')
  return dict(confirmed=True,outlet=r['outlet'],locality=r['locality'])
 for key in ['city','locality']:
  a,b=zomato.get(key,''),swiggy.get(key,'')
  if a and b and normalize(a)!=normalize(b):raise ValueError('Different '+key+': do not pair')
 return dict(confirmed=False,outlet=zomato['outlet'],locality=zomato.get('locality') or swiggy.get('locality') or 'locality unconfirmed')
