import unittest
from decimal import Decimal as D
import owner_reconcile as m
class Tests(unittest.TestCase):
 def test_worked_example(self):
  v=m.calculate(3,'1000','100','50','200')
  self.assertEqual(v,[3,D('1000'),D('100'),D('10'),D('900'),D('50'),D('5'),D('200'),D('650'),D('65'),D('35')])
  self.assertEqual(m.q(v[8]-D('2')+D('1')),D('649'))
 def test_zero_sales(self):self.assertEqual([m.calculate(0,0,0,0,0)[i] for i in [3,6,9,10]],[0]*4)
 def test_indian_grouping(self):self.assertEqual(m.rupee('123456.78'),'₹1,23,456.78')
 def test_assumed_mode_and_flags(self):
  o=[dict(id=str(i),rate=r,service_fee='20',cv='100',status='DELIVERED') for i,r in enumerate(['20','20','21'])]
  c=m.commission(o,{});self.assertEqual(c['rate'],'20.00');self.assertIn('assumed rate 20.00%',c['note']);self.assertEqual(len(c['flags']),1)
  c=m.commission(o,{'onboarding_rate_percent':21});self.assertEqual(len(c['flags']),2);self.assertEqual(c['rate'],'21.00')
 def test_ads_no_double_count_period(self):
  rows=[['A) Investments in growth services'],['Type','Deduction time period','Total amount','Adjusted amount','Outstanding amount'],['ADS','02 November 26 - 08 November 26','100','80','20'],['Total Ads & miscellaneous services','','100','80','20'],['ADS','26 October 26 - 01 November 26','50','10','40']]
  from datetime import date
  x=m.nonorder(rows,date(2026,11,2),date(2026,11,8));self.assertEqual(x['ads'],100);self.assertEqual(x['ads_adjusted'],90)
 def test_no_utr_output(self):
  r=dict(outlet='Test',outlet_id='1',period=['2026-11-02','2026-11-08'],rows=dict(zip(m.LABELS,map(str,m.calculate(1,100,0,0,0)))),notes=['UTR …TEST'])
  s=m.render(r);self.assertEqual(sum(line.startswith('| ') for line in s.splitlines()),12);self.assertIn('**Net Payout**',s)
 def test_recent_completed_week(self):
  from unittest.mock import patch
  from datetime import datetime
  with patch.object(m,'datetime') as clock:
   clock.now.return_value=datetime(2030,6,12)
   self.assertEqual([x.isoformat() for x in m.most_recent_week()],['2030-06-03','2030-06-09'])
if __name__=='__main__':unittest.main()

class Integration(unittest.TestCase):
 def fixture(self):
  import tempfile
  from pathlib import Path
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  p=Path(self.tmp.name)/'Zomato_Settlement_Report_ZOMATO_TEST_OUTLET_02 Nov 2026_08 Nov 2026.xlsx'
  headers=['Order ID','Order status','Res. name','Res. ID','Subtotal','Packaging','Restaurant discount [Promo]','Restaurant Discount [BOGO]','Total GST collected','Net order value','Commissionable value','Service fees %','Service fee','Service fee & payment mechanism fees','Taxes on service fees','Government charges','Other order-level deductions','Net Deductions','Net Additions','Order level Payout','Tax collected at source','TCS IGST amount','TDS 194O amount','GST paid by Zomato']
  row=['123','DELIVERED','Test','ZOMATO_TEST_OUTLET',100,0,10,0,4.5,94.5,90,20,18,18,3.24,7.83,0,25.83,0,68.67,0,0,.09,4.5]
  m.b.write_workbook(str(p),{'Order Level':[headers,row],'Payout Breakup':[['Particular','Total'],['Number of Orders',0]],'Addition Deductions Details':[]})
  return p
 def test_integration_mask_and_bridge(self):
  p=self.fixture();r=m.parse(p,{'outlet_id':'ZOMATO_TEST_OUTLET','outlets':{}},{'period':['2026-11-02','2026-11-08'],'status':'paid','paid_amount':'68.67','paid_date':'11 Nov 2026','utr_last4':'TEST'})
  self.assertEqual(r['bridge_difference'],'0.00');self.assertEqual(r['paid_difference'],'0.00');self.assertEqual(r['commission']['rate'],'20.00');self.assertEqual(len(r['rows']),11)
 def test_wrong_period_rejected(self):
  with self.assertRaisesRegex(ValueError,'period'):m.parse(self.fixture(),{'expected_period':['2026-10-26','2026-11-01']},{})
 def test_full_utr_rejected(self):
  with self.assertRaisesRegex(ValueError,'last four'):m.parse(self.fixture(),{},dict(period=['2026-11-02','2026-11-08'],status='paid',paid_amount='68.67',paid_date='11 Nov 2026',utr_last4='INVALID_LONG_REFERENCE'))
 def test_paid_without_reference_rejected(self):
  with self.assertRaisesRegex(ValueError,'Paid screen'):m.parse(self.fixture(),{},dict(period=['2026-11-02','2026-11-08'],status='paid'))

 def test_zomato_paid_rounding_boundary(self):
  for delta,expected in [('0.99',True),('-0.99',True),('1.00',False),('-1.00',False)]:
   screen=dict(period=['2026-11-02','2026-11-08'],status='paid',paid_amount=str(D('68.67')+D(delta)),paid_date='2030-11-12',utr_last4='TEST')
   r=m.parse(self.fixture(),{'outlet_id':'ZOMATO_TEST_OUTLET'},screen)
   self.assertEqual(r['paid_match'],expected,delta)
