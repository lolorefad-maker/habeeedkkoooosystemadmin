import {
  DomainError,
  businessDayOf,
  businessDayRange,
  computeTimeBill,
  type DayReport,
  type TimeBill,
} from '@lounge/core';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import {
  bills,
  businessDays,
  events,
  orderItems,
  orders,
  payments,
  products,
  reservations,
  sessions,
  shifts,
  stations,
  stockMovements,
  users,
} from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { currentDay, getBranch, loadBillingContext, loadSegments, openShift, toTimeline, type Branch } from './common';
import { closeOpenShift, closeShiftInput } from './shifts';

export const closeDayInput = z.object({
  counts: z
    .array(z.object({ productId: z.uuid(), countedQty: z.number().int().min(0) }))
    .max(500)
    .default([]),
  /** The cash counted in the drawer: closes the open shift in the same step ("end the day"). */
  shift: closeShiftInput.nullish(),
});

export async function getDayRow(q: Q, branchId: string, day: string) {
  const [row] = await q.select().from(businessDays).where(and(eq(businessDays.branchId, branchId), eq(businessDays.day, day)));
  return row ?? null;
}

export async function buildDayReport(q: Q, branch: Branch, day: string, now: number): Promise<DayReport> {
  const row = await getDayRow(q, branch.id, day);
  if (!row) throw notFound('business day');
  const until = row.closedAt ?? new Date(now);

  const [dayBills, dayPayments, dayShifts, allStations, counts] = await Promise.all([
    q.select().from(bills).where(and(eq(bills.branchId, branch.id), eq(bills.businessDay, day), eq(bills.status, 'paid'))),
    q.select().from(payments).where(and(eq(payments.branchId, branch.id), eq(payments.businessDay, day))),
    q.select().from(shifts).where(and(eq(shifts.branchId, branch.id), eq(shifts.businessDay, day))),
    q.select().from(stations).where(eq(stations.branchId, branch.id)),
    q
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.branchId, branch.id), eq(stockMovements.businessDay, day), eq(stockMovements.reason, 'count'))),
  ]);

  // Revenue
  const revenue = { bills: dayBills.length, time: 0, items: 0, discounts: 0, rounding: 0, total: 0 };
  for (const b of dayBills) {
    revenue.time += b.timeCharge;
    revenue.items += b.itemsTotal;
    revenue.discounts += b.discountAmount;
    revenue.rounding += b.rounding;
    revenue.total += b.total;
  }

  // Money movements
  const byMethod: Record<string, number> = { cash: 0, card: 0, wallet: 0 };
  let deposits = 0;
  let refunds = 0;
  for (const p of dayPayments) {
    byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    if (p.kind === 'deposit') deposits += p.amount;
    if (p.amount < 0) refunds += -p.amount;
  }
  const net = Object.values(byMethod).reduce((a, b) => a + b, 0);

  // Station performance from bill snapshots
  const stationMap = new Map(allStations.map((s) => [s.id, s]));
  const perStation = new Map<string, { minutes: number; amount: number }>();
  for (const b of dayBills) {
    const time = (b.breakdown as { time?: TimeBill | null }).time;
    for (const l of time?.lines ?? []) {
      const cur = perStation.get(l.stationId) ?? { minutes: 0, amount: 0 };
      cur.minutes += l.ms / 60_000;
      cur.amount += l.amount;
      perStation.set(l.stationId, cur);
    }
  }
  const stationRows = [...perStation.entries()]
    .map(([stationId, v]) => {
      const s = stationMap.get(stationId);
      return { stationId, name: s?.name ?? '?', type: s?.type ?? '', tier: s?.tier ?? '', minutes: Math.round(v.minutes), amount: v.amount };
    })
    .sort((a, b) => b.amount - a.amount);

  // Products sold on today's bills
  const billIds = dayBills.map((b) => b.id);
  const soldItems = billIds.length
    ? await q
        .select({ productId: orderItems.productId, name: orderItems.name, qty: orderItems.qty, unitPrice: orderItems.unitPrice })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(and(inArray(orders.billId, billIds), eq(orderItems.voided, false)))
    : [];
  const perProduct = new Map<string, { name: string; qty: number; amount: number }>();
  for (const i of soldItems) {
    const cur = perProduct.get(i.productId) ?? { name: i.name, qty: 0, amount: 0 };
    cur.qty += i.qty;
    cur.amount += i.qty * i.unitPrice;
    perProduct.set(i.productId, cur);
  }

  // Voids during the day
  const voidEvents = await q
    .select()
    .from(events)
    .where(
      and(
        eq(events.branchId, branch.id),
        eq(events.type, 'order.item_voided'),
        gte(events.createdAt, row.openedAt),
        lt(events.createdAt, until),
      ),
    );
  const voids = {
    count: voidEvents.length,
    amount: voidEvents.reduce((s, e) => s + Number((e.payload as { amount?: number }).amount ?? 0), 0),
  };

  // Reservations scheduled during the business day
  const range = businessDayRange(day, branch.timezone, branch.settings.day.cutoff);
  const dayRes = await q
    .select()
    .from(reservations)
    .where(and(eq(reservations.branchId, branch.id), gte(reservations.startAt, new Date(range.start)), lt(reservations.startAt, new Date(range.end))));

  // Sessions still open (they will be billed on the day they are paid)
  const open = await q
    .select()
    .from(sessions)
    .where(and(eq(sessions.branchId, branch.id), inArray(sessions.status, ['running', 'ended'])));
  let runningValue = 0;
  if (open.length) {
    const bctx = await loadBillingContext(q, branch);
    const segs = await loadSegments(q, open.map((s) => s.id));
    for (const s of open) {
      const asOf = s.status === 'running' ? now : (s.endedAt?.getTime() ?? now);
      try {
        runningValue += computeTimeBill(toTimeline(s, segs.get(s.id) ?? []), bctx, asOf).total;
      } catch {
        /* a misconfigured station should not break the report */
      }
    }
  }

  const userIds = [...new Set(dayShifts.map((s) => s.userId))];
  const names = userIds.length ? await q.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const nameOf = new Map(names.map((u) => [u.id, u.name]));

  const productNames = counts.length
    ? await q.select({ id: products.id, name: products.name, qty: products.stockQty }).from(products).where(inArray(products.id, counts.map((c) => c.productId)))
    : [];
  const productMap = new Map(productNames.map((p) => [p.id, p]));

  return {
    day,
    status: row.status,
    generatedAt: now,
    openedAt: row.openedAt.getTime(),
    closedAt: row.closedAt?.getTime() ?? null,
    auto: row.auto,
    currency: { code: branch.currency, decimals: branch.currencyDecimals },
    revenue,
    payments: { byMethod, deposits, refunds, net },
    stations: stationRows,
    products: [...perProduct.entries()]
      .map(([productId, v]) => ({ productId, ...v }))
      .sort((a, b) => b.amount - a.amount),
    voids,
    reservations: {
      total: dayRes.length,
      completed: dayRes.filter((r) => r.status === 'completed' || r.status === 'checked_in').length,
      cancelled: dayRes.filter((r) => r.status === 'cancelled').length,
      noShows: dayRes.filter((r) => r.status === 'no_show').length,
      fees: dayRes.reduce((s, r) => s + r.fee, 0),
    },
    openSessions: { count: open.length, runningValue },
    shifts: dayShifts.map((s) => ({
      id: s.id,
      userName: nameOf.get(s.userId) ?? '',
      openedAt: s.openedAt.getTime(),
      closedAt: s.closedAt?.getTime() ?? null,
      openingFloat: s.openingFloat,
      expectedCash: s.expectedCash,
      countedCash: s.countedCash,
      variance: s.variance,
    })),
    stock: counts.map((c) => {
      const p = productMap.get(c.productId);
      const counted = p?.qty ?? 0;
      return { productId: c.productId, name: p?.name ?? '?', expected: counted - c.delta, counted, variance: c.delta };
    }),
  };
}

