import { describe, expect, it } from 'vitest';
import { computeCheckout } from '../src/checkout';
import { chargeRemainingMs, controllerState, isCharged } from '../src/controllers';
import { DomainError } from '../src/errors';
import { allocate, formatMoney, parseMoney, roundToUnit } from '../src/money';
import { branchSettingsSchema, reservationPolicySchema } from '../src/policies';
import { quoteRate, rateBoundaries, type PricingRule } from '../src/pricing';
import { evaluateCancellation, isHolding, isNoShow, noShowOutcome, overlaps } from '../src/reservations';
import { applyAction, liveState, planAction, type Segment } from '../src/session';
import { businessDayOf, businessDayRange, formatDuration } from '../src/time';
import { at, baseRules, stations, TZ } from './helpers';

describe('money', () => {
  it('allocates integers that sum exactly to the total', () => {
    expect(allocate(100, [33.3, 33.3, 33.4])).toEqual([33, 33, 34]);
    expect(allocate(0, [200.4, -200.4])).toEqual([200, -200]);
    expect(allocate(10, [3.5, 3.5, 3.5]).reduce((a, b) => a + b)).toBe(10);
  });

  it('cash-rounds to a unit', () => {
    expect(roundToUnit(8230, 50)).toBe(8250);
    expect(roundToUnit(8224, 50)).toBe(8200);
    expect(roundToUnit(8224.6, 0)).toBe(8225);
  });

  it('parses user input into minor units', () => {
    expect(parseMoney('3.5', 3)).toBe(3500);
    expect(parseMoney('٣٫٥', 3)).toBe(3500);
    expect(parseMoney('۱٫۲۵', 3)).toBe(1250);
    expect(parseMoney('1ز5', 3)).toBe(1500); // "." on the Arabic keyboard layout
    expect(parseMoney('١٬٢٥٠', 2)).toBe(125000);
    expect(parseMoney('⁨1.750⁩', 3)).toBe(1750);
    expect(parseMoney('1 دينار', 3)).toBeNull();
    expect(parseMoney('1.5.0', 3)).toBeNull();
    expect(parseMoney('1,250', 2)).toBe(125000);
    expect(parseMoney('1.2345', 3)).toBeNull();
    expect(parseMoney('abc', 3)).toBeNull();
  });

  it('formats with the currency decimals and Latin digits', () => {
    expect(formatMoney(3500, { currency: 'JOD', decimals: 3, locale: 'en' }, { symbol: false })).toBe('3.500');
  });
});

