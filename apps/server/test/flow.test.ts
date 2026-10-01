import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import { Bus, type AppContext, type DomainEvent } from '../src/context';
import { openDatabase, type Database } from '../src/db';
import { tick } from '../src/scheduler';
import { DEMO_STAFF, seedIfEmpty } from '../src/seed';

// Friday 2026-09-25 18:00 in Amman (UTC+3). Happy hour (Sun–Thu) does not apply.
let t = Date.parse('2026-09-25T15:00:00Z');
const advance = (minutes: number) => {
  t += minutes * 60_000;
};

const config: Config = {
  port: 0,
  host: '127.0.0.1',
  dataDir: '',
  databaseUrl: null,
  jwtSecret: 'test-secret-test-secret-test-secret',
  mode: 'local',
  webDist: null,
  seedDemo: true,
  schedulerIntervalMs: 1_000_000,
  accessCode: null,
  owner: null,
  trustProxy: false,
};

let database: Database;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>;
const published: DomainEvent[] = [];

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as Record<string, unknown> | undefined,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const tokens: Record<string, string> = {};
let branchId = '';
let floor: Json;
const station = (name: string) => floor.stations.find((s: Json) => s.name === name);
const pinOf = (role: string) => DEMO_STAFF.find((s) => s.role === role)!.pin;

beforeAll(async () => {
  database = await openDatabase({ databaseUrl: null, dataDir: null });
  await seedIfEmpty(database.db, { demo: true });
  ctx = { db: database.db, clock: { now: () => t }, bus: new Bus(), config };
  ctx.bus.onEvent((e) => published.push(e));
  app = await buildApp(ctx);
  await app.ready();

  branchId = (await api('GET', '/api/auth/branches')).json[0].id;
  const staff = (await api('GET', `/api/auth/staff?branchId=${branchId}`)).json as Json[];
  for (const role of ['owner', 'manager', 'cashier', 'waiter']) {
    const u = staff.find((s) => s.role === role);
    const r = await api('POST', '/api/auth/login', { userId: u.id, branchId, pin: pinOf(role) });
    expect(r.status).toBe(200);
    tokens[role] = r.json.token;
  }
  floor = (await api('GET', '/api/floor', undefined, tokens.cashier)).json;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.close();
});

describe('auth & permissions', () => {
  it('rejects a wrong PIN', async () => {
    const staff = (await api('GET', `/api/auth/staff?branchId=${branchId}`)).json as Json[];
    const r = await api('POST', '/api/auth/login', { userId: staff[0].id, branchId, pin: '0000' });
    expect(r.status).toBe(401);
  });

  it('a waiter cannot start sessions or see reports', async () => {
    expect((await api('POST', '/api/sessions', { stationId: station('PS-01').id, mode: 'single', kind: 'open' }, tokens.waiter)).status).toBe(403);
    expect((await api('GET', '/api/reports/day', undefined, tokens.waiter)).status).toBe(403);
  });

  it('seeded a full floor', () => {
    expect(floor.stations).toHaveLength(16);
    expect(floor.branch.currency).toBe('JOD');
  });
});

