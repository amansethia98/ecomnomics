#!/usr/bin/env python3
from reconciliation_policy import within_rounding_tolerance, gap_note
"""Local operational Zomato owner-format calculator; no network/browser/session code."""
import argparse,csv,json,re
from pathlib import Path
from decimal import Decimal as D
from collections import Counter
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
import reconcile_base as b
LABELS=['Orders','ST+PC','Merchant Discount Burn','Effective Discount %','CV','Ads','Ads %','Comm.+PG+GST','Net Payout','Payout %','Burn %']
MEANINGS=['Total number of orders','Total Sales','Discounts given by restaurant','discount %','commissionable value','ads spent','ads spent against total sales','commission + pg + gst','total amount in bank account','% of sales in bank account','% of burn']
def q(v):return b.cents(D(str(v)))
def rupee(v):
 s=f'{q(v):.2f}';neg=s.startswith('-');s=s.lstrip('-');a,c=s.split('.');end=a[-3:];a=a[:-3];parts=[]
 while a:parts.insert(0,a[-2:]);a=a[:-2]
 return ('-' if neg else '')+'₹'+(','.join(parts+[end]))+'.'+c
def calculate(orders,sales,discount,ads,fees):
 sales,discount,ads,fees=map(q,(sales,discount,ads,fees));cv=sales-discount;net=cv-ads-fees
 pct=lambda v:q(v/sales*100) if sales else D(0)
 return [int(orders),sales,discount,pct(discount),cv,ads,pct(ads),fees,net,pct(net),q(100-net/sales*100) if sales else D(0)]
def commission(orders,setting):
 rates=[q(o['rate']) for o in orders if o['rate']!='' and o.get('status','') not in ('CANCELLED','REJECTED')]
 counts=Counter(rates)
 if setting.get('onboarding_rate_percent') is not None:
  rate=q(setting['onboarding_rate_percent']);note=f'configured onboarding rate {rate:.2f}%'
 elif counts:
  rate=sorted(counts,key=lambda r:(-counts[r],r))[0];note=f'assumed rate {rate:.2f}% (onboarding rate not yet provided)'
  if sum(c==counts[rate] for c in counts.values())>1:note+='; tied modes, lowest selected provisionally'
 else:return {'rate':None,'note':'No charged service fee % available; please provide onboarding rate.','flags':[]}
 flags=[{'order_id':o['id'],'charged_percent':str(q(o['rate'])),'assumed_or_configured_percent':str(rate),'fee_difference':str(q(D(str(o['service_fee']))-D(str(o['cv']))*rate/100))} for o in orders if o['rate']!='' and q(o['rate'])!=rate and o.get('status','') not in ('CANCELLED','REJECTED')]
 return {'rate':str(rate),'note':note,'flags':flags,'rate_counts':{str(k):v for k,v in counts.items()}}
def most_recent_week():
 today=datetime.now(ZoneInfo('Asia/Kolkata')).date();end=today-timedelta(days=today.weekday()+1);return end-timedelta(days=6),end
def date_start(text):
 text=str(text).strip();part=re.split(r'\s+[-–]\s+',text)[0]
 for fmt in ('%d %B %y','%d %b %Y','%d %B %Y','%Y-%m-%d'):
  try:return datetime.strptime(part,fmt).date()
  except ValueError:pass
 raise ValueError('Unrecognised ads deduction period (cannot allocate safely)')