describe('time & business day', () => {
  it('counts 02:00 toward the previous business day', () => {
    expect(businessDayOf(at('2026-09-26T02:00'), TZ, '06:00')).toBe('2026-09-25');
    expect(businessDayOf(at('2026-09-26T06:00'), TZ, '06:00')).toBe('2026-09-26');
  });

  it('returns the business day range', () => {
    const r = businessDayRange('2026-09-25', TZ, '06:00');
    expect(r.start).toBe(at('2026-09-25T06:00'));
    expect(r.end).toBe(at('2026-09-26T06:00'));
  });

  it('formats durations', () => {
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});

describe('pricing rules', () => {
  const ps1 = stations['ps-1']!;

  it('higher priority wins, then specificity', () => {
    const rules: PricingRule[] = [
      ...baseRules,
      { id: 'station-special', name: 'ps-1 special', priority: 0, active: true, match: { stationIds: ['ps-1'] }, effect: { kind: 'rate', perHour: 2000 } },
    ];
    expect(quoteRate(rules, ps1, 'single', at('2026-09-25T18:00'), TZ)?.perHour).toBe(2000);
    expect(quoteRate(rules, stations['ps-2']!, 'single', at('2026-09-25T18:00'), TZ)?.perHour).toBe(3000);
  });

  it('inactive rules are ignored', () => {
    const rules = baseRules.map((r) => (r.id === 'ps5-single' ? { ...r, active: false } : r));
    expect(quoteRate(rules, ps1, 'single', at('2026-09-25T18:00'), TZ)).toBeNull();
  });

  it('date ranges limit a promotion', () => {
    const promo: PricingRule = { id: 'eid', name: 'Eid', priority: 20, active: true, match: { dateFrom: '2026-09-25', dateTo: '2026-09-25' }, effect: { kind: 'rate', perHour: 1000 } };
    expect(quoteRate([...baseRules, promo], ps1, 'single', at('2026-09-25T23:59'), TZ)?.perHour).toBe(1000);
    expect(quoteRate([...baseRules, promo], ps1, 'single', at('2026-09-26T00:01'), TZ)?.perHour).toBe(3000);
  });

  it('lists boundaries inside a range', () => {
    const rules: PricingRule[] = [{ id: 'h', name: 'h', priority: 0, active: true, match: { timeFrom: '12:00', timeTo: '16:00' }, effect: { kind: 'percent', percent: -20 } }];
    expect(rateBoundaries(rules, at('2026-09-25T11:00'), at('2026-09-26T01:00'), TZ)).toEqual([
      at('2026-09-25T12:00'),
      at('2026-09-25T16:00'),
      at('2026-09-26T00:00'),
    ]);
  });
});

describe('session actions', () => {
  const running: Segment[] = [{ stationId: 'ps-1', mode: 'single', paused: false, startedAt: at('2026-09-25T18:00'), endedAt: null }];

  it('pause closes the segment and opens a paused one', () => {
    const { close, open } = planAction(running, { type: 'pause' }, at('2026-09-25T18:30'));
    expect(close.endedAt).toBe(at('2026-09-25T18:30'));
    expect(open).toMatchObject({ paused: true, stationId: 'ps-1', startedAt: at('2026-09-25T18:30') });
  });

  it('rejects invalid actions with stable codes', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        return (e as DomainError).code;
      }
      return null;
    };
    expect(codeOf(() => planAction(running, { type: 'resume' }, at('2026-09-25T18:30')))).toBe('not_paused');
    expect(codeOf(() => planAction(running, { type: 'transfer', stationId: 'ps-1' }, at('2026-09-25T18:30')))).toBe('same_station');
    const ended = applyAction(running, { type: 'end' }, at('2026-09-25T19:00'));
    expect(codeOf(() => planAction(ended, { type: 'pause' }, at('2026-09-25T19:10')))).toBe('session_not_running');
  });

  it('derives live status for fixed sessions', () => {
    const tl = { kind: 'fixed' as const, plannedMinutes: 60, segments: running };
    expect(liveState(tl, at('2026-09-25T18:30'), 5).status).toBe('active');
    expect(liveState(tl, at('2026-09-25T18:56'), 5).status).toBe('ending');
    expect(liveState(tl, at('2026-09-25T19:01'), 5).status).toBe('overtime');
    const paused = applyAction(running, { type: 'pause' }, at('2026-09-25T18:10'));
    expect(liveState({ ...tl, segments: paused }, at('2026-09-25T19:30'), 5)).toMatchObject({ status: 'paused', remainingMs: 50 * 60_000 });
  });
});

describe('checkout', () => {
  it('applies discount, cash rounding and prepaid amounts', () => {
    const r = computeCheckout({
      timeCharge: 9750,
      items: [
        { qty: 2, unitPrice: 750 },
        { qty: 1, unitPrice: 2000, voided: true },
      ],
      discount: { kind: 'percent', value: 10 },
      cashRounding: 50,
      paid: 3000,
    });
    expect(r.itemsTotal).toBe(1500);
    expect(r.subtotal).toBe(11250);
    expect(r.discountAmount).toBe(1125);
    expect(r.total).toBe(10150); // 10125 → nearest 50
    expect(r.rounding).toBe(25);
    expect(r.due).toBe(7150);
  });

  it('negative due means a refund', () => {
    const r = computeCheckout({ timeCharge: 1500, items: [], discount: null, cashRounding: 0, paid: 3000 });
    expect(r.due).toBe(-1500);
  });

  it('never discounts below zero', () => {
    const r = computeCheckout({ timeCharge: 1000, items: [], discount: { kind: 'amount', value: 5000 }, cashRounding: 0, paid: 0 });
    expect(r.total).toBe(0);
  });
});

