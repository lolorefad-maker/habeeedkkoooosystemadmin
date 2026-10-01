import { computeTimeBill, type BillingContext, type SessionTimeline } from '@lounge/core';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Q } from '../db';
import { dayCarries, orderItems, orders, sessions } from '../db/schema';
import { newId } from '../lib/ids';
import { loadBillingContext, loadSegments, toTimeline, type Branch } from './common';

/**
 * Splitting a session across business days ("played 9 pm → 3 am, the 3 hours before midnight are
 * yesterday's income"). When a day closes, every session still open gets a carry row: what it had
 * earned by the day's end that no earlier day already counted. The bill, paid later, is reported on
 * its own day minus those carries. A void writes the negative carry back, so the days always add up
 * to exactly what was billed.
 */

export interface Carry {
  time: number;
  items: number;
  ms: number;
}

const ZERO: Carry = { time: 0, items: 0, ms: 0 };

/** The session as it stood at `asOf`: segments after it dropped, the open one cut there. */
function timelineAsOf(t: SessionTimeline, asOf: number): SessionTimeline {
  return {
    ...t,
    segments: t.segments
      .filter((g) => g.startedAt < asOf)
      .map((g) => ({ ...g, endedAt: g.endedAt == null || g.endedAt > asOf ? asOf : g.endedAt })),
  };
}

/** Everything carried so far, per session. */
export async function carriedSoFar(q: Q, sessionIds: string[]): Promise<Map<string, Carry>> {
  const out = new Map<string, Carry>();
  if (sessionIds.length === 0) return out;
  const rows = await q.select().from(dayCarries).where(inArray(dayCarries.sessionId, sessionIds));
  for (const r of rows) {
    const c = out.get(r.sessionId) ?? { ...ZERO };
    c.time += r.time;
    c.items += r.items;
    c.ms += r.ms;
    out.set(r.sessionId, c);
  }
  return out;
}

/** What one open session had earned by `asOf`: its time charge and the drinks taken before then. */
async function valueAsOf(q: Q, bctx: BillingContext, s: typeof sessions.$inferSelect, segs: Parameters<typeof toTimeline>[1], asOf: number): Promise<Carry> {
  const until = s.status === 'ended' && s.endedAt ? Math.min(s.endedAt.getTime(), asOf) : asOf;
  let time = 0;
  let ms = 0;
  if (s.startedAt.getTime() < until) {
    try {
      const bill = computeTimeBill(timelineAsOf(toTimeline(s, segs), until), bctx, until);
      time = bill.total;
      ms = bill.playedMs;
    } catch {
      /* a misconfigured station must not stop the day from closing — its time goes to the bill's day */
    }
  }
  const rows = await q
    .select({ qty: orderItems.qty, unitPrice: orderItems.unitPrice })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.sessionId, s.id), eq(orders.status, 'open'), eq(orderItems.voided, false), lt(orderItems.createdAt, new Date(asOf))));
  const items = rows.reduce((sum, r) => sum + r.qty * r.unitPrice, 0);
  return { time, items, ms };
}

/** At a day's close: record, for each session still open, its share of the closing day (`day`, up to `asOf`). */
export async function carryOpenSessions(tx: Q, branch: Branch, day: string, asOf: number): Promise<number> {
  const open = await tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.branchId, branch.id), inArray(sessions.status, ['running', 'ended'])));
  if (open.length === 0) return 0;
  const bctx = await loadBillingContext(tx, branch);
  const segs = await loadSegments(tx, open.map((s) => s.id));
  const before = await carriedSoFar(tx, open.map((s) => s.id));
  let n = 0;
  for (const s of open) {
    const now = await valueAsOf(tx, bctx, s, segs.get(s.id) ?? [], asOf);
    const prev = before.get(s.id) ?? ZERO;
    const part = { time: now.time - prev.time, items: now.items - prev.items, ms: now.ms - prev.ms };
    if (part.time === 0 && part.items === 0) continue;
    await tx.insert(dayCarries).values({ id: newId(), branchId: branch.id, sessionId: s.id, businessDay: day, ...part });
    n++;
  }
  return n;
}

/** A voided session earns nothing: give back, on today, whatever earlier days counted for it. */
export async function reverseCarries(tx: Q, branchId: string, sessionId: string, day: string) {
  const prev = (await carriedSoFar(tx, [sessionId])).get(sessionId);
  if (!prev || (prev.time === 0 && prev.items === 0)) return;
  await tx.insert(dayCarries).values({ id: newId(), branchId, sessionId, businessDay: day, time: -prev.time, items: -prev.items, ms: -prev.ms });
}

/** Carries recorded on these business days (earned there, by sessions billed later or voided). */
export async function carriesOnDays(q: Q, branchId: string, days: string[]) {
  if (days.length === 0) return [];
  return q
    .select()
    .from(dayCarries)
    .where(and(eq(dayCarries.branchId, branchId), inArray(dayCarries.businessDay, days)));
}