def ads_like(s):return bool(re.search(r'\b(ads?|advertis\w*|sponsored|cpc|marketing|promoted)\b|investment.*growth|growth.*investment',b.norm(s)))
def nonorder(rows,start,end):
 section='';header=None;ads=D(0);adjusted_ads=D(0);deductions=D(0);adds=D(0);labels=set();count=0;warnings=[]
 for row in rows:
  joined=' '.join(str(v) for v in row if v);low=b.norm(joined)
  if low=='addition type':section='addition';header=None;continue
  if low=='deduction type':section='';header=None;continue
  if re.match(r'^[a-d]\)',low):section=joined;header=None;continue
  if 'total deductions' in low:continue
  if b.find_col(row,'adjusted') is not None and b.find_col(row,'total amount') is not None:header=row;continue
  if header is None or 'total additions' in low or re.match(r'^total\b',low):continue
  def val(*keys):return b.cell_at(row,b.find_col(header,*keys))
  typ=val('type')
  if not typ:continue
  total=b.money(val('total amount'));adj=b.money(val('adjusted'));period=val('deduction time period')
  if section=='addition':adds+=adj;continue
  if ads_like(typ) or ads_like(section):
   adjusted_ads+=adj
   if not period:raise ValueError('Ads line missing deduction period')
   first=date_start(period)
   if start<=first<=end:ads+=total;count+=1;labels.add(section+' / '+str(typ))
   else:warnings.append('Ads from another deduction period adjusted in this payout: '+rupee(adj))
  else:
   deductions+=adj
   if adj and not any(x in b.norm(section) for x in ['hyperpure','previous week']):warnings.append('Non-ad/unknown deduction: '+str(typ)+' '+rupee(adj)+'; owner review required')
 return dict(ads=ads,ads_adjusted=adjusted_ads,deductions=deductions,additions=adds,labels=sorted(labels),count=count,warnings=warnings)
