import { DomainError } from '@lounge/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext, type Record_ } from '../context';
import type { Q } from '../db';
import { payments, shifts, users } from '../db/schema';
import type { Actor } from '../lib/auth';
import { newId } from '../lib/ids';
import { currentDay, getBranch, openShift } from './common';

export const openShiftInput = z.object({ openingFloat: z.number().int().min(0) });
export const closeShiftInput = z.object({
  countedCash: z.number().int().min(0),
  note: z.string().trim().max(300).nullish(),
});

/** Cash the drawer should hold: opening float + every cash movement during the shift. */
export async function shiftSummary(q: Q, shiftId: string) {
  const [s] = await q.select().from(shifts).where(eq(shifts.id, shiftId));
  if (!s) return null;
  const rows = await q.select().from(payments).where(eq(payments.shiftId, shiftId));
  const byMethod: Record<string, number> = { cash: 0, card: 0, wallet: 0 };
  let refunds = 0;
  for (const p of rows) {
    byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    if (p.amount < 0) refunds += -p.amount;
  }
  const [u] = await q.select({ name: users.name }).from(users).where(eq(users.id, s.userId));
  return {
    ...s,
    userName: u?.name ?? '',
    byMethod,
    refunds,
    transactions: rows.length,
    expectedCash: s.openingFloat + (byMethod.cash ?? 0),
  };
}

export async function currentShift(q: Q, branchId: string) {
  const s = await openShift(q, branchId);
  return s ? shiftSummary(q, s.id) : null;
}

export async function startShift(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = openShiftInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    if (await openShift(tx, branch.id)) throw new DomainError('shift_already_open', 'A shift is already open');
    const id = newId();
    await tx.insert(shifts).values({
      id,
      branchId: branch.id,
      userId: actor.id,
      businessDay: await currentDay(tx, branch, now),
      status: 'open',
      openedAt: new Date(now),
      openingFloat: input.openingFloat,
    });
    await record({ type: 'shift.opened', entity: 'shift', entityId: id, payload: { openingFloat: input.openingFloat } });
    return { id };
  });
}

export async function endShift(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = closeShiftInput.parse(raw);
  return mutate(ctx, actor, (tx, record) => closeOpenShift(tx, record, actor, input, ctx.clock.now()));
}

/** Count the drawer and close the open shift, inside the caller's transaction (also used by "end the day"). */
export async function closeOpenShift(tx: Q, record: Record_, actor: Actor, input: z.infer<typeof closeShiftInput>, now: number) {
  const s = await openShift(tx, actor.branchId);
  if (!s) throw new DomainError('no_open_shift', 'No shift is open');
  const summary = (await shiftSummary(tx, s.id))!;
  const variance = input.countedCash - summary.expectedCash;
  await tx
    .update(shifts)
    .set({
      status: 'closed',
      closedAt: new Date(now),
      closedBy: actor.id,
      expectedCash: summary.expectedCash,
      countedCash: input.countedCash,
      variance,
      note: input.note ?? null,
    })
    .where(and(eq(shifts.id, s.id), eq(shifts.status, 'open')));
  await record({
    type: 'shift.closed',
    entity: 'shift',
    entityId: s.id,
    payload: { expectedCash: summary.expectedCash, countedCash: input.countedCash, variance },
    reason: input.note ?? null,
  });
  return { id: s.id, expectedCash: summary.expectedCash, countedCash: input.countedCash, variance };
}
