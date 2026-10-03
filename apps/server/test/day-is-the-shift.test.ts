import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tick } from '../src/scheduler';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
let station: (name: string) => Json;

beforeAll(async () => {
  h = await createHarness('2026-09-25T15:00:00Z'); // 18:00 in Amman
  await h.api('POST', '/api/shifts/open', { openingFloat: 5000 }, h.tokens.cashier);
  const floor = await h.floor();
  station = (name) => floor.stations.find((s: Json) => s.name === name);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const cashier = () => h.tokens.cashier;
const days = async () => (await h.api('GET', '/api/days', undefined, h.tokens.manager)).json as Json[];

describe('the day is the shift', () => {
  it('a night that crosses midnight is one day; closing the shift after midnight ends it', async () => {
    const playing = await h.api('POST', '/api/sessions', { stationId: station('PS-01').id, mode: 'single', kind: 'open', label: 'ليلي' }, cashier());
    const quick = await h.api('POST', '/api/sessions', { stationId: station('PS-02').id, mode: 'single', kind: 'open' }, cashier());
    h.advance(60);
    const due = (await h.api('GET', `/api/sessions/${quick.json.id}/bill`, undefined, cashier())).json.totals.due;
    expect((await h.api('POST', `/api/sessions/${quick.json.id}/checkout`, { payments: [{ method: 'cash', amount: due }] }, cashier())).status).toBe(200);

    h.advance(6 * 60); // 01:00 — past midnight, the scheduler would have closed the day before
    await tick(h.ctx);
    expect((await days()).find((d) => d.day === '2026-09-25')?.status).toBe('open');
    expect((await h.floor()).shift.openingFloat).toBe(5000);

    // A device is still playing when the cashier closes the shift by hand at 06:00.
    h.advance(5 * 60);
    const expected = (await h.floor()).shift.expectedCash;
    const closed = await h.api('POST', '/api/shifts/close', { countedCash: expected }, cashier());
    expect(closed.status).toBe(200);
    const list = await days();
    expect(list.find((d) => d.day === '2026-09-25')).toMatchObject({ status: 'closed', auto: false });
    expect(list.find((d) => d.day === '2026-09-26')?.status).toBe('open');

    const old = (await h.api('GET', '/api/reports/day?day=2026-09-25', undefined, h.tokens.manager)).json;
    expect(old.revenue.bills).toBe(1);
    expect(old.revenue.carriedIn).toBe(0);
    expect(old.shifts[0].openingFloat).toBe(5000);

    // The device that kept playing is paid on the new day, in full, with nothing split off.
    await h.api('POST', '/api/shifts/open', { openingFloat: 0 }, cashier());
    const bill = (await h.api('GET', `/api/sessions/${playing.json.id}/bill`, undefined, cashier())).json;
    expect(
      (await h.api('POST', `/api/sessions/${playing.json.id}/checkout`, { payments: [{ method: 'cash', amount: bill.totals.due }] }, cashier())).json.late ?? null,
    ).toBeNull();
    const fresh = (await h.api('GET', '/api/reports/day', undefined, h.tokens.manager)).json;
    expect(fresh.day).toBe('2026-09-26');
    expect(fresh.revenue.total).toBe(bill.totals.due);
    expect(fresh.revenue.carriedOut).toBe(0);
  });

  it('start from now hides every day so far, leaves the devices alone, and is for the owner', async () => {
    const running = await h.api('POST', '/api/sessions', { stationId: station('PS-03').id, mode: 'single', kind: 'open' }, cashier());
    expect((await h.api('POST', '/api/ledger/reset', { confirm: true }, h.tokens.manager)).json.code).toBe('owner_only');
    expect((await h.api('POST', '/api/ledger/reset', {}, h.tokens.owner)).status).toBe(400);
    const done = await h.api('POST', '/api/ledger/reset', { confirm: true }, h.tokens.owner);
    expect(done.status).toBe(200);

    const list = await days();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'open' });
    expect((await h.api('GET', '/api/reports/day?day=2026-09-25', undefined, h.tokens.manager)).status).toBe(404);
    expect((await h.api('GET', `/api/reports/sessions?day=2026-09-25`, undefined, h.tokens.manager)).json).toEqual([]);
    const range = (await h.api('GET', '/api/reports/range?from=2026-09-01&to=2026-09-30', undefined, h.tokens.manager)).json;
    expect(range.days).toHaveLength(0);
    expect(range.totals.total).toBe(0);

    // The shift was closed without a count, the device is still running.
    expect((await h.floor()).shift).toBeNull();
    expect(((await h.floor()).sessions as Json[]).find((s) => s.id === running.json.id)?.status).toBe('running');
  });
});
