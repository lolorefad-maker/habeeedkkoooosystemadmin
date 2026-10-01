import { describe, expect, it } from 'vitest';
import { computeTimeBill } from '../src/billing';
import type { PricingRule } from '../src/pricing';
import { applyAction, type Segment, type SessionTimeline } from '../src/session';
import { at, baseRules, ctx } from './helpers';

const seg = (stationId: string, mode: string, from: string, to: string | null, paused = false): Segment => ({
  stationId,
  mode,
  paused,
  startedAt: at(from),
  endedAt: to ? at(to) : null,
});

const open = (...segments: Segment[]): SessionTimeline => ({ kind: 'open', plannedMinutes: null, segments });
const fixed = (plannedMinutes: number, ...segments: Segment[]): SessionTimeline => ({
  kind: 'fixed',
  plannedMinutes,
  segments,
});

const sumLines = (b: ReturnType<typeof computeTimeBill>) =>
  b.lines.reduce((s, l) => s + l.amount, 0) + b.adjustment.amount;

describe('open time', () => {
  it('bills per minute by default', () => {
    const b = computeTimeBill(open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T20:00')), ctx(), at('2026-09-25T20:00'));
    expect(b.total).toBe(6000);
    expect(b.playedMs).toBe(2 * 3_600_000);
    expect(b.ended).toBe(true);
  });

  it('rounds up to 15-minute blocks (2h37m → 2h45m)', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T20:37')),
      ctx({ policy: { roundingMinutes: 15 } }),
      at('2026-09-25T20:37'),
    );
    expect(b.billableMs).toBe(165 * 60_000);
    expect(b.total).toBe(8250);
    expect(b.adjustment.reason).toBe('rounding');
    expect(sumLines(b)).toBe(b.subtotal);
  });

  it('keeps counting while running and reports the live rate', () => {
    const b = computeTimeBill(open(seg('ps-1', 'multi', '2026-09-25T18:00', null)), ctx(), at('2026-09-25T18:30'));
    expect(b.ended).toBe(false);
    expect(b.total).toBe(2500);
    expect(b.currentPerHour).toBe(5000);
  });

  it('is free inside the grace period', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T18:04')),
      ctx({ policy: { graceMinutes: 5, minimumMinutes: 30 } }),
      at('2026-09-25T18:04'),
    );
    expect(b.total).toBe(0);
    expect(b.adjustment.reason).toBe('grace');
    expect(sumLines(b)).toBe(0);
  });

  it('charges the minimum once past grace', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T18:10')),
      ctx({ policy: { graceMinutes: 5, minimumMinutes: 30 } }),
      at('2026-09-25T18:10'),
    );
    expect(b.total).toBe(1500);
    expect(b.adjustment.reason).toBe('minimum');
  });

  it('caps a single session', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T12:00', '2026-09-25T18:00')),
      ctx({ policy: { sessionCap: 10000 } }),
      at('2026-09-25T18:00'),
    );
    expect(b.subtotal).toBe(18000);
    expect(b.total).toBe(10000);
    expect(b.capApplied).toBe(true);
    expect(b.savings).toBe(8000);
  });
});

