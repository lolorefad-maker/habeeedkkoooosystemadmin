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
const list = async () => (await h.api('GET', '/api/customers', undefined, cashier())).json as Json[];

describe('customers: the numbers page', () => {
  it('a number typed when a device opens is registered by itself', async () => {
    const s = await h.api('POST', '/api/sessions', { stationId: station('VIP-1').id, mode: 'single', kind: 'open', label: 'أحمد', customerPhone: '0791234567' }, cashier());
    expect(s.status).toBe(200);
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'أحمد', phone: '962791234567', visits: 1, freeAvailable: 0 });
  });

  it('adds a number by hand, keeps one row per number, and edits the name', async () => {
    const add = await h.api('POST', '/api/customers', { phone: '0782222222', name: 'سامي' }, cashier());
    expect(add.status).toBe(200);
    expect(add.json).toMatchObject({ name: 'سامي', phone: '962782222222' });
    const again = await h.api('POST', '/api/customers', { phone: '+962 78 2222222' }, cashier());
    expect(again.json.id).toBe(add.json.id);
    expect(await list()).toHaveLength(2);

    const bad = await h.api('POST', '/api/customers', { phone: '12' }, cashier());
    expect(bad.status).toBe(409);

    const edit = await h.api('PATCH', `/api/customers/${add.json.id}`, { name: 'سامي الحلبي', notes: 'زبون مميز' }, cashier());
    expect(edit.status).toBe(200);
    expect((await list()).find((c) => c.id === add.json.id)).toMatchObject({ name: 'سامي الحلبي', notes: 'زبون مميز', visits: 0 });
  });

  it('the waiter cannot see the numbers', async () => {
    expect((await h.api('GET', '/api/customers', undefined, h.tokens.waiter)).status).toBe(403);
  });
});

describe('checkout: the cashier charges a chosen amount', () => {
  it('a special price is a discount from the shop; the charged amount is what the drawer takes', async () => {
    const s = await h.api('POST', '/api/sessions', { stationId: station('VIP-2').id, mode: 'single', kind: 'open' }, cashier());
    h.advance(60);
    const bill = (await h.api('GET', `/api/sessions/${s.json.id}/bill`, undefined, cashier())).json as Json;
    const total = bill.totals.due as number;
    expect(total).toBeGreaterThan(0);
    const charge = Math.floor(total * 0.95);
    const r = await h.api('POST', `/api/sessions/${s.json.id}/checkout`, {
      discount: { kind: 'amount', value: total - charge },
      discountReason: 'special price',
      payments: [{ method: 'cash', amount: charge }],
    }, cashier());
    expect(r.status).toBe(200);
    expect(r.json.totals.total).toBe(charge);
  });
});
