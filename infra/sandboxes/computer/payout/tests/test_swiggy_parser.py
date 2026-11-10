import json,os,tempfile,time,unittest
from pathlib import Path
import swiggy_reconcile as s
import reconcile_base as b
class Parser(unittest.TestCase):
 def settings(self):return dict(outlet_id="SWIGGY_TEST_OUTLET",outlet_name="<Restaurant Name>")
 def fixture(self,rid='SWIGGY_TEST_OUTLET'):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);p=Path(t.name)/'invoice_Annexure_SWIGGY_TEST_OUTLET_04112026_fixture.xlsx'
  h=['Order ID','Order Status','Service Fees %','Commission','Commission charged on','Net Bill Value','Total Customer Paid','GST Collected','Total Swiggy Fees','GST on Service Fee','Complaint & Cancellation Charges','Total Taxes','Net Payout for Order']
  ol=[h,['1','delivered','20%',200,1000,1000,1050,50,236,36,10,50,754]]
  br=[['','Particulars','Delivered','Total'],['','Orders',1,1],['A','Total Customer Paid',1050,1050],['1','Item Total',1000,1000],['2','Packaging Charges',100,100],['3','Restaurant Discounts (Coupon based)',-100,-100],['4','Restaurant Discounts (Trade Discounts, Freebies and others)',0,0],['5','GST Collected',50,50],['B','Swiggy Fees',-200,-200],['C','Customer Complaints & Cancellation Charges',-10,-10],['D','Growth Investment In Ads','',-60],['','HyperBoost','',-60],['E','Other Charges and Refunds','',-25],['','Co-branded Partnership','',-20],['','Packaging Material','',-5],['F','Total Taxes','',-86],['18','GST Deduction','',-50],['19','GST on Service Fee','',-36],['20','TCS','',0],['21','TDS','',0],['G','Net Payout','',669]]
  b.write_workbook(str(p),{'Summary':[['<Restaurant Name>'],['Rest. ID - '+rid],['Payout Period','25 October - 31 October']],'Payout Breakup':br,'Order Level':ol});return p
 def screen(self):return dict(outlet_id='SWIGGY_TEST_OUTLET',period=['2026-10-25','2026-10-31'],status='paid',paid_amount='669',paid_date='2026-11-03',utr_last4='TEST')
 def test_signed_ads_no_doublecount_gst_bridge(self):
  r=s.parse(self.fixture(),self.screen(),self.settings());self.assertEqual(r['rows']['Ads'],'80.00');self.assertEqual(r['rows']['Comm.+PG+GST'],'200.00');self.assertEqual(r['bridged'],'669.00');self.assertTrue(r['strict_paid_match'])
 def test_boundary_period(self):
  x=self.screen();x['period'][0]='2026-10-24';r=s.parse(self.fixture(),x,self.settings());self.assertEqual(r['period'][0],'2026-10-25');self.assertTrue(any('boundary' in n for n in r['notes']))
 def test_wrong_outlet(self):
  with self.assertRaisesRegex(ValueError,'Wrong outlet'):s.parse(self.fixture('WRONG_TEST_OUTLET'),self.screen(),self.settings())
 def test_pending(self):
  x=self.screen();x['status']='processing'
  with self.assertRaisesRegex(ValueError,'Paid screen'):s.parse(self.fixture(),x,self.settings())
 def test_full_reference_refused(self):
  x=self.screen();x['utr_last4']='INVALID_LONG_REFERENCE'
  with self.assertRaisesRegex(ValueError,'last four'):s.parse(self.fixture(),x,self.settings())
 def test_discrepancy_not_hidden(self):
  x=self.screen();x['paid_amount']='669.07';r=s.parse(self.fixture(),x,self.settings());self.assertFalse(r['strict_paid_match']);self.assertTrue(r['paid_match']);self.assertEqual(r['paid_difference'],'0.07');self.assertEqual(r['bridged'],'669.00');self.assertIn('rounding difference ₹0.07',s.render(r))

 def test_paid_tolerance_boundary(self):
  for delta,expected in [('0.99',True),('-0.99',True),('1.00',False),('-1.00',False),('1.01',False)]:
   x=self.screen();x['paid_amount']=str(s.D('669')+s.D(delta));r=s.parse(self.fixture(),x,self.settings())
   self.assertEqual(r['paid_match'],expected,delta)
 def test_missing_scope_settings_refused(self):
  with self.assertRaisesRegex(ValueError,'settings required'):s.parse(self.fixture(),self.screen(),{})
 def test_stale_job_and_annexure_refused(self):
  path=self.fixture();root=path.parent;os.environ['PAYOUT_STATE_DIR']=str(root)
  self.addCleanup(lambda: os.environ.pop('PAYOUT_STATE_DIR', None))
  screen=self.screen();screen['job_label']='OTHER_JOB';screen_path=root/'screen.json';screen_path.write_text(json.dumps(screen))
  settings=root/'settings.json';settings.write_text(json.dumps(self.settings()))
  (root/'job.json').write_text(json.dumps({'label':'CURRENT_JOB','issued_epoch':time.time()}))
  with self.assertRaisesRegex(ValueError,'wrong logical job'):s.main([str(path),'--screen',str(screen_path),'--settings',str(settings)])
  screen['job_label']='CURRENT_JOB';screen_path.write_text(json.dumps(screen))
  (root/'job.json').write_text(json.dumps({'label':'CURRENT_JOB','issued_epoch':time.time()+10000}))
  with self.assertRaisesRegex(ValueError,'Stale annexure'):s.main([str(path),'--screen',str(screen_path),'--settings',str(settings)])
