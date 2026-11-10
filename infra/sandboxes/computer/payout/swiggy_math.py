"""Pure deterministic Swiggy owner rows and signed bank bridge. No IO/browser code."""
from decimal import Decimal as D,ROUND_HALF_UP
from collections import Counter
LABELS=['Orders','ST+PC','Merchant Discount Burn','Effective Discount %','CV','Ads','Ads %','Comm.+PG+GST','Net Payout','Payout %','Burn %']
MEANINGS=['Total number of orders','Total Sales','Discounts given by restaurant','discount %','commissionable value','ads spend','ads spent against total sales','commission + pg + gst','total amount in bank account','% of sales in bank account','% of burn']
def dec(x):return D(str(x))
def q(x):return dec(x).quantize(D('.01'),rounding=ROUND_HALF_UP)
def owner_rows(orders,sales,discount,ads,total_fees):
 sales,discount,ads,total_fees=map(q,(sales,discount,ads,total_fees));cv=sales-discount;net=cv-ads-total_fees;pct=lambda x:q(x/sales*100) if sales else D(0)
 vals=[int(orders),sales,discount,pct(discount),cv,ads,pct(ads),total_fees,net,pct(net),q(100-net/sales*100) if sales else D(0)]
 return dict(zip(LABELS,vals))
def bridge(net,gst_on_fees,tds,tcs,gst_collected,gst_deducted,complaints_signed,nonad_other_signed):
 return dec(net)-dec(gst_on_fees)-dec(tds)-dec(tcs)+dec(gst_collected)-dec(gst_deducted)+dec(complaints_signed)+dec(nonad_other_signed)
def assumed_commission(orders,configured=None):
 charged=[o for o in orders if o.get('charged',True) and o.get('rate') is not None];counts=Counter(dec(o['rate']) for o in charged)
 if configured is not None:rate=dec(configured);note=f'configured onboarding rate {rate:.2f}%'
 elif counts:
  rate=sorted(counts,key=lambda r:(-counts[r],r))[0];note=f'assumed rate {rate:.2f}% (onboarding rate not yet provided)'
  if sum(v==counts[rate] for v in counts.values())>1:note+='; tied modal rates, lowest selected provisionally'
 else:return dict(rate=None,note='No charged service-fee percentages available; actual onboarding rate needed.',flags=[],counts={})
 flags=[{'order_id':str(o['id']),'charged_percent':str(q(o['rate'])),'reference_percent':str(q(rate)),'fee_difference':str(q(dec(o['commission'])-dec(o['base'])*rate/100)) if o.get('commission') is not None and o.get('base') is not None else None} for o in charged if dec(o['rate'])!=rate]
 return dict(rate=str(q(rate)),note=note,flags=flags,counts={str(q(k)):v for k,v in counts.items()})
