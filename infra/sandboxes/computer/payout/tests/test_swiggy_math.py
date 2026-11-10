import unittest
from decimal import Decimal as D
import swiggy_math as m
class Tests(unittest.TestCase):
 def test_owner_example(self):
  r=m.owner_rows(3,'1000','100','50','200');self.assertEqual(list(r),m.LABELS)
  self.assertEqual(r['CV'],D('900'));self.assertEqual(r['Net Payout'],D('650'));self.assertEqual(r['Payout %'],D('65'));self.assertEqual(r['Burn %'],D('35'))
  self.assertEqual(m.q(m.bridge(r['Net Payout'],'36','2',0,0,0,0,0)),D('612'))
 def test_zero(self):
  r=m.owner_rows(0,0,0,0,0);self.assertEqual([r[k] for k in ['Effective Discount %','Ads %','Payout %','Burn %']],[0]*4)
 def test_ads_refund(self):self.assertEqual(m.owner_rows(1,100,0,-10,0)['Payout %'],D('110.00'))
 def test_signed_adjustments(self):self.assertEqual(m.bridge(100,10,1,2,5,5,-3,4),D(88))
 def test_modal_and_configurable(self):
  rows=[dict(id=i,rate=r,commission=20,base=100) for i,r in enumerate([20,20,21])];a=m.assumed_commission(rows);self.assertEqual(a['rate'],'20.00');self.assertEqual(len(a['flags']),1);self.assertIn('assumed rate 20.00%',a['note']);self.assertEqual(len(m.assumed_commission(rows,21)['flags']),2)
 def test_no_fee_cancel_excluded(self):
  a=m.assumed_commission([dict(id=1,rate=20),dict(id=2,rate=0,charged=False)]);self.assertEqual(a['rate'],'20.00');self.assertEqual(a['flags'],[])
if __name__=='__main__':unittest.main()
