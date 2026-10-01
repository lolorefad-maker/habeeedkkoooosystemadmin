import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
const owner = () => h.tokens.owner;
const settings = async () => (await h.api('GET', '/api/settings', undefined, owner())).json as Json;
const stationByName = async (name: string) => (await h.floor()).stations.find((s: Json) => s.name === name);

/** Settle a running session on the spot (end + pay the exact bill). */
async function settle(sessionId: string) {
  const bill = (await h.api('GET', `/api/sessions/${sessionId}/bill`, undefined, h.tokens.cashier)).json;
  const due = bill.totals.due as number;
  const r = await h.api('POST', `/api/sessions/${sessionId}/checkout`, { payments: due > 0 ? [{ method: 'cash', amount: due }] : [], expectedTotal: bill.totals.total }, h.tokens.cashier);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

beforeAll(async () => {
  h = await createHarness('2026-10-01T15:00:00Z');
  expect((await h.api('POST', '/api/shifts/open', { openingFloat: 20000 }, h.tokens.cashier)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('delete: products, stations, controllers, bookings', () => {
  it('a product: gone from every list, its sales stay on the bill, its name is free again', async () => {
    const add = await h.api('POST', '/api/settings/products', { name: 'كيت كات', category: 'سناكس', price: 400, trackStock: true, stockQty: 10 }, owner());
    expect(add.status).toBe(200);
    const ps = await stationByName('PS-05');
    const s = await h.api('POST', '/api/sessions', { stationId: ps.id, mode: 'single', kind: 'open', items: [{ productId: add.json.id, qty: 2 }] }, h.tokens.cashier);
    expect(s.status).toBe(200);

    // Waiters can't delete.
    expect((await h.api('DELETE', `/api/settings/products/${add.json.id}`, undefined, h.tokens.waiter)).status).toBe(403);
    expect((await h.api('DELETE', `/api/settings/products/${add.json.id}`, undefined, owner())).status).toBe(200);

    expect((await settings()).products.some((p: Json) => p.id === add.json.id)).toBe(false);
    expect((await h.api('GET', '/api/products', undefined, h.tokens.waiter)).json.some((p: Json) => p.id === add.json.id)).toBe(false);
    expect((await h.api('GET', '/api/stock', undefined, owner())).json.some((p: Json) => p.id === add.json.id)).toBe(false);
    // It can't be sold any more, or edited, or deleted twice.
    const sell = await h.api('POST', '/api/orders', { sessionId: s.json.id, items: [{ productId: add.json.id, qty: 1 }] }, h.tokens.cashier);
    expect(sell.status).toBeGreaterThanOrEqual(400);
    expect((await h.api('PATCH', `/api/settings/products/${add.json.id}`, { price: 500 }, owner())).status).toBe(404);
    expect((await h.api('DELETE', `/api/settings/products/${add.json.id}`, undefined, owner())).status).toBe(404);

    // What was already sold stays on the customer's bill.
    const bill = (await h.api('GET', `/api/sessions/${s.json.id}/bill`, undefined, h.tokens.cashier)).json;
    expect(bill.totals.itemsTotal).toBe(800);
    await settle(s.json.id);

    // The name can be used again.
    expect((await h.api('POST', '/api/settings/products', { name: 'كيت كات', category: 'سناكس', price: 450 }, owner())).status).toBe(200);
  });

  it('a station: not while playing or booked; then gone from the floor, the ledger keeps its name', async () => {
    const add = await h.api('POST', '/api/settings/stations', { name: 'PS-99', type: 'ps5', tier: 'regular', zone: 'الصالة', modes: ['single'] }, owner());
    const id = add.json.id as string;
    const ctrl = (await h.floor()).controllers.find((c: Json) => !c.stationId && c.status === 'ready');
    const s = await h.api('POST', '/api/sessions', { stationId: id, mode: 'single', kind: 'open', controllerIds: [ctrl.id] }, h.tokens.cashier);
    expect(s.status).toBe(200);
    expect((await h.api('DELETE', `/api/settings/stations/${id}`, undefined, owner())).json.code).toBe('station_has_session');

    // Ended but not paid yet: still not.
    expect((await h.api('POST', `/api/sessions/${s.json.id}/action`, { type: 'end' }, h.tokens.cashier)).status).toBe(200);
    expect((await h.api('DELETE', `/api/settings/stations/${id}`, undefined, owner())).json.code).toBe('station_has_session');
    await settle(s.json.id);

    // Booked ahead: cancel first.
    h.advance(5);
    const booking = await h.api('POST', '/api/reservations', { stationId: id, startAt: h.now() + 3 * 3600_000, minutes: 60, mode: 'single', customerName: 'سامي' }, h.tokens.cashier);
    expect(booking.status).toBe(200);
    expect((await h.api('DELETE', `/api/settings/stations/${id}`, undefined, owner())).json.code).toBe('station_booked');
    expect((await h.api('POST', `/api/reservations/${booking.json.id}/cancel`, {}, h.tokens.cashier)).status).toBe(200);

    // A controller left at the station goes back on the shelf.
    expect((await h.api('POST', `/api/controllers/${ctrl.id}/assign`, { stationId: id }, h.tokens.cashier)).status).toBe(200);
    expect((await h.api('DELETE', `/api/settings/stations/${id}`, undefined, owner())).status).toBe(200);

    const f = await h.floor();
    expect(f.stations.some((x: Json) => x.id === id)).toBe(false);
    expect(f.archivedStations).toEqual([{ id, name: 'PS-99' }]);
    expect(f.controllers.find((c: Json) => c.id === ctrl.id).stationId).toBeNull();
    expect((await settings()).stations.some((x: Json) => x.id === id)).toBe(false);
    // No new sessions or bookings on it; the name is free again.
    expect((await h.api('POST', '/api/sessions', { stationId: id, mode: 'single', kind: 'open' }, h.tokens.cashier)).status).toBeGreaterThanOrEqual(400);
    expect((await h.api('POST', '/api/settings/stations', { name: 'PS-99', type: 'ps5', tier: 'regular', zone: '', modes: ['single'] }, owner())).status).toBe(200);
  });

  it('a controller: not while a customer has it; then gone for good, its number free again', async () => {
    const f = await h.floor();
    const top = Math.max(...f.controllers.map((c: Json) => c.number));
    const last = f.controllers.find((c: Json) => c.number === top);
    const ps = await stationByName('PS-06');
    expect((await h.api('POST', `/api/controllers/${last.id}/assign`, { stationId: ps.id }, h.tokens.cashier)).status).toBe(200);
    const busy = await h.api('DELETE', `/api/controllers/${last.id}`, undefined, owner());
    expect(busy.json.code).toBe('controller_in_use');

    expect((await h.api('POST', `/api/controllers/${last.id}/assign`, { stationId: null }, h.tokens.cashier)).status).toBe(200);
    expect((await h.api('DELETE', `/api/controllers/${last.id}`, undefined, h.tokens.cashier)).status).toBe(403);
    const del = await h.api('DELETE', `/api/controllers/${last.id}`, undefined, owner());
    expect(del.status).toBe(200);
    expect(del.json.number).toBe(top);
    expect((await h.floor()).controllers.some((c: Json) => c.id === last.id)).toBe(false);
    // Adding one again reuses the number.
    expect((await h.api('POST', '/api/controllers', { count: 1 }, owner())).json).toEqual({ from: top, to: top });
  });

  it('a booking: deleted when no money hangs on it; a deposit has to be settled first', async () => {
    const ps = await stationByName('PS-07');
    const at = h.now() + 2 * 3600_000;
    const plain = await h.api('POST', '/api/reservations', { stationId: ps.id, startAt: at, minutes: 60, mode: 'single', customerName: 'خالد' }, h.tokens.cashier);
    expect((await h.api('DELETE', `/api/reservations/${plain.json.id}`, undefined, h.tokens.cashier)).status).toBe(200);
    const list = (await h.api('GET', `/api/reservations?from=${h.now()}&to=${h.now() + 86_400_000}`, undefined, h.tokens.cashier)).json;
    expect(list.some((r: Json) => r.id === plain.json.id)).toBe(false);
    expect((await h.floor()).reservations.some((r: Json) => r.id === plain.json.id)).toBe(false);
    // The slot is free again.
    const again = await h.api('POST', '/api/reservations', { stationId: ps.id, startAt: at, minutes: 60, mode: 'single', customerName: 'خالد' }, h.tokens.cashier);
    expect(again.status).toBe(200);

    // With a deposit: cancel first (that gives the money back), then it can go.
    const paid = await h.api(
      'POST',
      '/api/reservations',
      { stationId: ps.id, startAt: at + 3 * 3600_000, minutes: 60, mode: 'single', customerName: 'ليلى', deposit: { amount: 2000, method: 'cash' } },
      h.tokens.cashier,
    );
    expect(paid.status).toBe(200);
    expect((await h.api('DELETE', `/api/reservations/${paid.json.id}`, undefined, h.tokens.cashier)).json.code).toBe('reservation_has_deposit');
    expect((await h.api('POST', `/api/reservations/${paid.json.id}/cancel`, {}, h.tokens.cashier)).status).toBe(200);
    expect((await h.api('DELETE', `/api/reservations/${paid.json.id}`, undefined, h.tokens.cashier)).status).toBe(200);

    // Checked in = it is a session now.
    h.advance(115);
    const checkIn = await h.api('POST', '/api/sessions', { stationId: ps.id, mode: 'single', kind: 'fixed', plannedMinutes: 60, reservationId: again.json.id }, h.tokens.cashier);
    expect(checkIn.status).toBe(200);
    expect((await h.api('DELETE', `/api/reservations/${again.json.id}`, undefined, h.tokens.cashier)).json.code).toBe('reservation_in_use');
  });

  it('deleted things never travel in the setup file', async () => {
    const file = (await h.api('GET', '/api/settings/export', undefined, owner())).json;
    expect(file.stations.filter((s: Json) => s.name === 'PS-99')).toHaveLength(1);
    expect(file.products.filter((p: Json) => p.name === 'كيت كات')).toEqual([expect.objectContaining({ price: 450 })]);
  });

  it('every delete is in the audit log', async () => {
    const audit = (await h.api('GET', '/api/audit?limit=200', undefined, owner())).json as Json[];
    const types = new Set(audit.map((e) => e.type));
    for (const t of ['product.deleted', 'station.deleted', 'controller.deleted', 'reservation.deleted']) expect(types.has(t)).toBe(true);
  });
});