describe('fixed time ended early (booked 1h, played 30m)', () => {
  const timeline = fixed(60, seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T18:30'));
  const now = at('2026-09-25T18:30');

  it('charge_actual → pays the 30 minutes', () => {
    expect(computeTimeBill(timeline, ctx({ policy: { earlyEnd: 'charge_actual' } }), now).total).toBe(1500);
  });

  it('charge_full → pays the full hour', () => {
    const b = computeTimeBill(timeline, ctx({ policy: { earlyEnd: 'charge_full' } }), now);
    expect(b.total).toBe(3000);
    expect(b.adjustment.reason).toBe('early_end');
  });

  it('actual_with_min → pays at least the minimum', () => {
    const b = computeTimeBill(timeline, ctx({ policy: { earlyEnd: 'actual_with_min', earlyEndMinMinutes: 45 } }), now);
    expect(b.total).toBe(2250);
  });

  it('reports remaining time and overtime', () => {
    const b = computeTimeBill(fixed(60, seg('ps-1', 'single', '2026-09-25T18:00', null)), ctx(), at('2026-09-25T19:10'));
    expect(b.remainingMs).toBe(-10 * 60_000);
    expect(b.overtimeMs).toBe(10 * 60_000);
    expect(b.total).toBe(3500);
  });
});

describe('segments', () => {
  it('prices single → pause → multi each at its own rate', () => {
    const b = computeTimeBill(
      open(
        seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T19:10'),
        seg('ps-1', 'single', '2026-09-25T19:10', '2026-09-25T19:25', true),
        seg('ps-1', 'multi', '2026-09-25T19:25', '2026-09-25T20:40'),
      ),
      ctx(),
      at('2026-09-25T20:40'),
    );
    expect(b.lines.map((l) => [l.mode, l.amount])).toEqual([
      ['single', 3500],
      ['multi', 6250],
    ]);
    expect(b.pausedMs).toBe(15 * 60_000);
    expect(b.total).toBe(9750);
  });

  it('transfer to a VIP room switches to the VIP rate', () => {
    let segments: Segment[] = [seg('ps-1', 'single', '2026-09-25T18:00', null)];
    segments = applyAction(segments, { type: 'transfer', stationId: 'vip-1' }, at('2026-09-25T19:00'));
    segments = applyAction(segments, { type: 'end' }, at('2026-09-25T20:00'));
    const b = computeTimeBill(open(...segments), ctx(), at('2026-09-25T20:00'));
    expect(b.total).toBe(3000 + 8000);
  });

  it('pausing does not consume fixed time', () => {
    const b = computeTimeBill(
      fixed(
        60,
        seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T18:30'),
        seg('ps-1', 'single', '2026-09-25T18:30', '2026-09-25T19:00', true),
        seg('ps-1', 'single', '2026-09-25T19:00', null),
      ),
      ctx(),
      at('2026-09-25T19:20'),
    );
    expect(b.remainingMs).toBe(10 * 60_000);
  });
});

describe('time-based rules', () => {
  const happyHour: PricingRule = {
    id: 'happy',
    name: 'Happy hour',
    priority: 0,
    active: true,
    match: { timeFrom: '12:00', timeTo: '16:00' },
    effect: { kind: 'percent', percent: -20 },
  };

  it('splits a session at the end of happy hour', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T15:00', '2026-09-25T17:00')),
      ctx({ rules: [...baseRules, happyHour] }),
      at('2026-09-25T17:00'),
    );
    expect(b.lines.map((l) => [l.perHour, l.amount])).toEqual([
      [2400, 2400],
      [3000, 3000],
    ]);
    expect(b.total).toBe(5400);
  });

  it('weekend night rate crossing midnight applies after 00:00', () => {
    const weekendNight: PricingRule = {
      id: 'weekend-night',
      name: 'Fri night',
      priority: 5,
      active: true,
      match: { stationTypes: ['ps5'], daysOfWeek: [5], timeFrom: '20:00', timeTo: '02:00' },
      effect: { kind: 'rate', perHour: 4000 },
    };
    // Friday 2026-09-25, 23:00 → Saturday 01:00 is still "Friday night"; 02:00 → 03:00 is not.
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T23:00', '2026-09-26T03:00')),
      ctx({ rules: [...baseRules, weekendNight] }),
      at('2026-09-26T03:00'),
    );
    expect(b.lines.map((l) => l.perHour)).toEqual([4000, 3000]);
    expect(b.total).toBe(3 * 4000 + 3000);
  });

  it('a price change applies from the moment it was made, not to time already played', () => {
    const change = at('2026-09-25T19:00');
    const rules: PricingRule[] = [
      ...baseRules.filter((r) => r.id !== 'ps5-single'),
      { ...baseRules[0]!, id: 'single-v1', match: { ...baseRules[0]!.match, endsAt: change } },
      { ...baseRules[0]!, id: 'single-v2', match: { ...baseRules[0]!.match, startsAt: change }, effect: { kind: 'rate', perHour: 1500 } },
    ];
    const b = computeTimeBill(open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T20:00')), ctx({ rules }), at('2026-09-25T20:00'));
    expect(b.lines.map((l) => [l.perHour, l.amount])).toEqual([
      [3000, 3000],
      [1500, 1500],
    ]);
  });

  it('a one-tap discount only covers its own time window', () => {
    const quick: PricingRule = {
      id: 'quick',
      name: 'Discount now',
      priority: 100,
      active: true,
      match: { startsAt: at('2026-09-25T18:30'), endsAt: at('2026-09-25T19:30') },
      effect: { kind: 'percent', percent: -50 },
    };
    const b = computeTimeBill(open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T20:00')), ctx({ rules: [...baseRules, quick] }), at('2026-09-25T20:00'));
    // 30m full + 60m half + 30m full at 3.000/h
    expect(b.lines.map((l) => l.perHour)).toEqual([3000, 1500, 3000]);
    expect(b.total).toBe(1500 + 1500 + 1500);
  });

  it('flags a station with no configured price', () => {
    const b = computeTimeBill(
      open(seg('vr-1', 'standard', '2026-09-25T18:00', null)),
      ctx({ rules: baseRules.filter((r) => r.id !== 'vr') }),
      at('2026-09-25T18:30'),
    );
    expect(b.missingRate).toBe(true);
    expect(b.total).toBe(0);
  });
});

