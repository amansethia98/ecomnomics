import unittest
from reconciliation_policy import within_rounding_tolerance as ok, gap_note
class Policy(unittest.TestCase):
 def test_boundary_both_signs(self):
  for x in ['0','0.07','-0.07','0.99','-0.99']:self.assertTrue(ok(x),x)
  for x in ['1','-1','1.01','-1.01']:self.assertFalse(ok(x),x)
 def test_explicit_note(self):
  self.assertIn('rounding difference ₹0.07',gap_note('-0.07'))
  self.assertIn('FAIL',gap_note('1'))
