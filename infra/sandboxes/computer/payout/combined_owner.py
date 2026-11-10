"""Offline-only combined formatter; live agent must supply fresh validated per-app JSON and screen evidence."""
from pathlib import Path
from decimal import Decimal as D,ROUND_HALF_UP
from datetime import date
import argparse,json,csv,os,re,zipfile,xml.etree.ElementTree as ET
import reconcile_base as b
from outlet_map import pair
q=lambda v:D(v).quantize(D('.01'),rounding=ROUND_HALF_UP)
def money(v):
 a,c=f'{abs(q(v)):.2f}'.split('.');p=a[-3:];a=a[:-3]
 while a:p=a[-2:]+','+p;a=a[:-2]
 return ('−' if D(v)<0 else '')+'₹'+p+'.'+c
def fmt(k,v):return str(int(D(v))) if k=='Orders' else (f'{q(v):.2f}%' if '%' in k else money(v))
def pretty(v):return date.fromisoformat(v).strftime('%-d %b %Y')
def render_png(path,title,period,headers,rows,notes):
 from PIL import Image,ImageDraw,ImageFont
 import os
 regular=os.environ.get('RECON_FONT_REGULAR','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
 bold=os.environ.get('RECON_FONT_BOLD','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
 font=lambda size,isbold=False:ImageFont.truetype(bold if isbold else regular,size)
 W=2400;pad=60;im=Image.new('RGB',(W,6000),'white');draw=ImageDraw.Draw(im)
 def wrap(text,f,width):
  result=[];cur=''
  for word in text.split():
   test=(cur+' '+word).strip()
   if cur and draw.textlength(test,font=f)>width:result.append(cur);cur=word
   else:cur=test
  return result+([cur] if cur else [])
 y=45
 for text,f,lineheight in [(title,font(40,True),55),(period,font(28),43)]:
  for line in wrap(text,f,W-2*pad):draw.text((pad,y),line,font=f,fill='#143b43');y+=lineheight
 y+=22;widths=[355,505,450,450,520]
 for i,row in enumerate([headers]+rows):
  isbold=i==0 or row[0] in ['Net Payout','Payout %'];f=font(28,isbold);lines=[wrap(t,f,w-28) for t,w in zip(row,widths)];h=max(76,max(map(len,lines))*39+26)
  draw.rectangle((pad,y,W-pad,y+h),fill='#143b43' if i==0 else ('#e1f1ea' if isbold else ('#f2f6f7' if i%2==0 else 'white')));x=pad
  for j,(ls,w) in enumerate(zip(lines,widths)):
   for n,line in enumerate(ls):draw.text((x+14 if j<2 or i==0 else x+w-14-draw.textlength(line,font=f),y+12+n*39),line,font=f,fill='white' if i==0 else '#172f35')
   x+=w
  y+=h
 y+=35;draw.text((pad,y),'Notes',font=font(28,True),fill='#143b43');y+=48
 for note in notes:
  for line in wrap(note,font(28),W-2*pad):draw.text((pad,y),line,font=font(28),fill='#23373c');y+=40
  y+=10
 im.crop((0,0,W,y+35)).save(path)

def style_workbook(path):
 ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';tag=lambda v:'{'+ns+'}'+v
 with zipfile.ZipFile(path) as f:data={n:f.read(n) for n in f.namelist()}
 styles='<styleSheet xmlns="'+ns+'"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF143B43"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf fontId="2" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
 data['xl/styles.xml']=styles.encode();ct=ET.fromstring(data['[Content_Types].xml']);ET.SubElement(ct,'{http://schemas.openxmlformats.org/package/2006/content-types}Override',PartName='/xl/styles.xml',ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml');data['[Content_Types].xml']=ET.tostring(ct)
 rel=ET.fromstring(data['xl/_rels/workbook.xml.rels']);ET.SubElement(rel,'{http://schemas.openxmlformats.org/package/2006/relationships}Relationship',Id='rIdStyles',Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',Target='styles.xml');data['xl/_rels/workbook.xml.rels']=ET.tostring(rel)
 for sheet in [1,2]:
  name=f'xl/worksheets/sheet{sheet}.xml';root=ET.fromstring(data[name]);old=root.find(tag('cols'))
  if old is not None:root.remove(old)
  cols=ET.Element(tag('cols'));widths=([25,45,18,18,24,20,20,24,20,20,24,20,20,52,65] if sheet==1 else [31,39,27,27,27])
  for i,w in enumerate(widths,1):ET.SubElement(cols,tag('col'),min=str(i),max=str(i),width=str(w),customWidth='1')
  sd=root.find(tag('sheetData'));root.insert(list(root).index(sd),cols);merges=ET.Element(tag('mergeCells'))
  for row in sd:
   cells=list(row);text=' '.join(''.join(c.itertext()) for c in cells);number=int(row.get('r'));bold=(number==1 if sheet==1 else number in [1,2] or text.startswith('Net Payout') or text.startswith('Payout %'))
   header=number==(1 if sheet==1 else 2)
   for c in cells:c.set('s','2' if header else ('1' if bold else '0'))
   height=40 if header else 35
   if sheet==1 and number==2:height=140
   if sheet==2 and len(cells)==1:
    ET.SubElement(merges,tag('mergeCell'),ref=f'A{number}:E{number}');height=max(28,16*(len(text)//145+2))
   row.set('ht',str(height));row.set('customHeight','1')
  if len(merges):merges.set('count',str(len(merges)));root.append(merges)
  data[name]=ET.tostring(root)
 with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as f:
  for n,v in data.items():f.writestr(n,v)

def map_default():
 configured=os.environ.get('PAYOUT_STATE_DIR','').strip()
 root=Path(configured).expanduser() if configured else Path.home()/'.local/share/payout-reconciliation'
 private=root/'owner-confirmed-outlet-map.csv'
 return str(private if private.is_file() else Path(__file__).parent/'owner-confirmed-outlet-map.csv')
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--zomato',required=True);ap.add_argument('--swiggy',required=True);ap.add_argument('--zscreen',required=True);ap.add_argument('--sscreen',required=True);ap.add_argument('--out',default=str(Path.cwd()));ap.add_argument('--outlet-map',default=map_default());a=ap.parse_args();Z=json.loads(Path(a.zomato).read_text());S=json.loads(Path(a.swiggy).read_text());zs=json.loads(Path(a.zscreen).read_text());ss=json.loads(Path(a.sscreen).read_text());out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
 assert Z['outlet_id'] and S['outlet_id'] and zs['status']=='paid' and ss['status']=='paid','Verified outlet and paid sources required'
 assert Z['period'][0]<=S['period'][1]<=Z['period'][1],'Swiggy cycle must end inside selected Zomato week'
 for sc in [zs,ss]:assert len(sc['utr_last4'])==4
 labels=list(Z['rows']);meanings=['Total number of orders','Total Sales','Discounts given by restaurant','discount %','commissionable value','ads spent','ads spent against total sales','commission + pg + gst','total amount in bank account','% of sales in bank account','% of burn'];total={k:str(q(D(Z['rows'][k])+D(S['rows'][k]))) for k in labels if '%' not in k};total['Orders']=str(int(D(total['Orders'])));sale=D(total['ST+PC'])
 for k,num in [('Effective Discount %','Merchant Discount Burn'),('Ads %','Ads'),('Payout %','Net Payout')]:total[k]=str(q(D(total[num])/sale*100)) if sale else '0.00'
 total['Burn %']=str(q((1-D(total['Net Payout'])/sale)*100)) if sale else '0.00'
 period=f'Zomato {pretty(Z["period"][0])} – {pretty(Z["period"][1])} · Swiggy {pretty(S["period"][0])} – {pretty(S["period"][1])}'
 matched=pair(Z,S,a.outlet_map);confirmed=matched['confirmed'];outlet_name=matched['outlet'];locality=matched['locality'];title=f'{outlet_name} ({locality})';match='' if confirmed else 'match uncertain – please confirm: cross-platform outlet mapping is not owner-confirmed.'
 banks=[]
 for name,r,screen in [('Zomato',Z,zs),('Swiggy',S,ss)]:
  gap=q(D(screen['paid_amount'])-D(r['bridged']));status='matches' if abs(gap)<1 else 'MISMATCH';rounding=f', {money(abs(gap))} rounding' if gap and abs(gap)<1 else (f', difference {money(gap)}' if gap else '')
  banks.append(f'{name} paid {money(screen["paid_amount"])} on {pretty(screen["paid_date"])} IST (UTR …{screen["utr_last4"]}) – {status}{rounding}.')
 commission='Commission: '+ '; '.join(f'{n} assumed rate {D(r["commission"]["rate"]).normalize():g}% (onboarding rate not yet provided), {len(r["commission"]["flags"])} differing-rate orders flagged' for n,r in [('Zomato',Z),('Swiggy',S)])+'. These are checks, not proven overcharges.'
 ads='Ads labels: Zomato – Investment in growth services / ADS; Swiggy – Growth Investment In Ads plus ads in Other Charges.'
 notes=([match] if match else [])+banks+[commission,ads];headers=['Terms','What it means',f'Zomato (ID {Z["outlet_id"]})',f'Swiggy (RID {S["outlet_id"]})','Total'];rows=[[k,m]+[fmt(k,r[k]) for r in [Z['rows'],S['rows'],total]] for k,m in zip(labels,meanings)]
 full=['| '+' | '.join(headers)+' |','|---|---|---:|---:|---:|']
 for row in rows:
  v=list(row)
  if v[0] in ['Net Payout','Payout %']:v=[('**'+x+'**') if i!=1 else x for i,x in enumerate(v)]
  full.append('| '+' | '.join(v)+' |')
 short=['| Term | Zomato | Swiggy | Total |','|---|---:|---:|---:|']
 for k in ['Orders','ST+PC','Effective Discount %','Ads %','Net Payout','Payout %','Burn %']:short.append('| '+k+' | '+' | '.join(fmt(k,r[k]) for r in [Z['rows'],S['rows'],total])+' |')
 chat=f'*{title} – Weekly Payouts {pretty(Z["period"][0])} – {pretty(Z["period"][1])}*\n'+period+'\n\n'+'\n'.join(short)+'\n\n'+'\n'.join('_'+line+'_' for line in banks)+('\n'+match if match else '')+'\n'+commission+'\n'+ads+'\n';(out/'owner-message.md').write_text(chat);(out/'combined-report.md').write_text(title+' | Payout Report | '+period+'\n\n'+'\n'.join(full)+'\n\nNotes:\n'+'\n'.join('- '+n for n in notes)+'\n');render_png(out/'combined-table.png',title+' | Payout Report',period,headers,rows,notes)
 cols=['Outlet','Locality','Zomato ID','Swiggy RID','Zomato Net Payout','Zomato Payout %','Zomato Burn %','Swiggy Net Payout','Swiggy Payout %','Swiggy Burn %','Total Net Payout','Total Payout %','Total Burn %','Bank check','Commission check']
 summary=[cols,[outlet_name,(locality if confirmed else locality+'; match uncertain – please confirm'),Z['outlet_id'],S['outlet_id']]+[fmt(k,r[k]) for r in [Z['rows'],S['rows'],total] for k in ['Net Payout','Payout %','Burn %']]+[' '.join(banks),commission],[],['Overall: 1 owner-confirmed cross-app pair in this report.' if confirmed else 'Overall: 1 provisional cross-app pair; no owner-confirmed locality map.'],['Terms','Zomato','Swiggy','Combined']]+[[k]+[fmt(k,r[k]) for r in [Z['rows'],S['rows'],total]] for k in ['Net Payout','ST+PC','Payout %']]
 outlet=[[title+' | Payout Report | '+period],headers]+rows+[['Owner notes']]+[[n] for n in notes]+[['Technical bridge / source notes — Excel only']]+[[name+': '+n] for name,r in [('Zomato',Z),('Swiggy',S)] for n in r['notes']]
 b.write_workbook(str(out/'Outlet-Payout-Report.xlsx'),{'Summary':summary,re.sub(r'[\[\]:*?/\\]',' ',outlet_name)[:31]:outlet});style_workbook(out/'Outlet-Payout-Report.xlsx');(out/'combined-data.json').write_text(json.dumps({'rows':total,'periods':[Z['period'],S['period']],'notes':notes,'outlet_match':'owner-confirmed' if confirmed else 'uncertain','outlet_map':a.outlet_map,'sources':[a.zomato,a.swiggy]},indent=2));print(chat);print('ATTACH IMAGE: '+str(out/'combined-table.png'));print('ATTACH EXCEL: '+str(out/'Outlet-Payout-Report.xlsx'))
if __name__=='__main__':main()