describe('packages', () => {
  const pkg3h = {
    id: '3h',
    name: '3 hours',
    minutes: 180,
    price: 7000,
    active: true,
    match: { stationTypes: ['ps5'], modes: ['single'] },
  };

  it('auto-applies the best price when cheaper', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T21:10')),
      ctx({ packages: [pkg3h], policy: { autoBestPackage: true } }),
      at('2026-09-25T21:10'),
    );
    expect(b.subtotal).toBe(9500);
    expect(b.total).toBe(7500);
    expect(b.package?.id).toBe('3h');
    expect(b.savings).toBe(2000);
  });

  it('does not apply when the hourly price is cheaper', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T19:00')),
      ctx({ packages: [pkg3h], policy: { autoBestPackage: true } }),
      at('2026-09-25T19:00'),
    );
    expect(b.package).toBeNull();
    expect(b.total).toBe(3000);
  });

  it('does not auto-apply to a mode the package excludes', () => {
    const b = computeTimeBill(
      open(seg('ps-1', 'multi', '2026-09-25T18:00', '2026-09-25T22:00')),
      ctx({ packages: [pkg3h], policy: { autoBestPackage: true } }),
      at('2026-09-25T22:00'),
    );
    expect(b.package).toBeNull();
  });

  it('a bought package is charged even if they leave early', () => {
    const b = computeTimeBill(
      { kind: 'fixed', plannedMinutes: 180, packageId: '3h', segments: [seg('ps-1', 'single', '2026-09-25T18:00', '2026-09-25T19:00')] },
      ctx({ packages: [pkg3h] }),
      at('2026-09-25T19:00'),
    );
    expect(b.total).toBe(7000);
    expect(b.package?.forced).toBe(true);
  });
});

describe('invariants', () => {
  it('lines + adjustment always equal the subtotal', () => {
    const policies = [
      { roundingMinutes: 1 },
      { roundingMinutes: 15, roundingMode: 'nearest' as const },
      { roundingMinutes: 10, roundingMode: 'down' as const, minimumMinutes: 20 },
      { graceMinutes: 5, minimumMinutes: 60 },
    ];
    for (const policy of policies) {
      for (let minutes = 1; minutes < 400; minutes += 7) {
        const start = at('2026-09-25T11:03');
        const b = computeTimeBill(
          open(
            { stationId: 'ps-1', mode: 'single', paused: false, startedAt: start, endedAt: start + minutes * 30_000 },
            { stationId: 'ps-1', mode: 'multi', paused: false, startedAt: start + minutes * 30_000, endedAt: start + minutes * 60_000 },
          ),
          ctx({ policy, rules: [...baseRules, { id: 'h', name: 'h', priority: 0, active: true, match: { timeFrom: '12:00', timeTo: '16:00' }, effect: { kind: 'percent', percent: -15 } }] }),
          start + minutes * 60_000,
        );
        expect(sumLines(b)).toBe(b.subtotal);
        expect(Number.isInteger(b.total)).toBe(true);
      }
    }
  });
});
