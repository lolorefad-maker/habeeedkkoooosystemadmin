import type { TimeBill } from '@lounge/core';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { Q } from '../db';
import { bills, payments } from '../db/schema';

/** Money received per method, from the payments table (prepaid, during play, at checkout, deposits, refunds). */
function byMethod(rows: { method: string; amount: number }[]) {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.method] = (out[r.method] ?? 0) + r.amount;
  return out;
}

/**
 * Daily log: every device session paid on this business day — which device, from when to when,
 * how long, time charge, what they took, the total, and how it was paid.
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

  return rows.map((b) => {
    const bd = b.breakdown as {
      time?: TimeBill | null;
      items?: { name: string; qty: number; voided?: boolean }[];
      label?: string | null;
      stationName?: string | null;
      startedAt?: number;
      endedAt?: number;
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
    };
  });
}

/** Monthly: one row per business day with what came in, plus month totals. `month` = "YYYY-MM". */
export async function monthReport(q: Q, branchId: string, month: string) {
  const start = DateTime.fromISO(`${month}-01`);
  if (!start.isValid) throw new Error('Invalid month');
  const from = start.toISODate()!;
  const to = start.plus({ months: 1 }).toISODate()!;

  const [monthBills, monthPayments] = await Promise.all([
    q
      .select({
        day: bills.businessDay,
        timeCharge: bills.timeCharge,
        itemsTotal: bills.itemsTotal,
        discount: bills.discountAmount,
        total: bills.total,
      })
      .from(bills)
      .where(and(eq(bills.branchId, branchId), eq(bills.status, 'paid'), gte(bills.businessDay, from), lt(bills.businessDay, to))),
    q
      .select({ day: payments.businessDay, method: payments.method, amount: payments.amount })
      .from(payments)
      .where(and(eq(payments.branchId, branchId), gte(payments.businessDay, from), lt(payments.businessDay, to))),
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
  for (const b of monthBills) {
    const r = row(b.day);
    r.sessions++;
    r.time += b.timeCharge;
    r.items += b.itemsTotal;
    r.discounts += b.discount;
    r.total += b.total;
  }
  for (const p of monthPayments) {
    const r = row(p.day);
    r.received[p.method] = (r.received[p.method] ?? 0) + p.amount;
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
  return { month, days: list, totals };
}
