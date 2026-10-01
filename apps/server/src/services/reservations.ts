import {
  DomainError,
  MINUTE,
  evaluateCancellation,
  isNoShow,
  noShowOutcome,
  overlaps,
} from '@lounge/core';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import { payments, reservations } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { currentDay, getBranch, requireOpenShift, type Branch } from './common';
import { assertUsable, getStation } from './stations';

export const createReservationInput = z.object({
  stationId: z.uuid(),
  startAt: z.number().int(),
  minutes: z.number().int().min(15).max(24 * 60),
  mode: z.string().min(1).max(40),
  customerName: z.string().trim().min(1).max(80),
  customerPhone: z.string().trim().max(30).nullish(),
  deposit: z.object({ amount: z.number().int().min(1), method: z.enum(['cash', 'card']) }).nullish(),
  note: z.string().trim().max(300).nullish(),
});

export const cancelReservationInput = z.object({
  refundMethod: z.enum(['cash', 'card']).default('cash'),
  reason: z.string().trim().max(200).nullish(),
});

export const refundReservationInput = z.object({
  method: z.enum(['cash', 'card']).default('cash'),
});

type ReservationRow = typeof reservations.$inferSelect;

const like = (r: ReservationRow) => ({
  startAt: r.startAt.getTime(),
  minutes: r.minutes,
  deposit: r.deposit,
  status: r.status,
});

async function getReservation(q: Q, branchId: string, id: string) {
  const [r] = await q.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.branchId, branchId)));
  if (!r) throw notFound('reservation');
  return r;
}

export async function createReservation(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = createReservationInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const station = await getStation(tx, branch.id, input.stationId);
    assertUsable(station, input.mode);
    if (input.startAt < now - 5 * MINUTE) throw new DomainError('reservation_in_past', 'Reservation time is in the past');

    const sameStation = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.stationId, station.id),
          inArray(reservations.status, ['confirmed', 'checked_in']),
          gte(reservations.startAt, new Date(input.startAt - 24 * 60 * MINUTE)),
          lt(reservations.startAt, new Date(input.startAt + input.minutes * MINUTE)),
        ),
      );
    const clash = sameStation.find((r) => overlaps(r.startAt.getTime(), r.minutes, input.startAt, input.minutes));
    if (clash) {
      throw new DomainError('reservation_conflict', 'Station is already booked at that time', {
        reservationId: clash.id,
        customerName: clash.customerName,
        startAt: clash.startAt.getTime(),
      });
    }

    const id = newId();
    await tx.insert(reservations).values({
      id,
      branchId: branch.id,
      stationId: station.id,
      customerName: input.customerName,
      customerPhone: input.customerPhone ?? null,
      startAt: new Date(input.startAt),
      minutes: input.minutes,
      mode: input.mode,
      deposit: input.deposit?.amount ?? 0,
      status: 'confirmed',
      note: input.note ?? null,
      createdBy: actor.id,
    });

    if (input.deposit) {
      const shift = await requireOpenShift(tx, branch.id);
      await tx.insert(payments).values({
        id: newId(),
        branchId: branch.id,
        businessDay: await currentDay(tx, branch, now),
        shiftId: shift.id,
        reservationId: id,
        method: input.deposit.method,
        kind: 'deposit',
        amount: input.deposit.amount,
        createdBy: actor.id,
      });
    }

    await record({
      type: 'reservation.created',
      entity: 'reservation',
      entityId: id,
      payload: { stationId: station.id, startAt: input.startAt, minutes: input.minutes, deposit: input.deposit?.amount ?? 0 },
    });
    return { id };
  });
}

async function refundDeposit(
  tx: Q,
  branch: Branch,
  actor: Actor,
  r: ReservationRow,
  amount: number,
  method: 'cash' | 'card',
  now: number,
) {
  if (amount <= 0) return;
  const shift = await requireOpenShift(tx, branch.id);
  await tx.insert(payments).values({
    id: newId(),
    branchId: branch.id,
    businessDay: await currentDay(tx, branch, now),
    shiftId: shift.id,
    reservationId: r.id,
    method,
    kind: 'refund',
    amount: -amount,
    createdBy: actor.id,
  });
}

/** Cancel per policy: free before the window, otherwise part of the deposit is kept. */
export async function cancelReservation(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = cancelReservationInput.parse(raw ?? {});
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const r = await getReservation(tx, branch.id, id);
    if (r.status !== 'confirmed') throw new DomainError('reservation_not_confirmed', 'Only a confirmed reservation can be cancelled');
    const outcome = evaluateCancellation(like(r), now, branch.settings.reservations);
    await refundDeposit(tx, branch, actor, r, outcome.refund, input.refundMethod, now);
    await tx
      .update(reservations)
      .set({ status: 'cancelled', fee: outcome.fee, refunded: outcome.refund, cancelledAt: new Date(now), updatedAt: new Date(now) })
      .where(eq(reservations.id, id));
    await record({
      type: 'reservation.cancelled',
      entity: 'reservation',
      entityId: id,
      payload: { ...outcome },
      reason: input.reason ?? null,
    });
    return { id, ...outcome };
  });
}

/** Give back whatever part of a no-show / cancelled deposit the policy says the customer is owed. */
export async function refundReservation(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = refundReservationInput.parse(raw ?? {});
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const r = await getReservation(tx, branch.id, id);
    if (r.status !== 'no_show' && r.status !== 'cancelled') throw new DomainError('not_refundable', 'Nothing to refund');
    const owed = r.deposit - r.fee - r.refunded;
    if (owed <= 0) throw new DomainError('not_refundable', 'Nothing to refund');
    await refundDeposit(tx, branch, actor, r, owed, input.method, now);
    await tx.update(reservations).set({ refunded: r.refunded + owed, updatedAt: new Date(now) }).where(eq(reservations.id, id));
    await record({ type: 'reservation.refunded', entity: 'reservation', entityId: id, payload: { amount: owed } });
    return { id, refunded: owed };
  });
}

export async function listReservations(q: Q, branchId: string, from: number, to: number) {
  return q
    .select()
    .from(reservations)
    .where(and(eq(reservations.branchId, branchId), gte(reservations.startAt, new Date(from)), lt(reservations.startAt, new Date(to))))
    .orderBy(asc(reservations.startAt));
}

/** Scheduler: turn late, un-checked-in reservations into no-shows and release their stations. */
export async function sweepNoShows(ctx: AppContext, branchId: string) {
  const now = ctx.clock.now();
  const branch = await getBranch(ctx.db, branchId);
  const due = (
    await ctx.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.branchId, branchId), eq(reservations.status, 'confirmed'), lt(reservations.startAt, new Date(now))))
  ).filter((r) => isNoShow(like(r), now, branch.settings.reservations));

  for (const r of due) {
    await mutate(ctx, { id: null, branchId }, async (tx, record) => {
      const outcome = noShowOutcome(like(r), branch.settings.reservations);
      await tx
        .update(reservations)
        .set({ status: 'no_show', fee: outcome.fee, updatedAt: new Date(now) })
        .where(and(eq(reservations.id, r.id), eq(reservations.status, 'confirmed')));
      await record({ type: 'reservation.no_show', entity: 'reservation', entityId: r.id, payload: { ...outcome } });
    });
  }
  return due.length;
}
