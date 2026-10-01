import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoRollover } from '../src/services/days';
import { createHarness, type Json } from './harness';

/**
 * The shop's day ends at midnight. A device played 9 pm → 3 am: the 3 hours before midnight are
 * the old day's income, the rest the new day's; the money is in the drawer of the shift that took it.
 * At midnight the shift rolls over by itself. And the cafeteria sells to people not on a device.
 */
let h: Awaited<ReturnType<typeof createHarness>>;
const at = (iso: string) => {
  // Move the test clock to an Amman wall-clock time (UTC+3).
  const target = Date.parse(`${iso}+03:00`);
  h.advance((target - h.now()) / 60_000);
};
const report = async (day: string) => (await h.api('GET', `/api/reports/day?day=${day}`, undefined, h.tokens.manager)).json as Json;
const log = async (day: string) => (await h.api('GET', `/api/reports/sessions?day=${day}`, undefined, h.tokens.manager)).json as Json[];
const station = async (name: string) => (await h.floor()).stations.find((s: Json) => s.name === name);

let ps1: string;
let ps2: string;

beforeAll(async () => {
  h = await createHarness('2026-10-06T17:00:00Z'); // Tuesday 20:00 in Amman
  // The owner's choice: the day starts at midnight and closes by itself. Plain hourly prices here.
  const s = await h.api('PATCH', '/api/settings/branch', { settings: { day: { cutoff: '00:00', autoCloseDay: true }, billing: { autoBestPackage: false } } }, h.tokens.owner);
  expect(s.status).toBe(200);
  expect((await h.api('POST', '/api/shifts/open', { openingFloat: 20000 }, h.tokens.cashier)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('a session across midnight', () => {
  it('9 pm → 3 am: 3 hours on each day, the money on the day it was paid', async () => {
    at('2026-10-06T21:00:00');
    const s1 = await h.api('POST', '/api/sessions', { stationId: (await station('PS-01')).id, mode: 'single', kind: 'open', label: 'أحمد' }, h.tokens.cashier);
    ps1 = s1.json.id;
    at('2026-10-06T22:00:00');
    const pepsi = (await h.api('GET', '/api/products', undefined, h.tokens.cashier)).json.find((p: Json) => p.name === 'بيبسي');
    expect((await h.api('POST', '/api/orders', { sessionId: ps1, items: [{ productId: pepsi.id, qty: 1 }] }, h.tokens.cashier)).status).toBe(200);
    at('2026-10-06T23:00:00');
    ps2 = (await h.api('POST', '/api/sessions', { stationId: (await station('PS-02')).id, mode: 'single', kind: 'open' }, h.tokens.cashier)).json.id;

    // The server only notices midnight at 00:20 (it was asleep): the split is still at midnight.
    at('2026-10-07T00:20:00');
    expect(await autoRollover(h.ctx, h.branchId)).toBe(true);

    const d1 = await report('2026-10-06');
    expect(d1.status).toBe('closed');
    // PS-01: 3 h × 2.000 + pepsi 0.750; PS-02: 1 h × 2.000 — earned on the 6th, not paid yet.
    expect(d1.revenue.carriedIn).toBe(6000 + 750 + 2000);
    expect(d1.revenue.total).toBe(6000 + 750 + 2000);
    expect(d1.revenue.time).toBe(8000);
    expect(d1.revenue.items).toBe(750);
    expect(d1.payments.net).toBe(0); // no money moved before midnight
    const ps1Row = d1.stations.find((x: Json) => x.name === 'PS-01');
    expect(ps1Row).toMatchObject({ minutes: 180, amount: 6000 });
    const carriedRows = (await log('2026-10-06')).filter((r) => r.carried);
    expect(carriedRows.map((r) => r.total).sort((a, b) => a - b)).toEqual([2000, 6750]);

    // Pay at 3 am: the customer pays the whole bill.
    at('2026-10-07T03:00:00');
    const bill = (await h.api('GET', `/api/sessions/${ps1}/bill`, undefined, h.tokens.cashier)).json;
    expect(bill.totals.total).toBe(12000 + 750);
    const paid = await h.api('POST', `/api/sessions/${ps1}/checkout`, { payments: [{ method: 'cash', amount: 12750 }], expectedTotal: 12750 }, h.tokens.cashier);
    expect(paid.status).toBe(200);

    const d2 = await report('2026-10-07');
    expect(d2.revenue.carriedOut).toBe(6750);
    expect(d2.revenue.total).toBe(12750 - 6750); // the 3 hours after midnight
    expect(d2.revenue.time).toBe(6000);
    expect(d2.revenue.items).toBe(0);
    expect(d2.payments.byMethod.cash).toBe(12750); // the money is today's: it is in today's drawer
    const row = (await log('2026-10-07')).find((r) => !r.carried && r.total === 12750);
    expect(row.carriedOutTime + row.carriedOutItems).toBe(6750);

    const month = (await h.api('GET', '/api/reports/month?month=2026-10', undefined, h.tokens.manager)).json;
    const m6 = month.days.find((d: Json) => d.day === '2026-10-06');
    const m7 = month.days.find((d: Json) => d.day === '2026-10-07');
    expect(m6.total).toBe(8750);
    expect(m7.total).toBe(6000);
  });

  it('the shift rolled over at midnight: closed uncounted, the drawer carried into a new one', async () => {
    const d1 = await report('2026-10-06');
    expect(d1.shifts).toHaveLength(1);
    expect(d1.shifts[0]).toMatchObject({ auto: true, countedCash: null, expectedCash: 20000 });
    const cur = (await h.api('GET', '/api/shifts/current', undefined, h.tokens.cashier)).json.shift;
    expect(cur.businessDay).toBe('2026-10-07');
    expect(cur.openingFloat).toBe(20000);
    expect(cur.expectedCash).toBe(20000 + 12750);
    // The cashier can still count and close it by hand.
    const closed = await h.api('POST', '/api/shifts/close', { countedCash: 32750 }, h.tokens.cashier);
    expect(closed.json.variance).toBe(0);
    expect((await h.api('POST', '/api/shifts/open', { openingFloat: 32750 }, h.tokens.cashier)).status).toBe(200);
  });

  it('a voided session gives back on the new day what the old day counted', async () => {
    at('2026-10-07T01:00:00');
    const v = await h.api('POST', `/api/sessions/${ps2}/void`, { reason: 'جهاز معطّل', approvalPin: h.pin('manager') }, h.tokens.cashier);
    expect(v.status).toBe(200);
    const d1 = await report('2026-10-06');
    const d2 = await report('2026-10-07');
    // Old day keeps its saved report; the new day carries the −2.000: together they equal what was billed.
    expect(d1.revenue.total + d2.revenue.total).toBe(12750);
    expect(d2.revenue.carriedIn).toBe(-2000);
  });
});

describe('cafeteria', () => {
  it('sells to someone not on a device, paid on the spot, out of the stock', async () => {
    const list = (await h.api('GET', '/api/products', undefined, h.tokens.cashier)).json as Json[];
    const pepsi = list.find((p) => p.name === 'بيبسي');
    const before = (await h.api('GET', '/api/stock', undefined, h.tokens.manager)).json.find((p: Json) => p.id === pepsi.id).stockQty;

    // Waiters take orders, they don't take money.
    expect((await h.api('POST', '/api/counter/sale', { items: [{ productId: pepsi.id, qty: 1 }], payments: [{ method: 'cash', amount: 750 }] }, h.tokens.waiter)).status).toBe(403);
    // The total must match what the cashier saw.
    const wrong = await h.api('POST', '/api/counter/sale', { items: [{ productId: pepsi.id, qty: 2 }], payments: [{ method: 'cash', amount: 1500 }], expectedTotal: 1400 }, h.tokens.cashier);
    expect(wrong.json.code).toBe('bill_changed');

    const sale = await h.api('POST', '/api/counter/sale', { items: [{ productId: pepsi.id, qty: 2 }], payments: [{ method: 'card', amount: 1500 }], expectedTotal: 1500 }, h.tokens.cashier);
    expect(sale.status).toBe(200);
    expect(sale.json.totals.total).toBe(1500);
    expect(sale.json.stock.find((s: Json) => s.productId === pepsi.id).left).toBe(before - 2);

    const d2 = await report('2026-10-07');
    expect(d2.payments.byMethod.card).toBe(1500);
    expect(d2.products.find((p: Json) => p.name === 'بيبسي').qty).toBeGreaterThanOrEqual(2);
    const row = (await log('2026-10-07')).find((r) => r.counter);
    expect(row).toMatchObject({ counter: true, total: 1500, itemsTotal: 1500, timeCharge: 0, items: [{ name: 'بيبسي', qty: 2 }] });
  });

  it('no drawer, no sale (and nothing leaves the stock)', async () => {
    const shift = (await h.api('GET', '/api/shifts/current', undefined, h.tokens.cashier)).json.shift;
    await h.api('POST', '/api/shifts/close', { countedCash: shift.expectedCash }, h.tokens.cashier);
    const chips = (await h.api('GET', '/api/stock', undefined, h.tokens.manager)).json.find((p: Json) => p.trackStock && p.stockQty > 0);
    const r = await h.api('POST', '/api/counter/sale', { items: [{ productId: chips.id, qty: 1 }], payments: [{ method: 'cash', amount: chips.price }] }, h.tokens.cashier);
    expect(r.json.code).toBe('no_open_shift');
    const after = (await h.api('GET', '/api/stock', undefined, h.tokens.manager)).json.find((p: Json) => p.id === chips.id);
    expect(after.stockQty).toBe(chips.stockQty);
  });
});

describe('ledger: any period, from day to day', () => {
  it('adds up the days it covers, the same as each day on its own', async () => {
    const [d6, d7] = [await report('2026-10-06'), await report('2026-10-07')];
    const r = (await h.api('GET', '/api/reports/range?from=2026-10-06&to=2026-10-07', undefined, h.tokens.manager)).json as Json;
    expect(r.days.map((d: Json) => d.day)).toEqual(['2026-10-06', '2026-10-07']);
    expect(r.totals.total).toBe(d6.revenue.total + d7.revenue.total);
    expect(r.totals.received.cash ?? 0).toBe((d6.payments.byMethod.cash ?? 0) + (d7.payments.byMethod.cash ?? 0));
    expect(r.totals.received.card ?? 0).toBe((d6.payments.byMethod.card ?? 0) + (d7.payments.byMethod.card ?? 0));
    // One day on its own is a period too.
    const one = (await h.api('GET', '/api/reports/range?from=2026-10-07&to=2026-10-07', undefined, h.tokens.manager)).json as Json;
    expect(one.totals.total).toBe(d7.revenue.total);
  });

  it('refuses a period that ends before it starts or is longer than a year; cashiers cannot see it', async () => {
    expect((await h.api('GET', '/api/reports/range?from=2026-10-07&to=2026-10-06', undefined, h.tokens.manager)).json.code).toBe('invalid_range');
    expect((await h.api('GET', '/api/reports/range?from=2025-01-01&to=2026-10-07', undefined, h.tokens.manager)).json.code).toBe('range_too_long');
    expect((await h.api('GET', '/api/reports/range?from=2026-10-01&to=2026-10-07', undefined, h.tokens.cashier)).status).toBe(403);
  });
});
