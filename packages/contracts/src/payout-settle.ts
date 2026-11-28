/** Bank-paid amount, or the file's net after adjustments when the bank figure is absent. */
export function settledPayoutPaise(input: {
  paidAmountPaise: number | null;
  netPayoutPaise: number | null;
  adjustmentPaise: number;
}): number | null {
  if (input.paidAmountPaise != null) return input.paidAmountPaise;
  if (input.netPayoutPaise == null) return null;
  return input.netPayoutPaise - input.adjustmentPaise;
}
