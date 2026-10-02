import {
  DomainError,
  computeCheckout,
  computeTimeBill,
  planAction,
  type SessionAction,
} from '@lounge/core';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import { orderItems, orders, packages, payments, reservations, segments, sessions } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  currentDay,
  getBranch,
  getSession,
  loadBillingContext,
  loadSegments,
  requireOpenShift,
  resolveApproval,
  sessionPaid,
  sessionPaidByMethod,
  toTimeline,
  type Branch,
  type SessionRow,
} from './common';
import { handOverControllers, moveStationControllers, returnStationControllers } from './controllers';
import { insertOrder } from './orders';
import { assertFree, assertUsable, getStation, holdingReservation } from './stations';
import { reverseCarries } from './carries';
import { customerForPhone } from './rewards';

export const startSessionInput = z.object({
  stationId: z.uuid(),
  mode: z.string().min(1).max(40),
  kind: z.enum(['open', 'fixed']),
  plannedMinutes: z.number().int().min(1).max(24 * 60).nullish(),
  packageId: z.uuid().nullish(),
  label: z.string().trim().max(80).nullish(),
  /** The customer's phone number: it earns them a free hour after a long session (see rewards). */
  customerPhone: z.string().trim().max(30).nullish(),
  reservationId: z.uuid().nullish(),
  /** Start even though another customer's reservation is holding the station. */
  overrideReservation: z.boolean().optional(),
  /** Paid up front (any session kind): how much and how (cash / visa). */
  prepaid: z.object({ amount: z.number().int().min(1), method: z.enum(['cash', 'card']) }).nullish(),
  /** Numbered controllers handed to the customer. */
  controllerIds: z.array(z.uuid()).max(8).default([]),
  /** Drinks / food ordered together with the device. */
  items: z
    .array(z.object({ productId: z.uuid(), qty: z.number().int().min(1).max(99) }))
    .max(50)
    .default([]),
});

export const sessionPaymentInput = z.object({
  amount: z.number().int().min(1),
  method: z.enum(['cash', 'card']),
});

export const sessionActionInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('mode'), mode: z.string().min(1).max(40) }),
  z.object({ type: z.literal('transfer'), stationId: z.uuid() }),
]);

export const setPlanInput = z.object({
  /** null → switch to open time. */
  plannedMinutes: z.number().int().min(1).max(24 * 60).nullable(),
});

export const voidSessionInput = z.object({
  reason: z.string().trim().min(3).max(200),
  approvalPin: z.string().nullish(),
});

export async function startSession(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = startSessionInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const station = await getStation(tx, branch.id, input.stationId);
    assertUsable(station, input.mode);
    await assertFree(tx, station.id);

    const hold = await holdingReservation(tx, branch, station.id, now);
    if (hold && hold.id !== input.reservationId && !input.overrideReservation) {
      throw new DomainError('station_reserved', 'Station is held for a reservation', {
        reservationId: hold.id,
        customerName: hold.customerName,
        startAt: hold.startAt.getTime(),
      });
    }

    let kind = input.kind;
    let plannedMinutes = input.kind === 'fixed' ? (input.plannedMinutes ?? null) : null;
    if (input.packageId) {
      const [pkg] = await tx.select().from(packages).where(and(eq(packages.id, input.packageId), eq(packages.branchId, branch.id)));
      if (!pkg || !pkg.active) throw notFound('package');
      kind = 'fixed';
      plannedMinutes = pkg.minutes;
    }
    if (kind === 'fixed' && !plannedMinutes) throw new DomainError('planned_minutes_required', 'Fixed sessions need a duration');

    let reservation: typeof reservations.$inferSelect | undefined;
    if (input.reservationId) {
      [reservation] = await tx
        .select()
        .from(reservations)
        .where(and(eq(reservations.id, input.reservationId), eq(reservations.branchId, branch.id)));
      if (!reservation) throw notFound('reservation');
      if (reservation.status !== 'confirmed') throw new DomainError('reservation_not_confirmed', 'Reservation is not active');
    }

    // The number typed now, or the one given when booking.
    const customer = await customerForPhone(tx, branch, {
      phone: input.customerPhone || reservation?.customerPhone,
      name: input.label || reservation?.customerName,
      strict: !!input.customerPhone,
    });

    const id = newId();
    await tx.insert(sessions).values({
      id,
      branchId: branch.id,
      kind,
      plannedMinutes,
      packageId: input.packageId ?? null,
      customerId: customer?.id ?? reservation?.customerId ?? null,
      label: input.label || reservation?.customerName || null,
      status: 'running',
      stationId: station.id,
      reservationId: reservation?.id ?? null,
      startedAt: new Date(now),
      createdBy: actor.id,
    });
    await tx.insert(segments).values({
      id: newId(),
      sessionId: id,
      stationId: station.id,
      mode: input.mode,
      paused: false,
      startedAt: new Date(now),
    });

    await handOverControllers(tx, record, branch.id, station.id, input.controllerIds, now, id);
    const order = input.items.length ? await insertOrder(tx, record, branch, actor, { sessionId: id, items: input.items }, now) : null;

    if (reservation) {
      await tx
        .update(reservations)
        .set({ status: 'checked_in', sessionId: id, updatedAt: new Date(now) })
        .where(eq(reservations.id, reservation.id));
      await record({ type: 'reservation.checked_in', entity: 'reservation', entityId: reservation.id, payload: { sessionId: id } });
    }

    if (input.prepaid) {
      const shift = await requireOpenShift(tx, branch.id);
      await tx.insert(payments).values({
        id: newId(),
        branchId: branch.id,
        businessDay: await currentDay(tx, branch, now),
        shiftId: shift.id,
        sessionId: id,
        method: input.prepaid.method,
        kind: 'prepaid',
        amount: input.prepaid.amount,
        createdBy: actor.id,
      });
    }

    await record({
      type: 'session.started',
      entity: 'session',
      entityId: id,
      payload: { stationId: station.id, mode: input.mode, kind, plannedMinutes, packageId: input.packageId ?? null, prepaid: input.prepaid ?? null, customerId: customer?.id ?? null },
      reason: hold && input.overrideReservation ? 'override_reservation' : null,
    });
    return { id, stock: order?.stock ?? [] };
  });
}

