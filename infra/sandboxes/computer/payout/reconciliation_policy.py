"""Shared owner bridge tolerance: strictly below INR 1, never a balancing plug."""
from decimal import Decimal
import os
from pathlib import Path
def within_rounding_tolerance(gap):
 return abs(Decimal(str(gap))) < Decimal('1')
def gap_note(gap):
 value=abs(Decimal(str(gap)))
 if value == 0: return 'Bridge exact; difference ₹0.00.'
 if within_rounding_tolerance(gap): return f'rounding difference ₹{value:.2f}; accepted under owner rule (absolute gap < ₹1). No balancing adjustment.'
 return f'FAIL: bridge difference ₹{value:.2f} is ₹1 or more; owner review required. No balancing adjustment or dispute sent.'
def runtime_dir():
 """This restaurant's payout files on its computer. Never a value from the product image."""
 configured=os.environ.get('PAYOUT_STATE_DIR','').strip()
 path=Path(configured).expanduser() if configured else Path.home()/'.local/share/payout-reconciliation'
 path.mkdir(parents=True, exist_ok=True)
 return path