const nextDay = (day: string) => DateTime.fromISO(day).plus({ days: 1 }).toISODate()!;

async function closeAndRoll(
  ctx: AppContext,
  actor: Actor | { id: null; branchId: string },
  opts: { auto: boolean; counts: { productId: string; countedQty: number }[]; shift?: { countedCash: number; note?: string | null } | null },
) {
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const day = await currentDay(tx, branch, now);

    // Drawer first, so the day's report already has the counted cash and its variance.
    if (opts.shift && actor.id) await closeOpenShift(tx, record, actor as Actor, opts.shift, now);

    for (const c of opts.counts) {
      const [p] = await tx.select().from(products).where(and(eq(products.id, c.productId), eq(products.branchId, branch.id)));
      if (!p) throw notFound('product');
      const delta = c.countedQty - p.stockQty;
      await tx.update(products).set({ stockQty: c.countedQty, updatedAt: new Date(now) }).where(eq(products.id, p.id));
      await tx.insert(stockMovements).values({
        id: newId(),
        branchId: branch.id,
        productId: p.id,
        delta,
        reason: 'count',
        businessDay: day,
        createdBy: actor.id,
      });
    }

    await tx
      .update(businessDays)
      .set({ status: 'closed', closedAt: new Date(now), closedBy: actor.id, auto: opts.auto })
      .where(and(eq(businessDays.branchId, branch.id), eq(businessDays.day, day)));
    const report = await buildDayReport(tx, branch, day, now);
    await tx
      .update(businessDays)
      .set({ report: report as unknown as Record<string, unknown> })
      .where(and(eq(businessDays.branchId, branch.id), eq(businessDays.day, day)));

    const clockDay = businessDayOf(now, branch.timezone, branch.settings.day.cutoff);
    const next = clockDay > day ? clockDay : nextDay(day);
    await tx
      .insert(businessDays)
      .values({ id: newId(), branchId: branch.id, day: next, status: 'open', openedAt: new Date(now) })
      .onConflictDoUpdate({
        target: [businessDays.branchId, businessDays.day],
        set: { status: 'open', closedAt: null, closedBy: null, report: null },
      });

    await record({
      type: 'day.closed',
      entity: 'day',
      payload: { day, next, auto: opts.auto, total: report.revenue.total, net: report.payments.net },
    });
    return { day, next, report };
  });
}