const ACTION_EVENTS: Record<SessionAction['type'], string> = {
  pause: 'session.paused',
  resume: 'session.resumed',
  end: 'session.ended',
  mode: 'session.mode_changed',
  transfer: 'session.transferred',
};

export async function sessionAction(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const action = sessionActionInput.parse(raw) as SessionAction;
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const s = await getSession(tx, actor.branchId, id);
    if (s.status !== 'running') throw new DomainError('session_not_running', 'Session is not running');
    const segs = (await loadSegments(tx, [id])).get(id) ?? [];
    const cur = segs.find((g) => g.endedAt === null);
    if (!cur) throw new DomainError('session_not_running', 'Session is not running');

    const plan = planAction(toTimeline(s, segs).segments, action, now);

    if (action.type === 'transfer') {
      const target = await getStation(tx, actor.branchId, action.stationId);
      assertUsable(target, cur.mode);
      await assertFree(tx, target.id);
    }
    if (action.type === 'mode') {
      assertUsable(await getStation(tx, actor.branchId, cur.stationId), action.mode);
    }

    await tx.update(segments).set({ endedAt: new Date(now) }).where(eq(segments.id, cur.id));
    if (plan.open) {
      await tx.insert(segments).values({
        id: newId(),
        sessionId: id,
        stationId: plan.open.stationId,
        mode: plan.open.mode,
        paused: plan.open.paused,
        startedAt: new Date(now),
      });
    }
    await tx
      .update(sessions)
      .set({
        updatedAt: new Date(now),
        ...(action.type === 'transfer' ? { stationId: action.stationId } : {}),
        ...(action.type === 'end' ? { status: 'ended' as const, endedAt: new Date(now) } : {}),
      })
      .where(eq(sessions.id, id));
    if (action.type === 'transfer') await moveStationControllers(tx, cur.stationId, action.stationId, now);
    if (action.type === 'end') await returnStationControllers(tx, record, await getBranch(tx, actor.branchId), cur.stationId, now, id);

    await record({
      type: ACTION_EVENTS[action.type],
      entity: 'session',
      entityId: id,
      payload: { ...action, fromStationId: cur.stationId, fromMode: cur.mode },
    });
    return { id };
  });
}

/** Extend / shorten a fixed session, or switch between open and fixed time. */
export async function setPlan(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = setPlanInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const s = await getSession(tx, actor.branchId, id);
    if (s.status !== 'running') throw new DomainError('session_not_running', 'Session is not running');
    if (input.plannedMinutes === null && s.packageId) throw new DomainError('package_session', 'A package session cannot become open time');
    await tx
      .update(sessions)
      .set({
        kind: input.plannedMinutes === null ? 'open' : 'fixed',
        plannedMinutes: input.plannedMinutes,
        updatedAt: new Date(ctx.clock.now()),
      })
      .where(eq(sessions.id, id));
    await record({
      type: 'session.plan_changed',
      entity: 'session',
      entityId: id,
      payload: { from: s.plannedMinutes, to: input.plannedMinutes },
    });
    return { id };
  });
}

