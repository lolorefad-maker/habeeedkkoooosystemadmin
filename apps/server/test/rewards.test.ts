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
const start = (name: string, body: Json = {}) =>
  h.api('POST', '/api/sessions', { stationId: station(name).id, mode: 'single', kind: 'open', ...body }, cashier());
const bill = async (id: string) => (await h.api('GET', `/api/sessions/${id}/bill`, undefined, cashier())).json as Json;
/** Pays whatever is due in cash (the clock is frozen, so the bill read now is the bill charged now). */
const checkout = async (id: string, body: Json = {}) => {
  const due = (await bill(id)).totals.due;
  return h.api('POST', `/api/sessions/${id}/checkout`, { payments: due > 0 ? [{ method: 'cash', amount: due }] : [], ...body }, cashier());
};
const rewards = async (status = 'all') => (await h.api('GET', `/api/rewards?status=${status}`, undefined, cashier())).json as Json[];

describe('people rewards: a long session earns a free hour for the phone number', () => {
  it('more than 4 hours, registered with a number: one free hour, ready to send on WhatsApp', async () => {
    const s = await start('VIP-1', { label: 'أحمد', customerPhone: '0791234567' });
    expect(s.status).toBe(200);
    h.advance(5 * 60);
    const r = await checkout(s.json.id);
    expect(r.status).toBe(200);
    expect(r.json.reward).toMatchObject({ minutes: 60, playedMinutes: 300, name: 'أحمد', phone: '962791234567' });

    const list = await rewards();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'أحمد', phone: '962791234567', status: 'available', minutes: 60, notifiedAt: null });

    const sent = await h.api('POST', `/api/rewards/${list[0].id}/notified`, {}, cashier());
    expect(sent.status).toBe(200);
    expect((await rewards())[0].notifiedAt).toBeGreaterThan(0);
  });

  it('exactly 4 hours earns nothing; a minute more does; no number earns nothing', async () => {
    const exact = await start('VIP-1', { label: 'سامي', customerPhone: '0782222222' });
    h.advance(4 * 60);
    expect((await checkout(exact.json.id)).json.reward).toBeNull();

    const more = await start('VIP-1', { label: 'سامي', customerPhone: '0782222222' });
    h.advance(4 * 60 + 1);
    expect((await checkout(more.json.id)).json.reward).toMatchObject({ playedMinutes: 241 });

    const anonymous = await start('VIP-1', { label: 'بدون رقم' });
    h.advance(6 * 60);
    expect((await checkout(anonymous.json.id)).json.reward).toBeNull();
  });

  it('a pause does not count as play time', async () => {
    const s = await start('VIP-1', { customerPhone: '0773333333' });
    h.advance(2 * 60);
    await h.api('POST', `/api/sessions/${s.json.id}/action`, { type: 'pause' }, cashier());
    h.advance(3 * 60);
    await h.api('POST', `/api/sessions/${s.json.id}/action`, { type: 'resume' }, cashier());
    h.advance(60);
    expect((await checkout(s.json.id)).json.reward).toBeNull(); // 3 h played, 3 h paused
  });

  it('a number typed only at checkout still earns it', async () => {
    const s = await start('VIP-1', { label: 'ليلى' });
    h.advance(5 * 60);
    const r = await checkout(s.json.id, { customerPhone: '+962 78 444 5555' });
    expect(r.status).toBe(200);
    expect(r.json.reward).toMatchObject({ name: 'ليلى', phone: '962784445555' });
  });

  it('a booking with a number carries it to the session', async () => {
    const t = h.now();
    const res = await h.api(
      'POST',
      '/api/reservations',
      { stationId: station('VIP-2').id, startAt: t + 5 * 60_000, minutes: 360, mode: 'single', customerName: 'رنا', customerPhone: '079 666 7777' },
      cashier(),
    );
    expect(res.status).toBe(200);
    const s = await start('VIP-2', { reservationId: res.json.id });
    expect(s.status).toBe(200);
    h.advance(5 * 60);
    const r = await checkout(s.json.id);
    expect(r.json.reward).toMatchObject({ name: 'رنا', phone: '962796667777' });
  });

  it('a number that cannot be real is refused, not saved half-way', async () => {
    const r = await start('VIP-1', { customerPhone: '12' });
    expect(r.json.code).toBe('invalid_phone');
    expect((await h.floor()).sessions.some((x: Json) => x.stationId === station('VIP-1').id)).toBe(false);
  });
});

