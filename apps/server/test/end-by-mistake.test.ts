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
const start = (name: string) => h.api('POST', '/api/sessions', { stationId: station(name).id, mode: 'single', kind: 'open' }, cashier());
const end = (id: string) => h.api('POST', `/api/sessions/${id}/action`, { type: 'end' }, cashier());

describe('a session ended by mistake', () => {
  it('can be resumed, and the unpaid list is empty again', async () => {
    const s = await start('PS-01');
    h.advance(10);
    expect((await end(s.json.id)).status).toBe(200);
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)?.status).toBe('ended');
    expect((await h.api('POST', `/api/sessions/${s.json.id}/reopen`, {}, cashier())).status).toBe(200);
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)?.status).toBe('running');
  });

  it('can be deleted; the cashier needs the manager PIN, the manager does not', async () => {
    const s = await start('PS-02');
    h.advance(5);
    await end(s.json.id);
    const denied = await h.api('POST', `/api/sessions/${s.json.id}/void`, { reason: 'ended by mistake' }, cashier());
    expect(denied.json.code).toBe('approval_required');
    const done = await h.api('POST', `/api/sessions/${s.json.id}/void`, { reason: 'ended by mistake' }, h.tokens.manager);
    expect(done.status).toBe(200);
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)).toBeUndefined();
  });
});

describe('deleting a paid bill from the ledger', () => {
  const day = async () => (await h.floor()).day as string;
  const report = async () => (await h.api('GET', `/api/reports/day?day=${await day()}`, undefined, h.tokens.manager)).json as Json;

  it('takes it out of the income and the drawer; keeps the row; refuses a second delete', async () => {
    const list = (await h.api('GET', '/api/products', undefined, cashier())).json as Json[];
    const p = list.find((x) => x.price > 0)!;
    const before = await report();
    const sale = await h.api('POST', '/api/counter/sale', { items: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: p.price }] }, cashier());
    expect(sale.status).toBe(200);
    expect((await report()).revenue.total).toBe(before.revenue.total + p.price);

    // The cashier cannot (the ledger is the manager's); the manager can.
    expect((await h.api('POST', `/api/bills/${sale.json.billId}/void`, { reason: 'wrong entry' }, cashier())).status).toBe(403);
    const done = await h.api('POST', `/api/bills/${sale.json.billId}/void`, { reason: 'wrong entry' }, h.tokens.manager);
    expect(done.status).toBe(200);

    const after = await report();
    expect(after.revenue.total).toBe(before.revenue.total);
    expect(after.payments.net).toBe(before.payments.net);
    expect((await h.api('GET', `/api/bills/${sale.json.billId}`, undefined, cashier())).json.status).toBe('void');
    const again = await h.api('POST', `/api/bills/${sale.json.billId}/void`, { reason: 'wrong entry' }, h.tokens.manager);
    expect(again.json.code).toBe('bill_void');
    const log = (await h.api('GET', `/api/reports/sessions?day=${await day()}`, undefined, h.tokens.manager)).json as Json[];
    expect(log.find((r) => r.billId === sale.json.billId)).toBeUndefined();
  });
});

describe('deleting from a closed day', () => {
  it('works too: the closed day and its drawer lose the bill', async () => {
    const list = (await h.api('GET', '/api/products', undefined, cashier())).json as Json[];
    const p = list.find((x) => x.price > 0)!;
    const day = (await h.floor()).day as string;
    const sale = await h.api('POST', '/api/counter/sale', { items: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: p.price }] }, cashier());
    const closed = await h.api('POST', '/api/days/close', { stockCounts: [], shift: { countedCash: p.price } }, h.tokens.manager);
    expect(closed.status).toBe(200);
    const rep = async () => (await h.api('GET', `/api/reports/day?day=${day}`, undefined, h.tokens.manager)).json as Json;
    const before = await rep();
    expect((await h.api('POST', `/api/bills/${sale.json.billId}/void`, { reason: 'wrong entry' }, h.tokens.manager)).status).toBe(200);
    const after = await rep();
    expect(after.revenue.bills).toBe(before.revenue.bills - 1);
    expect(after.revenue.total).toBe(before.revenue.total - p.price);
    expect(after.payments.net).toBe(before.payments.net - p.price);
  });
});
