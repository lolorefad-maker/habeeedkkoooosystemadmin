import { DomainError } from './errors';
import { roundToUnit, type Minor } from './money';

export interface ItemInput {
  qty: number;
  unitPrice: Minor;
  voided?: boolean;
}

export interface DiscountInput {
  kind: 'amount' | 'percent';
  /** Minor units for "amount", 0–100 for "percent". */
  value: number;
}

export interface CheckoutTotals {
  timeCharge: Minor;
  itemsTotal: Minor;
  subtotal: Minor;
  discountAmount: Minor;
  /** Positive or negative cash-rounding adjustment. */
  rounding: Minor;
  total: Minor;
  paid: Minor;
  /** total − paid. Negative means the customer is owed a refund. */
  due: Minor;
}

export function discountPercentOf(discount: DiscountInput | null, subtotal: Minor): number {
  if (!discount || subtotal <= 0) return 0;
  return discount.kind === 'percent' ? discount.value : (discount.value / subtotal) * 100;
}

export function computeCheckout(input: {
  timeCharge: Minor;
  items: ItemInput[];
  discount: DiscountInput | null;
  cashRounding: Minor;
  paid: Minor;
}): CheckoutTotals {
  const { timeCharge, items, discount, cashRounding, paid } = input;
  for (const it of items) {
    if (!Number.isInteger(it.qty) || it.qty <= 0) throw new DomainError('invalid_qty', 'Quantity must be a positive integer');
  }
  const itemsTotal = items.filter((i) => !i.voided).reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  const subtotal = timeCharge + itemsTotal;

  let discountAmount = 0;
  if (discount) {
    if (discount.value < 0) throw new DomainError('invalid_discount', 'Discount cannot be negative');
    if (discount.kind === 'percent' && discount.value > 100) throw new DomainError('invalid_discount', 'Discount over 100%');
    discountAmount = discount.kind === 'amount' ? discount.value : Math.round((subtotal * discount.value) / 100);
    discountAmount = Math.min(Math.max(0, discountAmount), subtotal);
  }

  const afterDiscount = subtotal - discountAmount;
  const total = Math.max(0, roundToUnit(afterDiscount, cashRounding));
  return {
    timeCharge,
    itemsTotal,
    subtotal,
    discountAmount,
    rounding: total - afterDiscount,
    total,
    paid,
    due: total - paid,
  };
}
