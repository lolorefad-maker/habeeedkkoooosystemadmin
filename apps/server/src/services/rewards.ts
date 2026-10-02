import { DomainError, earnsReward, freeTimeValue, normalizePhone, type TimeBill } from '@lounge/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext, type Record_ } from '../context';
import type { Q, Tx } from '../db';
import { customers, rewards } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { getBranch, type Branch, type SessionRow } from './common';

/**
 * Customer rewards ("People Rewards"): a session of more than N hours, registered with a phone number,
 * earns a free hour for that number. The next bill of the same number can take it off (once).
 */

export interface CustomerRef {
  id: string;
  name: string;
  /** Digits with the country code, as WhatsApp wants it. */
  phone: string;
}

/**
 * The customer behind a phone number in this shop, created on first sight. null when no number was
 * given. A number that cannot be a real one is refused when the cashier typed it (`strict`), and
 * ignored when it comes from an old booking.
 */
export async function customerForPhone(
  tx: Tx,
  branch: Branch,
  input: { phone: string | null | undefined; name: string | null | undefined; strict: boolean },
): Promise<CustomerRef | null> {
  if (!input.phone?.trim()) return null;
  const phone = normalizePhone(input.phone, branch.settings.rewards.countryCode);
  if (!phone) {
    if (input.strict) throw new DomainError('invalid_phone', 'This phone number is not valid');
    return null;
  }
  const name = input.name?.trim() || null;
  await tx
    .insert(customers)
    .values({ id: newId(), orgId: branch.orgId, name: name ?? phone, phone })
    .onConflictDoNothing({ target: [customers.orgId, customers.phone] });
  const [c] = await tx
    .select({ id: customers.id, name: customers.name, phone: customers.phone })
    .from(customers)
    .where(and(eq(customers.orgId, branch.orgId), eq(customers.phone, phone)));
  if (!c) throw notFound('customer');
  // A number first seen without a name gets the name the next time it is given.
  if (name && c.name === phone) {
    await tx.update(customers).set({ name, updatedAt: new Date() }).where(eq(customers.id, c.id));
    return { id: c.id, name, phone };
  }
  return { id: c.id, name: c.name, phone };
}

const reasonText = (locale: string, minutes: number) =>
  locale.startsWith('ar') ? `مكافأة: ${minutes} دقيقة مجانية` : `Reward: ${minutes} free minutes`;

/** The oldest free time this customer has not used yet. */
async function oldestAvailable(q: Q, branchId: string, customerId: string) {
  const [r] = await q
    .select()
    .from(rewards)
    .where(and(eq(rewards.branchId, branchId), eq(rewards.customerId, customerId), eq(rewards.status, 'available')))
    .orderBy(asc(rewards.createdAt))
    .limit(1);
  return r;
}

/** What the checkout screen offers: who the customer is and the free time waiting for them, with what it is worth on this bill. */
export async function billCustomer(q: Q, branch: Branch, s: SessionRow, time: TimeBill) {
  if (!s.customerId) return { customer: null, reward: null };
  const [c] = await q.select({ id: customers.id, name: customers.name, phone: customers.phone }).from(customers).where(eq(customers.id, s.customerId));
  if (!c?.phone) return { customer: null, reward: null };
  const r = await oldestAvailable(q, branch.id, c.id);
  const value = r ? freeTimeValue(time.total, time.billableMs, r.minutes) : 0;
  return {
    customer: { id: c.id, name: c.name, phone: c.phone },
    reward: r && value > 0 ? { id: r.id, minutes: r.minutes, value } : null,
  };
}

/** The discount a reward gives on this bill, checked: it is the customer's own, unused, and worth something. */
export async function rewardDiscount(tx: Tx, branch: Branch, s: SessionRow, time: TimeBill, rewardId: string) {
  if (!s.customerId) throw new DomainError('reward_no_customer', 'Register the customer’s phone number to use a reward');
  const [r] = await tx
    .select()
    .from(rewards)
    .where(and(eq(rewards.id, rewardId), eq(rewards.branchId, branch.id), eq(rewards.customerId, s.customerId), eq(rewards.status, 'available')));
  if (!r) throw new DomainError('reward_unavailable', 'This reward is not available');
  const value = freeTimeValue(time.total, time.billableMs, r.minutes);
  if (value <= 0) throw new DomainError('reward_no_value', 'There is no play time to take the free time off');
  return { id: r.id, minutes: r.minutes, value, reason: reasonText(branch.locale, r.minutes) };
}

/** Marks the reward used by this bill. The guard on `status` makes a double use fail (and roll the checkout back). */
export async function useReward(tx: Tx, record: Record_, id: string, billId: string, sessionId: string, now: number) {
  const used = await tx
    .update(rewards)
    .set({ status: 'used', usedAt: new Date(now), usedSessionId: sessionId, usedBillId: billId, updatedAt: new Date(now) })
    .where(and(eq(rewards.id, id), eq(rewards.status, 'available')))
    .returning({ id: rewards.id });
  if (!used.length) throw new DomainError('reward_unavailable', 'This reward was already used');
  await record({ type: 'reward.used', entity: 'reward', entityId: id, payload: { billId, sessionId } });
}

