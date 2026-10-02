import {
  DomainError,
  computeCheckout,
  computeTimeBill,
  discountPercentOf,
  type CheckoutTotals,
  type DiscountInput,
  type TimeBill,
} from '@lounge/core';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext, type Record_ } from '../context';
import type { Q, Tx } from '../db';
import { bills, branches, dayCarries, orderItems, orders, payments, reservations, segments, sessions, shifts, stations, users } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  currentDay,
  getBranch,
  getSession,
  loadBillingContext,
  loadSegments,
  openShift,
  requireOpenShift,
  resolveApproval,
  sessionPaidByMethod,
  toTimeline,
  type Branch,
} from './common';
import { AFTER_DAY_END, carriedSoFar } from './carries';
import { returnStationControllers } from './controllers';
import { insertOrder, orderItemsInput } from './orders';
import { sessionItems } from './sessions';

const paymentInput = z.object({
  method: z.enum(['cash', 'card']),
  /** Minor units. Negative = refund to the customer. */
  amount: z.number().int(),
});

const baseCheckout = {
  discount: z
    .object({ kind: z.enum(['amount', 'percent']), value: z.number().min(0) })
    .nullish(),
  discountReason: z.string().trim().max(200).nullish(),
  payments: z.array(paymentInput).max(4),
  approvalPin: z.string().nullish(),
  /** The total the cashier saw. If the server computes something else, the checkout is refused so nobody is surprised. */
  expectedTotal: z.number().int().optional(),
};

export const checkoutSessionInput = z.object(baseCheckout);

interface ItemLine {
  id: string;
  orderId: string;
  name: string;
  unitPrice: number;
  qty: number;
  voided: boolean;
}

function validatePayments(due: number, list: { method: string; amount: number }[]) {
  const sum = list.reduce((s, p) => s + p.amount, 0);
  if (due >= 0) {
    if (list.some((p) => p.amount <= 0)) throw new DomainError('invalid_payment', 'Payment amounts must be positive');
  } else if (list.length !== 1 || list[0]!.amount >= 0) {
    throw new DomainError('invalid_payment', 'A refund is a single negative payment');
  }
  if (sum !== due) throw new DomainError('payment_mismatch', 'Payments do not match the amount due', { due, paid: sum });
}

