import { describe, expect, it } from 'vitest';
import { branchSettingsSchema } from '../src/policies';
import { arabicDuration, earnsReward, fillMessage, freeTimeValue, normalizePhone, whatsappUrl } from '../src/rewards';

const HOUR = 3_600_000;

describe('phone numbers', () => {
  it('turns every way of typing a Jordanian number into the WhatsApp form', () => {
    for (const raw of ['0791234567', '079 123 4567', '079-123-4567', '791234567', '962791234567', '+962 79 123 4567', '00962791234567', '٠٧٩١٢٣٤٥٦٧', '۰۷۹۱۲۳۴۵۶۷']) {
      expect(normalizePhone(raw, '962'), raw).toBe('962791234567');
    }
  });

  it('keeps a foreign number as it is and refuses what cannot be a number', () => {
    expect(normalizePhone('+44 7911 123456', '962')).toBe('447911123456');
    expect(normalizePhone('0044 7911 123456', '962')).toBe('447911123456');
    expect(normalizePhone('', '962')).toBeNull();
    expect(normalizePhone(null, '962')).toBeNull();
    expect(normalizePhone('abc', '962')).toBeNull();
    expect(normalizePhone('12', '962')).toBeNull();
    expect(normalizePhone('0'.repeat(3) + '1'.repeat(20), '962')).toBeNull();
  });

  it('builds the WhatsApp link with the message encoded', () => {
    expect(whatsappUrl('962791234567', 'أهلاً أحمد\nشكراً')).toBe(`https://wa.me/962791234567?text=${encodeURIComponent('أهلاً أحمد\nشكراً')}`);
  });
});

describe('the free time', () => {
  it('earns only after more than the policy hours, pauses excluded', () => {
    expect(earnsReward(4 * HOUR, 240)).toBe(false);
    expect(earnsReward(4 * HOUR + 1, 240)).toBe(true);
    expect(earnsReward(3 * HOUR, 240)).toBe(false);
  });

  it('is worth the first hour at the session’s own average price', () => {
    // 5 h at 2.000 an hour = 10.000 → one hour = 2.000
    expect(freeTimeValue(10_000, 5 * HOUR, 60)).toBe(2_000);
    // mixed prices: 4 h for 9.000 → one hour = 2.250
    expect(freeTimeValue(9_000, 4 * HOUR, 60)).toBe(2_250);
    // billed in 5-minute units: 90 min played, 95 billed for 6.333 → still exactly one hour at 4.000
    expect(freeTimeValue(6_333, 95 * 60_000, 60)).toBe(4_000);
    // a session shorter than the free time is free entirely, never more than it cost
    expect(freeTimeValue(1_500, 30 * 60_000, 60)).toBe(1_500);
    expect(freeTimeValue(0, 3 * HOUR, 60)).toBe(0);
    expect(freeTimeValue(5_000, 0, 60)).toBe(0);
  });
});

describe('the message', () => {
  it('says a length of time in plain Arabic', () => {
    expect(arabicDuration(60)).toBe('ساعة');
    expect(arabicDuration(120)).toBe('ساعتين');
    expect(arabicDuration(300)).toBe('5 ساعات');
    expect(arabicDuration(310)).toBe('5 ساعات و10 دقائق');
    expect(arabicDuration(11 * 60 + 1)).toBe('11 ساعة ودقيقة');
    expect(arabicDuration(30)).toBe('30 دقيقة');
    expect(arabicDuration(0)).toBe('0 دقيقة');
  });

  it('fills the placeholders and leaves unknown ones', () => {
    expect(fillMessage('أهلاً {name}، {free} من {shop} {nope}', { name: 'أحمد', free: 'ساعة', shop: 'Habeedko' })).toBe('أهلاً أحمد، ساعة من Habeedko {nope}');
  });

  it('settings: on by default with 4 hours → 1 hour, Jordan code, and old settings stay valid', () => {
    const s = branchSettingsSchema.parse({});
    expect(s.rewards).toMatchObject({ enabled: true, afterMinutes: 240, freeMinutes: 60, countryCode: '962' });
    expect(s.rewards.message).toContain('{name}');
    expect(branchSettingsSchema.parse({ billing: { graceMinutes: 3 } }).rewards.afterMinutes).toBe(240);
    expect(() => branchSettingsSchema.parse({ rewards: { countryCode: '+962' } })).toThrow();
  });
});
