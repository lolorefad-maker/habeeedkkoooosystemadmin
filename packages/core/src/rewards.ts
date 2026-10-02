import type { Minor } from './money';

/**
 * Customer rewards ("People Rewards"): a session of more than N hours earns a free hour for the
 * phone number it was registered with. Pure rules shared by the server and the web app.
 */

/**
 * A phone number as WhatsApp wants it: digits only, with the country code, no "+" or leading zeros
 * ("0791234567" → "962791234567"). null when it cannot be a real number.
 */
export function normalizePhone(raw: string | null | undefined, countryCode: string): string | null {
  // An Arabic keyboard types ٠١٢٣٤٥٦٧٨٩ — read them as 0123456789.
  const text = (raw ?? '')
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (!text) return null;
  const cc = countryCode.replace(/\D/g, '');
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;
  if (text.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = cc + digits.replace(/^0+/, '');
  } else if (!(cc && digits.startsWith(cc) && digits.length >= cc.length + 8)) {
    digits = cc + digits;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** A WhatsApp chat with the message ready to send (the cashier only presses send). */
export function whatsappUrl(normalized: string, text: string): string {
  return `https://wa.me/${normalized}?text=${encodeURIComponent(text)}`;
}

/** Fills {name}, {played}, {free}, {shop} in the owner's message. Unknown placeholders stay as they are. */
export function fillMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all);
}

/**
 * What the free time is worth on a bill: the first `freeMinutes` at the session's own average price
 * per billed minute (so rounding and packages are priced in, and an hour at 4.000 an hour is 4.000),
 * never more than the time charge. A session shorter than that is free entirely.
 */
export function freeTimeValue(timeCharge: Minor, billableMs: number, freeMinutes: number): Minor {
  if (timeCharge <= 0 || billableMs <= 0 || freeMinutes <= 0) return 0;
  const share = Math.min(1, (freeMinutes * 60_000) / billableMs);
  return Math.min(timeCharge, Math.round(timeCharge * share));
}

/** A session earns a reward when it played longer than the policy says (pauses do not count). */
export function earnsReward(playedMs: number, afterMinutes: number): boolean {
  return playedMs > afterMinutes * 60_000;
}

/**
 * A length of time in plain Arabic for the customer's message ("5 ساعات و10 دقائق"), whatever language
 * the cashier's screen is in — the message belongs to the customer, not to the screen.
 */
export function arabicDuration(totalMinutes: number): string {
  const part = (n: number, one: string, two: string, few: string, many: string) =>
    n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
  const m = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(m / 60);
  const minutes = m % 60;
  const parts = [
    ...(hours ? [part(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')] : []),
    ...(minutes ? [part(minutes, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')] : []),
  ];
  return parts.length ? parts.join(' و') : '0 دقيقة';
}