/**
 * Manager ends the day ("إنهاء اليوم"): counts the drawer (closing the open shift), optionally
 * counts stock, saves the day's report, and the next day opens at zero — all in one transaction.
 */
export async function closeDay(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = closeDayInput.parse(raw ?? {});
  const shiftOpen = !!(await openShift(ctx.db, actor.branchId));
  if (shiftOpen && !input.shift) {
    throw new DomainError('shift_open', 'Count the cash drawer (close the shift) before closing the day');
  }
  return closeAndRoll(ctx, actor, { auto: false, counts: input.counts, shift: shiftOpen ? input.shift : null });
}

/** Scheduler: at the cutoff, close a day nobody closed. Open shifts and sessions simply carry on. */
export async function autoRollover(ctx: AppContext, branchId: string): Promise<boolean> {
  const branch = await getBranch(ctx.db, branchId);
  if (!branch.settings.day.autoCloseDay) return false;
  const now = ctx.clock.now();
  const open = await currentDay(ctx.db, branch, now);
  const clockDay = businessDayOf(now, branch.timezone, branch.settings.day.cutoff);
  if (clockDay <= open) return false;
  await closeAndRoll(ctx, { id: null, branchId }, { auto: true, counts: [] });
  return true;
}

export async function dayReport(q: Q, branchId: string, day: string | null, now: number): Promise<DayReport> {
  const branch = await getBranch(q, branchId);
  const target = day ?? (await currentDay(q, branch, now));
  const row = await getDayRow(q, branchId, target);
  if (!row) throw notFound('business day');
  if (row.status === 'closed' && row.report) return row.report as unknown as DayReport;
  return buildDayReport(q, branch, target, now);
}

export async function listDays(q: Q, branchId: string) {
  return q
    .select({ day: businessDays.day, status: businessDays.status, openedAt: businessDays.openedAt, closedAt: businessDays.closedAt, auto: businessDays.auto })
    .from(businessDays)
    .where(eq(businessDays.branchId, branchId))
    .orderBy(businessDays.day);
}
