/**
 * All money is stored and computed as integer *minor units* (fils, cents, piasters…).
 * Floats only appear transiently inside pricing math and are rounded exactly once.
 */
export type Minor = number;

export interface CurrencyFormat {
  currency: string;
  decimals: number;
  locale: string;
}

/** Round to the nearest multiple of `unit` (cash rounding, e.g. 50 fils). unit <= 1 means no rounding. */
export function roundToUnit(value: number, unit: Minor): Minor {
  if (!unit || unit <= 1) return Math.round(value);
  return Math.round(value / unit) * unit;
}

/**
 * Turn exact (float) amounts into integers that sum to exactly `total`,
 * staying as close as possible to each exact value (largest-remainder method).
 * Used so that bill lines always add up to the bill total.
 */
export function allocate(total: Minor, exact: number[]): Minor[] {
  const out = exact.map((v) => Math.round(v));
  let diff = total - out.reduce((a, b) => a + b, 0);
  if (diff === 0 || out.length === 0) return out;

  // Positive diff: bump the entries that were rounded down the most. Negative: the reverse.
  const order = exact
    .map((v, i) => ({ i, err: v - (out[i] ?? 0) }))
    .sort((a, b) => (diff > 0 ? b.err - a.err : a.err - b.err));

  let k = 0;
  while (diff !== 0) {
    const idx = order[k % order.length]!.i;
    out[idx] = (out[idx] ?? 0) + Math.sign(diff);
    diff -= Math.sign(diff);
    k++;
  }
  return out;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Format integer minor units as a currency string, always with Latin digits unless the locale asks otherwise. */
export function formatMoney(value: Minor, fmt: CurrencyFormat, opts: { symbol?: boolean } = {}): string {
  const key = `${fmt.locale}|${fmt.currency}|${fmt.decimals}|${opts.symbol !== false}`;
  let nf = formatters.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(fmt.locale, {
      style: opts.symbol === false ? 'decimal' : 'currency',
      currency: fmt.currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: fmt.decimals,
      maximumFractionDigits: fmt.decimals,
    });
    formatters.set(key, nf);
  }
  return nf.format(value / 10 ** fmt.decimals);
}

/** Parse a user-typed major-unit string ("3.5", "3,500") into minor units. Returns null if invalid. */
export function parseMoney(input: string, decimals: number): Minor | null {
  const cleaned = input.trim().replace(/[\s,]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const [int, frac = ''] = cleaned.replace('-', '').split('.');
  if (frac.length > decimals) return null;
  const minor = Number(int) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || 0);
  return cleaned.startsWith('-') ? -minor : minor;
}
