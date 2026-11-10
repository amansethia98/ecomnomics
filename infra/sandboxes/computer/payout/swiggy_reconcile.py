#!/usr/bin/env python3
"""Local operational Swiggy owner report. No network/browser/private API code."""
import argparse,json,re,csv,sys,fcntl,time
from pathlib import Path
from datetime import datetime,timedelta
from decimal import Decimal as D
import reconcile_base as b
import swiggy_math as sm
from reconciliation_policy import within_rounding_tolerance, gap_note, runtime_dir
from owner_reconcile import rupee
N=lambda x:' '.join(str(x or '').split()).lower()
def number(x):
 t=str(x or '').strip().replace(',','').replace('₹','').replace('%','')
 if not t or t=='-':return D(0)
 if t.startswith('(') and t.endswith(')'):t='-'+t[1:-1]
 return D(t)
def source_meta(sheets,path,settings):
 summary=sheets.get('Summary',[]);joined=[' '.join(str(c) for c in r if c) for r in summary]
 rid=next((re.search(r'rest\.?\s*id\s*[-:]\s*(\S+)',s,re.I).group(1) for s in joined if re.search(r'rest\.?\s*id\s*[-:]\s*(\S+)',s,re.I)),None)
 expected=str(settings.get('outlet_id',''));name=settings.get('outlet_name','')
 if not expected or not name:raise ValueError('Expected outlet_id and outlet_name settings required')
 if rid!=expected or not any(N(name) in N(s) for s in joined):raise ValueError('Wrong outlet: source must match configured name and RID')
 filedate=re.search(rf'invoice_Annexure_{re.escape(rid)}_(\d{{8}})_',path.name,re.I)
 if not filedate:raise ValueError('Unexpected annexure filename/outlet, cannot prove year')
 paid_file=datetime.strptime(filedate[1],'%d%m%Y').date()
 ptext=next((s for s in joined if 'payout period' in s.lower()),'');match=re.search(r'(\d{1,2})\s+([A-Za-z]+)\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)',ptext)
 if not match:raise ValueError('Missing payout period in source Summary')
 def dt(day,month):
  for fmt in ('%d %B %Y','%d %b %Y'):
   try:
    d=datetime.strptime(f'{day} {month} {paid_file.year}',fmt).date()
    return d.replace(year=d.year-1) if d>paid_file else d
   except ValueError:pass
  raise ValueError('Bad period date')
 start,end=dt(match[1],match[2]),dt(match[3],match[4]);return rid,start,end