def parse(path,config,screen):
 sheets=b.load_workbook(str(path));raw=sheets['Order Level'];hi,header=next((i,r) for i,r in enumerate(raw) if 'order id' in [b.norm(c) for c in r]);orders=b._orders(raw)
 def idx(*n,required=False):
  c=b.find_col(header,*n)
  if c is None and required:raise ValueError('Missing required header: '+' '.join(n))
  return c
 for words in [('subtotal',),('packaging',),('discount','promo'),('payment mechanism fees',),('taxes on service',),('government charges',),('net order value',),('other order-level',),('net deductions',),('net additions',),('commissionable value',)]:idx(*words,required=True)
 def sumcol(*n,required=False):
  c=idx(*n,required=required);return sum((b.money(b.cell_at(r,c)) for r in raw[hi+1:] if b.order_id(b.cell_at(r,idx('order id')))),D(0))
 rows=[r for r in raw[hi+1:] if b.order_id(b.cell_at(r,idx('order id')))];rids={str(o['rid']).removesuffix('.0') for o in orders};assert len(rids)==1,'Mixed outlets refused';rid=next(iter(rids))
 pattern=re.search(r'_(\d{2} \w+ \d{4})_(\d{2} \w+ \d{4})',path.name)
 if not pattern:raise ValueError('Cannot prove report period from source filename')
 start,end=[datetime.strptime(x,'%d %b %Y').date() for x in pattern.groups()]
 if screen and screen.get('period')!=[start.isoformat(),end.isoformat()]:raise ValueError('Payouts-screen period missing or wrong')
 expected=config.get('expected_period')
 if expected=='latest_completed':expected=[x.isoformat() for x in most_recent_week()]
 if expected and [start.isoformat(),end.isoformat()]!=expected:raise ValueError('Wrong settlement period')
 if config.get('outlet_id') and rid!=config['outlet_id']:raise ValueError('Wrong outlet')
 sums=lambda k:sum((b.money(o[k]) for o in orders),D(0))
 non=nonorder(sheets.get('Addition Deductions Details',[]),start,end)
 extra_ads=sumcol('extra inventory','ads');ads=non['ads']+extra_ads
 values=calculate(len(orders),sums('subtotal')+sums('packaging'),sums('promo')+sums('other_discount'),ads,sums('fees')+sums('tax_on_fees'))
 # Prefer populated payout summary totals; blank formula summaries use order columns.
 summary=sheets.get('Payout Breakup',[]);summary_used=False
 hr=b._header_row(summary,'particular')
 if hr:
  sh=hr[1];ci=b.find_col(sh,'particular');ti=b.find_col(sh,'total');lookup=[(b.norm(b.cell_at(r,ci)),b.cell_at(r,ti)) for r in summary]
  def pick(*needles):
   hits=[v for k,v in lookup if all(n in k for n in needles)]
   return b.money(hits[0]) if hits else None
  ns=pick('number of orders')
  if ns and ns>0:
   st=pick('subtotal');pc=pick('packaging');promo=pick('restaurant discount','promo');other=next((b.money(v) for k,v in lookup if 'restaurant discount' in k and 'promo' not in k),None);fees=pick('service fees & payment mechanism fees');tax=pick('taxes on service')
   if all(x is not None for x in (st,pc,promo,other,fees,tax)):
    sv=calculate(int(ns),st+pc,promo+other,ads,fees+tax)
    if any(abs(D(str(a))-D(str(z)))>D('.05') for a,z in zip(values,sv)):raise ValueError('Payout Breakup and Order Level disagree beyond tolerance')
    values=sv;summary_used=True
 # Independent bank bridge from named components, not an unexplained plug.
 tds=sumcol('tds','194o',required=True);tcs=sumcol('tax collected at source',required=True)+sumcol('tcs igst');gst=sums('gst')-sumcol('gst paid by zomato',required=True)
 other=sums('other')-extra_ads;additions=sums('net_additions')+non['additions']
 # Any self-logistics / subscription / discount differences are explicitly bridged.
 order_value_delta=sums('net_order')-sums('gst')-values[4]
 bridge=[('TDS 194O',-tds),('TCS including IGST',-tcs),('GST collected minus GST paid u/s 9(5)',gst),('Other order-level deductions excluding ads',-other),('Hyperpure / other non-order deductions',-non['deductions']),('Additions including cancellation refunds / ads credits',additions),('Ads allocated to this week minus ads deducted',non['ads']-non['ads_adjusted']),('Other net-order-value adjustments',order_value_delta),('Cancellation/rejection sales reversal',sums('payout')-(sums('net_order')-sums('net_deductions')+sums('net_additions'))),('Other government charges',-(sums('government')-tds-tcs-sumcol('gst paid by zomato',required=True)-sums('tax_on_fees')))]
 bridged=q(values[8]+sum(v for _,v in bridge));order_payout=sums('payout')-non['ads_adjusted']-non['deductions']+non['additions'];sheet_net=b._sheet_net_payout(summary,sums('payout'));platform=q(sheet_net if sheet_net is not None else order_payout)
 charged=[]
 for row,o in zip(rows,orders):
  charged.append(dict(id=o['id'],status=o['status'],rate=b.cell_at(row,idx('service','fees','%')) if idx('service','fees','%') is not None else b.cell_at(row,idx('base service','%')),service_fee=b.cell_at(row,next((i for i,h in enumerate(header) if ('service fee' in b.norm(h)) and not any(t in b.norm(h) for t in ['%','payment','tax','government','discount'])),None)),cv=b.cell_at(row,idx('commissionable value'))))
 com=commission(charged,config.get('outlets',{}).get(rid,{}))
 paid=screen.get('paid_amount');status=screen.get('status','not read');diff=q(D(str(paid))-platform) if paid is not None else None
 # All screen fields are non-secret except UTR, accepted as LAST FOUR only.
 utr=str(screen.get('utr_last4',''))
 if status.lower()=='paid' and (paid is None or not screen.get('paid_date') or not utr):raise ValueError('Paid screen requires amount, date and UTR last-four')
 if utr and not re.fullmatch(r'[A-Za-z0-9]{4}',utr):raise ValueError('UTR must contain last four only')
 notes=[f'Source: {path.name}; {start:%d %b %Y} – {end:%d %b %Y}; '+('Payout Breakup totals verified against Order Level.' if summary_used else 'Summary blank → computed from Order Level and Addition Deductions Details.'),f'Ads label used: {", ".join(non["labels"]) or "no non-order ads lines"}; {non["count"]} invoice lines; extra inventory ads {rupee(extra_ads)}.',f'Commission check: {com["note"]}; {len(com["flags"])} different-rate orders flagged. Please provide the actual onboarding rate to replace this assumption.']
 for f in com['flags']:notes.append(f'Commission flag: order {f["order_id"]}, charged {f["charged_percent"]}%, reference {f["assumed_or_configured_percent"]}%, fee difference {rupee(f["fee_difference"])}.')
 notes.append('Bank bridge: Net '+rupee(values[8])+' '+ ' '.join(('+' if v>=0 else '−')+' '+rupee(abs(v))+' ('+k+')' for k,v in bridge if v)+' = '+rupee(bridged)+'; Zomato Net Payout (I'+(' reconstructed; blank summary' if sheet_net is None else '')+') '+rupee(platform)+'; bridge difference '+rupee(bridged-platform)+'.')
 if status.lower() in ('pending','processing','not paid yet','estimated'):
  notes.append('Payouts screen: not paid yet; '+str(screen.get('paid_date','payout date not read'))+' IST; no paid amount/UTR. Bank check waits for payout; no bank receipt claimed.')
 elif paid is not None:
  notes.append('Payouts screen: paid '+rupee(paid)+' on '+str(screen.get('paid_date','date missing'))+' IST, UTR …'+utr+'; difference from Zomato I '+rupee(diff)+'. Dashboard tie-out only; bank statement not checked.')
 else:notes.append('Payouts screen not verified; bank check incomplete. No paid amount/UTR invented.')
 notes+=non['warnings']
 cv_file=sumcol('commissionable value');
 if abs(q(cv_file)-values[4])>D('.05'):notes.append('File CV differs: '+rupee(cv_file)+' vs owner formula '+rupee(values[4])+'.')
 if bridged!=platform:notes.append('Source payout bridge: '+gap_note(bridged-platform))
 paid_bridge_diff=q(D(str(paid))-bridged) if paid is not None else None
 if paid_bridge_diff:notes.append('Paid bank bridge: '+gap_note(paid_bridge_diff))
 return dict(outlet=orders[0]['name'],locality=config.get('locality',''),city=config.get('city',''),outlet_id=rid,period=[start.isoformat(),end.isoformat()],rows=dict(zip(LABELS,map(str,values))),notes=notes,commission=com,bridge={k:str(q(v)) for k,v in bridge},bridged=str(bridged),platform_net=str(platform),bridge_difference=str(q(bridged-platform)),paid_difference=str(diff) if diff is not None else None,payout_status=status,utr_last4=utr,source_summary_used=summary_used,paid_bridge_difference=str(paid_bridge_diff) if paid_bridge_diff is not None else None,paid_match=(status.lower()=='paid' and paid_bridge_diff is not None and within_rounding_tolerance(paid_bridge_diff) and within_rounding_tolerance(bridged-platform)),tolerance_rule='absolute gap < INR 1; INR 1 or more fails')