/** A session that played longer than the policy says earns its customer a free time. */
export async function earnReward(tx: Tx, record: Record_, branch: Branch, s: SessionRow, playedMs: number, day: string, now: number) {
  const policy = branch.settings.rewards;
  if (!policy.enabled || !s.customerId || !earnsReward(playedMs, policy.afterMinutes)) return null;
  const id = newId();
  const playedMinutes = Math.floor(playedMs / 60_000);
  const added = await tx
    .insert(rewards)
    .values({ id, branchId: branch.id, customerId: s.customerId, earnedSessionId: s.id, earnedDay: day, minutes: policy.freeMinutes, playedMinutes })
    .onConflictDoNothing({ target: rewards.earnedSessionId })
    .returning({ id: rewards.id });
  if (!added.length) return null;
  const [c] = await tx.select({ name: customers.name, phone: customers.phone }).from(customers).where(eq(customers.id, s.customerId));
  await record({ type: 'reward.earned', entity: 'reward', entityId: id, payload: { customerId: s.customerId, sessionId: s.id, playedMinutes, minutes: policy.freeMinutes } });
  return { id, minutes: policy.freeMinutes, playedMinutes, name: c?.name ?? '', phone: c?.phone ?? '' };
}

export const rewardsQuery = z.object({
  status: z.enum(['available', 'used', 'void', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function listRewards(q: Q, branchId: string, raw: unknown) {
  const input = rewardsQuery.parse(raw);
  const rows = await q
    .select({
      id: rewards.id,
      customerId: rewards.customerId,
      name: customers.name,
      phone: customers.phone,
      minutes: rewards.minutes,
      playedMinutes: rewards.playedMinutes,
      status: rewards.status,
      earnedDay: rewards.earnedDay,
      earnedAt: rewards.createdAt,
      usedAt: rewards.usedAt,
      notifiedAt: rewards.notifiedAt,
      voidReason: rewards.voidReason,
    })
    .from(rewards)
    .innerJoin(customers, eq(customers.id, rewards.customerId))
    .where(and(eq(rewards.branchId, branchId), input.status === 'all' ? undefined : eq(rewards.status, input.status)))
    .orderBy(sql`case when ${rewards.status} = 'available' then 0 else 1 end`, desc(rewards.createdAt))
    .limit(input.limit);
  return rows.map((r) => ({ ...r, earnedAt: r.earnedAt.getTime(), usedAt: r.usedAt?.getTime() ?? null, notifiedAt: r.notifiedAt?.getTime() ?? null }));
}

/** The "who is this?" at the start of a session: the name behind a number and whether free time waits for them. */
export async function lookupCustomer(q: Q, branchId: string, rawPhone: unknown) {
  const branch = await getBranch(q, branchId);
  const phone = normalizePhone(typeof rawPhone === 'string' ? rawPhone : '', branch.settings.rewards.countryCode);
  if (!phone) return null;
  const [c] = await q.select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.orgId, branch.orgId), eq(customers.phone, phone)));
  if (!c) return { phone, name: null, available: 0 };
  const open = await q
    .select({ id: rewards.id })
    .from(rewards)
    .where(and(eq(rewards.branchId, branchId), eq(rewards.customerId, c.id), eq(rewards.status, 'available')));
  return { phone, name: c.name, available: open.length };
}

export async function markRewardNotified(ctx: AppContext, actor: Actor, id: string) {
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const [r] = await tx.update(rewards).set({ notifiedAt: new Date(now), updatedAt: new Date(now) }).where(and(eq(rewards.id, id), eq(rewards.branchId, actor.branchId))).returning({ id: rewards.id });
    if (!r) throw notFound('reward');
    await record({ type: 'reward.notified', entity: 'reward', entityId: id });
    return { id };
  });
}

export const voidRewardInput = z.object({ reason: z.string().trim().min(3).max(200) });

/** A reward given by mistake (a wrong number, a wrong session). Only an unused one can be voided; the row stays. */
export async function voidReward(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = voidRewardInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const [r] = await tx
      .update(rewards)
      .set({ status: 'void', voidReason: input.reason, updatedAt: new Date(now) })
      .where(and(eq(rewards.id, id), eq(rewards.branchId, actor.branchId), eq(rewards.status, 'available')))
      .returning({ id: rewards.id });
    if (!r) throw new DomainError('reward_unavailable', 'Only a reward that is still unused can be voided');
    await record({ type: 'reward.voided', entity: 'reward', entityId: id, reason: input.reason });
    return { id };
  });
}