ADS=re.compile(r'\b(ads?|advertis\w*|cpc|sponsored|marketing|promoted)\b|growth.*investment|investment.*growth|co.branded partnership|brandverse',re.I)
def parse(path,screen,settings):
 path=Path(path);sheets=b.load_workbook(str(path));rid,start,end=source_meta(sheets,path,settings)
 if screen.get('outlet_id')!=rid or screen.get('status','').lower()!='paid':raise ValueError('Paid screen/outlet verification missing')
 if not re.fullmatch(r'[A-Za-z0-9]{4}',str(screen.get('utr_last4',''))):raise ValueError('Only UTR last four are permitted')
 if screen.get('paid_amount') is None or not screen.get('paid_date'):raise ValueError('Actual paid amount/date missing')
 period=[start.isoformat(),end.isoformat()];sp=screen.get('period');warnings=[]
 if sp!=period:
  if sp==[(start-timedelta(days=1)).isoformat(),end.isoformat()]:warnings.append(f'Dashboard navigation range starts {sp[0]}; annexure Payout Period is {period[0]}–{period[1]}. Owner period uses the annexure, not the preceding-day URL boundary.')
  else:raise ValueError('Screen period differs from annexure cycle')
 rows=sheets.get('Payout Breakup',[]);hi,head=next((i,r) for i,r in enumerate(rows) if any(N(v)=='particulars' for v in r) and any(N(v)=='total' for v in r));ci=next(i for i,v in enumerate(head) if N(v)=='particulars');ti=next(i for i,v in enumerate(head) if N(v)=='total')
 records=[];section=''
 for r in rows[hi+1:]:
  label=str(b.cell_at(r,ci)).strip();code=str(b.cell_at(r,ci-1)).strip();raw=b.cell_at(r,ti)
  if not label:continue
  if code in list('ABCDEFG'):section=code
  records.append(dict(label=label,norm=N(label),code=code,section=section,amount=number(raw)))
 def rec(prefix=None,code=None):
  hits=[r for r in records if (r['norm'].startswith(prefix) if prefix else r['code']==code)]
  if len(hits)!=1:raise ValueError('Missing/ambiguous Payout Breakup field '+str(prefix or code))
  return hits[0]['amount']
 orders=int(rec('orders'));sales=rec('item total')+rec('packaging charges');discount=-(rec('restaurant discounts (coupon')+rec('restaurant discounts (trade'));fee=-rec(code='B');ad_d=-rec(code='D');ead=[r for r in records if r['section']=='E' and r['code']!='E' and ADS.search(r['label'])];e_ads_signed=sum((r['amount'] for r in ead),D(0));ads=ad_d-e_ads_signed;enonad=rec(code='E')-e_ads_signed
 vals=sm.owner_rows(orders,sales,discount,ads,fee);gstcol=rec('gst collected');f=rec(code='F');c=rec(code='C');g=rec(code='G');gstfee=-rec('gst on service fee');gstpaid=-rec('gst deduction');tds=-rec('tds');tcs=-rec('tcs')
 ol=sheets.get('Order Level',[]);oi,oh=next((i,r) for i,r in enumerate(ol) if any(N(v)=='order id' for v in r) and any(N(v)=='service fees %' for v in r));idcol=next(i for i,v in enumerate(oh) if N(v)=='order id')
 data=[r for r in ol[oi+1:] if str(b.cell_at(r,idcol)).strip() and re.fullmatch(r'\d+(?:\.0)?',str(b.cell_at(r,idcol)).strip())]
 def col(prefix=None,exact=None):
  hits=[i for i,v in enumerate(oh) if (N(v)==exact if exact else N(v).startswith(prefix))]
  if len(hits)!=1:raise ValueError('Missing/ambiguous Order Level header '+str(prefix or exact))
  return hits[0]
 def total(prefix=None,exact=None):return sum((number(b.cell_at(r,col(prefix,exact))) for r in data),D(0))
 olcv=total('net bill value');olcustomer=total('total customer paid');olgst=total('gst collected');olfees=total('total swiggy fees');olgstfee=total('gst on service fee');olc=total('complaint & cancellation');oltax=total('total taxes');olnet=total('net payout for order')
 if len(data)!=orders:raise ValueError('Order count mismatch between summary and order rows')
 bridge=[('GST on service fee (outside owner fee row)',-gstfee),('TDS',-tds),('TCS',-tcs),('GST collected minus GST deduction',gstcol-gstpaid),('Complaints & cancellation charges',c),('Non-ad Other Charges/refunds',enonad)]
 # Source-derived subtotal differences; NEVER use paid amount/G as an unexplained plug.
 bridge += [('Tax subtotal F minus its rounded components',f-(-gstfee-tds-tcs-gstpaid)),('CV Order Level vs owner breakup totals',olcv-vals['CV']),('Customer-paid source residual vs OL CV + GST',olcustomer-olcv-olgst),('GST collected Order Level vs breakup',olgst-gstcol),('Fees breakup vs OL fees excluding GST',fee-(olfees-olgstfee)),('Taxes breakup vs Order Level',(-olgstfee-oltax)-f),('Complaints breakup vs Order Level',-olc-c),('Stored order payout vs order component equation',olnet-(olcustomer-olfees-olc-oltax))]
 bridge=[(k,sm.q(v)) for k,v in bridge];bridged=sm.q(vals['Net Payout']+sum((v for k,v in bridge),D(0)));platform=sm.q(g);paid=sm.q(screen['paid_amount']);diff_g=sm.q(bridged-platform);diff_paid=sm.q(paid-bridged)
 ri=col(exact='service fees %');commission_i=col(exact='commission');base_i=col(exact='commission charged on');rateorders=[]
 for r in data:
  rawrate=b.cell_at(r,ri);comm=number(b.cell_at(r,commission_i));rateorders.append(dict(id=str(b.cell_at(r,idcol)).removesuffix('.0'),rate=number(rawrate) if str(rawrate).strip() else None,commission=comm,base=number(b.cell_at(r,base_i)),charged=comm!=0))
 com=sm.assumed_commission(rateorders,settings.get('outlets',{}).get(rid,{}).get('onboarding_rate_percent'))
 unknown=[r for r in records if r['section']=='E' and r['code']!='E' and r['amount'] and not ADS.search(r['label'])]
 labels=[r['label'] for r in records if r['section']=='D' and r['code']!='D' and r['amount']]+[r['label'] for r in ead if r['amount']]
 notes=[f'Source: {path.name}; Payout Breakup TOTAL column; annexure period {start:%d %b %Y} – {end:%d %b %Y}; outlet {settings["outlet_name"]} RID{rid} verified. All-channel annexure includes Swiggy and Toing orders, not another outlet.',f'Ads labels used: Growth Investment In Ads ({", ".join(labels) or "no nonzero ad lines"}); D {rupee(ad_d)} plus genuine ads in Other Charges {rupee(-e_ads_signed)}, counted once. Non-ad Other Charges/refunds {rupee(enonad)} are bridge-only.',f'Comm.+PG+GST is source B Swiggy Fees {rupee(fee)} EXCLUDING GST on fees {rupee(gstfee)}; that GST goes in the bridge.',f'Commission check: {com["note"]}; {len(com["flags"])} different charged-rate orders flagged. Actual onboarding rate is not contract-verified; configurable per outlet.']
 for flag in com['flags']:notes.append(f'Commission flag order {flag["order_id"]}: charged {flag["charged_percent"]}%, reference {flag["reference_percent"]}%, fee difference {rupee(flag["fee_difference"])} (assumption check, not proof of overcharge).')
 notes.append('Bank bridge: Net '+rupee(vals['Net Payout'])+' '+' '.join(('+' if v>=0 else '−')+' '+rupee(abs(v))+' ('+k+')' for k,v in bridge if v)+' = '+rupee(bridged)+'; Swiggy G '+rupee(platform)+'; difference to G '+rupee(diff_g)+'.')
 notes.append(f'Paid screen: {rupee(paid)}, paid {screen["paid_date"]} IST, UTR …{screen["utr_last4"]}; paid minus bridge {rupee(diff_paid)}. Dashboard tie-out only; no bank statement/receipt of bank funds independently verified.')
 if diff_paid:notes.append(gap_note(diff_paid))
 if diff_g:notes.append('Source G bridge: '+gap_note(diff_g))
 if sm.q(olcv-vals['CV']):notes.append('Source CV inconsistency: owner breakup CV '+rupee(vals['CV'])+' vs Order Level '+rupee(olcv)+' (difference '+rupee(olcv-vals['CV'])+'); explicit source-derived bridge correction, not altered owner row.')
 for r in unknown:notes.append('Non-ad/unknown Other Charges line: '+r['label']+' '+rupee(r['amount'])+'; owner review, not assumed ads.')
 notes+=warnings
 return dict(outlet=settings['outlet_name'],locality=settings.get('locality',''),city=settings.get('city',''),outlet_id=rid,period=period,rows={k:str(v) for k,v in vals.items()},notes=notes,commission=com,ads_labels=labels,bridge={k:str(v) for k,v in bridge},bridged=str(bridged),platform_net=str(platform),paid_amount=str(paid),bridge_difference_to_G=str(diff_g),paid_difference=str(diff_paid),utr_last4=screen['utr_last4'],paid_date=screen['paid_date'],strict_paid_match=diff_paid==0 and diff_g==0,paid_match=within_rounding_tolerance(diff_paid) and within_rounding_tolerance(diff_g),tolerance_rule='absolute gap < INR 1; INR 1 or more fails',source_cv_difference=str(sm.q(olcv-vals['CV'])))