/** Continue a session that was ended but not yet paid (customer decided to keep playing). */
export async function reopenSession(ctx: AppContext, actor: Actor, id: string) {
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const s = await getSession(tx, actor.branchId, id);
    if (s.status !== 'ended') throw new DomainError('session_not_ended', 'Only an ended, unpaid session can be reopened');
    const segs = (await loadSegments(tx, [id])).get(id) ?? [];
    const last = segs.at(-1);
    const station = await getStation(tx, actor.branchId, s.stationId);
    assertUsable(station, last?.mode);
    await assertFree(tx, station.id);
    await tx.insert(segments).values({
      id: newId(),
      sessionId: id,
      stationId: station.id,
      mode: last?.mode ?? station.modes[0] ?? 'single',
      paused: false,
      startedAt: new Date(now),
    });
    await tx.update(sessions).set({ status: 'running', endedAt: null, updatedAt: new Date(now) }).where(eq(sessions.id, id));
    await record({ type: 'session.reopened', entity: 'session', entityId: id });
    return { id };
  });
}

/** Cancel a session started by mistake. Only when nothing was paid or ordered on it. */
export async function voidSession(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = voidSessionInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const s = await getSession(tx, actor.branchId, id);
    if (s.status !== 'running' && s.status !== 'ended') throw new DomainError('session_closed', 'Session is already closed');
    const approvedBy = await resolveApproval(tx, actor, true, input.approvalPin, 'void session');
    const items = await sessionItems(tx, id);
    if (items.some((i) => !i.voided) || (await sessionPaid(tx, s)) !== 0) {
      throw new DomainError('session_has_charges', 'Session has orders or payments; check it out instead');
    }
    if (s.status === 'running') {
      await tx
        .update(segments)
        .set({ endedAt: new Date(now) })
        .where(and(eq(segments.sessionId, id), isNull(segments.endedAt)));
    }
    await tx.update(sessions).set({ status: 'void', endedAt: s.endedAt ?? new Date(now), updatedAt: new Date(now) }).where(eq(sessions.id, id));
    const branch = await getBranch(tx, actor.branchId);
    // It ran past an earlier day's end and that day counted its share: today gives it back.
    await reverseCarries(tx, branch.id, id, await currentDay(tx, branch, now));
    if (s.status === 'running') await returnStationControllers(tx, record, branch, s.stationId, now, id);
    await record({ type: 'session.voided', entity: 'session', entityId: id, approvedBy, reason: input.reason });
    return { id };
  });
}

/** Money received during the session (e.g. "he paid 2.000 now, the rest at the end"). */
export async function addSessionPayment(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = sessionPaymentInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const s = await getSession(tx, branch.id, id);
    if (s.status !== 'running' && s.status !== 'ended') throw new DomainError('session_closed', 'Session is already closed');
    const shift = await requireOpenShift(tx, branch.id);
    await tx.insert(payments).values({
      id: newId(),
      branchId: branch.id,
      businessDay: await currentDay(tx, branch, now),
      shiftId: shift.id,
      sessionId: id,
      method: input.method,
      kind: 'prepaid',
      amount: input.amount,
      createdBy: actor.id,
    });
    await record({ type: 'session.payment', entity: 'session', entityId: id, payload: { ...input } });
    return { id };
  });
}

export async function sessionItems(q: Q, sessionId: string) {
  return q
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      name: orderItems.name,
      unitPrice: orderItems.unitPrice,
      qty: orderItems.qty,
      voided: orderItems.voided,
      voidReason: orderItems.voidReason,
      createdAt: orderItems.createdAt,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.sessionId, sessionId), eq(orders.status, 'open')))
    .orderBy(orderItems.createdAt);
}

/** Current bill of a session: live for running sessions, final for ended ones. */
export async function sessionBill(q: Q, branch: Branch, s: SessionRow, now: number) {
  const bctx = await loadBillingContext(q, branch);
  const segs = (await loadSegments(q, [s.id])).get(s.id) ?? [];
  const timeline = toTimeline(s, segs);
  const asOf = s.status === 'running' ? now : (s.endedAt?.getTime() ?? now);
  const time = computeTimeBill(timeline, bctx, asOf);
  const items = await sessionItems(q, s.id);
  const { total: paid, byMethod: paidByMethod } = await sessionPaidByMethod(q, s);
  const totals = computeCheckout({
    timeCharge: time.total,
    items,
    discount: null,
    cashRounding: branch.settings.checkout.cashRounding,
    paid,
  });
  return { session: s, timeline, time, items, paid, paidByMethod, totals };
}