describe('reservations', () => {
  const policy = reservationPolicySchema.parse({ freeCancelMinutes: 120, lateCancelFeeKind: 'percent_deposit', lateCancelFeeValue: 50, noShowGraceMinutes: 15 });
  const r = { startAt: at('2026-09-25T20:00'), minutes: 60, deposit: 2000, status: 'confirmed' as const };

  it('cancelling early is free, late costs part of the deposit', () => {
    expect(evaluateCancellation(r, at('2026-09-25T17:00'), policy)).toEqual({ late: false, fee: 0, refund: 2000 });
    expect(evaluateCancellation(r, at('2026-09-25T19:00'), policy)).toEqual({ late: true, fee: 1000, refund: 1000 });
  });

  it('a fixed fee never exceeds the deposit', () => {
    const p = { ...policy, lateCancelFeeKind: 'fixed' as const, lateCancelFeeValue: 5000 };
    expect(evaluateCancellation(r, at('2026-09-25T19:30'), p).fee).toBe(2000);
  });

  it('becomes a no-show after the grace period', () => {
    expect(isNoShow(r, at('2026-09-25T20:14'), policy)).toBe(false);
    expect(isNoShow(r, at('2026-09-25T20:15'), policy)).toBe(true);
    expect(noShowOutcome(r, policy)).toEqual({ late: true, fee: 2000, refund: 0 });
    expect(isHolding(r, at('2026-09-25T19:50'), policy)).toBe(true);
  });

  it('detects overlapping bookings', () => {
    expect(overlaps(at('2026-09-25T20:00'), 60, at('2026-09-25T20:59'), 30)).toBe(true);
    expect(overlaps(at('2026-09-25T20:00'), 60, at('2026-09-25T21:00'), 30)).toBe(false);
  });
});

describe('controllers', () => {
  const t0 = at('2026-09-25T20:00');
  const charging = { status: 'charging' as const, stationId: null, readyAt: t0 + 60 * 60_000 };

  it('is charging until readyAt, then ready by itself', () => {
    expect(controllerState(charging, t0 + 59 * 60_000)).toBe('charging');
    expect(chargeRemainingMs(charging, t0 + 59 * 60_000)).toBe(60_000);
    expect(controllerState(charging, t0 + 60 * 60_000)).toBe('spare');
    expect(isCharged(charging, t0 + 60 * 60_000)).toBe(true);
  });

  it('knows where a ready controller is', () => {
    expect(controllerState({ status: 'ready', stationId: 'ps-1', readyAt: null }, t0)).toBe('at_station');
    expect(controllerState({ status: 'ready', stationId: null, readyAt: null }, t0)).toBe('spare');
    expect(controllerState({ status: 'broken', stationId: null, readyAt: null }, t0)).toBe('broken');
  });

  it('defaults to a one-hour charge', () => {
    expect(branchSettingsSchema.parse({}).controllers.chargeMinutes).toBe(60);
  });
});

describe('settings', () => {
  it('fills every default from an empty object', () => {
    const s = branchSettingsSchema.parse({});
    expect(s.billing.roundingMinutes).toBe(1);
    expect(s.day.cutoff).toBe('06:00');
    expect(s.reservations.noShowGraceMinutes).toBe(15);
  });

  it('keeps partial overrides and fills the rest', () => {
    const s = branchSettingsSchema.parse({ billing: { roundingMinutes: 15 } });
    expect(s.billing.roundingMinutes).toBe(15);
    expect(s.billing.earlyEnd).toBe('charge_actual');
  });
});
