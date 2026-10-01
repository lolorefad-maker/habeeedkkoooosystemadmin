import { DomainError, type TimeBill } from '@lounge/core';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { Q } from '../db';
import { bills, payments, sessions, stations } from '../db/schema';
import { carriedSoFar, carriesOnDays } from './carries';

/** Money received per method, from the payments table (prepaid, during play, at checkout, deposits, refunds). */
function byMethod(rows: { method: string; amount: number }[]) {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.method] = (out[r.method] ?? 0) + r.amount;
  return out;
}

/**
 * Daily log: every device session paid on this business day — which device, from when to when,
 * how long, time charge, what they took, the total, and how it was paid — and every cafeteria sale.
 * A session that ran past an earlier day's end shows what that day already counted (`carriedOut`);
 * a session still open at this day's end shows as a `carried` row with this day's share.
 */
export async function sessionsLog(q: Q, branchId: string, day: string) {
  const rows = await q
    .select()
    .from(bills)
    .where(and(eq(bills.branchId, branchId), eq(bills.businessDay, day), eq(bills.status, 'paid')))
    .orderBy(asc(bills.createdAt));
  const pays = rows.length
    ? await q
        .select({ billId: payments.billId, method: payments.method, amount: payments.amount })
        .from(payments)
        .where(inArray(payments.billId, rows.map((b) => b.id)))
    : [];

  const earlier = await carriedSoFar(q, rows.map((b) => b.sessionId).filter((x): x is string => !!x));

  const billRows = rows.map((b) => {
    const bd = b.breakdown as {
      time?: TimeBill | null;
      items?: { name: string; qty: number; voided?: boolean }[];
      label?: string | null;
      stationName?: string | null;
      startedAt?: number;
      endedAt?: number;
      counter?: boolean;
    };
    const items = new Map<string, number>();
    for (const i of bd.items ?? []) if (!i.voided) items.set(i.name, (items.get(i.name) ?? 0) + i.qty);
    return {
      billId: b.id,
      number: b.number,
      stationName: bd.stationName ?? null,
      label: bd.label ?? null,
      startedAt: bd.startedAt ?? null,
      endedAt: bd.endedAt ?? null,
      playedMs: bd.time?.playedMs ?? 0,
      timeCharge: b.timeCharge,
      items: [...items.entries()].map(([name, qty]) => ({ name, qty })),
      itemsTotal: b.itemsTotal,
      discount: b.discountAmount,
      total: b.total,
      paidByMethod: byMethod(pays.filter((p) => p.billId === b.id)),
      /** A cafeteria sale (no device). */
      counter: !!bd.counter,
      /** Already counted on an earlier day (what was played and taken before that day ended). */
      carriedOutTime: b.sessionId ? (earlier.get(b.sessionId)?.time ?? 0) : 0,
      carriedOutItems: b.sessionId ? (earlier.get(b.sessionId)?.items ?? 0) : 0,
      carried: false,
    };
  });

  // Sessions that were still open when this day ended: this day's share of them.
  const carries = await carriesOnDays(q, branchId, [day]);
  const carriedRows = [];
  if (carries.length) {
    const sess = await q
      .select({ id: sessions.id, label: sessions.label, startedAt: sessions.startedAt, stationName: stations.name })
      .from(sessions)
      .leftJoin(stations, eq(stations.id, sessions.stationId))
      .where(inArray(sessions.id, carries.map((c) => c.sessionId)));
    const byId = new Map(sess.map((x) => [x.id, x]));
    for (const c of carries) {
      const x = byId.get(c.sessionId);
      carriedRows.push({
        billId: c.id,
        number: 0,
        stationName: x?.stationName ?? null,
        label: x?.label ?? null,
        startedAt: x?.startedAt.getTime() ?? null,
        endedAt: null,
        playedMs: c.ms,
        timeCharge: c.time,
        items: [] as { name: string; qty: number }[],
        itemsTotal: c.items,
        discount: 0,
        total: c.time + c.items,
        paidByMethod: {} as Record<string, number>,
        counter: false,
        carriedOutTime: 0,
        carriedOutItems: 0,
        carried: true,
      });
    }
  }
  return [...billRows, ...carriedRows];
}