describe('a full evening', () => {
  let sessionA = '';

  it('refuses money without an open shift, then opens one', async () => {
    const r = await api(
      'POST',
      '/api/sessions',
      { stationId: station('PS-02').id, mode: 'single', kind: 'fixed', plannedMinutes: 60, prepaid: { amount: 2000, method: 'cash' } },
      tokens.cashier,
    );
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('no_open_shift');
    expect((await api('POST', '/api/shifts/open', { openingFloat: 20000 }, tokens.cashier)).status).toBe(200);
  });

  it('starts an open session and blocks a second one on the same station', async () => {
    const r = await api('POST', '/api/sessions', { stationId: station('PS-01').id, mode: 'single', kind: 'open', label: 'Ahmad' }, tokens.cashier);
    expect(r.status).toBe(200);
    sessionA = r.json.id;
    const dup = await api('POST', '/api/sessions', { stationId: station('PS-01').id, mode: 'single', kind: 'open' }, tokens.cashier);
    expect(dup.json.code).toBe('station_busy');
    expect(published.some((e) => e.type === 'session.started')).toBe(true);
  });

  it('switches to multi, adds orders, and prices each segment', async () => {
    advance(70);
    expect((await api('POST', `/api/sessions/${sessionA}/action`, { type: 'mode', mode: 'multi' }, tokens.cashier)).status).toBe(200);
    advance(75);
    const pepsi = (await api('GET', '/api/products', undefined, tokens.waiter)).json.find((p: Json) => p.name === 'بيبسي');
    const order = await api('POST', '/api/orders', { sessionId: sessionA, items: [{ productId: pepsi.id, qty: 2 }] }, tokens.waiter);
    expect(order.status).toBe(200);

    const bill = (await api('GET', `/api/sessions/${sessionA}/bill`, undefined, tokens.cashier)).json;
    expect(bill.time.lines.map((l: Json) => l.mode)).toEqual(['single', 'multi']);
    expect(bill.time.total).toBe(6083); // 70m × 2.000 + 75m × 3.000
    expect(bill.totals.itemsTotal).toBe(1500);
    expect(bill.totals.total).toBe(7600); // 7.583 rounded to 0.050
  });

  it('refuses a checkout when the total changed, then accepts the right one', async () => {
    const wrong = await api('POST', `/api/sessions/${sessionA}/checkout`, { payments: [{ method: 'cash', amount: 7000 }], expectedTotal: 7000 }, tokens.cashier);
    expect(wrong.json.code).toBe('bill_changed');
    const ok = await api('POST', `/api/sessions/${sessionA}/checkout`, { payments: [{ method: 'cash', amount: 7600 }], expectedTotal: 7600 }, tokens.cashier);
    expect(ok.status).toBe(200);
    expect(ok.json.number).toBe(1);
    const f = (await api('GET', '/api/floor', undefined, tokens.cashier)).json;
    expect(f.sessions.find((s: Json) => s.id === sessionA)).toBeUndefined();
  });

  it('booked 1 hour, played 30 minutes → refunds the difference', async () => {
    const start = await api(
      'POST',
      '/api/sessions',
      { stationId: station('PS-02').id, mode: 'single', kind: 'fixed', plannedMinutes: 60, prepaid: { amount: 2000, method: 'cash' } },
      tokens.cashier,
    );
    expect(start.status).toBe(200);
    advance(30);
    const bill = (await api('GET', `/api/sessions/${start.json.id}/bill`, undefined, tokens.cashier)).json;
    expect(bill.time.total).toBe(1000);
    expect(bill.totals.due).toBe(-1000);
    const out = await api('POST', `/api/sessions/${start.json.id}/checkout`, { payments: [{ method: 'cash', amount: -1000 }] }, tokens.cashier);
    expect(out.status).toBe(200);
  });

  it('a big discount needs a manager PIN', async () => {
    const s = await api('POST', '/api/sessions', { stationId: station('PS-03').id, mode: 'single', kind: 'open' }, tokens.cashier);
    advance(60);
    const body = { discount: { kind: 'percent', value: 50 }, discountReason: 'regular customer', payments: [{ method: 'cash', amount: 1000 }] };
    const denied = await api('POST', `/api/sessions/${s.json.id}/checkout`, body, tokens.cashier);
    expect(denied.json.code).toBe('approval_required');
    const approved = await api('POST', `/api/sessions/${s.json.id}/checkout`, { ...body, approvalPin: pinOf('manager') }, tokens.cashier);
    expect(approved.status).toBe(200);
  });

  it('transfer to a VIP room and pause/resume', async () => {
    const s = (await api('POST', '/api/sessions', { stationId: station('PS-04').id, mode: 'single', kind: 'open' }, tokens.cashier)).json.id;
    advance(30);
    expect((await api('POST', `/api/sessions/${s}/action`, { type: 'transfer', stationId: station('VIP-1').id }, tokens.cashier)).status).toBe(200);
    advance(30);
    await api('POST', `/api/sessions/${s}/action`, { type: 'pause' }, tokens.cashier);
    advance(20);
    await api('POST', `/api/sessions/${s}/action`, { type: 'resume' }, tokens.cashier);
    advance(30);
    const bill = (await api('GET', `/api/sessions/${s}/bill`, undefined, tokens.cashier)).json;
    // 30m × 2.000 + 60m × 4.000 (VIP), 20m paused not charged
    expect(bill.time.total).toBe(1000 + 4000);
    expect(bill.time.pausedMs).toBe(20 * 60_000);
    // a session cannot move onto a busy station
    const busy = (await api('POST', '/api/sessions', { stationId: station('PS-05').id, mode: 'single', kind: 'open' }, tokens.cashier)).json.id;
    const clash = await api('POST', `/api/sessions/${busy}/action`, { type: 'transfer', stationId: station('VIP-1').id }, tokens.cashier);
    expect(clash.json.code).toBe('station_busy');
  });
});

