import { DomainError } from '@lounge/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext, type Record_ } from '../context';
import type { Q } from '../db';
import { payments, shifts, users } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { currentDay, getBranch, openShift } from './common';
import { archivedDays } from './ledger';

export const openShiftInput = z.object({ openingFloat: z.number().int().min(0) });
function closeShiftInputBase() {
  return z.object({
    countedCash: z.number().int().min(0),
    note: z.string().trim().max(300).nullish(),
  });
}
export const closeShiftInput = closeShiftInputBase();

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

/** Shifts the day's end closed by itself whose drawer nobody has counted yet (newest first). */
export async function uncountedShifts(q: Q, branchId: string) {
  const rows = await q
    .select({ id: shifts.id, userId: shifts.userId, businessDay: shifts.businessDay, closedAt: shifts.closedAt, expectedCash: shifts.expectedCash, userName: users.name })
    .from(shifts)
    .leftJoin(users, eq(users.id, shifts.userId))
    .where(and(eq(shifts.branchId, branchId), eq(shifts.status, 'closed'), isNull(shifts.countedCash), isNull(shifts.closedBy)))
    .orderBy(desc(shifts.closedAt))
    .limit(5);
  const hidden = await archivedDays(q, branchId);
  return rows.filter((r) => !hidden.has(r.businessDay)).map((r) => ({ id: r.id, userName: r.userName ?? '', businessDay: r.businessDay, closedAt: r.closedAt?.getTime() ?? null, expectedCash: r.expectedCash ?? 0 }));
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

/**
 * The day ended by itself (midnight) with a shift open: close it without a count — nobody was asked
 * to count — and open the new day's shift from zero. The old shift's cash is its own: count it later
 * with `countClosedShift` (the ledger shows "count the drawer" next to it).
 */
export async function rollShiftAtDayEnd(tx: Q, record: Record_, branchId: string, nextDay: string, now: number) {
  const s = await openShift(tx, branchId);
  if (!s) return null;
  const summary = (await shiftSummary(tx, s.id))!;
  await tx
    .update(shifts)
    .set({ status: 'closed', closedAt: new Date(now), closedBy: null, expectedCash: summary.expectedCash, countedCash: null, variance: null })
    .where(and(eq(shifts.id, s.id), eq(shifts.status, 'open')));
  await record({ type: 'shift.closed', entity: 'shift', entityId: s.id, payload: { expectedCash: summary.expectedCash, auto: true } });
  const id = newId();
  await tx.insert(shifts).values({
    id,
    branchId,
    userId: s.userId,
    businessDay: nextDay,
    status: 'open',
    openedAt: new Date(now),
    openingFloat: 0,
  });
  await record({ type: 'shift.opened', entity: 'shift', entityId: id, payload: { openingFloat: 0, auto: true, after: s.id } });
  return { closed: s.id, opened: id };
}

export const countShiftInput = closeShiftInputBase();

/**
 * Count, afterwards, the drawer of a shift that closed by itself at the day's end ("we counted the
 * old shift's cash: 34.500"). Once only — a shift counted by hand cannot be recounted here.
 */
export async function countClosedShift(ctx: AppContext, actor: Actor, shiftId: string, raw: unknown) {
  const input = countShiftInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const [s] = await tx.select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.branchId, actor.branchId)));
    if (!s) throw notFound('shift');
    if (s.status !== 'closed') throw new DomainError('shift_not_closed', 'This shift is still open — close it with a count instead');
    if (s.countedCash != null) throw new DomainError('shift_already_counted', 'This shift was already counted');
    const expected = s.expectedCash ?? (await shiftSummary(tx, s.id))!.expectedCash;
    const variance = input.countedCash - expected;
    await tx
      .update(shifts)
      .set({ countedCash: input.countedCash, variance, expectedCash: expected, note: input.note ?? s.note })
      .where(and(eq(shifts.id, s.id), isNull(shifts.countedCash)));
    await record({ type: 'shift.counted', entity: 'shift', entityId: s.id, payload: { expectedCash: expected, countedCash: input.countedCash, variance }, reason: input.note ?? null });
    return { id: s.id, expectedCash: expected, countedCash: input.countedCash, variance };
  });
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