/** Monthly: one row per business day with what came in, plus month totals. `month` = "YYYY-MM". */
export async function monthReport(q: Q, branchId: string, month: string) {
  const start = DateTime.fromISO(`${month}-01`);
  if (!start.isValid) throw new Error('Invalid month');
  const report = await rangeReport(q, branchId, start.toISODate()!, start.endOf('month').toISODate()!);
  return { month, days: report.days, totals: report.totals };
}

/** Longest period one report covers. */
export const MAX_RANGE_DAYS = 366;

/**
 * Any period, "from the 1st to the 15th": one row per business day with what came in, and the
 * period's totals. `from` and `to` are business days (YYYY-MM-DD), both included.
 */
export async function rangeReport(q: Q, branchId: string, from: string, to: string) {
  const start = DateTime.fromISO(from);
  const end = DateTime.fromISO(to);
  if (!start.isValid || !end.isValid) throw new DomainError('invalid_range', 'Invalid dates');
  if (end < start) throw new DomainError('invalid_range', 'The period ends before it starts');
  if (end.diff(start, 'days').days + 1 > MAX_RANGE_DAYS) throw new DomainError('range_too_long', 'Pick a period of at most a year');
  const until = end.plus({ days: 1 }).toISODate()!;

  const [rangeBills, rangePayments] = await Promise.all([
    q
      .select({
        sessionId: bills.sessionId,
        day: bills.businessDay,
        timeCharge: bills.timeCharge,
        itemsTotal: bills.itemsTotal,
        discount: bills.discountAmount,
        total: bills.total,
      })
      .from(bills)
      .where(and(eq(bills.branchId, branchId), eq(bills.status, 'paid'), gte(bills.businessDay, from), lt(bills.businessDay, until))),
    q
      .select({ day: payments.businessDay, method: payments.method, amount: payments.amount })
      .from(payments)
      .where(and(eq(payments.branchId, branchId), gte(payments.businessDay, from), lt(payments.businessDay, until))),
  ]);

  type Row = { day: string; sessions: number; time: number; items: number; discounts: number; total: number; received: Record<string, number> };
  const days = new Map<string, Row>();
  const row = (day: string) => {
    let r = days.get(day);
    if (!r) {
      r = { day, sessions: 0, time: 0, items: 0, discounts: 0, total: 0, received: {} };
      days.set(day, r);
    }
    return r;
  };
  for (const b of rangeBills) {
    const r = row(b.day);
    r.sessions++;
    r.time += b.timeCharge;
    r.items += b.itemsTotal;
    r.discounts += b.discount;
    r.total += b.total;
  }
  for (const p of rangePayments) {
    const r = row(p.day);
    r.received[p.method] = (r.received[p.method] ?? 0) + p.amount;
  }
  // A session that ran past a day's end: its share goes to that day, the bill's day keeps the rest.
  const earlier = await carriedSoFar(q, rangeBills.map((b) => b.sessionId).filter((x): x is string => !!x));
  for (const b of rangeBills) {
    const c = b.sessionId ? earlier.get(b.sessionId) : undefined;
    if (!c) continue;
    const r = row(b.day);
    r.time -= c.time;
    r.items -= c.items;
    r.total -= c.time + c.items;
  }
  const rangeDays: string[] = [];
  for (let d = start; d <= end; d = d.plus({ days: 1 })) rangeDays.push(d.toISODate()!);
  for (const c of await carriesOnDays(q, branchId, rangeDays)) {
    const r = row(c.businessDay);
    r.time += c.time;
    r.items += c.items;
    r.total += c.time + c.items;
  }

  const list = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totals = list.reduce(
    (t, r) => {
      t.sessions += r.sessions;
      t.time += r.time;
      t.items += r.items;
      t.discounts += r.discounts;
      t.total += r.total;
      for (const [m, v] of Object.entries(r.received)) t.received[m] = (t.received[m] ?? 0) + v;
      return t;
    },
    { sessions: 0, time: 0, items: 0, discounts: 0, total: 0, received: {} as Record<string, number> },
  );
  return { from, to, days: list, totals };
}
