"""Synthetic-only JSON fixtures. Workbook/PNG outputs exist only in TemporaryDirectory."""
import unittest,tempfile,json,csv,subprocess,sys
from pathlib import Path
from decimal import Decimal
from PIL import Image
import openpyxl
import owner_reconcile as zmath
from outlet_map import FIELDS
class Combined(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.z=self.app('ZOMATO_TEST_OUTLET',3,1000,100,50,200,['2030-11-04','2030-11-10'])
  self.s=self.app('SWIGGY_TEST_OUTLET',5,600,150,30,120,['2030-11-03','2030-11-09'])
  for name,value in [('z',self.z),('s',self.s)]:
   (self.root/(name+'.json')).write_text(json.dumps(value));screen=dict(status='paid',paid_amount=value['bridged'],paid_date='2030-11-12',utr_last4='TEST');(self.root/(name+'screen.json')).write_text(json.dumps(screen))
 def app(self,outlet,orders,sales,discount,ads,fees,period):
  rows=dict(zip(zmath.LABELS,map(str,zmath.calculate(orders,sales,discount,ads,fees))))
  return dict(outlet='DEMO_OUTLET',outlet_id=outlet,rows=rows,period=period,bridged=rows['Net Payout'],commission=dict(rate='20',flags=[]),notes=['Bank bridge: synthetic test explanation; no source data.'])
 def run_builder(self,confirmed=False):
  mapfile=self.root/'map.csv'
  with mapfile.open('w',newline='') as f:
   w=csv.DictWriter(f,fieldnames=FIELDS);w.writeheader()
   if confirmed:w.writerow(dict(outlet='DEMO_OUTLET',locality='DEMO_LOCALITY',zomato_id=self.z['outlet_id'],swiggy_rid=self.s['outlet_id']))
  script=Path(__file__).resolve().parents[1]/'combined_owner.py';self.output=self.root/'output'
  result=subprocess.run([sys.executable,str(script),'--zomato',str(self.root/'z.json'),'--swiggy',str(self.root/'s.json'),'--zscreen',str(self.root/'zscreen.json'),'--sscreen',str(self.root/'sscreen.json'),'--outlet-map',str(mapfile),'--out',str(self.output)],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr);return json.loads((self.output/'combined-data.json').read_text())
 def test_money_and_recomputed_percentages(self):
  data=self.run_builder();self.assertEqual(data['rows']['Orders'],'8');self.assertEqual(data['rows']['ST+PC'],'1600.00');self.assertEqual(data['rows']['Net Payout'],'950.00');self.assertEqual(data['rows']['Payout %'],'59.38');self.assertEqual(data['rows']['Burn %'],'40.63')
 def test_confirmation_removes_uncertainty(self):
  data=self.run_builder(True);self.assertEqual(data['outlet_match'],'owner-confirmed');self.assertNotIn('uncertain',(self.output/'owner-message.md').read_text());self.assertEqual(len(data['notes']),4)
 def test_unknown_pair_retains_uncertainty(self):
  self.run_builder();self.assertIn('match uncertain – please confirm',(self.output/'owner-message.md').read_text())
 def test_png_and_excel_and_plain_notes(self):
  self.run_builder(True)
  with Image.open(self.output/'combined-table.png') as im:self.assertEqual(im.width,2400);im.verify()
  w=openpyxl.load_workbook(self.output/'Outlet-Payout-Report.xlsx',data_only=True);self.assertEqual(w.sheetnames,['Summary','DEMO_OUTLET']);self.assertTrue(w['DEMO_OUTLET']['A11'].font.bold);self.assertTrue(w['DEMO_OUTLET']['A12'].font.bold);self.assertEqual(len(list(w['Summary'].values)[0]),15)
  text=(self.output/'owner-message.md').read_text();self.assertNotIn('Bank bridge:',text);self.assertEqual(sum(l.startswith('|') for l in text.splitlines()),9);self.assertTrue(any('Bank bridge:' in str(c.value) for row in w['DEMO_OUTLET'] for c in row))
 def test_rounding_note_is_not_a_plug(self):
  screen=json.loads((self.root/'sscreen.json').read_text());screen['paid_amount']=str(Decimal(self.s['bridged'])+Decimal('.09'));(self.root/'sscreen.json').write_text(json.dumps(screen));self.run_builder(True);self.assertIn('₹0.09 rounding',(self.output/'owner-message.md').read_text())
