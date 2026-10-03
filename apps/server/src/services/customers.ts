import { DomainError } from '@lounge/core';
import { and, count, eq, isNotNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import { customers, rewards, sessions } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { customerForPhone } from './rewards';
import { getBranch } from './common';

/**
 * The customers' numbers: everyone whose number was typed when a device was opened (or at checkout, or
 * in a booking) lands here by itself; the cashier can also add a number by hand and fix a name.
 */

export async function listCustomers(q: Q, orgId: string, branchId: string) {
  const rows = await q
    .select({ id: customers.id, name: customers.name, phone: customers.phone, notes: customers.notes, createdAt: customers.createdAt })
    .from(customers)
    .where(and(eq(customers.orgId, orgId), isNotNull(customers.phone)));
  const visits = await q
    .select({ customerId: sessions.customerId, visits: count(), last: max(sessions.startedAt) })
    .from(sessions)
    .where(and(eq(sessions.branchId, branchId), isNotNull(sessions.customerId)))
    .groupBy(sessions.customerId);
  const free = await q
    .select({ customerId: rewards.customerId, n: count() })
    .from(rewards)
    .where(and(eq(rewards.branchId, branchId), eq(rewards.status, 'available')))
    .groupBy(rewards.customerId);
  const v = new Map(visits.map((x) => [x.customerId, x]));
  const f = new Map(free.map((x) => [x.customerId, x.n]));
  return rows
    .map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone!,
      notes: c.notes,
      createdAt: c.createdAt.getTime(),
      visits: v.get(c.id)?.visits ?? 0,
      lastVisitAt: v.get(c.id)?.last?.getTime() ?? null,
      freeAvailable: f.get(c.id) ?? 0,
    }))
    .sort((a, b) => (b.lastVisitAt ?? b.createdAt) - (a.lastVisitAt ?? a.createdAt));
}

export const createCustomerInput = z.object({
  phone: z.string().trim().min(1).max(30),
  name: z.string().trim().max(80).nullish(),
  notes: z.string().trim().max(300).nullish(),
});

/** Adds a number by hand. A number that is already there keeps its row (a name given now fills a missing one). */
export async function createCustomer(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = createCustomerInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const branch = await getBranch(tx, actor.branchId);
    const c = await customerForPhone(tx, branch, { phone: input.phone, name: input.name, strict: true });
    if (!c) throw new DomainError('invalid_phone', 'This phone number is not valid');
    if (input.notes) await tx.update(customers).set({ notes: input.notes, updatedAt: new Date(ctx.clock.now()) }).where(eq(customers.id, c.id));
    await record({ type: 'customer.saved', entity: 'customer', entityId: c.id, payload: { phone: c.phone } });
    return c;
  });
}

export const updateCustomerInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  notes: z.string().trim().max(300).nullish(),
});

export async function updateCustomer(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = updateCustomerInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const set: Partial<typeof customers.$inferInsert> = { updatedAt: new Date(ctx.clock.now()) };
    if (input.name !== undefined) set.name = input.name;
    if (input.notes !== undefined) set.notes = input.notes || null;
    const [row] = await tx.update(customers).set(set).where(and(eq(customers.id, id), eq(customers.orgId, actor.orgId))).returning({ id: customers.id });
    if (!row) throw notFound('customer');
    await record({ type: 'customer.updated', entity: 'customer', entityId: id });
    return { id };
  });
}
