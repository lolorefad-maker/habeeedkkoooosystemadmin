import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
let floor: Json;
const station = (name: string) => floor.stations.find((s: Json) => s.name === name);
const stock = async () => (await h.api('GET', '/api/stock', undefined, h.tokens.manager)).json as Json[];

beforeAll(async () => {
  // Friday 18:00 Amman
  h = await createHarness('2026-09-25T15:00:00Z');
  floor = await h.floor();
  await h.api('POST', '/api/shifts/open', { openingFloat: 0 }, h.tokens.cashier);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('goods: cartons in, pieces out', () => {
  let chipsId = '';
  let cakeId = '';

  it('receives 2 cartons of chips (24 each) and a new product in one delivery', async () => {
    const chips = (await stock()).find((p) => p.name === 'شيبس');
    chipsId = chips.id;
    const r = await h.api(
      'POST',
      '/api/stock/receive',
      {
        lines: [
          { productId: chipsId, cartons: 2, packSize: 24, price: 500 },
          { newProduct: { name: 'كيك', category: 'سناكس' }, cartons: 1, packSize: 12, price: 750 },
        ],
        note: 'from the supplier',
      },
      h.tokens.manager,
    );
    expect(r.status).toBe(200);
    const list = await stock();
    const after = list.find((p) => p.id === chipsId);
    expect(after.stockQty).toBe(chips.stockQty + 48);
    expect(after.packSize).toBe(24);
    const cake = list.find((p) => p.name === 'كيك');
    cakeId = cake.id;
    // A new product warns when about a quarter of a carton is left.
    expect(cake).toMatchObject({ stockQty: 12, trackStock: true, price: 750, lowStockAt: 3 });
  });

  it('a customer taking pieces on a device lowers the stock', async () => {
    const before = (await stock()).find((p) => p.id === cakeId).stockQty;
    const s = await h.api(
      'POST',
      '/api/sessions',
      { stationId: station('PS-01').id, mode: 'single', kind: 'open', items: [{ productId: cakeId, qty: 3 }] },
      h.tokens.cashier,
    );
    expect(s.status).toBe(200);
    expect((await stock()).find((p) => p.id === cakeId).stockQty).toBe(before - 3);
    // The device that opened the station is told what is left on the shelf.
    expect(s.json.stock).toEqual([{ productId: cakeId, name: 'كيك', left: before - 3, lowAt: 3 }]);

    h.advance(95);
    const bill = (await h.api('GET', `/api/sessions/${s.json.id}/bill`, undefined, h.tokens.cashier)).json;
    await h.api('POST', `/api/sessions/${s.json.id}/checkout`, { payments: [{ method: 'card', amount: bill.totals.due }] }, h.tokens.cashier);
  });

  it('a manual count corrects the stock and is recorded', async () => {
    const r = await h.api('POST', `/api/stock/${cakeId}/adjust`, { countedQty: 8, reason: 'one fell' }, h.tokens.manager);
    expect(r.json.delta).toBe(-1);
    const moves = (await h.api('GET', `/api/stock/movements?productId=${cakeId}`, undefined, h.tokens.manager)).json as Json[];
    expect(moves.map((m) => m.reason)).toEqual(['adjust', 'sale', 'purchase']);
    expect(moves[2]).toMatchObject({ delta: 12, cartons: 1, packSize: 12, unitPrice: 750 });
  });

  it('only managers receive goods', async () => {
    const r = await h.api('POST', '/api/stock/receive', { lines: [{ productId: chipsId, cartons: 1, packSize: 24 }] }, h.tokens.cashier);
    expect(r.status).toBe(403);
  });
});

describe('ledger', () => {
  it('daily log shows the device, from–to, what they took and how they paid', async () => {
    const day = floor.day as string;
    const log = (await h.api('GET', `/api/reports/sessions?day=${day}`, undefined, h.tokens.manager)).json as Json[];
    expect(log).toHaveLength(1);
    const row = log[0];
    expect(row.stationName).toBe('PS-01');
    expect(row.endedAt - row.startedAt).toBe(95 * 60_000);
    expect(row.items).toEqual([{ name: 'كيك', qty: 3 }]);
    expect(row.itemsTotal).toBe(2250);
    // 95 min single at 2.000/h = 3.167 → 5-minute units keep 95 → cash rounding to 0.050
    expect(row.timeCharge).toBe(3167);
    expect(row.total).toBe(5400);
    expect(row.paidByMethod).toEqual({ card: 5400 });
  });

  it('monthly report sums each day', async () => {
    const month = (floor.day as string).slice(0, 7);
    const m = (await h.api('GET', `/api/reports/month?month=${month}`, undefined, h.tokens.manager)).json;
    expect(m.days).toHaveLength(1);
    expect(m.days[0]).toMatchObject({ day: floor.day, sessions: 1, total: 5400, received: { card: 5400 } });
    expect(m.totals.total).toBe(5400);
    expect((await h.api('GET', '/api/reports/month?month=2026-13', undefined, h.tokens.manager)).status).toBe(400);
  });
});

describe('how many are left', () => {
  it('adding drinks to a playing device answers with what is left of each counted item', async () => {
    const list = await stock();
    const chips = list.find((p) => p.name === 'شيبس');
    const untracked = list.find((p) => !p.trackStock);
    const s = await h.api('POST', '/api/sessions', { stationId: station('PS-02').id, mode: 'single', kind: 'open' }, h.tokens.cashier);
    expect(s.json.stock).toEqual([]);

    const items = [{ productId: chips.id, qty: 2 }, ...(untracked ? [{ productId: untracked.id, qty: 1 }] : [])];
    const r = await h.api('POST', '/api/orders', { sessionId: s.json.id, items }, h.tokens.waiter);
    expect(r.status).toBe(200);
    // Only counted items are reported.
    expect(r.json.stock).toEqual([{ productId: chips.id, name: 'شيبس', left: chips.stockQty - 2, lowAt: chips.lowStockAt }]);
  });
});

describe('end the day in one step', () => {
  it('counts the drawer, closes the shift and the day, and the new day starts at zero', async () => {
    const shift = (await h.api('GET', '/api/shifts/current', undefined, h.tokens.cashier)).json.shift;
    expect(shift).not.toBeNull();
    const before = (await h.api('GET', '/api/reports/day', undefined, h.tokens.manager)).json;
    expect(before.revenue.total).toBeGreaterThan(0);

    // Without the cash count it is refused (the drawer must be counted first).
    expect((await h.api('POST', '/api/days/close', {}, h.tokens.manager)).json.code).toBe('shift_open');

    const r = await h.api('POST', '/api/days/close', { shift: { countedCash: shift.expectedCash + 250, note: 'tip jar' } }, h.tokens.manager);
    expect(r.status).toBe(200);
    expect(r.json.report.revenue.total).toBe(before.revenue.total);
    expect(r.json.report.shifts[0]).toMatchObject({ countedCash: shift.expectedCash + 250, variance: 250 });
    expect((await h.api('GET', '/api/shifts/current', undefined, h.tokens.cashier)).json.shift).toBeNull();

    const today = (await h.api('GET', '/api/reports/day', undefined, h.tokens.manager)).json;
    expect(today.day).toBe(r.json.next);
    expect(today.status).toBe('open');
    expect(today.revenue).toMatchObject({ bills: 0, total: 0 });
    expect(today.payments.net).toBe(0);
    // The closed day keeps its saved report.
    const closed = (await h.api('GET', `/api/reports/day?day=${r.json.day}`, undefined, h.tokens.manager)).json;
    expect(closed).toMatchObject({ status: 'closed', revenue: { total: before.revenue.total } });
  });
});
