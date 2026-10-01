import { describe, expect, it } from 'vitest';
import { alertKey, decideAlerts, type AlertMemory, type AlertSession } from './alerts-core';

const MIN = 60_000;
const t0 = Date.parse('2026-09-27T18:00:00Z');
const session = (planned: number, overrides: Partial<AlertSession> = {}): AlertSession => ({
  id: 's1',
  kind: 'fixed',
  status: 'running',
  plannedMinutes: planned,
  stationId: 'ps-4',
  segments: [{ stationId: 'ps-4', mode: 'single', paused: false, startedAt: t0, endedAt: null }],
  ...overrides,
});
const opts = { endingSoonMinutes: 5, repeatMs: 2 * MIN };

function run(sessions: AlertSession[], times: number[], acked = new Set<string>()) {
  const memory = new Map<string, AlertMemory>();
  return times.map((t) => decideAlerts(sessions, memory, acked, t, opts).map((a) => a.kind));
}

describe('time alerts', () => {
  it('chimes once when 5 minutes are left, then alarms once when time is up', () => {
    const s = [session(60)];
    const out = run(s, [t0 + 50 * MIN, t0 + 55 * MIN, t0 + 55 * MIN + 1000, t0 + 60 * MIN, t0 + 60 * MIN + 1000]);
    expect(out).toEqual([[], ['soon'], [], ['up'], []]);
  });

  it('repeats the alarm every 2 minutes until someone acknowledges it', () => {
    const s = [session(60)];
    const acked = new Set<string>();
    const memory = new Map<string, AlertMemory>();
    const at = (m: number) => decideAlerts(s, memory, acked, t0 + m * MIN, opts).map((a) => a.kind);
    expect(at(59)).toEqual([]);
    expect(at(60)).toEqual(['up']);
    expect(at(61)).toEqual([]);
    expect(at(62)).toEqual(['repeat']);
    acked.add(alertKey(s[0]!));
    expect(at(64)).toEqual([]);
  });

  it('does not chime for a session already ending when the app opens, but still alarms at the end', () => {
    const out = run([session(60)], [t0 + 57 * MIN, t0 + 60 * MIN]);
    expect(out).toEqual([[], ['up']]);
  });

  it('alarms on open for a session already over time that nobody acknowledged', () => {
    expect(run([session(60)], [t0 + 70 * MIN])).toEqual([['up']]);
    expect(run([session(60)], [t0 + 70 * MIN], new Set([alertKey(session(60))]))).toEqual([[]]);
  });

  it('extending the time re-arms the alerts', () => {
    const memory = new Map<string, AlertMemory>();
    const acked = new Set<string>();
    expect(decideAlerts([session(60)], memory, acked, t0 + 60 * MIN, opts).map((a) => a.kind)).toEqual(['up']);
    acked.add(alertKey(session(60)));
    // +30 minutes: new key, first sight of it is while "active", then ending, then up again
    expect(decideAlerts([session(90)], memory, acked, t0 + 61 * MIN, opts)).toEqual([]);
    expect(decideAlerts([session(90)], memory, acked, t0 + 85 * MIN, opts).map((a) => a.kind)).toEqual(['soon']);
    expect(decideAlerts([session(90)], memory, acked, t0 + 90 * MIN, opts).map((a) => a.kind)).toEqual(['up']);
  });

  it('ignores open time, paused and ended sessions', () => {
    const paused = session(60, {
      segments: [
        { stationId: 'ps-4', mode: 'single', paused: false, startedAt: t0, endedAt: t0 + 30 * MIN },
        { stationId: 'ps-4', mode: 'single', paused: true, startedAt: t0 + 30 * MIN, endedAt: null },
      ],
    });
    expect(run([session(60, { kind: 'open', plannedMinutes: null }), session(60, { status: 'ended' }), paused], [t0 + 90 * MIN])).toEqual([[]]);
  });
});