def render(r):
 out=[f'{r["outlet"]} | Payout Report | Swiggy '+ ' – '.join(r['period']),'',f'| Terms | What it means | Swiggy (RID {r["outlet_id"]}) |','|---|---|---:|']
 for label,meaning in zip(sm.LABELS,sm.MEANINGS):
  value=r['rows'][label];value=value if label=='Orders' else (f'{sm.q(value):.2f}%' if '%' in label else rupee(value));bold=label in ('Net Payout','Payout %');out.append('| '+('**'+label+'**' if bold else label)+' | '+meaning+' | '+('**'+value+'**' if bold else value)+' |')
 out+=['','Notes:']+['- '+n for n in r['notes']];return '\n'.join(out)
def main(argv=None):
 a=argparse.ArgumentParser();a.add_argument('workbook');a.add_argument('--screen',required=True);a.add_argument('--settings',required=True);a.add_argument('--job',default='');args=a.parse_args(argv);path=Path(args.workbook);screen=json.loads(Path(args.screen).read_text());settings=json.loads(Path(args.settings).read_text());root=runtime_dir();job=json.loads(Path(args.job).read_text() if args.job else (root/'job.json').read_text());lock=(root/'swiggy-processing.lock').open('a')
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if screen.get('job_label')!=job['label']:raise ValueError('Stale screen evidence: wrong logical job')
  if path.stat().st_mtime<job['issued_epoch']-2:raise ValueError('Stale annexure: fresh download required')
  statepath=root/'swiggy-processing-state.json';state=json.loads(statepath.read_text()) if statepath.exists() else {}
  if state.get('label')==job['label'] and state.get('success'):print(state['stdout']);print('Cached same-job success, no duplicate processing.');return
  r=parse(path,screen,settings);text=render(r);stem=path.with_name(path.stem+'-owner-swiggy');stem.with_suffix('.json').write_text(json.dumps(r,indent=2,ensure_ascii=False));stem.with_suffix('.md').write_text(text)
  with stem.with_suffix('.csv').open('w') as f:
   writer=csv.writer(f);writer.writerow(['Terms','What it means','Swiggy']);writer.writerows((l,m,r['rows'][l]) for l,m in zip(sm.LABELS,sm.MEANINGS))
  b.write_workbook(str(stem.with_suffix('.xlsx')),{'Summary':[['Terms','What it means','Swiggy'],*[[l,m,r['rows'][l]] for l,m in zip(sm.LABELS,sm.MEANINGS)],[],['Notes'],*[[n] for n in r['notes']]]});stdout=text+'\nOUTPUT: '+str(stem)+'.md / .json / .csv / .xlsx';statepath.write_text(json.dumps({'label':job['label'],'success':True,'stdout':stdout}));print(stdout)
 finally:
  fcntl.flock(lock,fcntl.LOCK_UN);lock.close()
if __name__=='__main__':main()
