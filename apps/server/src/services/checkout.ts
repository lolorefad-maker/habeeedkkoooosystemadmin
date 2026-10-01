import {
  DomainError,
  computeCheckout,
  computeTimeBill,
  discountPercentOf,
  type CheckoutTotals,
  type DiscountInput,
  type TimeBill,
} from '@lounge/core';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext, type Record_ } from '../context';
import type { Q, Tx } from '../db';
import { bills, branches, orders, payments, reservations, segments, sessions, stations } from '../db/schema';
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
import { returnStationControllers } from './controllers';
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

  if (args.payments.length) {
    await tx.insert(payments).values(
      args.payments.map((p) => ({
        id: newId(),
        branchId: branch.id,
        businessDay: day,
        shiftId: shift!.id,
        billId,
        sessionId: args.sessionId,
        method: p.method,
        kind: p.amount < 0 ? ('refund' as const) : ('payment' as const),
        amount: p.amount,
        createdBy: actor.id,
        approvedBy: p.amount < 0 ? approvedBy : null,
      })),
    );
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

  return { billId, number: seq!.number, totals };
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

    const result = await finalize(tx, record, ctx, actor, branch, {
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

export async function getBill(q: Q, branchId: string, id: string) {
  const [b] = await q.select().from(bills).where(and(eq(bills.id, id), eq(bills.branchId, branchId)));
  if (!b) throw notFound('bill');
  return b;
}
