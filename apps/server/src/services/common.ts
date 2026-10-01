import {
  DomainError,
  businessDayOf,
  parseBranchSettings,
  pricePackageSchema,
  pricingRuleSchema,
  type BillingContext,
  type BranchSettings,
  type SessionTimeline,
} from '@lounge/core';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { Q } from '../db';
import {
  branches,
  businessDays,
  packages,
  payments,
  pricingRules,
  segments,
  sessions,
  shifts,
  stations,
  users,
} from '../db/schema';
import { isManager, verifyPin, type Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';

export type BranchRow = typeof branches.$inferSelect;
export interface Branch extends Omit<BranchRow, 'settings'> {
  settings: BranchSettings;
}

export async function getBranch(q: Q, branchId: string): Promise<Branch> {
  const [row] = await q.select().from(branches).where(eq(branches.id, branchId));
  if (!row) throw notFound('branch');
  return { ...row, settings: parseBranchSettings(row.settings) };
}

export async function loadBillingContext(q: Q, branch: Branch): Promise<BillingContext> {
  const [st, rules, pkgs] = await Promise.all([
    q.select({ id: stations.id, type: stations.type, tier: stations.tier }).from(stations).where(eq(stations.branchId, branch.id)),
    q.select().from(pricingRules).where(eq(pricingRules.branchId, branch.id)),
    q.select().from(packages).where(eq(packages.branchId, branch.id)),
  ]);
  return {
    tz: branch.timezone,
    stations: Object.fromEntries(st.map((s) => [s.id, s])),
    rules: rules.map((r) => pricingRuleSchema.parse(r)),
    packages: pkgs.map((p) => pricePackageSchema.parse(p)),
    policy: branch.settings.billing,
  };
}

export type SegmentRow = typeof segments.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export function toTimeline(s: SessionRow, segs: SegmentRow[]): SessionTimeline {
  return {
    kind: s.kind,
    plannedMinutes: s.plannedMinutes,
    packageId: s.packageId,
    segments: segs.map((g) => ({
      stationId: g.stationId,
      mode: g.mode,
      paused: g.paused,
      startedAt: g.startedAt.getTime(),
      endedAt: g.endedAt ? g.endedAt.getTime() : null,
    })),
  };
}

export async function loadSegments(q: Q, sessionIds: string[]): Promise<Map<string, SegmentRow[]>> {
  const out = new Map<string, SegmentRow[]>();
  if (sessionIds.length === 0) return out;
  const rows = await q
    .select()
    .from(segments)
    .where(inArray(segments.sessionId, sessionIds))
    .orderBy(asc(segments.startedAt), asc(segments.id));
  for (const r of rows) {
    const list = out.get(r.sessionId) ?? [];
    list.push(r);
    out.set(r.sessionId, list);
  }
  return out;
}

export async function getSession(q: Q, branchId: string, id: string): Promise<SessionRow> {
  const [s] = await q.select().from(sessions).where(and(eq(sessions.id, id), eq(sessions.branchId, branchId)));
  if (!s) throw notFound('session');
  return s;
}

/**
 * The business day transactions are booked to: the branch's open day. There is always exactly
 * one; if none exists (fresh install) it is opened for the current clock day.
 */
export async function currentDay(q: Q, branch: Branch, now: number): Promise<string> {
  const [open] = await q
    .select({ day: businessDays.day })
    .from(businessDays)
    .where(and(eq(businessDays.branchId, branch.id), eq(businessDays.status, 'open')));
  if (open) return open.day;
  const day = businessDayOf(now, branch.timezone, branch.settings.day.cutoff);
  await q
    .insert(businessDays)
    .values({ id: newId(), branchId: branch.id, day, status: 'open', openedAt: new Date(now) })
    .onConflictDoNothing();
  return day;
}

export async function openShift(q: Q, branchId: string) {
  const [s] = await q.select().from(shifts).where(and(eq(shifts.branchId, branchId), eq(shifts.status, 'open')));
  return s ?? null;
}

/** Money can only move while a cash-drawer shift is open — that is what makes the drawer auditable. */
export async function requireOpenShift(q: Q, branchId: string) {
  const s = await openShift(q, branchId);
  if (!s) throw new DomainError('no_open_shift', 'Open a shift before taking payments');
  return s;
}

/** Money already received toward a session (prepaid, payments during play, reservation deposit), by method. */
export async function sessionPaidByMethod(q: Q, s: SessionRow): Promise<{ total: number; byMethod: Record<string, number> }> {
  const conds = [eq(payments.sessionId, s.id)];
  if (s.reservationId) conds.push(and(eq(payments.reservationId, s.reservationId), inArray(payments.kind, ['deposit']))!);
  const rows = await q
    .select({ amount: payments.amount, billId: payments.billId, method: payments.method })
    .from(payments)
    .where(or(...conds));
  const byMethod: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    if (r.billId) continue;
    total += r.amount;
    byMethod[r.method] = (byMethod[r.method] ?? 0) + r.amount;
  }
  return { total, byMethod };
}

export async function sessionPaid(q: Q, s: SessionRow): Promise<number> {
  return (await sessionPaidByMethod(q, s)).total;
}

/**
 * Sensitive actions need a manager. A manager/owner acting themselves approves implicitly;
 * anyone else must supply a manager's PIN. Returns the approver's id, or null when not needed.
 */
export async function resolveApproval(
  q: Q,
  actor: Actor,
  needed: boolean,
  pin: string | null | undefined,
  what: string,
): Promise<string | null> {
  if (!needed) return null;
  if (isManager(actor.role)) return actor.id;
  if (!pin) throw new DomainError('approval_required', `Manager approval required: ${what}`, { what });
  const managers = await q
    .select({ id: users.id, pinHash: users.pinHash, branchId: users.branchId })
    .from(users)
    .where(and(eq(users.orgId, actor.orgId), eq(users.active, true), inArray(users.role, ['owner', 'manager'])));
  for (const m of managers) {
    if (m.branchId && m.branchId !== actor.branchId) continue;
    if (await verifyPin(pin, m.pinHash)) return m.id;
  }
  throw new DomainError('approval_invalid', 'Manager PIN is not valid');
}
