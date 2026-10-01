import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
let floor: Json;
const station = (name: string) => floor.stations.find((s: Json) => s.name === name);
const settings = async () => (await h.api('GET', '/api/settings', undefined, h.tokens.owner)).json;
const rule = async (name: string) => (await settings()).rules.find((r: Json) => r.name === name);

beforeAll(async () => {
  // Friday 18:00 Amman (no happy hour on Fridays in the demo data)
  h = await createHarness('2026-09-25T15:00:00Z');
  floor = await h.floor();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

describe('changing a price', () => {
  it('applies from now: time already played keeps the old price', async () => {
    const s = await h.api('POST', '/api/sessions', { stationId: station('PS-01').id, mode: 'single', kind: 'open' }, h.tokens.cashier);
    h.advance(60);

    const single = await rule('PS5 فردي');
    const r = await h.api('PUT', `/api/settings/rules/${single.id}`, { ...single, effect: { kind: 'rate', perHour: 1500 } }, h.tokens.owner);
    expect(r.status).toBe(200);
    expect(r.json.id).not.toBe(single.id); // a new version

    h.advance(60);
    const bill = (await h.api('GET', `/api/sessions/${s.json.id}/bill`, undefined, h.tokens.cashier)).json;
    expect(bill.time.lines.map((l: Json) => [l.perHour, l.amount])).toEqual([
      [2000, 2000],
      [1500, 1500],
    ]);
  });

  it('settings show only the price in force; editing an old version is refused', async () => {
    const rules = (await settings()).rules.filter((r: Json) => r.name === 'PS5 فردي');
    expect(rules).toHaveLength(1);
    expect(rules[0].effect.perHour).toBe(1500);
    const all = (await h.floor()).rules.filter((r: Json) => r.name === 'PS5 فردي');
    expect(all).toHaveLength(2); // history kept for billing
    const old = all.find((r: Json) => r.effect.perHour === 2000);
    const again = await h.api('PUT', `/api/settings/rules/${old.id}`, { ...old, effect: { kind: 'rate', perHour: 999 } }, h.tokens.owner);
    expect(again.json.code).toBe('rule_ended');
  });

  it('switching a rule off ends it now instead of rewriting the past', async () => {
    const multi = await rule('PS5 زوجي');
    await h.api('PUT', `/api/settings/rules/${multi.id}`, { ...multi, active: false }, h.tokens.owner);
    expect(await rule('PS5 زوجي')).toBeUndefined();
  });
});

describe('discount now (one tap)', () => {
  it('20% off every PS5 from now until stopped, only for the time it was on', async () => {
    floor = await h.floor();
    const s = await h.api('POST', '/api/sessions', { stationId: station('PS-02').id, mode: 'single', kind: 'open' }, h.tokens.cashier);
    h.advance(30);
    const start = await h.api('POST', '/api/pricing/discount', { percent: 20, stationTypes: ['ps5'], until: { kind: 'manual' } }, h.tokens.owner);
    expect(start.status).toBe(200);
    h.advance(60);
    await h.api('POST', '/api/pricing/discount/stop', {}, h.tokens.owner);
    h.advance(30);

    const bill = (await h.api('GET', `/api/sessions/${s.json.id}/bill`, undefined, h.tokens.cashier)).json;
    // 30m at 1.500 · 60m at 1.200 (−20%) · 30m at 1.500
    expect(bill.time.lines.map((l: Json) => l.perHour)).toEqual([1500, 1200, 1500]);
    expect(bill.time.total).toBe(750 + 1200 + 750);
  });

  it('"until end of day" stops by itself at the cutoff, and only managers can start one', async () => {
    const r = await h.api('POST', '/api/pricing/discount', { percent: 10, until: { kind: 'day_end' } }, h.tokens.owner);
    expect(r.json.endsAt).toBe(Date.parse('2026-09-26T03:00:00Z')); // 06:00 Amman
    const denied = await h.api('POST', '/api/pricing/discount', { percent: 50, until: { kind: 'manual' } }, h.tokens.cashier);
    expect(denied.status).toBe(403);
    const audit = (await h.api('GET', '/api/audit?limit=50', undefined, h.tokens.owner)).json as Json[];
    expect(audit.some((e) => e.type === 'discount.started')).toBe(true);
  });
});