def render(report):
 values=report['rows'];out=[f'{report["outlet"]} (ID {report["outlet_id"]}) | Payout Report | Zomato '+ ' – '.join(report['period']),'','| Terms | What it means | Zomato (ID '+report['outlet_id']+') |','|---|---|---:|']
 for label,meaning in zip(LABELS,MEANINGS):
  value=values[label];text=value if label=='Orders' else (f'{q(value):.2f}%' if '%' in label else rupee(value));bold=label in ('Net Payout','Payout %');out.append('| '+('**'+label+'**' if bold else label)+' | '+meaning+' | '+('**'+text+'**' if bold else text)+' |')
 out+=['','Notes:']+['- '+x for x in report['notes']];return '\n'.join(out)
def main(argv=None):
 a=argparse.ArgumentParser();a.add_argument('workbook');a.add_argument('--config',required=True);a.add_argument('--screen',required=True);args=a.parse_args(argv);path=Path(args.workbook);config=json.loads(Path(args.config).read_text());screen=json.loads(Path(args.screen).read_text());report=parse(path,config,screen);text=render(report);stem=path.with_name(path.stem+'-owner-reconciliation');stem.with_suffix('.json').write_text(json.dumps(report,indent=2,ensure_ascii=False));stem.with_suffix('.md').write_text(text)
 with stem.with_suffix('.csv').open('w') as f:
  writer=csv.writer(f);writer.writerow(['Terms','What it means','Zomato']);writer.writerows((l,m,report['rows'][l]) for l,m in zip(LABELS,MEANINGS))
 b.write_workbook(str(stem.with_suffix('.xlsx')),{'Summary':[['Terms','What it means','Zomato'],*[[l,m,report['rows'][l]] for l,m in zip(LABELS,MEANINGS)],[],['Notes'],*[[x] for x in report['notes']]]});print(text);print('\nOUTPUT: '+str(stem)+'.md / .json / .csv / .xlsx')
if __name__=='__main__':main()