/** Shared tail of every checkout: approvals, bill number, payments, audit. */
async function finalize(
  tx: Tx,
  record: Record_,
  ctx: AppContext,
  actor: Actor,
  branch: Branch,
  args: {
    sessionId: string | null;
    reservationId: string | null;
    time: TimeBill | null;
    items: ItemLine[];
    orderIds: string[];
    paid: number;
    discount: DiscountInput | null;
    discountReason: string | null;
    payments: { method: 'cash' | 'card'; amount: number }[];
    approvalPin: string | null;
    expectedTotal: number | undefined;
    extra: Record<string, unknown>;
    /** The part of this bill an earlier day earned (it ran past that day's end): paid into that day's drawer. */
    late?: LateShare | null;
  },
) {
  const now = ctx.clock.now();
  const policy = branch.settings.checkout;
  const totals: CheckoutTotals = computeCheckout({
    timeCharge: args.time?.total ?? 0,
    items: args.items,
    discount: args.discount,
    cashRounding: policy.cashRounding,
    paid: args.paid,
  });
  if (args.expectedTotal !== undefined && args.expectedTotal !== totals.total) {
    throw new DomainError('bill_changed', 'The bill changed since it was shown; please review it again', { totals });
  }

  const pct = discountPercentOf(args.discount, totals.subtotal);
  const refund = totals.due < 0 ? -totals.due : 0;
  const needsApproval = pct > policy.maxCashierDiscountPercent + 1e-9 || refund > policy.refundApprovalAbove;
  if (totals.discountAmount > 0 && !args.discountReason) {
    throw new DomainError('discount_reason_required', 'Give a reason for the discount');
  }
  const approvedBy = await resolveApproval(
    tx,
    actor,
    needsApproval,
    args.approvalPin,
    refund > 0 ? `refund ${refund}` : `discount ${pct.toFixed(1)}%`,
  );

  validatePayments(totals.due, args.payments);
  const shift = args.payments.length > 0 ? await requireOpenShift(tx, branch.id) : await openShift(tx, branch.id);
  const day = await currentDay(tx, branch, now);

  const [seq] = await tx
    .update(branches)
    .set({ billSeq: sql`${branches.billSeq} + 1` })
    .where(eq(branches.id, branch.id))
    .returning({ number: branches.billSeq });

  const billId = newId();
  await tx.insert(bills).values({
    id: billId,
    branchId: branch.id,
    number: seq!.number,
    businessDay: day,
    sessionId: args.sessionId,
    shiftId: shift?.id ?? null,
    timeCharge: totals.timeCharge,
    itemsTotal: totals.itemsTotal,
    discountAmount: totals.discountAmount,
    discountReason: args.discountReason,
    rounding: totals.rounding,
    total: totals.total,
    paid: totals.total,
    status: 'paid',
    breakdown: {
      time: args.time,
      items: args.items,
      totals,
      discount: args.discount,
      payments: args.payments,
      ...args.extra,
    },
    createdBy: actor.id,
    approvedBy,
  });

  // A session that ran past an earlier day's end: what that day earned (and was not paid yet) goes
  // to the shift that closed then — the new shift only takes its own part.
  let toOld = args.late && totals.due > 0 ? Math.min(args.late.amount, totals.due) : 0;
  const lateParts: { method: 'cash' | 'card'; amount: number }[] = [];
  const rows: (typeof payments.$inferInsert)[] = [];
  for (const p of args.payments) {
    const base = { branchId: branch.id, billId, sessionId: args.sessionId, method: p.method, createdBy: actor.id };
    if (p.amount > 0 && toOld > 0 && args.late) {
      const part = Math.min(p.amount, toOld);
      toOld -= part;
      lateParts.push({ method: p.method, amount: part });
      rows.push({ ...base, id: newId(), businessDay: args.late.day, shiftId: args.late.shiftId, kind: 'payment', amount: part, note: AFTER_DAY_END, approvedBy: null });
      if (p.amount > part) rows.push({ ...base, id: newId(), businessDay: day, shiftId: shift!.id, kind: 'payment', amount: p.amount - part, approvedBy: null });
      continue;
    }
    rows.push({ ...base, id: newId(), businessDay: day, shiftId: shift!.id, kind: p.amount < 0 ? 'refund' : 'payment', amount: p.amount, approvedBy: p.amount < 0 ? approvedBy : null });
  }
  if (rows.length) await tx.insert(payments).values(rows);
  const lateCash = lateParts.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0);
  if (args.late && lateCash > 0) {
    // The old drawer was closed with what it held then; it now also holds this.
    await tx
      .update(shifts)
      .set({ expectedCash: sql`coalesce(${shifts.expectedCash}, 0) + ${lateCash}` })
      .where(eq(shifts.id, args.late.shiftId));
  }

  // Money taken earlier (prepaid time, reservation deposit) now belongs to this bill.
  if (args.sessionId) {
    const conds = [eq(payments.sessionId, args.sessionId)];
    if (args.reservationId) conds.push(and(eq(payments.reservationId, args.reservationId), eq(payments.kind, 'deposit'))!);
    await tx
      .update(payments)
      .set({ billId })
      .where(and(isNull(payments.billId), or(...conds)));
  }

  if (args.orderIds.length) {
    await tx
      .update(orders)
      .set({ status: 'billed', billId, updatedAt: new Date(now) })
      .where(and(inArray(orders.id, args.orderIds), eq(orders.status, 'open')));
  }

  await record({
    type: 'bill.paid',
    entity: 'bill',
    entityId: billId,
    payload: { number: seq!.number, total: totals.total, due: totals.due, sessionId: args.sessionId, payments: args.payments },
    approvedBy,
    reason: args.discountReason,
  });

  const lateTotal = lateParts.reduce((a, p) => a + p.amount, 0);
  return {
    billId,
    number: seq!.number,
    totals,
    late: args.late && lateTotal > 0 ? { amount: lateTotal, cash: lateCash, shiftId: args.late.shiftId, userName: args.late.userName, closedAt: args.late.closedAt } : null,
  };
}


interface LateShare {
  amount: number;
  shiftId: string;
  day: string;
  userName: string;
  closedAt: number | null;
}

/**
 * What an earlier day earned on this session and still waits to be paid, and the drawer it goes to:
 * the shift that closed by itself at that day's end, as long as nobody has counted it yet.
 */
async function lateShareFor(tx: Q, s: typeof sessions.$inferSelect, today: string): Promise<LateShare | null> {
  const carried = (await carriedSoFar(tx, [s.id])).get(s.id);
  const earned = carried ? carried.time + carried.items : 0;
  if (earned <= 0) return null;
  const [last] = await tx
    .select({ day: dayCarries.businessDay })
    .from(dayCarries)
    .where(eq(dayCarries.sessionId, s.id))
    .orderBy(desc(dayCarries.businessDay))
    .limit(1);
  if (!last) return null;
  // Already paid before today (prepaid while playing, the booking's deposit): it is in the old drawers.
  const conds = [eq(payments.sessionId, s.id)];
  if (s.reservationId) conds.push(and(eq(payments.reservationId, s.reservationId), eq(payments.kind, 'deposit'))!);
  const earlier = await tx
    .select({ amount: payments.amount })
    .from(payments)
    .where(and(or(...conds), lt(payments.businessDay, today)));
  const owed = earned - earlier.reduce((a, p) => a + p.amount, 0);
  if (owed <= 0) return null;
  const [drawer] = await tx
    .select({ id: shifts.id, closedAt: shifts.closedAt, userName: users.name })
    .from(shifts)
    .leftJoin(users, eq(users.id, shifts.userId))
    .where(and(eq(shifts.branchId, s.branchId), eq(shifts.businessDay, last.day), eq(shifts.status, 'closed'), isNull(shifts.closedBy), isNull(shifts.countedCash)))
    .orderBy(desc(shifts.closedAt))
    .limit(1);
  if (!drawer) return null;
  return { amount: owed, shiftId: drawer.id, day: last.day, userName: drawer.userName ?? '', closedAt: drawer.closedAt?.getTime() ?? null };
}

