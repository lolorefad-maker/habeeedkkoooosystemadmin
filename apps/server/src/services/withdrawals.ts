import { DomainError } from '@lounge/core';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import { cashWithdrawals, users } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { requireOpenShift } from './common';
import { archivedDays } from './ledger';
import { shiftSummary } from './shifts';

export const withdrawalInput = z.object({
  amount: z.number().int().min(1),
  /** Who took it / what for ("the accountant"). */
  note: z.string().trim().max(200).nullish(),
});

/** The accountant takes cash out of the open drawer: the shift stays open and the day's income does not change. */
export async function createWithdrawal(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = withdrawalInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const shift = await requireOpenShift(tx, actor.branchId);
    const summary = (await shiftSummary(tx, shift.id))!;
    if (input.amount > summary.expectedCash) {
      throw new DomainError('withdrawal_too_large', 'The drawer does not hold that much', { expectedCash: summary.expectedCash });
    }
    const id = newId();
    await tx.insert(cashWithdrawals).values({
      id,
      branchId: actor.branchId,
      shiftId: shift.id,
      businessDay: shift.businessDay,
      amount: input.amount,
      note: input.note || null,
      createdBy: actor.id,
    });
    await record({ type: 'cash.withdrawn', entity: 'cash_withdrawal', entityId: id, payload: { amount: input.amount, shiftId: shift.id }, reason: input.note ?? null });
    return { id, expectedCash: summary.expectedCash - input.amount };
  });
}

export const voidWithdrawalInput = z.object({ reason: z.string().trim().max(200).nullish() });

/** Taken by mistake: only while its shift is still open (a closed drawer was counted with it). The row stays, marked void. */
export async function voidWithdrawal(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = voidWithdrawalInput.parse(raw ?? {});
  return mutate(ctx, actor, async (tx, record) => {
    const open = await requireOpenShift(tx, actor.branchId);
    const [w] = await tx.select().from(cashWithdrawals).where(and(eq(cashWithdrawals.id, id), eq(cashWithdrawals.branchId, actor.branchId)));
    if (!w) throw notFound('withdrawal');
    if (w.status === 'void') throw new DomainError('withdrawal_void', 'This withdrawal was already cancelled');
    if (w.shiftId !== open.id) throw new DomainError('withdrawal_shift_closed', 'That shift is closed, its drawer was counted with this withdrawal');
    await tx.update(cashWithdrawals).set({ status: 'void', voidReason: input.reason || null }).where(eq(cashWithdrawals.id, id));
    await record({ type: 'cash.withdrawal_voided', entity: 'cash_withdrawal', entityId: id, payload: { amount: w.amount }, reason: input.reason ?? null });
    return { id };
  });
}

/** What the accountant took on a business day, for the ledger. */
export async function listWithdrawals(q: Q, branchId: string, day: string) {
  if ((await archivedDays(q, branchId)).has(day)) return [];
  const rows = await q
    .select({
      id: cashWithdrawals.id,
      amount: cashWithdrawals.amount,
      note: cashWithdrawals.note,
      status: cashWithdrawals.status,
      createdAt: cashWithdrawals.createdAt,
      userName: users.name,
    })
    .from(cashWithdrawals)
    .leftJoin(users, eq(users.id, cashWithdrawals.createdBy))
    .where(and(eq(cashWithdrawals.branchId, branchId), eq(cashWithdrawals.businessDay, day), eq(cashWithdrawals.status, 'active')))
    .orderBy(asc(cashWithdrawals.createdAt));
  return rows.map((r) => ({ ...r, userName: r.userName ?? '', createdAt: r.createdAt.getTime() }));
}
