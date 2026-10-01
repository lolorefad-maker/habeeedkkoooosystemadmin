import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tick } from '../src/scheduler';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
let floor: Json;
const station = (name: string) => floor.stations.find((s: Json) => s.name === name);
const ctrl = (n: number) => floor.controllers.find((c: Json) => c.number === n);

beforeAll(async () => {
  // Friday 18:00 Amman
  h = await createHarness('2026-09-25T15:00:00Z');
  floor = await h.floor();
  await h.api('POST', '/api/shifts/open', { openingFloat: 10000 }, h.tokens.cashier);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('controllers handed out with a session', () => {
  let sessionId = '';

  it('seeds 30 numbered controllers on the shelf', () => {
    expect(floor.controllers).toHaveLength(30);
    expect(floor.controllers.every((c: Json) => c.status === 'ready' && c.stationId === null)).toBe(true);
  });

  it('starts a session with controllers 1 & 2, paid 2.000 cash up front', async () => {
    const r = await h.api(
      'POST',
      '/api/sessions',
      {
        stationId: station('PS-01').id,
        mode: 'multi',
        kind: 'open',
        label: 'Ahmad',
        controllerIds: [ctrl(1).id, ctrl(2).id],
        prepaid: { amount: 2000, method: 'cash' },
      },
      h.tokens.cashier,
    );
    expect(r.status).toBe(200);
    sessionId = r.json.id;
    floor = await h.floor();
    expect(ctrl(1).stationId).toBe(station('PS-01').id);
    expect(ctrl(2).stationId).toBe(station('PS-01').id);
    const s = floor.sessions.find((x: Json) => x.id === sessionId);
    expect(s.paid).toBe(2000);
    expect(s.paidByMethod).toEqual({ cash: 2000 });
  });

  it('battery died on #2 → charging, swap in #3, ready again after an hour by itself', async () => {
    h.advance(20);
    const charge = await h.api('POST', `/api/controllers/${ctrl(2).id}/charge`, {}, h.tokens.waiter);
    expect(charge.status).toBe(200);
    expect(charge.json.readyAt).toBe(h.now() + 60 * 60_000);

    // a charging controller cannot be handed out
    const tooEarly = await h.api('POST', `/api/controllers/${ctrl(2).id}/assign`, { stationId: station('PS-02').id }, h.tokens.waiter);
    expect(tooEarly.json.code).toBe('controller_charging');

    await h.api('POST', `/api/controllers/${ctrl(3).id}/assign`, { stationId: station('PS-01').id }, h.tokens.waiter);
    floor = await h.floor();
    expect(ctrl(2)).toMatchObject({ status: 'charging', stationId: null });
    expect(ctrl(3).stationId).toBe(station('PS-01').id);

    h.advance(61);
    await tick(h.ctx);
    floor = await h.floor();
    expect(ctrl(2)).toMatchObject({ status: 'ready', readyAt: null });
    expect(h.published.some((e) => e.type === 'controller.charged' && e.payload.number === 2)).toBe(true);
  });

  it('takes a visa payment during play and shows what is left', async () => {
    const pay = await h.api('POST', `/api/sessions/${sessionId}/payments`, { amount: 1000, method: 'card' }, h.tokens.cashier);
    expect(pay.status).toBe(200);
    const bill = (await h.api('GET', `/api/sessions/${sessionId}/bill`, undefined, h.tokens.cashier)).json;
    // 81 min multi at 3.000/h = 4.050 → 5-minute units → 85 min = 4.250
    expect(bill.time.total).toBe(4250);
    expect(bill.paid).toBe(3000);
    expect(bill.paidByMethod).toEqual({ cash: 2000, card: 1000 });
    expect(bill.totals.due).toBe(1250);
  });

  it('moving to a VIP room takes the controllers along; ending returns them to the shelf', async () => {
    await h.api('POST', `/api/sessions/${sessionId}/action`, { type: 'transfer', stationId: station('VIP-1').id }, h.tokens.cashier);
    floor = await h.floor();
    expect([ctrl(1).stationId, ctrl(3).stationId]).toEqual([station('VIP-1').id, station('VIP-1').id]);

    const bill = (await h.api('GET', `/api/sessions/${sessionId}/bill`, undefined, h.tokens.cashier)).json;
    const out = await h.api('POST', `/api/sessions/${sessionId}/checkout`, { payments: [{ method: 'cash', amount: bill.totals.due }] }, h.tokens.cashier);
    expect(out.status).toBe(200);
    floor = await h.floor();
    expect(ctrl(1).stationId).toBeNull();
    expect(ctrl(3).stationId).toBeNull();
  });

  it('a broken controller cannot be handed out until fixed', async () => {
    await h.api('POST', `/api/controllers/${ctrl(5).id}/broken`, { broken: true, note: 'stick drift' }, h.tokens.waiter);
    const r = await h.api('POST', '/api/sessions', { stationId: station('PS-02').id, mode: 'single', kind: 'open', controllerIds: [ctrl(5).id] }, h.tokens.cashier);
    expect(r.json.code).toBe('controller_broken');
    await h.api('POST', `/api/controllers/${ctrl(5).id}/broken`, { broken: false }, h.tokens.waiter);
    const ok = await h.api('POST', '/api/sessions', { stationId: station('PS-02').id, mode: 'single', kind: 'open', controllerIds: [ctrl(5).id] }, h.tokens.cashier);
    expect(ok.status).toBe(200);
  });

  it('opens a device with drinks, controllers and a visa payment in one step', async () => {
    const products = (await h.api('GET', '/api/products', undefined, h.tokens.cashier)).json as Json[];
    const pepsi = products.find((p) => p.name === 'بيبسي');
    const r = await h.api(
      'POST',
      '/api/sessions',
      {
        stationId: station('PS-03').id,
        mode: 'single',
        kind: 'open',
        controllerIds: [ctrl(6).id],
        items: [{ productId: pepsi.id, qty: 2 }],
        prepaid: { amount: 1500, method: 'card' },
      },
      h.tokens.cashier,
    );
    expect(r.status).toBe(200);
    floor = await h.floor();
    const s = floor.sessions.find((x: Json) => x.id === r.json.id);
    expect(s).toMatchObject({ itemsCount: 2, itemsTotal: 1500, paid: 1500, paidByMethod: { card: 1500 } });
    expect(ctrl(6).stationId).toBe(station('PS-03').id);
  });

  it('managers add more numbered controllers', async () => {
    const r = await h.api('POST', '/api/controllers', { count: 4 }, h.tokens.manager);
    expect(r.json).toEqual({ from: 31, to: 34 });
    expect((await h.api('POST', '/api/controllers', { count: 1 }, h.tokens.waiter)).status).toBe(403);
  });
});