describe('reservations', () => {
  it('late cancellation keeps part of the deposit', async () => {
    const r = await api(
      'POST',
      '/api/reservations',
      { stationId: station('VIP-2').id, startAt: t + 60 * 60_000, minutes: 120, mode: 'multi', customerName: 'Sami', deposit: { amount: 2000, method: 'cash' } },
      tokens.cashier,
    );
    expect(r.status).toBe(200);
    const overlap = await api('POST', '/api/reservations', { stationId: station('VIP-2').id, startAt: t + 90 * 60_000, minutes: 60, mode: 'multi', customerName: 'X' }, tokens.cashier);
    expect(overlap.json.code).toBe('reservation_conflict');
    advance(30);
    const c = await api('POST', `/api/reservations/${r.json.id}/cancel`, { refundMethod: 'cash' }, tokens.cashier);
    expect(c.json).toMatchObject({ late: true, fee: 1000, refund: 1000 });
  });

  it('holds the station, then releases it as a no-show', async () => {
    const r = await api('POST', '/api/reservations', { stationId: station('VR-1').id, startAt: t + 10 * 60_000, minutes: 30, mode: 'standard', customerName: 'Lina' }, tokens.cashier);
    const blocked = await api('POST', '/api/sessions', { stationId: station('VR-1').id, mode: 'standard', kind: 'open' }, tokens.cashier);
    expect(blocked.json.code).toBe('station_reserved');
    advance(30);
    await tick(ctx);
    const list = (await api('GET', `/api/reservations?from=${t - 3_600_000}`, undefined, tokens.cashier)).json;
    expect(list.find((x: Json) => x.id === r.json.id).status).toBe('no_show');
    expect((await api('POST', '/api/sessions', { stationId: station('VR-1').id, mode: 'standard', kind: 'open' }, tokens.cashier)).status).toBe(200);
  });

  it('check-in turns the deposit into credit on the bill', async () => {
    const r = await api(
      'POST',
      '/api/reservations',
      { stationId: station('VIP-3').id, startAt: t + 5 * 60_000, minutes: 60, mode: 'single', customerName: 'Omar', deposit: { amount: 1000, method: 'card' } },
      tokens.cashier,
    );
    const s = await api('POST', '/api/sessions', { stationId: station('VIP-3').id, mode: 'single', kind: 'open', reservationId: r.json.id }, tokens.cashier);
    expect(s.status).toBe(200);
    advance(60);
    const bill = (await api('GET', `/api/sessions/${s.json.id}/bill`, undefined, tokens.cashier)).json;
    expect(bill.paid).toBe(1000);
    expect(bill.totals.due).toBe(4000 - 1000);
  });
});

describe('end of day', () => {
  it('closes the shift with a cash count and the day with a stock count', async () => {
    const shift = (await api('GET', '/api/shifts/current', undefined, tokens.cashier)).json.shift;
    // float 20.000 + 7.600 + 2.000 prepaid − 1.000 refund + 1.000 discounted bill + 2.000 deposit − 1.000 deposit refund
    expect(shift.expectedCash).toBe(20000 + 7600 + 2000 - 1000 + 1000 + 2000 - 1000);

    const early = await api('POST', '/api/days/close', {}, tokens.manager);
    expect(early.json.code).toBe('shift_open');

    const closed = await api('POST', '/api/shifts/close', { countedCash: shift.expectedCash - 500 }, tokens.cashier);
    expect(closed.json.variance).toBe(-500);

    const pepsi = (await api('GET', '/api/stock', undefined, tokens.manager)).json.find((p: Json) => p.name === 'بيبسي');
    expect(pepsi.stockQty).toBe(46);
    const day = await api('POST', '/api/days/close', { counts: [{ productId: pepsi.id, countedQty: 45 }] }, tokens.manager);
    expect(day.status).toBe(200);
    const report = day.json.report;
    expect(report.revenue.bills).toBe(3);
    // Paid bills, plus what the stations still playing earned up to the close (that is this day's too).
    expect(report.revenue.total - report.revenue.carriedIn).toBe(7600 + 1000 + 1000);
    expect(report.revenue.carriedIn).toBeGreaterThan(0);
    expect(report.stock[0]).toMatchObject({ expected: 46, counted: 45, variance: -1 });
    expect(report.openSessions.count).toBeGreaterThan(0);
    expect(report.shifts[0].variance).toBe(-500);
    expect(day.json.next).toBe('2026-09-26');
  });

  it('rolls the day over automatically at the cutoff', async () => {
    t = Date.parse('2026-09-27T03:30:00Z'); // 06:30 Amman on the 27th
    await tick(ctx);
    const days = (await api('GET', '/api/days', undefined, tokens.manager)).json as Json[];
    expect(days.find((d) => d.day === '2026-09-26')).toMatchObject({ status: 'closed', auto: true });
    expect(days.find((d) => d.day === '2026-09-27')?.status).toBe('open');
  });

  it('keeps an audit trail of everything', async () => {
    const log = (await api('GET', '/api/audit?limit=500', undefined, tokens.owner)).json as Json[];
    const types = new Set(log.map((e) => e.type));
    for (const t of ['session.started', 'session.mode_changed', 'order.created', 'bill.paid', 'reservation.no_show', 'shift.closed', 'day.closed']) {
      expect(types.has(t)).toBe(true);
    }
    expect(log.find((e) => e.type === 'bill.paid' && e.approverName)).toBeTruthy();
  });
});