export async function checkoutSession(ctx: AppContext, actor: Actor, sessionId: string, raw: unknown) {
  const input = checkoutSessionInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    let s = await getSession(tx, branch.id, sessionId);
    if (s.status !== 'running' && s.status !== 'ended') throw new DomainError('session_closed', 'Session is already closed');

    // "End & pay" in one step.
    if (s.status === 'running') {
      await tx
        .update(segments)
        .set({ endedAt: new Date(now) })
        .where(and(eq(segments.sessionId, s.id), isNull(segments.endedAt)));
      await tx.update(sessions).set({ status: 'ended', endedAt: new Date(now), updatedAt: new Date(now) }).where(eq(sessions.id, s.id));
      s = { ...s, status: 'ended', endedAt: new Date(now) };
      await record({ type: 'session.ended', entity: 'session', entityId: s.id, payload: { viaCheckout: true } });
      await returnStationControllers(tx, record, branch, s.stationId, now, s.id);
    }

    const bctx = await loadBillingContext(tx, branch);
    const segs = (await loadSegments(tx, [s.id])).get(s.id) ?? [];
    const time = computeTimeBill(toTimeline(s, segs), bctx, s.endedAt!.getTime());
    if (time.missingRate) throw new DomainError('missing_rate', 'A station has no price configured for part of this session');

    const items = await sessionItems(tx, s.id);
    const orderIds = [...new Set(items.map((i) => i.orderId))];
    const [st] = await tx.select({ name: stations.name }).from(stations).where(eq(stations.id, s.stationId));
    const paid = await sessionPaidByMethod(tx, s);
    const late = await lateShareFor(tx, s, await currentDay(tx, branch, now));

    const result = await finalize(tx, record, ctx, actor, branch, {
      late,
      sessionId: s.id,
      reservationId: s.reservationId,
      time,
      items,
      orderIds,
      paid: paid.total,
      discount: input.discount ?? null,
      discountReason: input.discountReason ?? null,
      payments: input.payments,
      approvalPin: input.approvalPin ?? null,
      expectedTotal: input.expectedTotal,
      extra: {
        label: s.label,
        stationName: st?.name ?? null,
        startedAt: s.startedAt.getTime(),
        endedAt: s.endedAt!.getTime(),
        prepaidByMethod: paid.byMethod,
      },
    });

    await tx
      .update(sessions)
      .set({ status: 'closed', closedAt: new Date(now), billId: result.billId, updatedAt: new Date(now) })
      .where(eq(sessions.id, s.id));
    if (s.reservationId) {
      await tx.update(reservations).set({ status: 'completed', updatedAt: new Date(now) }).where(eq(reservations.id, s.reservationId));
    }
    return result;
  });
}

export const counterSaleInput = z.object({
  items: orderItemsInput,
  /** Optional name on the receipt ("Ahmad", "table 2"). */
  label: z.string().trim().max(80).nullish(),
  ...baseCheckout,
});

/**
 * A cafeteria sale: drinks and snacks for someone who is not on a station, paid on the spot. One
 * step — the items leave the stock, one bill is made and the money goes into the open shift's drawer.
 */
export async function counterSale(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = counterSaleInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    // Before touching the stock: no drawer, no sale.
    if (input.payments.length > 0) await requireOpenShift(tx, branch.id);
    const order = await insertOrder(tx, record, branch, actor, { sessionId: null, label: input.label ?? null, items: input.items }, now);
    const items: ItemLine[] = await tx
      .select({ id: orderItems.id, orderId: orderItems.orderId, name: orderItems.name, unitPrice: orderItems.unitPrice, qty: orderItems.qty, voided: orderItems.voided })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    const result = await finalize(tx, record, ctx, actor, branch, {
      sessionId: null,
      reservationId: null,
      time: null,
      items,
      orderIds: [order.id],
      paid: 0,
      discount: input.discount ?? null,
      discountReason: input.discountReason ?? null,
      payments: input.payments,
      approvalPin: input.approvalPin ?? null,
      expectedTotal: input.expectedTotal,
      extra: { counter: true, label: input.label ?? null, startedAt: now, endedAt: now },
    });
    return { ...result, stock: order.stock };
  });
}

export async function getBill(q: Q, branchId: string, id: string) {
  const [b] = await q.select().from(bills).where(and(eq(bills.id, id), eq(bills.branchId, branchId)));
  if (!b) throw notFound('bill');
  return b;
}
