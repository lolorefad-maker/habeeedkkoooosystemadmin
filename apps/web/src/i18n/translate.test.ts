import { describe, expect, it } from 'vitest';
import { translate } from './index';

describe('translate', () => {
  it('finds nested keys and fills variables', () => {
    expect(translate('ar', 'nav.floor')).toBe('الصالة');
    expect(translate('en', 'stock.left', { n: 7 })).toBe('7 left');
  });

  it('finds keys that contain dots themselves (audit log event types)', () => {
    expect(translate('ar', 'events.session.started')).toBe('بدء جلسة');
    expect(translate('ar', 'events.day.closed')).toBe('إنهاء يوم');
    expect(translate('en', 'events.shift.closed')).toBe('Shift closed');
  });

  it('falls back to English, then to the key', () => {
    expect(translate('ar', 'no.such.key')).toBe('no.such.key');
  });
});
