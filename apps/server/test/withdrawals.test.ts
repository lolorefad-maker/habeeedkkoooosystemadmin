import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;

beforeAll(async () => {
  h = await createHarness('2026-09-25T15:00:00Z');
  await h.api('POST', '/api/shifts/open', { openingFloat: 20000 }, h.tokens.cashier);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const cashier = () => h.tokens.cashier;
const shift = async () => (await h.floor()).shift as Json;
const report = async () => (await h.api('GET', '/api/reports/day', undefined, h.tokens.manager)).json as Json;

describe('the accountant takes cash from the drawer', () => {
  it('lowers the drawer, not the income, and leaves the shift open', async () => {
    const list = (await h.api('GET', '/api/products', undefined, cashier())).json as Json[];
    const p = list.find((x) => x.price > 0)!;
    await h.api('POST', '/api/counter/sale', { items: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: p.price }] }, cashier());
    const before = await report();
    expect((await shift()).expectedCash).toBe(20000 + p.price);

    const took = await h.api('POST', '/api/withdrawals', { amount: 5000, note: 'المحاسب' }, cashier());
    expect(took.status).toBe(200);
    expect(took.json.expectedCash).toBe(20000 + p.price - 5000);

    const s = await shift();
    expect(s.status).toBe('open');
    expect(s.expectedCash).toBe(20000 + p.price - 5000);
    expect(s.withdrawn).toBe(5000);
    expect(s.withdrawals).toHaveLength(1);
    // Income, cash received and refunds do not move.
    const after = await report();
    expect(after.revenue.total).toBe(before.revenue.total);
    expect(after.payments.byMethod.cash).toBe(before.payments.byMethod.cash);
    expect(after.payments.refunds).toBe(before.payments.refunds);

    const day = (await h.floor()).day as string;
    const rows = (await h.api('GET', `/api/withdrawals?day=${day}`, undefined, h.tokens.manager)).json as Json[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 5000, note: 'المحاسب' });
  });

  it('cannot take more than the drawer holds; a mistake is cancelled while the shift is open', async () => {
    const tooMuch = await h.api('POST', '/api/withdrawals', { amount: 99_000_000 }, cashier());
    expect(tooMuch.json.code).toBe('withdrawal_too_large');
    const w = (await shift()).withdrawals[0];
    const before = (await shift()).expectedCash;
    expect((await h.api('POST', `/api/withdrawals/${w.id}/void`, { reason: 'wrong amount' }, cashier())).status).toBe(200);
    expect((await shift()).expectedCash).toBe(before + 5000);
    expect((await h.api('POST', `/api/withdrawals/${w.id}/void`, {}, cashier())).json.code).toBe('withdrawal_void');
  });

  it('the count at closing agrees with what is left in the drawer', async () => {
    await h.api('POST', '/api/withdrawals', { amount: 3000, note: 'المحاسب' }, cashier());
    const expected = (await shift()).expectedCash;
    const closed = await h.api('POST', '/api/shifts/close', { countedCash: expected }, cashier());
    expect(closed.json.variance).toBe(0);
    expect(closed.json.expectedCash).toBe(expected);
    // Nothing can be taken once the shift is closed.
    expect((await h.api('POST', '/api/withdrawals', { amount: 100 }, cashier())).json.code).toBe('no_open_shift');
  });

  it('the waiter cannot', async () => {
    expect((await h.api('POST', '/api/withdrawals', { amount: 100 }, h.tokens.waiter)).status).toBe(403);
  });
});