describe('using the free hour', () => {
  it('the same number in another format is the same customer; the free hour comes off the bill with no PIN', async () => {
    const who = (await h.api('GET', `/api/customers/lookup?phone=${encodeURIComponent('+962 79 123 4567')}`, undefined, cashier())).json;
    expect(who).toMatchObject({ name: 'أحمد', available: 1, phone: '962791234567' });

    const s = await start('VIP-3', { label: 'أحمد', customerPhone: '791234567' });
    h.advance(90);
    const b = await bill(s.json.id);
    expect(b.customer).toMatchObject({ name: 'أحمد', phone: '962791234567' });
    // 1.5 h at 4.000 = 6.000 → the free hour is worth 4.000
    expect(b.time.total).toBe(6000);
    expect(b.reward).toMatchObject({ minutes: 60, value: 4000 });

    // Both a hand-made discount and the reward: refused.
    const both = await h.api('POST', `/api/sessions/${s.json.id}/checkout`, { rewardId: b.reward.id, discount: { kind: 'percent', value: 5 }, discountReason: 'x', payments: [] }, cashier());
    expect(both.json.code).toBe('reward_and_discount');

    // 4.000 off 6.000 is far above a limit — the reward needs no manager.
    const paid = await h.api('POST', `/api/sessions/${s.json.id}/checkout`, { rewardId: b.reward.id, expectedTotal: 2000, payments: [{ method: 'cash', amount: 2000 }] }, cashier());
    expect(paid.status).toBe(200);
    expect(paid.json.redeemed).toMatchObject({ minutes: 60, value: 4000 });
    expect(paid.json.totals).toMatchObject({ discountAmount: 4000, total: 2000 });

    const used = (await rewards()).find((x) => x.id === b.reward.id);
    expect(used).toMatchObject({ status: 'used' });
    const saved = (await h.api('GET', `/api/bills/${paid.json.billId}`, undefined, cashier())).json;
    expect(saved.discountReason).toContain('مكافأة');
  });

  it('it can be used only once', async () => {
    const s = await start('VIP-3', { customerPhone: '0791234567' });
    h.advance(30);
    const b = await bill(s.json.id);
    expect(b.reward).toBeNull();
    const old = (await rewards()).find((x) => x.phone === '962791234567');
    const again = await h.api('POST', `/api/sessions/${s.json.id}/checkout`, { rewardId: old!.id, payments: [] }, cashier());
    expect(again.json.code).toBe('reward_unavailable');
    await h.api('POST', `/api/sessions/${s.json.id}/void`, { reason: 'test', approvalPin: h.pin('manager') }, cashier());
  });

  it('a reward belongs to its number: another customer cannot use it', async () => {
    const s = await start('VIP-3', { customerPhone: '0599999999' });
    h.advance(30);
    const mine = (await rewards('available'))[0];
    const r = await h.api('POST', `/api/sessions/${s.json.id}/checkout`, { rewardId: mine.id, payments: [] }, cashier());
    expect(r.json.code).toBe('reward_unavailable');
    await h.api('POST', `/api/sessions/${s.json.id}/void`, { reason: 'test', approvalPin: h.pin('manager') }, cashier());
  });

  it('only a manager voids a reward, with a reason, and it can no longer be used', async () => {
    const [open] = await rewards('available');
    expect((await h.api('POST', `/api/rewards/${open.id}/void`, { reason: 'رقم غلط' }, cashier())).status).toBe(403);
    expect((await h.api('POST', `/api/rewards/${open.id}/void`, { reason: 'x' }, h.tokens.manager)).status).toBe(400);
    expect((await h.api('POST', `/api/rewards/${open.id}/void`, { reason: 'رقم غلط' }, h.tokens.manager)).status).toBe(200);
    expect((await rewards()).find((x) => x.id === open.id)).toMatchObject({ status: 'void', voidReason: 'رقم غلط' });
    expect((await h.api('POST', `/api/rewards/${open.id}/void`, { reason: 'مرة ثانية' }, h.tokens.manager)).json.code).toBe('reward_unavailable');
  });

  it('the waiter sees nothing of it', async () => {
    expect((await h.api('GET', '/api/rewards', undefined, h.tokens.waiter)).status).toBe(403);
    expect((await h.api('GET', '/api/customers/lookup?phone=0791234567', undefined, h.tokens.waiter)).status).toBe(403);
  });
});

describe('the owner’s policy', () => {
  it('the hours, the free time and the switch are the owner’s to change', async () => {
    expect((await h.api('PATCH', '/api/settings/branch', { settings: { rewards: { afterMinutes: 120, freeMinutes: 30 } } }, h.tokens.owner)).status).toBe(200);
    const s = await start('VIP-1', { customerPhone: '0705550000' });
    h.advance(150);
    expect((await checkout(s.json.id)).json.reward).toMatchObject({ minutes: 30, playedMinutes: 150 });

    expect((await h.api('PATCH', '/api/settings/branch', { settings: { rewards: { enabled: false } } }, h.tokens.owner)).status).toBe(200);
    const off = await start('VIP-1', { customerPhone: '0705550000' });
    h.advance(10 * 60);
    expect((await checkout(off.json.id)).json.reward).toBeNull();
    expect((await h.api('PATCH', '/api/settings/branch', { settings: { rewards: { afterMinutes: 5 } } }, h.tokens.owner)).status).toBe(400);
  });

  it('every step is in the audit log', async () => {
    const log = (await h.api('GET', '/api/audit?limit=200', undefined, h.tokens.owner)).json as Json[];
    const types = new Set(log.map((e) => e.type));
    for (const t of ['reward.earned', 'reward.used', 'reward.notified', 'reward.voided', 'session.customer_set']) expect(types.has(t), t).toBe(true);
  });
});
