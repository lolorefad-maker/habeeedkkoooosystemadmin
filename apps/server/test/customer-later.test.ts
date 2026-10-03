import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
let station: (name: string) => Json;

beforeAll(async () => {
  h = await createHarness('2026-09-25T15:00:00Z');
  await h.api('POST', '/api/shifts/open', { openingFloat: 0 }, h.tokens.cashier);
  const floor = await h.floor();
  station = (name) => floor.stations.find((s: Json) => s.name === name);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const cashier = () => h.tokens.cashier;

describe('the number given after the device was opened', () => {
  it('is saved in the numbers, and a session over 4 hours earns the free hour', async () => {
    const s = await h.api('POST', '/api/sessions', { stationId: station('PS-01').id, mode: 'single', kind: 'open', label: 'أبو علي' }, cashier());
    expect(s.status).toBe(200);
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)?.customer).toBeNull();

    h.advance(30);
    const bad = await h.api('POST', `/api/sessions/${s.json.id}/customer`, { phone: '12' }, cashier());
    expect(bad.json.code).toBe('invalid_phone');
    const set = await h.api('POST', `/api/sessions/${s.json.id}/customer`, { phone: '0795551234' }, cashier());
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ name: 'أبو علي', phone: '962795551234' });
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)?.customer).toMatchObject({ phone: '962795551234' });
    expect(((await h.api('GET', '/api/customers', undefined, cashier())).json as Json[]).map((c) => c.phone)).toContain('962795551234');

    h.advance(5 * 60);
    const due = (await h.api('GET', `/api/sessions/${s.json.id}/bill`, undefined, cashier())).json.totals.due;
    const done = await h.api('POST', `/api/sessions/${s.json.id}/checkout`, { payments: [{ method: 'cash', amount: due }] }, cashier());
    expect(done.status).toBe(200);
    expect(done.json.reward).toMatchObject({ minutes: 60, phone: '962795551234' });
    expect(((await h.api('GET', '/api/rewards?status=available', undefined, cashier())).json as Json[])).toHaveLength(1);
  });

  it('can be corrected while playing', async () => {
    const s = await h.api('POST', '/api/sessions', { stationId: station('PS-02').id, mode: 'single', kind: 'open', customerPhone: '0791111111' }, cashier());
    await h.api('POST', `/api/sessions/${s.json.id}/customer`, { phone: '0792222222' }, cashier());
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)?.customer).toMatchObject({ phone: '962792222222' });
  });
});
